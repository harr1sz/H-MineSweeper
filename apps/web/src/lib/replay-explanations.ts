import type {
  VisibleBoardAnalysis,
  VisibleBoardProof,
} from "@h-minesweeper/game-core";
import type { SoloReplayV1 } from "./solo-history";

export type ReviewConceptId =
  | "FOUNDATIONS_FORCED_RULES"
  | "REASONING_REMAINING_MINES"
  | "REASONING_SUBSETS"
  | "REASONING_UNCERTAINTY"
  | "PRACTICE_SAFE_CHORD";

export type ReviewStepVerdict =
  | "PROVABLE_MINE_REVEALED"
  | "PROVABLE_SAFE_FLAGGED"
  | "CORRECT_SAFE_REVEAL"
  | "CORRECT_MINE_FLAG"
  | "UNDETERMINED_TARGET_WITH_ALTERNATIVES"
  | "NO_DETERMINISTIC_MOVE"
  | "UNCERTAIN_LOSS"
  | "WRONG_FLAG_CHORD_CHAIN"
  | "FIRST_CLICK_PROTECTED"
  | "ANALYSIS_PARTIAL"
  | "ANALYSIS_CONTRADICTION"
  | "ACTION_NOT_APPLIED"
  | "CORRECT_WRONG_FLAG_REMOVED"
  | "PROVABLE_MINE_UNFLAGGED"
  | "UNDETERMINED_FLAG_REMOVED";

export interface ReviewActionSuggestion {
  readonly cellIndex: number;
  readonly row: number;
  readonly column: number;
  readonly action: "REVEAL" | "FLAG" | "UNFLAG_THEN_REVEAL";
  readonly proof: VisibleBoardProof;
  readonly conceptId: ReviewConceptId;
}

export interface HumanProofChain {
  readonly rule: VisibleBoardProof["rule"];
  readonly kind: VisibleBoardProof["kind"];
  readonly sourceCells: readonly number[];
  readonly targetCells: readonly number[];
  readonly stateHash: string;
}

export interface ReviewStepExplanation {
  readonly verdict: ReviewStepVerdict;
  readonly targetProof?: HumanProofChain;
  readonly safeSuggestions: readonly ReviewActionSuggestion[];
  readonly mineSuggestions: readonly ReviewActionSuggestion[];
}

type ReplayAction = SoloReplayV1["actions"][number];

const PROOF_PRIORITY: Readonly<Record<VisibleBoardProof["rule"], number>> = {
  SINGLE_SAFE: 0,
  SINGLE_MINE: 0,
  SUBSET_SAFE: 1,
  SUBSET_MINE: 1,
  GLOBAL_SAFE: 2,
  GLOBAL_MINE: 2,
  CSP_SAFE: 3,
  CSP_MINE: 3,
};

function compareProofs(left: VisibleBoardProof, right: VisibleBoardProof): number {
  return (
    PROOF_PRIORITY[left.rule] - PROOF_PRIORITY[right.rule] ||
    left.sources.length - right.sources.length ||
    left.targets.length - right.targets.length ||
    left.sources.join(",").localeCompare(right.sources.join(","))
  );
}

export function learningConceptForReview(input: {
  readonly verdict?: ReviewStepVerdict;
  readonly proof?: Pick<VisibleBoardProof, "rule">;
}): ReviewConceptId {
  if (input.verdict === "WRONG_FLAG_CHORD_CHAIN") return "PRACTICE_SAFE_CHORD";
  if (input.verdict === "UNCERTAIN_LOSS" || input.verdict === "NO_DETERMINISTIC_MOVE" || input.verdict === "UNDETERMINED_FLAG_REMOVED") {
    return "REASONING_UNCERTAINTY";
  }
  const proof = input.proof;
  if (!proof) return "FOUNDATIONS_FORCED_RULES";
  if (proof.rule.startsWith("SUBSET")) return "REASONING_SUBSETS";
  if (proof.rule.startsWith("GLOBAL") || proof.rule.startsWith("CSP")) {
    return "REASONING_REMAINING_MINES";
  }
  return "FOUNDATIONS_FORCED_RULES";
}

function suggestionFor(
  width: number,
  cellIndex: number,
  proof: VisibleBoardProof,
  playerClaims: ReadonlySet<number>,
): ReviewActionSuggestion {
  return {
    cellIndex,
    row: Math.floor(cellIndex / width) + 1,
    column: (cellIndex % width) + 1,
    action: proof.kind === "SAFE"
      ? playerClaims.has(cellIndex) ? "UNFLAG_THEN_REVEAL" : "REVEAL"
      : "FLAG",
    proof,
    conceptId: learningConceptForReview({ proof }),
  };
}

/**
 * Converts solver proofs into unique user actions. A target can be derived by
 * several rules; the shortest, most teachable proof wins.
 */
export function dedupeReviewSuggestions(
  width: number,
  proofs: readonly VisibleBoardProof[],
  excludedCell?: number,
  playerClaims: readonly number[] = [],
): readonly ReviewActionSuggestion[] {
  const bestByConclusion = new Map<string, ReviewActionSuggestion>();
  const claims = new Set(playerClaims);
  for (const proof of [...proofs].sort(compareProofs)) {
    for (const target of proof.targets) {
      if (target === excludedCell) continue;
      if (proof.kind === "MINE" && claims.has(target)) continue;
      const key = `${proof.kind}:${target}`;
      if (!bestByConclusion.has(key)) {
        bestByConclusion.set(key, suggestionFor(width, target, proof, claims));
      }
    }
  }
  return [...bestByConclusion.values()].sort((left, right) =>
    compareProofs(left.proof, right.proof) || left.cellIndex - right.cellIndex,
  );
}

function bestTargetProof(
  analysis: VisibleBoardAnalysis,
  target: number,
): VisibleBoardProof | undefined {
  return analysis.proofs
    .filter((proof) => proof.targets.includes(target))
    .sort(compareProofs)[0];
}

function toHumanProofChain(proof: VisibleBoardProof): HumanProofChain {
  return {
    rule: proof.rule,
    kind: proof.kind,
    sourceCells: proof.sources,
    targetCells: proof.targets,
    stateHash: proof.stateHash,
  };
}

export function explainReplayStep(input: {
  readonly width: number;
  readonly analysis: VisibleBoardAnalysis;
  readonly action: ReplayAction;
  readonly accepted: boolean;
  readonly hitMine: boolean;
  readonly flagged?: boolean;
  readonly outcome: "READY" | "PLAYING" | "WON" | "LOST";
  readonly isFirstAcceptedReveal: boolean;
  readonly wrongFlagChord: boolean;
  readonly playerClaims?: readonly number[];
}): ReviewStepExplanation {
  const { analysis, action } = input;
  const targetProof = bestTargetProof(analysis, action.cellIndex);
  const suggestions = dedupeReviewSuggestions(
    input.width,
    analysis.proofs,
    action.cellIndex,
    input.playerClaims ?? [],
  );
  const base = {
    ...(targetProof ? { targetProof: toHumanProofChain(targetProof) } : {}),
    safeSuggestions: suggestions.filter(({ action: suggestionAction }) => suggestionAction === "REVEAL" || suggestionAction === "UNFLAG_THEN_REVEAL"),
    mineSuggestions: suggestions.filter(({ action: suggestionAction }) => suggestionAction === "FLAG"),
  };

  if (analysis.status === "CONTRADICTION") {
    return { verdict: "ANALYSIS_CONTRADICTION", ...base };
  }
  if (input.wrongFlagChord) {
    return { verdict: "WRONG_FLAG_CHORD_CHAIN", ...base };
  }
  if (input.isFirstAcceptedReveal && input.accepted) {
    return { verdict: "FIRST_CLICK_PROTECTED", ...base };
  }
  if (!input.accepted) {
    return { verdict: "ACTION_NOT_APPLIED", ...base };
  }
  if (targetProof && action.actionType === "REVEAL") {
    // The solver reasons from the action's pre-state, while hitMine is the
    // independently replayed result of that action. Never blame the player
    // when those two sources disagree: omitted flags are valid play, and a
    // successful reveal cannot simultaneously be a mine reveal.
    if ((targetProof.kind === "MINE") !== input.hitMine) {
      return { verdict: "ANALYSIS_CONTRADICTION", ...base };
    }
    return {
      verdict: targetProof.kind === "MINE"
        ? "PROVABLE_MINE_REVEALED"
        : "CORRECT_SAFE_REVEAL",
      ...base,
    };
  }
  if (
    targetProof &&
    action.actionType === "TOGGLE_FLAG" &&
    input.flagged === true
  ) {
    return {
      verdict: targetProof.kind === "SAFE"
        ? "PROVABLE_SAFE_FLAGGED"
        : "CORRECT_MINE_FLAG",
      ...base,
    };
  }
  if (
    action.actionType === "TOGGLE_FLAG" &&
    input.flagged === false
  ) {
    if (targetProof?.kind === "SAFE") {
      return { verdict: "CORRECT_WRONG_FLAG_REMOVED", ...base };
    }
    if (targetProof?.kind === "MINE") {
      return { verdict: "PROVABLE_MINE_UNFLAGGED", ...base };
    }
    return { verdict: "UNDETERMINED_FLAG_REMOVED", ...base };
  }
  if (analysis.status === "PARTIAL") {
    return { verdict: "ANALYSIS_PARTIAL", ...base };
  }
  if (input.hitMine || input.outcome === "LOST") {
    return { verdict: "UNCERTAIN_LOSS", ...base };
  }
  if (suggestions.length > 0) {
    return { verdict: "UNDETERMINED_TARGET_WITH_ALTERNATIVES", ...base };
  }
  return { verdict: "NO_DETERMINISTIC_MOVE", ...base };
}

export function cellCoordinates(width: number, cellIndex: number): {
  readonly row: number;
  readonly column: number;
} {
  return {
    row: Math.floor(cellIndex / width) + 1,
    column: (cellIndex % width) + 1,
  };
}
