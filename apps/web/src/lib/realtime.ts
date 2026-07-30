import type { ClientMessage, ServerMessage } from "@h-minesweeper/game-core";

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

function websocketUrl(): string {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) {
    return configured;
  }

  const url = new URL("/realtime/v1", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private pingTimer: number | null = null;
  private readonly pendingPings = new Map<number, number>();
  private messageListener: MessageListener | null = null;
  private statusListener: StatusListener | null = null;
  private lastRttMs: number | null = null;
  private lastServerOffsetMs = 0;

  get rttMs(): number | null {
    return this.lastRttMs;
  }

  get serverOffsetMs(): number {
    return this.lastServerOffsetMs;
  }

  connect(
    ticket: string,
    onMessage: MessageListener,
    onStatus: StatusListener,
  ): Promise<void> {
    this.disconnect();
    this.messageListener = onMessage;
    this.statusListener = onStatus;
    onStatus("connecting");

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(websocketUrl());
      let settled = false;
      this.socket = socket;

      socket.addEventListener("open", () => {
        if (socket !== this.socket) return;
        this.send({ type: "HELLO", v: 1, ticket });
        this.startPings();
      });

      socket.addEventListener("message", (event) => {
        if (socket !== this.socket || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as ServerMessage;
          if (message.type === "WELCOME") {
            this.lastServerOffsetMs = message.serverTime - Date.now();
            onStatus("connected");
            if (!settled) {
              settled = true;
              resolve();
            }
          }
          if (message.type === "PONG") {
            const started = this.pendingPings.get(message.at);
            if (started !== undefined) {
              this.lastRttMs = Math.max(0, performance.now() - started);
              const clientMidpoint =
                message.at + (Date.now() - message.at) / 2;
              this.lastServerOffsetMs =
                message.serverTime - clientMidpoint;
              this.pendingPings.delete(message.at);
            }
          }
          this.messageListener?.(message);
        } catch {
          onStatus("error");
        }
      });

      socket.addEventListener("close", () => {
        if (socket !== this.socket) return;
        this.stopPings();
        onStatus("disconnected");
        if (!settled) {
          settled = true;
          reject(new Error("实时票据无效或连接在认证前关闭"));
        }
      });

      socket.addEventListener("error", () => {
        if (socket !== this.socket) return;
        onStatus("error");
        if (!settled) {
          settled = true;
          reject(new Error("实时连接失败"));
        }
      });
    });
  }

  send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.socket.send(JSON.stringify(message));
    return true;
  }

  disconnect(): void {
    this.stopPings();
    this.socket?.close();
    this.socket = null;
  }

  private startPings(): void {
    this.stopPings();
    const ping = () => {
      const at = Date.now();
      this.pendingPings.set(at, performance.now());
      this.send({ type: "PING", at });
      for (const key of this.pendingPings.keys()) {
        if (at - key > 15_000) this.pendingPings.delete(key);
      }
    };
    ping();
    this.pingTimer = window.setInterval(ping, 5_000);
  }

  private stopPings(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.pendingPings.clear();
  }
}
