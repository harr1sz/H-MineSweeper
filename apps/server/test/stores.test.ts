import { describe, expect, it } from "vitest";
import { GuestSessionStore, TicketStore } from "../src/stores.js";

describe("GuestSessionStore", () => {
  it("expires sessions and purges stale entries on get and create", () => {
    let now = 1_000;
    const store = new GuestSessionStore(5_000, () => now);
    const first = store.create(" First ");

    expect(store.get(first.guestToken)).toMatchObject({
      displayName: "First",
    });
    expect(store.size).toBe(1);

    now += 5_000;
    expect(store.get(first.guestToken)).toBeUndefined();
    expect(store.size).toBe(0);

    const second = store.create("Second");
    now += 5_000;
    const third = store.create("Third");
    expect(store.get(second.guestToken)).toBeUndefined();
    expect(store.get(third.guestToken)).toBeDefined();
    expect(store.size).toBe(1);
  });
});

describe("TicketStore", () => {
  it("consumes a short-lived ticket exactly once", () => {
    let now = 1_000;
    const store = new TicketStore(5_000, () => now);
    const issued = store.issue("room-1", "guest-1");

    expect(store.consume(issued.ticket)).toMatchObject({
      roomId: "room-1",
      guestId: "guest-1",
    });
    expect(store.consume(issued.ticket)).toBeUndefined();

    const expired = store.issue("room-1", "guest-1");
    now += 5_001;
    expect(store.consume(expired.ticket)).toBeUndefined();
  });

  it("purges expired epoch records without allowing an epoch to go backwards", () => {
    let now = 10_000;
    const store = new TicketStore(1_000, () => now, 2_000);
    const first = store.issue("room-1", "guest-1");
    const second = store.issue("room-1", "guest-1");

    expect(second.connectionEpoch).toBe(first.connectionEpoch + 1);
    expect(store.epochCount).toBe(1);

    now += 2_000;
    expect(store.consume("missing-ticket")).toBeUndefined();
    expect(store.epochCount).toBe(0);

    const renewed = store.issue("room-1", "guest-1");
    expect(renewed.connectionEpoch).toBeGreaterThan(second.connectionEpoch);
    expect(renewed.connectionEpoch).toBe(now);
  });
});
