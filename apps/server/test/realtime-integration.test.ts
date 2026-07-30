import { createBoard } from "@h-minesweeper/game-core";
import type { BoardSpec } from "@h-minesweeper/game-core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

interface WireMessage {
  readonly type: string;
  readonly serverSeq?: number;
  readonly matchId?: string;
  readonly connectionEpoch?: number;
  readonly boardSpec?: BoardSpec;
  readonly replayId?: string;
  readonly phase?: string;
}

class TestClient {
  readonly #messages: WireMessage[] = [];
  readonly #waiters = new Set<{
    readonly predicate: (message: WireMessage) => boolean;
    readonly resolve: (message: WireMessage) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  #actionCounter = 0;
  #lastServerSeq = 0;
  #matchId = "";
  #connectionEpoch = 0;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      this.#lastServerSeq = Math.max(
        this.#lastServerSeq,
        message.serverSeq ?? 0,
      );
      if (message.matchId) this.#matchId = message.matchId;
      if (message.connectionEpoch) {
        this.#connectionEpoch = message.connectionEpoch;
      }

      for (const waiter of this.#waiters) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(message);
        return;
      }
      this.#messages.push(message);
    });
  }

  static async connect(url: string, ticket: string): Promise<TestClient> {
    const socket = new WebSocket(url, {
      origin: "http://127.0.0.1:5173",
    });
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "HELLO", v: 1, ticket }));
    await client.next("WELCOME");
    return client;
  }

  next(
    type: string,
    predicate: (message: WireMessage) => boolean = () => true,
    timeoutMs = 2_000,
  ): Promise<WireMessage> {
    const existingIndex = this.#messages.findIndex(
      (message) => message.type === type && predicate(message),
    );
    if (existingIndex >= 0) {
      const [message] = this.#messages.splice(existingIndex, 1);
      if (message) return Promise.resolve(message);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: (message: WireMessage) =>
          message.type === type && predicate(message),
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  action(
    actionType: "READY" | "REVEAL" | "TOGGLE_FLAG" | "CHORD" | "REMATCH",
    cellIndex?: number,
  ): void {
    this.#actionCounter += 1;
    this.socket.send(JSON.stringify({
      type: "ACTION",
      envelope: {
        v: 1,
        matchId: this.#matchId,
        connectionEpoch: this.#connectionEpoch,
        clientActionId: `integration-${this.#actionCounter}`,
        lastServerSeq: this.#lastServerSeq,
        actionType,
        ...(cellIndex === undefined ? {} : { cellIndex }),
        clientMonoTelemetry: performance.now(),
      },
    }));
  }

  async close(): Promise<void> {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Client closed"));
    }
    this.#waiters.clear();
    if (
      this.socket.readyState === WebSocket.CLOSED ||
      this.socket.readyState === WebSocket.CLOSING
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

const apps: FastifyInstance[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function createGuest(
  baseUrl: string,
  displayName: string,
): Promise<{ guestToken: string }> {
  const response = await fetch(`${baseUrl}/api/v1/guest-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { guestToken: string };
}

describe("real WebSocket duel", () => {
  it("completes ten unique rounds across five Bo3 matches without divergent boards", async () => {
    const base = loadConfig({});
    const app = createApp({
      logger: false,
      config: {
        ...base,
        allowedOrigins: new Set(["http://127.0.0.1:5173"]),
        countdownMs: 2,
        terminalWindowMs: 2,
        roundDurationMs: 2_000,
        progressIntervalMs: 1,
      },
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const websocketUrl = `ws://127.0.0.1:${address.port}/realtime/v1`;

    const hostGuest = await createGuest(baseUrl, "Alpha");
    const rivalGuest = await createGuest(baseUrl, "Bravo");
    const roomResponse = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guestToken: hostGuest.guestToken }),
    });
    const room = await roomResponse.json() as {
      roomCode: string;
      ticket: string;
    };
    const joinResponse = await fetch(
      `${baseUrl}/api/v1/rooms/${room.roomCode}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guestToken: rivalGuest.guestToken }),
      },
    );
    const joined = await joinResponse.json() as { ticket: string };

    const host = await TestClient.connect(websocketUrl, room.ticket);
    const rival = await TestClient.connect(websocketUrl, joined.ticket);
    clients.push(host, rival);
    await Promise.all([
      host.next("ROOM_STATE", (message) => message.phase === "LOBBY"),
      rival.next("ROOM_STATE", (message) => message.phase === "LOBBY"),
    ]);

    const seeds = new Set<string>();
    const replayIds = new Set<string>();
    for (let match = 0; match < 5; match += 1) {
      for (let round = 0; round < 2; round += 1) {
        host.action("READY");
        rival.action("READY");
        const [hostCountdown, rivalCountdown] = await Promise.all([
          host.next("COUNTDOWN"),
          rival.next("COUNTDOWN"),
        ]);
        expect(hostCountdown.boardSpec).toEqual(rivalCountdown.boardSpec);
        const boardSpec = hostCountdown.boardSpec;
        if (!boardSpec) throw new Error("COUNTDOWN omitted the client seed");
        expect(seeds.has(boardSpec.seed)).toBe(false);
        seeds.add(boardSpec.seed);

        await Promise.all([
          host.next("ROUND_ACTIVE"),
          rival.next("ROUND_ACTIVE"),
        ]);
        const mineIndex = createBoard(boardSpec).mines.findIndex(
          (value) => value === 1,
        );
        expect(mineIndex).toBeGreaterThanOrEqual(0);
        host.action("REVEAL", mineIndex);

        await Promise.all([
          host.next("ROUND_RESULT"),
          rival.next("ROUND_RESULT"),
        ]);
        if (round === 0) {
          await Promise.all([
            host.next("ROOM_STATE", (message) => message.phase === "ROUND_RESULT"),
            rival.next("ROOM_STATE", (message) => message.phase === "ROUND_RESULT"),
          ]);
        }
      }

      const [hostResult, rivalResult] = await Promise.all([
        host.next("MATCH_RESULT"),
        rival.next("MATCH_RESULT"),
      ]);
      expect(hostResult.replayId).toBe(rivalResult.replayId);
      if (!hostResult.replayId) throw new Error("Missing replay id");
      replayIds.add(hostResult.replayId);

      const replayResponse = await fetch(
        `${baseUrl}/api/v1/replays/${hostResult.replayId}`,
      );
      expect(replayResponse.status).toBe(200);
      const replay = await replayResponse.json() as {
        status: string;
        events: Array<{ type: string }>;
      };
      expect(replay.status).toBe("COMPLETED");
      expect(
        replay.events.filter((event) => event.type === "ROUND_RESULT"),
      ).toHaveLength(2);

      if (match < 4) {
        await Promise.all([
          host.next("ROOM_STATE", (message) => message.phase === "MATCH_RESULT"),
          rival.next("ROOM_STATE", (message) => message.phase === "MATCH_RESULT"),
        ]);
        host.action("REMATCH");
        rival.action("REMATCH");
        await Promise.all([
          host.next("REMATCH_STARTED"),
          rival.next("REMATCH_STARTED"),
        ]);
        await Promise.all([
          host.next("ROOM_STATE", (message) => message.phase === "LOBBY"),
          rival.next("ROOM_STATE", (message) => message.phase === "LOBBY"),
        ]);
      }
    }

    expect(seeds.size).toBe(10);
    expect(replayIds.size).toBe(5);
  }, 20_000);

  it("closes an authenticated connection that floods realtime messages", async () => {
    const base = loadConfig({});
    const app = createApp({
      logger: false,
      config: {
        ...base,
        allowedOrigins: new Set(["http://127.0.0.1:5173"]),
      },
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const guest = await createGuest(baseUrl, "Flooder");
    const roomResponse = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guestToken: guest.guestToken }),
    });
    const room = await roomResponse.json() as { ticket: string };
    const client = await TestClient.connect(
      `ws://127.0.0.1:${address.port}/realtime/v1`,
      room.ticket,
    );
    clients.push(client);
    const closed = new Promise<number>((resolve) => {
      client.socket.once("close", (code) => resolve(code));
    });
    for (let index = 0; index < 200; index += 1) {
      client.socket.send(JSON.stringify({ type: "PING", at: index }));
    }
    await expect(closed).resolves.toBe(4429);
  });
});
