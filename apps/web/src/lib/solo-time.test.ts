import { describe, expect, it } from "vitest";
import { formatSoloElapsedTime } from "./solo-time";

describe("formatSoloElapsedTime", () => {
  it("shows a clock with minutes, seconds, and centiseconds", () => {
    expect(formatSoloElapsedTime(65_432, "clock", "zh-CN")).toBe("01:05.43");
  });

  it("shows the full elapsed duration as seconds", () => {
    expect(formatSoloElapsedTime(65_432, "seconds", "zh-CN")).toBe("65.43 秒");
    expect(formatSoloElapsedTime(65_432, "seconds", "en-US")).toBe("65.43 s");
  });

  it("never displays a negative duration", () => {
    expect(formatSoloElapsedTime(-100, "seconds", "zh-CN")).toBe("0.00 秒");
  });
});
