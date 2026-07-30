import { beforeEach, describe, expect, it } from "vitest";
import { percentile, recordMetric } from "./performance";

describe("bounded performance telemetry", () => {
  beforeEach(() => {
    globalThis.__HMS_PERF__ = undefined;
    globalThis.__HMS_PERF_COUNTS__ = undefined;
  });

  it("calculates nearest-rank percentiles", () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);
  });

  it("retains only the latest 256 finite non-negative samples", () => {
    for (let value = 0; value < 300; value += 1) {
      recordMetric("pointerNextPaintMs", value);
    }
    recordMetric("pointerNextPaintMs", Number.NaN);
    recordMetric("pointerNextPaintMs", -1);

    const samples = globalThis.__HMS_PERF__?.pointerNextPaintMs;
    expect(samples).toHaveLength(256);
    expect(samples?.[0]).toBe(44);
    expect(samples?.at(-1)).toBe(299);
    expect(globalThis.__HMS_PERF_COUNTS__?.pointerNextPaintMs).toBe(300);
  });
});
