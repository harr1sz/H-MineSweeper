import { describe, expect, it } from "vitest";
import { RestRateLimiter } from "../src/rest-rate-limiter.js";

describe("RestRateLimiter", () => {
  it("refills a bounded token bucket", () => {
    let now = 0;
    const limiter = new RestRateLimiter(60, 1, 10, () => now);
    expect(limiter.consume("subject").allowed).toBe(true);
    expect(limiter.consume("subject")).toMatchObject({
      allowed: false,
      capacityReached: false,
      retryAfterMs: 1_000,
    });
    now = 1_000;
    expect(limiter.consume("subject").allowed).toBe(true);
  });

  it("fails closed instead of allocating unbounded unique-key state", () => {
    const limiter = new RestRateLimiter(60, 1, 2, () => 0);
    expect(limiter.consume("first").allowed).toBe(true);
    expect(limiter.consume("second").allowed).toBe(true);
    expect(limiter.size).toBe(2);
    expect(limiter.consume("third")).toEqual({
      allowed: false,
      retryAfterMs: 60_000,
      capacityReached: true,
    });
    expect(limiter.size).toBe(2);
  });
});
