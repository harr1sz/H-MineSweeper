import { randomInt, randomUUID } from "node:crypto";
import type { ServerConfig } from "./config.js";
import { RoomActor } from "./room-actor.js";
import type { GuestSession, ReplayDocument } from "./types.js";

const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_CODE_LENGTH = 6;

function roomCode(): string {
  let result = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    result += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  }
  return result;
}

export type JoinRoomResult =
  | { readonly ok: true; readonly room: RoomActor }
  | {
      readonly ok: false;
      readonly reason: "ROOM_NOT_FOUND" | "ROOM_FULL" | "ALREADY_JOINED";
    };

export class RoomManager {
  readonly #byId = new Map<string, RoomActor>();
  readonly #byCode = new Map<string, RoomActor>();

  constructor(
    private readonly config: ServerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  create(host: GuestSession): RoomActor {
    this.purgeIdleRooms();
    let code = roomCode();
    while (this.#byCode.has(code)) code = roomCode();
    const room = new RoomActor({
      roomId: randomUUID(),
      roomCode: code,
      host,
      timings: {
        countdownMs: this.config.countdownMs,
        roundDurationMs: this.config.roundDurationMs,
        terminalWindowMs: this.config.terminalWindowMs,
        progressIntervalMs: this.config.progressIntervalMs,
      },
      now: this.now,
    });
    this.#byId.set(room.roomId, room);
    this.#byCode.set(room.roomCode, room);
    return room;
  }

  join(code: string, guest: GuestSession): JoinRoomResult {
    this.purgeIdleRooms();
    const room = this.#byCode.get(code.toUpperCase());
    if (!room) return { ok: false, reason: "ROOM_NOT_FOUND" };
    if (room.hasPlayer(guest.guestId)) {
      return { ok: false, reason: "ALREADY_JOINED" };
    }
    if (room.isFull()) return { ok: false, reason: "ROOM_FULL" };
    room.addPlayer(guest);
    return { ok: true, room };
  }

  getById(roomId: string): RoomActor | undefined {
    this.purgeIdleRooms();
    return this.#byId.get(roomId);
  }

  getReplay(replayId: string): ReplayDocument | undefined {
    this.purgeIdleRooms();
    for (const room of this.#byId.values()) {
      const replay = room.getReplay(replayId);
      if (replay) return replay;
    }
    return undefined;
  }

  close(): void {
    for (const room of this.#byId.values()) room.close();
    this.#byId.clear();
    this.#byCode.clear();
  }

  private purgeIdleRooms(): void {
    const now = this.now();
    for (const [roomId, room] of this.#byId) {
      const activity = room.getActivitySnapshot();
      const active =
        activity.phase === "COUNTDOWN" ||
        activity.phase === "ACTIVE";
      if (
        activity.hasConnectedPlayers ||
        active ||
        now - activity.lastActivityAt < this.config.roomIdleTtlMs
      ) {
        continue;
      }

      room.close();
      this.#byId.delete(roomId);
      this.#byCode.delete(room.roomCode);
    }
  }
}
