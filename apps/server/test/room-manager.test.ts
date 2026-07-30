import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { RoomManager } from "../src/room-manager.js";
import type { GuestSession } from "../src/types.js";

function guest(id: string): GuestSession {
  return {
    guestId: id,
    guestToken: `token-${id}`,
    displayName: id,
  };
}

function testConfig(roomIdleTtlMs: number) {
  return {
    ...loadConfig({}),
    roomIdleTtlMs,
  };
}

describe("RoomManager idle cleanup", () => {
  it("enforces the configured room capacity", () => {
    const manager = new RoomManager({
      ...testConfig(60_000),
      maxRooms: 1,
    });
    manager.create(guest("first"));

    expect(() => manager.create(guest("second"))).toThrow(
      "rooms capacity has been reached",
    );
    manager.close();
  });

  it("closes and removes a fully offline room after the idle TTL", () => {
    let now = 1_000;
    const manager = new RoomManager(testConfig(5_000), () => now);
    const stale = manager.create(guest("stale"));
    const close = vi.spyOn(stale, "close");

    now += 5_000;
    const current = manager.create(guest("current"));

    expect(close).toHaveBeenCalledOnce();
    expect(manager.getById(stale.roomId)).toBeUndefined();
    expect(manager.getById(current.roomId)).toBe(current);
    manager.close();
  });

  it("keeps a connected room even when its last activity exceeds the TTL", () => {
    let now = 10_000;
    const manager = new RoomManager(testConfig(1_000), () => now);
    const room = manager.create(guest("host"));
    room.connect("host", 1, { send: vi.fn() });

    now += 10_000;
    manager.create(guest("other"));

    expect(manager.getById(room.roomId)).toBe(room);
    manager.close();
  });

  it("keeps an active room even if a defensive snapshot reports no connections", () => {
    let now = 20_000;
    const manager = new RoomManager(testConfig(1_000), () => now);
    const room = manager.create(guest("host"));
    vi.spyOn(room, "getActivitySnapshot").mockReturnValue({
      hasConnectedPlayers: false,
      phase: "ACTIVE",
      lastActivityAt: now - 10_000,
    });

    now += 1_000;
    expect(manager.getById(room.roomId)).toBe(room);
    manager.close();
  });

  it("collects an offline round-result room after the idle TTL", () => {
    let now = 30_000;
    const manager = new RoomManager(testConfig(1_000), () => now);
    const room = manager.create(guest("finished-round"));
    vi.spyOn(room, "getActivitySnapshot").mockReturnValue({
      hasConnectedPlayers: false,
      phase: "ROUND_RESULT",
      lastActivityAt: now - 2_000,
    });
    const close = vi.spyOn(room, "close");

    now += 1;
    expect(manager.getById(room.roomId)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    manager.close();
  });

  it("supports timer-driven sweeping without a follow-up room request", () => {
    let now = 40_000;
    const manager = new RoomManager(testConfig(1_000), () => now);
    const room = manager.create(guest("timer-sweep"));
    const close = vi.spyOn(room, "close");

    now += 1_000;
    manager.sweepIdleRooms();

    expect(manager.size).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    manager.close();
  });
});
