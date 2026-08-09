import {
  CELL_QUESTIONED,
  CELL_REVEALED,
  analyzeVisibleBoard,
  chordCell,
  createBoard,
  createGameState,
  cycleCellMark,
  hashGameState,
  hashVisibleBoardState,
  revealCell,
  toggleFlag,
  type GameState,
  type VisibleBoardAnalysis,
  type VisibleBoardState,
} from "@h-minesweeper/game-core";
import type {
  SoloReplayV1,
  SoloRunRecordV2,
} from "../lib/solo-history";
import { verifySoloReplay } from "../lib/solo-history";

export type ReplayWorkerRequest =
  | {
      readonly requestId: number;
      readonly type: "VERIFY_AND_ANALYZE";
      readonly record: SoloRunRecordV2;
      readonly replay: SoloReplayV1;
      readonly nodeBudgetPerStep?: number;
      readonly totalNodeBudget?: number;
    }
  | {
      readonly requestId: number;
      readonly type: "ANALYZE_STEP";
      readonly record: SoloRunRecordV2;
      readonly replay: SoloReplayV1;
      readonly seq: number;
      readonly nodeBudget?: number;
    }
  | { readonly requestId: number; readonly type: "CANCEL" };

export type ReplayWorkerResponse =
  | { readonly requestId: number; readonly type: "PROGRESS"; readonly completed: number; readonly total: number }
  | { readonly requestId: number; readonly type: "CANCELLED" }
  | {
      readonly requestId: number;
      readonly type: "STEP_RESULT";
      readonly ok: true;
      readonly step: {
        readonly seq: number;
        readonly before: VisibleBoardAnalysis;
        readonly playerClaims: readonly number[];
        readonly accepted: boolean;
        readonly hitMine: boolean;
        readonly outcome: GameState["outcome"];
        readonly revealed: readonly { readonly index: number; readonly value: number }[];
        readonly flagChange?: { readonly index: number; readonly flagged: boolean };
        readonly questionChange?: { readonly index: number; readonly questioned: boolean };
      };
    }
  | {
      readonly requestId: number;
      readonly type: "RESULT";
      readonly ok: true;
      readonly steps: readonly {
        readonly seq: number;
        readonly before: VisibleBoardAnalysis;
        readonly playerClaims: readonly number[];
        readonly accepted: boolean;
        readonly hitMine: boolean;
        readonly outcome: GameState["outcome"];
        readonly revealed: readonly { readonly index: number; readonly value: number }[];
        readonly flagChange?: { readonly index: number; readonly flagged: boolean };
        readonly questionChange?: { readonly index: number; readonly questioned: boolean };
      }[];
      readonly terminal: {
        readonly detonatedMine?: number;
        readonly otherMines: readonly number[];
        readonly correctFlags: readonly number[];
        readonly wrongFlags: readonly number[];
      };
    }
  | { readonly requestId: number; readonly type: "RESULT"; readonly ok: false; readonly errorCode: string; readonly seq?: number };

function visibleState(state: GameState): VisibleBoardState {
  const clues = Array.from(state.visibility, (visibility, index) =>
    visibility === CELL_REVEALED ? (state.board.adjacent[index] ?? 0) : -1,
  );
  const playerClaims = Array.from(state.visibility, (visibility, index) =>
    visibility === 2 ? index : -1,
  ).filter((index) => index >= 0);
  return {
    width: state.board.spec.width,
    height: state.board.spec.height,
    totalMines: state.board.spec.mines,
    clues,
    playerClaims,
  };
}

function failure(requestId: number, errorCode: string, seq?: number): ReplayWorkerResponse {
  return { requestId, type: "RESULT", ok: false, errorCode, ...(seq === undefined ? {} : { seq }) };
}

const cancelledRequests = new Set<number>();

const PROOF_ORDER: Readonly<Record<VisibleBoardAnalysis["proofs"][number]["rule"], number>> = {
  SINGLE_SAFE: 0,
  SINGLE_MINE: 0,
  SUBSET_SAFE: 1,
  SUBSET_MINE: 1,
  GLOBAL_SAFE: 2,
  GLOBAL_MINE: 2,
  CSP_SAFE: 3,
  CSP_MINE: 3,
};

function compactAnalysisForAction(
  analysis: VisibleBoardAnalysis,
  cellIndex: number,
): VisibleBoardAnalysis {
  const ordered = [...analysis.proofs].sort((left, right) =>
    PROOF_ORDER[left.rule] - PROOF_ORDER[right.rule] ||
    left.sources.length - right.sources.length ||
    left.targets.length - right.targets.length,
  );
  const compact = [] as VisibleBoardAnalysis["proofs"][number][];
  const targetProof = ordered.find(({ targets }) => targets.includes(cellIndex));
  if (targetProof) compact.push({ ...targetProof, targets: [cellIndex] });
  const seen = new Set<string>();
  for (const proof of ordered) {
    for (const target of proof.targets) {
      if (target === cellIndex) continue;
      const key = `${proof.kind}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      compact.push({ ...proof, targets: [target] });
      if (seen.size === 3) return { ...analysis, proofs: compact };
    }
  }
  return { ...analysis, proofs: compact };
}

self.addEventListener("message", async (event: MessageEvent<ReplayWorkerRequest>) => {
  const request = event.data;
  if (request.type === "CANCEL") {
    cancelledRequests.add(request.requestId);
    return;
  }
  if (request.type !== "VERIFY_AND_ANALYZE" && request.type !== "ANALYZE_STEP") return;
  const { record, replay, requestId } = request;
  if (record.recordId !== replay.recordId) {
    self.postMessage(failure(requestId, "RECORD_REPLAY_MISMATCH"));
    return;
  }
  try {
    verifySoloReplay(record, replay);
  } catch {
    self.postMessage(failure(requestId, "REPLAY_INTEGRITY_FAILED"));
    return;
  }
  const state = createGameState(createBoard(record.board.spec));
  for (const index of replay.initialFlags) {
    const delta = toggleFlag(state, index);
    if (!delta.accepted) {
      self.postMessage(failure(requestId, "INVALID_INITIAL_FLAG"));
      return;
    }
  }
  for (const index of replay.initialQuestions ?? []) {
    state.visibility[index] = CELL_QUESTIONED;
  }
  const steps: Array<Extract<ReplayWorkerResponse, { type: "RESULT"; ok: true }>["steps"][number]> = [];
  const analysisCache = new Map<string, VisibleBoardAnalysis>();
  let remainingNodeBudget = request.type === "ANALYZE_STEP"
    ? request.nodeBudget ?? 100_000
    : request.totalNodeBudget ?? 5_000_000;
  let detonatedMine: number | undefined;
  for (const action of replay.actions) {
    if (cancelledRequests.has(requestId)) {
      cancelledRequests.delete(requestId);
      self.postMessage({ requestId, type: "CANCELLED" } satisfies ReplayWorkerResponse);
      return;
    }
    if (action.preStateHash !== hashGameState(state)) {
      self.postMessage(failure(requestId, "PRE_STATE_HASH_MISMATCH", action.seq));
      return;
    }
    const visibleBefore = visibleState(state);
    const visibleHash = hashVisibleBoardState(visibleBefore);
    const shouldAnalyze = request.type === "VERIFY_AND_ANALYZE" || action.seq === request.seq;
    let fullBefore = shouldAnalyze ? analysisCache.get(visibleHash) : undefined;
    if (shouldAnalyze && !fullBefore) {
      if (remainingNodeBudget === 0) {
        fullBefore = { status: "PARTIAL", proofs: [], searchedNodes: 0, stateHash: visibleHash };
      } else {
        const requestedStepBudget = request.type === "ANALYZE_STEP" ? request.nodeBudget ?? 100_000 : request.nodeBudgetPerStep ?? 100_000;
        const stepBudget = Math.min(requestedStepBudget, remainingNodeBudget);
        fullBefore = analyzeVisibleBoard(visibleBefore, stepBudget);
        remainingNodeBudget = Math.max(0, remainingNodeBudget - fullBefore.searchedNodes);
      }
      analysisCache.set(visibleHash, fullBefore);
    }
    const delta = action.actionType === "REVEAL"
      ? revealCell(state, action.cellIndex)
      : action.actionType === "TOGGLE_FLAG"
        ? replay.questionMarksEnabled === true
          ? cycleCellMark(state, action.cellIndex)
          : toggleFlag(state, action.cellIndex)
        : chordCell(state, action.cellIndex);
    if (
      delta.accepted !== action.accepted ||
      delta.rejectReason !== action.rejectReason ||
      delta.stateHash !== action.postStateHash
    ) {
      self.postMessage(failure(requestId, "ACTION_REPLAY_MISMATCH", action.seq));
      return;
    }
    if (delta.hitMine) {
      detonatedMine = delta.revealed.find(({ value }) => value < 0)?.index;
    }
    const analyzedStep = fullBefore ? {
      seq: action.seq,
      before: compactAnalysisForAction(fullBefore, action.cellIndex),
      playerClaims: visibleBefore.playerClaims,
      accepted: action.accepted,
      hitMine: delta.hitMine === true,
      outcome: state.outcome,
      revealed: delta.revealed.map(({ index, value }) => ({ index, value })),
      ...(delta.flagged ? { flagChange: delta.flagged } : {}),
      ...(delta.questioned ? { questionChange: delta.questioned } : {}),
    } : undefined;
    if (analyzedStep) steps.push(analyzedStep);
    if (request.type === "ANALYZE_STEP" && action.seq === request.seq && analyzedStep) {
      self.postMessage({ requestId, type: "STEP_RESULT", ok: true, step: analyzedStep } satisfies ReplayWorkerResponse);
      return;
    }
    if (steps.length % 100 === 0) {
      self.postMessage({ requestId, type: "PROGRESS", completed: steps.length, total: replay.actions.length } satisfies ReplayWorkerResponse);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  if (request.type === "ANALYZE_STEP") {
    self.postMessage(failure(requestId, "STEP_NOT_FOUND", request.seq));
    return;
  }
  const mines = Array.from(state.board.mines, (mine, index) => mine === 1 ? index : -1)
    .filter((index) => index >= 0);
  const claims = new Set(visibleState(state).playerClaims);
  self.postMessage({
    requestId,
    type: "RESULT",
    ok: true,
    steps,
    terminal: {
      ...(detonatedMine === undefined ? {} : { detonatedMine }),
      otherMines: mines.filter((index) => index !== detonatedMine),
      correctFlags: mines.filter((index) => claims.has(index)),
      wrongFlags: [...claims].filter((index) => !state.board.mines[index]),
    },
  } satisfies ReplayWorkerResponse);
});
