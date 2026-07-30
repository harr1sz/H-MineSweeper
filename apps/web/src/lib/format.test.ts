import { describe, expect, it } from "vitest";
import { formatDuration, normalizeRoomCode } from "./format";

describe("formatDuration", () => {
  it("formats a race timer with centiseconds", () => {
    expect(formatDuration(65_432)).toBe("01:05.43");
  });

  it("never renders negative time", () => {
    expect(formatDuration(-100)).toBe("00:00.00");
  });
});

describe("normalizeRoomCode", () => {
  it("keeps only six uppercase alphanumeric characters", () => {
    expect(normalizeRoomCode("ab-12 cd!")).toBe("AB12CD");
  });
});
