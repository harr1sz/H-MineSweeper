import { describe, expect, it } from "vitest";
import {
  metricValuesForHistoryRecord,
  resolveSoloMetricView,
} from "./solo-metrics";

describe("Solo metric eligibility", () => {
  it("keeps completion metrics unavailable until a standard game is won", () => {
    const base = {
      sessionKind: "STANDARD" as const,
      board3BV: 82,
      elapsedMs: 41_000,
      physicalClicks: 50,
    };

    for (const status of ["READY", "GENERATING"] as const) {
      expect(resolveSoloMetricView({ ...base, status })).toEqual({
        board3BV: 82,
        threeBvPerSecond: null,
        ioe: null,
        completionState: "UNAVAILABLE",
      });
    }
    expect(resolveSoloMetricView({ ...base, status: "PLAYING" })).toEqual({
      board3BV: 82,
      threeBvPerSecond: null,
      ioe: null,
      completionState: "PENDING",
    });
    expect(resolveSoloMetricView({ ...base, status: "LOST" })).toEqual({
      board3BV: 82,
      threeBvPerSecond: null,
      ioe: null,
      completionState: "UNAVAILABLE",
    });
    expect(resolveSoloMetricView({ ...base, status: "WON" })).toEqual({
      board3BV: 82,
      threeBvPerSecond: 2,
      ioe: 1.64,
      completionState: "FINAL",
    });
  });

  it("never turns guided practice into a scored completion", () => {
    expect(resolveSoloMetricView({
      sessionKind: "GUIDED_PRACTICE",
      status: "WON",
      board3BV: 10,
      elapsedMs: 5_000,
      physicalClicks: 4,
    })).toEqual({
      board3BV: 10,
      threeBvPerSecond: null,
      ioe: null,
      completionState: "PRACTICE",
    });
  });

  it("masks legacy loss metrics without rewriting the source record", () => {
    const legacyMetrics = { threeBvPerSecond: 9.5, ioe: 3.2 };
    expect(metricValuesForHistoryRecord("LOST", legacyMetrics)).toEqual({
      threeBvPerSecond: null,
      ioe: null,
    });
    expect(legacyMetrics).toEqual({ threeBvPerSecond: 9.5, ioe: 3.2 });
    expect(metricValuesForHistoryRecord("WON", legacyMetrics)).toEqual(legacyMetrics);
  });
});
