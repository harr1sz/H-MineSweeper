import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import type { ServerConfig } from "./config.js";
import type { RoomManager } from "./room-manager.js";
import type { TicketStore } from "./stores.js";
import type { ClientActionEnvelope, WireSender } from "./types.js";

interface ConnectionContext {
  authenticated: boolean;
  lastActivityAt: number;
  rateTokens: number;
  rateLastRefillAt: number;
  rateLimitViolations: number;
  helloTimer?: NodeJS.Timeout;
  roomId?: string;
  guestId?: string;
  connectionEpoch?: number;
}

const MESSAGE_RATE_PER_SECOND = 60;
const MESSAGE_BURST = 120;
const SOFT_BUFFERED_BYTES = 256 * 1024;
const HARD_BUFFERED_BYTES = 1024 * 1024;

interface GatewayLogger {
  warn(data: unknown, message?: string): void;
  error(data: unknown, message?: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isHello(
  value: unknown,
): value is { readonly type: "HELLO"; readonly v: 1; readonly ticket: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "v", "ticket"]) &&
    value.type === "HELLO" &&
    value.v === 1 &&
    typeof value.ticket === "string" &&
    value.ticket.length >= 20 &&
    value.ticket.length <= 256
  );
}

function isPing(
  value: unknown,
): value is { readonly type: "PING"; readonly at: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "at"]) &&
    value.type === "PING" &&
    typeof value.at === "number" &&
    Number.isFinite(value.at)
  );
}

function isClientActionEnvelope(value: unknown): value is ClientActionEnvelope {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "v",
      "matchId",
      "connectionEpoch",
      "clientActionId",
      "lastServerSeq",
      "actionType",
      "cellIndex",
      "clientMonoTelemetry",
    ])
  ) {
    return false;
  }

  const actionType = value.actionType;
  const actionTypeValid =
    actionType === "READY" ||
    actionType === "REVEAL" ||
    actionType === "TOGGLE_FLAG" ||
    actionType === "CHORD" ||
    actionType === "REMATCH";
  const cellIndexValid =
    value.cellIndex === undefined ||
    (Number.isSafeInteger(value.cellIndex) &&
      Number(value.cellIndex) >= 0 &&
      Number(value.cellIndex) < 10_000);

  return (
    value.v === 1 &&
    typeof value.matchId === "string" &&
    value.matchId.length >= 1 &&
    value.matchId.length <= 128 &&
    Number.isSafeInteger(value.connectionEpoch) &&
    Number(value.connectionEpoch) >= 1 &&
    typeof value.clientActionId === "string" &&
    value.clientActionId.length >= 1 &&
    value.clientActionId.length <= 128 &&
    Number.isSafeInteger(value.lastServerSeq) &&
    Number(value.lastServerSeq) >= 0 &&
    actionTypeValid &&
    cellIndexValid &&
    typeof value.clientMonoTelemetry === "number" &&
    Number.isFinite(value.clientMonoTelemetry)
  );
}

function isAction(
  value: unknown,
): value is {
  readonly type: "ACTION";
  readonly envelope: ClientActionEnvelope;
} {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "envelope"]) &&
    value.type === "ACTION" &&
    isClientActionEnvelope(value.envelope)
  );
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
}

function websocketPath(request: IncomingMessage): string | undefined {
  if (!request.url) return undefined;
  try {
    return new URL(request.url, "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

export class RealtimeGateway {
  readonly #wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  readonly #contexts = new Map<WebSocket, ConnectionContext>();
  readonly #heartbeatTimer: NodeJS.Timeout;
  readonly #upgradeListener: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
  #closed = false;

  constructor(
    private readonly server: HttpServer,
    private readonly config: ServerConfig,
    private readonly rooms: RoomManager,
    private readonly tickets: TicketStore,
    private readonly logger: GatewayLogger,
    private readonly now: () => number = Date.now,
  ) {
    this.#upgradeListener = (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    };
    this.server.on("upgrade", this.#upgradeListener);
    this.#wss.on("connection", (socket) => this.handleConnection(socket));
    this.#heartbeatTimer = setInterval(
      () => this.heartbeat(),
      this.config.heartbeatIntervalMs,
    );
    this.#heartbeatTimer.unref();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeatTimer);
    this.server.off("upgrade", this.#upgradeListener);

    for (const [socket, context] of this.#contexts) {
      if (context.helloTimer) clearTimeout(context.helloTimer);
      socket.terminate();
    }
    this.#contexts.clear();

    await new Promise<void>((resolve) => {
      this.#wss.close(() => resolve());
    });
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (this.#closed) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (websocketPath(request) !== "/realtime/v1") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const origin = request.headers.origin;
    if (!origin || !this.config.allowedOrigins.has(origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    this.#wss.handleUpgrade(request, socket, head, (websocket) => {
      this.#wss.emit("connection", websocket, request);
    });
  }

  private handleConnection(socket: WebSocket): void {
    const context: ConnectionContext = {
      authenticated: false,
      lastActivityAt: this.now(),
      rateTokens: MESSAGE_BURST,
      rateLastRefillAt: this.now(),
      rateLimitViolations: 0,
    };
    context.helloTimer = setTimeout(() => {
      if (!context.authenticated) socket.close(4401, "HELLO required");
    }, this.config.helloTimeoutMs);
    this.#contexts.set(socket, context);

    socket.on("pong", () => {
      context.lastActivityAt = this.now();
    });
    socket.on("message", (data, isBinary) => {
      context.lastActivityAt = this.now();
      this.handleMessage(socket, context, data, isBinary);
    });
    socket.on("error", (error) => {
      this.logger.warn({ error }, "WebSocket connection error");
    });
    socket.on("close", () => {
      if (context.helloTimer) clearTimeout(context.helloTimer);
      this.#contexts.delete(socket);
      if (
        context.authenticated &&
        context.roomId &&
        context.guestId &&
        context.connectionEpoch !== undefined
      ) {
        this.rooms
          .getById(context.roomId)
          ?.disconnect(context.guestId, context.connectionEpoch);
      }
    });
  }

  private handleMessage(
    socket: WebSocket,
    context: ConnectionContext,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (isBinary) {
      socket.close(4400, "Text JSON messages required");
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      socket.close(4400, "Invalid JSON");
      return;
    }

    if (!context.authenticated) {
      if (!isHello(message)) {
        socket.close(4401, "HELLO must be the first message");
        return;
      }
      this.authenticate(socket, context, message.ticket);
      return;
    }

    if (!this.consumeRateToken(socket, context)) return;

    if (isPing(message)) {
      this.send(socket, {
        type: "PONG",
        v: 1,
        at: message.at,
        serverTime: this.now(),
      });
      return;
    }
    if (!isAction(message)) {
      socket.close(4400, "Invalid protocol message");
      return;
    }

    if (!context.roomId || !context.guestId) {
      socket.close(1011, "Missing connection context");
      return;
    }
    const room = this.rooms.getById(context.roomId);
    if (!room) {
      socket.close(4404, "Room not found");
      return;
    }
    room.handleAction(context.guestId, message.envelope);
  }

  private authenticate(
    socket: WebSocket,
    context: ConnectionContext,
    ticket: string,
  ): void {
    const claims = this.tickets.consume(ticket);
    if (!claims) {
      socket.close(4401, "Invalid or consumed ticket");
      return;
    }
    const room = this.rooms.getById(claims.roomId);
    if (!room || !room.hasPlayer(claims.guestId)) {
      socket.close(4404, "Room not found");
      return;
    }

    const sender: WireSender = {
      send: (message) => this.send(socket, message),
    };
    if (!room.connect(claims.guestId, claims.connectionEpoch, sender)) {
      socket.close(4409, "Stale connection ticket");
      return;
    }

    context.authenticated = true;
    context.roomId = claims.roomId;
    context.guestId = claims.guestId;
    context.connectionEpoch = claims.connectionEpoch;
    if (context.helloTimer) {
      clearTimeout(context.helloTimer);
      delete context.helloTimer;
    }
  }

  private heartbeat(): void {
    const now = this.now();
    for (const [socket, context] of this.#contexts) {
      if (now - context.lastActivityAt >= this.config.inactiveTimeoutMs) {
        socket.terminate();
        continue;
      }
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }

  private consumeRateToken(
    socket: WebSocket,
    context: ConnectionContext,
  ): boolean {
    const now = this.now();
    const elapsedSeconds = Math.max(
      0,
      (now - context.rateLastRefillAt) / 1_000,
    );
    context.rateTokens = Math.min(
      MESSAGE_BURST,
      context.rateTokens + elapsedSeconds * MESSAGE_RATE_PER_SECOND,
    );
    context.rateLastRefillAt = now;
    if (context.rateTokens >= 1) {
      context.rateTokens -= 1;
      context.rateLimitViolations = 0;
      return true;
    }

    context.rateLimitViolations += 1;
    if (context.rateLimitViolations >= 3) {
      socket.close(4429, "Message rate exceeded");
    } else {
      this.send(socket, {
        type: "ERROR",
        v: 1,
        code: "RATE_LIMITED",
        message: "Too many realtime messages",
        retryable: true,
      });
    }
    return false;
  }

  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount >= HARD_BUFFERED_BYTES) {
      socket.close(4408, "Realtime backpressure");
      return;
    }
    if (
      socket.bufferedAmount >= SOFT_BUFFERED_BYTES &&
      isRecord(message) &&
      message.type === "PROGRESS"
    ) {
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this.logger.error({ error }, "Failed to serialize WebSocket message");
      socket.close(1011, "Serialization failure");
    }
  }
}
