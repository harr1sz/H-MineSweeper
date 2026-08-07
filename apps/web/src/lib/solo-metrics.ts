import {
  calculate3BVPerSecond,
  calculateIOE,
} from "@h-minesweeper/game-core";
import type { SoloSessionKind } from "./practice-coach";
import type { SoloRunOutcome } from "./solo-history";

export type SoloMetricStatus =
  | "READY"
  | "GENERATING"
  | "PLAYING"
  | "WON"
  | "LOST";

export type SoloCompletionMetricState =
  | "PENDING"
  | "FINAL"
  | "UNAVAILABLE"
  | "PRACTICE";

export interface SoloMetricView {
  readonly board3BV: number | null;
  readonly threeBvPerSecond: number | null;
  readonly ioe: number | null;
  readonly completionState: SoloCompletionMetricState;
}

export function isSoloCompletionMetricEligible(
  outcome: SoloRunOutcome,
): boolean {
  return outcome === "WON";
}

export function resolveSoloMetricView(input: {
  readonly sessionKind: SoloSessionKind;
  readonly status: SoloMetricStatus;
  readonly board3BV: number | null;
  readonly elapsedMs: number;
  readonly physicalClicks: number;
}): SoloMetricView {
  if (input.sessionKind === "GUIDED_PRACTICE") {
    return {
      board3BV: input.board3BV,
      threeBvPerSecond: null,
      ioe: null,
      completionState: "PRACTICE",
    };
  }
  if (input.status !== "WON") {
    return {
      board3BV: input.board3BV,
      threeBvPerSecond: null,
      ioe: null,
      completionState:
        input.status === "PLAYING" ? "PENDING" : "UNAVAILABLE",
    };
  }
  return {
    board3BV: input.board3BV,
    threeBvPerSecond:
      input.board3BV === null
        ? null
        : calculate3BVPerSecond(input.board3BV, input.elapsedMs),
    ioe:
      input.board3BV === null
        ? null
        : calculateIOE(input.board3BV, input.physicalClicks),
    completionState: "FINAL",
  };
}

export function metricValuesForHistoryRecord(
  outcome: SoloRunOutcome,
  metrics: {
    readonly threeBvPerSecond: number | null;
    readonly ioe: number | null;
  },
): Pick<SoloMetricView, "threeBvPerSecond" | "ioe"> {
  return isSoloCompletionMetricEligible(outcome)
    ? {
        threeBvPerSecond: metrics.threeBvPerSecond,
        ioe: metrics.ioe,
      }
    : { threeBvPerSecond: null, ioe: null };
}
