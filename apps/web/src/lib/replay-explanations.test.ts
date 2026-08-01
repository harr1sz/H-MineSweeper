import { describe, expect, it } from "vitest";
import type { VisibleBoardAnalysis, VisibleBoardProof } from "@h-minesweeper/game-core";
import {
  dedupeReviewSuggestions,
  explainReplayStep,
} from "./replay-explanations";

const stateHash = "visible";

function proof(
  rule: VisibleBoardProof["rule"],
  kind: VisibleBoardProof["kind"],
  targets: readonly number[],
  sources: readonly number[] = [0],
): VisibleBoardProof {
  return { rule, kind, targets, sources, stateHash };
}

function analysis(
  status: VisibleBoardAnalysis["status"],
  proofs: readonly VisibleBoardProof[],
): VisibleBoardAnalysis {
  return { status, proofs, searchedNodes: 10, stateHash };
}

const reveal = {
  seq: 1,
  elapsedMs: 20,
  actionType: "REVEAL" as const,
  cellIndex: 4,
  physicalClicks: 1,
  preStateHash: "before",
  postStateHash: "after",
  accepted: true,
};

it("deduplicates targets and prefers the simplest proof", () => {
  const suggestions = dedupeReviewSuggestions(3, [
    proof("CSP_MINE", "MINE", [4], [0, 1, 2]),
    proof("SINGLE_MINE", "MINE", [4], [1]),
    proof("SUBSET_SAFE", "SAFE", [5], [1, 2]),
    proof("SUBSET_SAFE", "SAFE", [5], [1, 2]),
  ]);
  expect(suggestions).toHaveLength(2);
  expect(suggestions[0]).toMatchObject({ cellIndex: 4, row: 2, column: 2, action: "FLAG" });
  expect(suggestions[0]?.proof.rule).toBe("SINGLE_MINE");
});

it("turns a proven safe wrong flag into an executable unflag-then-reveal suggestion", () => {
  const suggestions = dedupeReviewSuggestions(3, [
    proof("SINGLE_SAFE", "SAFE", [5]),
    proof("SINGLE_MINE", "MINE", [6]),
  ], undefined, [5, 6]);
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0]).toMatchObject({ cellIndex: 5, action: "UNFLAG_THEN_REVEAL" });
});

describe("explainReplayStep", () => {
  it("classifies a provable mine even when the global search is partial", () => {
    const result = explainReplayStep({
      width: 3,
      analysis: analysis("PARTIAL", [proof("SINGLE_MINE", "MINE", [4])]),
      action: reveal,
      accepted: true,
      hitMine: true,
      outcome: "LOST",
      isFirstAcceptedReveal: false,
      wrongFlagChord: false,
    });
    expect(result.verdict).toBe("PROVABLE_MINE_REVEALED");
  });

  it("separates an undetermined target from deterministic moves elsewhere", () => {
    const result = explainReplayStep({
      width: 3,
      analysis: analysis("COMPLETE", [proof("SINGLE_SAFE", "SAFE", [5])]),
      action: reveal,
      accepted: true,
      hitMine: false,
      outcome: "PLAYING",
      isFirstAcceptedReveal: false,
      wrongFlagChord: false,
    });
    expect(result.verdict).toBe("UNDETERMINED_TARGET_WITH_ALTERNATIVES");
    expect(result.safeSuggestions.map(({ cellIndex }) => cellIndex)).toEqual([5]);
  });

  it("does not call an incomplete analysis a required guess", () => {
    const result = explainReplayStep({
      width: 3,
      analysis: analysis("PARTIAL", []),
      action: reveal,
      accepted: true,
      hitMine: true,
      outcome: "LOST",
      isFirstAcceptedReveal: false,
      wrongFlagChord: false,
    });
    expect(result.verdict).toBe("ANALYSIS_PARTIAL");
  });

  it("explains the first accepted reveal as protected by the game rule", () => {
    const result = explainReplayStep({
      width: 9,
      analysis: analysis("COMPLETE", []),
      action: reveal,
      accepted: true,
      hitMine: false,
      outcome: "PLAYING",
      isFirstAcceptedReveal: true,
      wrongFlagChord: false,
    });
    expect(result.verdict).toBe("FIRST_CLICK_PROTECTED");
  });

  it("separates a complete board with no forced move from partial analysis", () => {
    const result = explainReplayStep({
      width: 3,
      analysis: analysis("COMPLETE", []),
      action: reveal,
      accepted: true,
      hitMine: false,
      outcome: "PLAYING",
      isFirstAcceptedReveal: false,
      wrongFlagChord: false,
    });
    expect(result.verdict).toBe("NO_DETERMINISTIC_MOVE");
  });

  it("stops teaching when the visible state is contradictory", () => {
    const result = explainReplayStep({
      width: 3,
      analysis: analysis("CONTRADICTION", []),
      action: reveal,
      accepted: true,
      hitMine: false,
      outcome: "PLAYING",
      isFirstAcceptedReveal: false,
      wrongFlagChord: false,
    });
    expect(result.verdict).toBe("ANALYSIS_CONTRADICTION");
  });

  it("gives wrong-flag chord causality priority over generic loss", () => {
    const result = explainReplayStep({
      width: 3,
      analysis: analysis("COMPLETE", []),
      action: { ...reveal, actionType: "CHORD" },
      accepted: true,
      hitMine: true,
      outcome: "LOST",
      isFirstAcceptedReveal: false,
      wrongFlagChord: true,
    });
    expect(result.verdict).toBe("WRONG_FLAG_CHORD_CHAIN");
  });

  it("never calls a successfully revealed safe cell a mine when flags were omitted", () => {
    const result = explainReplayStep({
      width: 9,
      analysis: analysis("COMPLETE", [
        proof("CSP_MINE", "MINE", [4], [1, 2, 3]),
        proof("CSP_MINE", "MINE", [10, 11, 12], [1, 2, 3]),
      ]),
      action: reveal,
      accepted: true,
      hitMine: false,
      outcome: "WON",
      isFirstAcceptedReveal: false,
      wrongFlagChord: false,
    });

    expect(result.verdict).toBe("ANALYSIS_CONTRADICTION");
  });

  it("does not judge a rejected high-speed input as a logical mistake", () => {
    const result = explainReplayStep({
      width: 9,
      analysis: analysis("COMPLETE", [proof("CSP_MINE", "MINE", [4])]),
      action: { ...reveal, accepted: false, rejectReason: "ALREADY_REVEALED" },
      accepted: false,
      hitMine: false,
      outcome: "PLAYING",
      isFirstAcceptedReveal: false,
      wrongFlagChord: false,
    });

    expect(result.verdict).toBe("ACTION_NOT_APPLIED");
  });

  it("recognizes a safe reveal beside an unflagged 2-3-2 mine group", () => {
    const result = explainReplayStep({
      width: 5,
      analysis: analysis("COMPLETE", [
        proof("CSP_SAFE", "SAFE", [0, 4], [6, 7, 8]),
        proof("CSP_MINE", "MINE", [1, 2, 3], [6, 7, 8]),
      ]),
      action: reveal,
      accepted: true,
      hitMine: false,
      outcome: "WON",
      isFirstAcceptedReveal: false,
      wrongFlagChord: false,
    });

    expect(result.verdict).toBe("CORRECT_SAFE_REVEAL");
    expect(result.mineSuggestions.map(({ cellIndex }) => cellIndex)).toEqual([1, 2, 3]);
  });

  it.each([
    ["SAFE", "CORRECT_WRONG_FLAG_REMOVED"],
    ["MINE", "PROVABLE_MINE_UNFLAGGED"],
  ] as const)("classifies removing a %s proof flag", (kind, verdict) => {
    const result = explainReplayStep({
      width: 3,
      analysis: analysis("COMPLETE", [proof(kind === "SAFE" ? "SINGLE_SAFE" : "SINGLE_MINE", kind, [4])]),
      action: { ...reveal, actionType: "TOGGLE_FLAG" },
      accepted: true,
      hitMine: false,
      flagged: false,
      outcome: "PLAYING",
      isFirstAcceptedReveal: false,
      wrongFlagChord: false,
    });
    expect(result.verdict).toBe(verdict);
  });

  it("does not invent a judgment when an unproven flag is removed", () => {
    const result = explainReplayStep({
      width: 3,
      analysis: analysis("COMPLETE", []),
      action: { ...reveal, actionType: "TOGGLE_FLAG" },
      accepted: true,
      hitMine: false,
      flagged: false,
      outcome: "PLAYING",
      isFirstAcceptedReveal: false,
      wrongFlagChord: false,
    });
    expect(result.verdict).toBe("UNDETERMINED_FLAG_REMOVED");
  });
});
