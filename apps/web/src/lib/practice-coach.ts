import {
  CELL_FLAGGED,
  CELL_REVEALED,
  analyzeVisibleBoard,
  getNeighborIndices,
  hashVisibleBoardState,
  type GameState,
  type VisibleBoardAnalysis,
  type VisibleBoardProof,
  type VisibleBoardState,
} from "@h-minesweeper/game-core";

export type PracticeAssistMode = "COACH" | "AUTO_MARK_MINES";
export type SoloSessionKind = "STANDARD" | "GUIDED_PRACTICE";

export type CoachAction = "REVEAL" | "FLAG" | "UNFLAG";

export type CoachSuggestionStatus =
  | "READY"
  | "NO_FORCED_MOVE"
  | "PARTIAL"
  | "CONTRADICTION"
  | "ERROR";

export const PRACTICE_COACH_NODE_BUDGET = 100_000 as const;
export const PRACTICE_COACH_FULL_SEARCH_FRONTIER_LIMIT = 64 as const;

/**
 * Live analysis is intentionally limited to the visible board. Do not add a
 * Board, seed, mine map, replay, or terminal-state field to this contract.
 */
export interface CoachRequest {
  readonly requestId: number;
  readonly visibleState: VisibleBoardState;
}

export interface CoachMineAction {
  readonly cellIndex: number;
  readonly proof: VisibleBoardProof;
}

export interface CoachSafeAction {
  readonly action: "REVEAL" | "UNFLAG";
  readonly cellIndex: number;
  readonly proof: VisibleBoardProof;
}

export interface CoachSuggestion {
  readonly requestId: number;
  readonly stateHash: string;
  readonly status: CoachSuggestionStatus;
  /** Every currently provable, not-yet-claimed mine in deterministic order. */
  readonly mineActions: readonly CoachMineAction[];
  /** Every currently provable safe reveal or wrong-flag correction. */
  readonly safeActions: readonly CoachSafeAction[];
  readonly action?: CoachAction;
  readonly cellIndex?: number;
  readonly proof?: VisibleBoardProof;
}

interface CoachCandidate {
  readonly action: CoachAction;
  readonly cellIndex: number;
  readonly proof: VisibleBoardProof;
}

const INVALID_STATE_HASH = "invalid";

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

const ACTION_PRIORITY: Readonly<Record<CoachAction, number>> = {
  UNFLAG: 0,
  FLAG: 1,
  REVEAL: 2,
};

const COACH_STATUSES = new Set<CoachSuggestionStatus>([
  "READY",
  "NO_FORCED_MOVE",
  "PARTIAL",
  "CONTRADICTION",
  "ERROR",
]);

const COACH_ACTIONS = new Set<CoachAction>(["REVEAL", "FLAG", "UNFLAG"]);

const PROOF_RULES = new Set<VisibleBoardProof["rule"]>([
  "SINGLE_SAFE",
  "SINGLE_MINE",
  "SUBSET_SAFE",
  "SUBSET_MINE",
  "GLOBAL_SAFE",
  "GLOBAL_MINE",
  "CSP_SAFE",
  "CSP_MINE",
]);

const PARTIAL_SAFE_RULES = new Set<VisibleBoardProof["rule"]>([
  "SINGLE_SAFE",
  "SINGLE_MINE",
  "SUBSET_SAFE",
  "SUBSET_MINE",
]);

function compareNumberArrays(left: readonly number[], right: readonly number[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function compareCandidates(left: CoachCandidate, right: CoachCandidate): number {
  return (
    PROOF_PRIORITY[left.proof.rule] - PROOF_PRIORITY[right.proof.rule] ||
    left.proof.sources.length - right.proof.sources.length ||
    left.proof.targets.length - right.proof.targets.length ||
    ACTION_PRIORITY[left.action] - ACTION_PRIORITY[right.action] ||
    left.cellIndex - right.cellIndex ||
    compareNumberArrays(left.proof.sources, right.proof.sources) ||
    compareNumberArrays(left.proof.targets, right.proof.targets)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isSafeIntegerArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(Number.isSafeInteger);
}

function parseProof(value: unknown): VisibleBoardProof | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind",
    "rule",
    "sources",
    "stateHash",
    "targets",
  ])) {
    return null;
  }
  if (
    !PROOF_RULES.has(value.rule as VisibleBoardProof["rule"]) ||
    (value.kind !== "SAFE" && value.kind !== "MINE") ||
    !isSafeIntegerArray(value.sources) ||
    !isSafeIntegerArray(value.targets) ||
    value.targets.length === 0 ||
    value.sources.some((index) => index < 0) ||
    value.targets.some((index) => index < 0) ||
    typeof value.stateHash !== "string" ||
    !/^[a-f0-9]{8}$/u.test(value.stateHash)
  ) {
    return null;
  }
  return {
    rule: value.rule as VisibleBoardProof["rule"],
    kind: value.kind,
    sources: [...value.sources],
    targets: [...value.targets],
    stateHash: value.stateHash,
  };
}

/**
 * Validates the worker response before it can be shown or applied. The live
 * request remains the privacy boundary; this parser makes malformed worker
 * messages fail closed instead of reaching the board or replay log.
 */
export function parseCoachSuggestion(value: unknown): CoachSuggestion | null {
  if (!isRecord(value)) return null;
  const allowedKeys = new Set([
    "action",
    "cellIndex",
    "mineActions",
    "proof",
    "requestId",
    "safeActions",
    "stateHash",
    "status",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  if (
    !Number.isSafeInteger(value.requestId) ||
    (value.requestId as number) < 0 ||
    typeof value.stateHash !== "string" ||
    !/^[a-f0-9]{8}$/u.test(value.stateHash) ||
    !COACH_STATUSES.has(value.status as CoachSuggestionStatus) ||
    !Array.isArray(value.mineActions) ||
    !Array.isArray(value.safeActions)
  ) {
    return null;
  }

  const safeActions: CoachSafeAction[] = [];
  const seenSafeActions = new Set<number>();
  for (const rawAction of value.safeActions) {
    if (!isRecord(rawAction) || !hasExactKeys(rawAction, ["action", "cellIndex", "proof"])) return null;
    const action = rawAction.action;
    const cellIndex = rawAction.cellIndex;
    const proof = parseProof(rawAction.proof);
    if (
      (action !== "REVEAL" && action !== "UNFLAG") ||
      !Number.isSafeInteger(cellIndex) ||
      (cellIndex as number) < 0 ||
      seenSafeActions.has(cellIndex as number) ||
      !proof ||
      proof.kind !== "SAFE" ||
      proof.stateHash !== value.stateHash ||
      !proof.targets.includes(cellIndex as number)
    ) {
      return null;
    }
    seenSafeActions.add(cellIndex as number);
    safeActions.push({ action, cellIndex: cellIndex as number, proof });
  }

  const mineActions: CoachMineAction[] = [];
  const seenMineActions = new Set<number>();
  for (const rawAction of value.mineActions) {
    if (!isRecord(rawAction) || !hasExactKeys(rawAction, ["cellIndex", "proof"])) return null;
    const cellIndex = rawAction.cellIndex;
    const proof = parseProof(rawAction.proof);
    if (
      !Number.isSafeInteger(cellIndex) ||
      (cellIndex as number) < 0 ||
      seenMineActions.has(cellIndex as number) ||
      !proof ||
      proof.kind !== "MINE" ||
      proof.stateHash !== value.stateHash ||
      !proof.targets.includes(cellIndex as number)
    ) {
      return null;
    }
    seenMineActions.add(cellIndex as number);
    mineActions.push({ cellIndex: cellIndex as number, proof });
  }

  const optionalActionFields = [value.action, value.cellIndex, value.proof];
  const hasAnyActionField = optionalActionFields.some((field) => field !== undefined);
  const hasEveryActionField = optionalActionFields.every((field) => field !== undefined);
  if (hasAnyActionField !== hasEveryActionField) return null;
  if (!hasEveryActionField) {
    if (value.status === "READY") return null;
    return {
      requestId: value.requestId as number,
      stateHash: value.stateHash,
      status: value.status as CoachSuggestionStatus,
      mineActions,
      safeActions,
    };
  }

  const action = value.action as CoachAction;
  const cellIndex = value.cellIndex as number;
  const proof = parseProof(value.proof);
  if (
    !COACH_ACTIONS.has(action) ||
    !Number.isSafeInteger(cellIndex) ||
    cellIndex < 0 ||
    !proof ||
    proof.stateHash !== value.stateHash ||
    !proof.targets.includes(cellIndex) ||
    (action === "FLAG" ? proof.kind !== "MINE" : proof.kind !== "SAFE") ||
    (value.status !== "READY" && value.status !== "PARTIAL")
  ) {
    return null;
  }
  return {
    requestId: value.requestId as number,
    stateHash: value.stateHash,
    status: value.status as CoachSuggestionStatus,
    mineActions,
    safeActions,
    action,
    cellIndex,
    proof,
  };
}

function parseVisibleBoardState(value: unknown): VisibleBoardState | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "clues",
    "height",
    "playerClaims",
    "totalMines",
    "width",
  ])) {
    return null;
  }
  const { width, height, totalMines, clues, playerClaims } = value;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(totalMines) ||
    (width as number) <= 0 ||
    (height as number) <= 0 ||
    (totalMines as number) < 0 ||
    !isSafeIntegerArray(clues) ||
    !isSafeIntegerArray(playerClaims)
  ) {
    return null;
  }
  const cellCount = (width as number) * (height as number);
  if (
    !Number.isSafeInteger(cellCount) ||
    clues.length !== cellCount ||
    (totalMines as number) > cellCount ||
    clues.some((clue) => clue < -1 || clue > 8) ||
    playerClaims.some((index) => index < 0 || index >= cellCount || clues[index] !== -1) ||
    new Set(playerClaims).size !== playerClaims.length
  ) {
    return null;
  }
  return {
    width: width as number,
    height: height as number,
    totalMines: totalMines as number,
    clues: [...clues],
    playerClaims: [...playerClaims].sort((left, right) => left - right),
  };
}

/**
 * Rejects fields outside the live-coach boundary and clones the accepted
 * payload before analysis. This means even an untyped caller cannot smuggle
 * hidden board truth into the worker's solver input.
 */
export function parseCoachRequest(value: unknown): CoachRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["requestId", "visibleState"])) {
    return null;
  }
  const visibleState = parseVisibleBoardState(value.visibleState);
  if (!Number.isSafeInteger(value.requestId) || (value.requestId as number) < 0 || !visibleState) {
    return null;
  }
  return { requestId: value.requestId as number, visibleState };
}

/** Creates an exact, structured-clone-safe request for the coach worker. */
export function createCoachRequest(
  requestId: number,
  visibleState: VisibleBoardState,
): CoachRequest {
  const request = parseCoachRequest({ requestId, visibleState });
  if (!request) throw new TypeError("Invalid visible board state");
  return request;
}

/**
 * Converts a live playing state without copying its Board, seed, mine map, or
 * hidden clue values. Terminal states are rejected because a detonated cell is
 * not a live clue.
 */
export function visibleBoardStateForPractice(state: GameState): VisibleBoardState {
  if (state.outcome !== "PLAYING") {
    throw new TypeError("Practice analysis requires a playing game state");
  }
  const clues = Array.from(state.visibility, (visibility, index) =>
    visibility === CELL_REVEALED ? (state.board.adjacent[index] ?? 0) : -1,
  );
  const playerClaims = Array.from(state.visibility, (visibility, index) =>
    visibility === CELL_FLAGGED ? index : -1,
  ).filter((index) => index >= 0);
  return {
    width: state.board.spec.width,
    height: state.board.spec.height,
    totalMines: state.board.spec.mines,
    clues,
    playerClaims,
  };
}

function candidateForTarget(
  proof: VisibleBoardProof,
  cellIndex: number,
  claims: ReadonlySet<number>,
): CoachCandidate | null {
  if (proof.kind === "SAFE") {
    return {
      action: claims.has(cellIndex) ? "UNFLAG" : "REVEAL",
      cellIndex,
      proof,
    };
  }
  if (claims.has(cellIndex)) return null;
  return { action: "FLAG", cellIndex, proof };
}

function eligibleProofs(
  analysis: VisibleBoardAnalysis,
): readonly VisibleBoardProof[] {
  return analysis.status === "PARTIAL"
    ? analysis.proofs.filter(({ rule }) => PARTIAL_SAFE_RULES.has(rule))
    : analysis.proofs;
}

function collectCandidates(
  visibleState: VisibleBoardState,
  analysis: VisibleBoardAnalysis,
): readonly CoachCandidate[] {
  const claims = new Set(visibleState.playerClaims);
  const candidates: CoachCandidate[] = [];
  for (const proof of eligibleProofs(analysis)) {
    if (proof.stateHash !== analysis.stateHash) continue;
    for (const cellIndex of proof.targets) {
      const candidate = candidateForTarget(proof, cellIndex, claims);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort(compareCandidates);
}

function selectCandidate(candidates: readonly CoachCandidate[]): CoachCandidate | null {
  return candidates[0] ?? null;
}

function collectMineActions(
  candidates: readonly CoachCandidate[],
): readonly CoachMineAction[] {
  const seen = new Set<number>();
  const mineActions: CoachMineAction[] = [];
  for (const candidate of candidates) {
    if (candidate.action !== "FLAG" || seen.has(candidate.cellIndex)) continue;
    seen.add(candidate.cellIndex);
    mineActions.push({ cellIndex: candidate.cellIndex, proof: candidate.proof });
  }
  return mineActions;
}

function collectSafeActions(
  candidates: readonly CoachCandidate[],
): readonly CoachSafeAction[] {
  const seen = new Set<number>();
  const safeActions: CoachSafeAction[] = [];
  for (const candidate of candidates) {
    if (candidate.action === "FLAG" || seen.has(candidate.cellIndex)) continue;
    seen.add(candidate.cellIndex);
    safeActions.push({
      action: candidate.action,
      cellIndex: candidate.cellIndex,
      proof: candidate.proof,
    });
  }
  return safeActions;
}

function hasConflictingProofs(proofs: readonly VisibleBoardProof[]): boolean {
  const conclusionByTarget = new Map<number, VisibleBoardProof["kind"]>();
  for (const proof of proofs) {
    for (const target of proof.targets) {
      const existing = conclusionByTarget.get(target);
      if (existing !== undefined && existing !== proof.kind) return true;
      conclusionByTarget.set(target, proof.kind);
    }
  }
  return false;
}

function hasPlayerClaimContradiction(state: VisibleBoardState): boolean {
  if (state.playerClaims.length > state.totalMines) return true;
  const claims = new Set(state.playerClaims);
  for (let source = 0; source < state.clues.length; source += 1) {
    const clue = state.clues[source];
    if (clue === undefined || clue < 0) continue;
    const sourceRow = Math.floor(source / state.width);
    const sourceColumn = source % state.width;
    let adjacentClaims = 0;
    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
        if (rowOffset === 0 && columnOffset === 0) continue;
        const row = sourceRow + rowOffset;
        const column = sourceColumn + columnOffset;
        if (row < 0 || row >= state.height || column < 0 || column >= state.width) continue;
        if (claims.has(row * state.width + column)) adjacentClaims += 1;
      }
    }
    if (adjacentClaims > clue) return true;
  }
  return false;
}

function visibleFrontierSize(state: VisibleBoardState): number {
  const frontier = new Set<number>();
  for (let source = 0; source < state.clues.length; source += 1) {
    if ((state.clues[source] ?? -1) < 0) continue;
    for (const neighbor of getNeighborIndices(state.width, state.height, source)) {
      if ((state.clues[neighbor] ?? -1) < 0) frontier.add(neighbor);
    }
  }
  return frontier.size;
}

/** Maps a solver result to one deterministic, explainable next action. */
export function coachSuggestionFromAnalysis(
  request: CoachRequest,
  analysis: VisibleBoardAnalysis,
): CoachSuggestion {
  const currentHash = hashVisibleBoardState(request.visibleState);
  if (analysis.stateHash !== currentHash) {
    return {
      requestId: request.requestId,
      stateHash: currentHash,
      status: "ERROR",
      mineActions: [],
      safeActions: [],
    };
  }
  if (
    analysis.status === "CONTRADICTION" ||
    hasConflictingProofs(analysis.proofs) ||
    hasPlayerClaimContradiction(request.visibleState)
  ) {
    return {
      requestId: request.requestId,
      stateHash: currentHash,
      status: "CONTRADICTION",
      mineActions: [],
      safeActions: [],
    };
  }
  const candidates = collectCandidates(request.visibleState, analysis);
  const candidate = selectCandidate(candidates);
  const mineActions = collectMineActions(candidates);
  const safeActions = collectSafeActions(candidates);
  if (analysis.status === "PARTIAL") {
    return {
      requestId: request.requestId,
      stateHash: currentHash,
      status: "PARTIAL",
      mineActions,
      safeActions,
      ...(candidate ? {
        action: candidate.action,
        cellIndex: candidate.cellIndex,
        proof: candidate.proof,
      } : {}),
    };
  }
  if (!candidate) {
    return {
      requestId: request.requestId,
      stateHash: currentHash,
      status: "NO_FORCED_MOVE",
      mineActions,
      safeActions,
    };
  }
  return {
    requestId: request.requestId,
    stateHash: currentHash,
    status: "READY",
    mineActions,
    safeActions,
    action: candidate.action,
    cellIndex: candidate.cellIndex,
    proof: candidate.proof,
  };
}

/** Pure worker entry point, also used by focused contract tests. */
export function runCoachRequest(value: unknown): CoachSuggestion {
  const request = parseCoachRequest(value);
  if (!request) {
    const requestId = isRecord(value) && Number.isSafeInteger(value.requestId) &&
      (value.requestId as number) >= 0
      ? value.requestId as number
      : 0;
    return {
      requestId,
      stateHash: INVALID_STATE_HASH,
      status: "ERROR",
      mineActions: [],
      safeActions: [],
    };
  }
  try {
    // The coach promises SINGLE and SUBSET guidance before CSP. A one-node
    // pass already computes those sound local deductions, so return them as
    // an honest PARTIAL result instead of making a large board wait for an
    // exhaustive frontier search it does not need for the next action.
    const localSuggestion = coachSuggestionFromAnalysis(
      request,
      analyzeVisibleBoard(request.visibleState, 1),
    );
    if (
      localSuggestion.status === "CONTRADICTION" ||
      visibleFrontierSize(request.visibleState) >
        PRACTICE_COACH_FULL_SEARCH_FRONTIER_LIMIT
    ) {
      return localSuggestion;
    }
    return coachSuggestionFromAnalysis(
      request,
      analyzeVisibleBoard(request.visibleState, PRACTICE_COACH_NODE_BUDGET),
    );
  } catch {
    return {
      requestId: request.requestId,
      stateHash: hashVisibleBoardState(request.visibleState),
      status: "ERROR",
      mineActions: [],
      safeActions: [],
    };
  }
}

/**
 * Validates the complete auto-mark batch against one immutable pre-action
 * visible state. Callers may then synchronously apply the returned flags in
 * order, stopping if any individual game-core toggle is rejected.
 */
export function coachMineActionsForApplication(
  suggestion: CoachSuggestion,
  currentVisibleState: VisibleBoardState,
): readonly CoachMineAction[] {
  if (suggestion.status !== "READY" && suggestion.status !== "PARTIAL") return [];
  const currentHash = hashVisibleBoardState(currentVisibleState);
  if (suggestion.stateHash !== currentHash) return [];
  const claims = new Set(currentVisibleState.playerClaims);
  const seen = new Set<number>();
  const candidates: CoachCandidate[] = [];
  for (const mineAction of suggestion.mineActions) {
    const { cellIndex, proof } = mineAction;
    if (
      !Number.isSafeInteger(cellIndex) ||
      cellIndex < 0 ||
      cellIndex >= currentVisibleState.clues.length ||
      currentVisibleState.clues[cellIndex] !== -1 ||
      claims.has(cellIndex) ||
      seen.has(cellIndex) ||
      proof.kind !== "MINE" ||
      proof.stateHash !== currentHash ||
      !proof.targets.includes(cellIndex) ||
      (suggestion.status === "PARTIAL" && !PARTIAL_SAFE_RULES.has(proof.rule))
    ) {
      return [];
    }
    seen.add(cellIndex);
    candidates.push({ action: "FLAG", cellIndex, proof });
  }
  candidates.sort(compareCandidates);
  return candidates.map(({ cellIndex, proof }) => ({ cellIndex, proof }));
}

/** Returns whether the worker proved this exact player action before it ran. */
export function isCoachActionProven(
  suggestion: CoachSuggestion,
  currentVisibleState: VisibleBoardState,
  action: CoachAction,
  cellIndex: number,
): boolean {
  const currentHash = hashVisibleBoardState(currentVisibleState);
  if (
    suggestion.stateHash !== currentHash ||
    (suggestion.status !== "READY" && suggestion.status !== "PARTIAL") ||
    !Number.isSafeInteger(cellIndex) ||
    cellIndex < 0 ||
    cellIndex >= currentVisibleState.clues.length ||
    currentVisibleState.clues[cellIndex] !== -1
  ) {
    return false;
  }
  if (action === "FLAG") {
    return coachMineActionsForApplication(suggestion, currentVisibleState)
      .some((mineAction) => mineAction.cellIndex === cellIndex);
  }
  const expectedAction = currentVisibleState.playerClaims.includes(cellIndex)
    ? "UNFLAG"
    : "REVEAL";
  if (action !== expectedAction) return false;
  const safeAction = suggestion.safeActions.find((candidate) =>
    candidate.action === action && candidate.cellIndex === cellIndex
  );
  return Boolean(
    safeAction &&
    safeAction.proof.kind === "SAFE" &&
    safeAction.proof.stateHash === currentHash &&
    safeAction.proof.targets.includes(cellIndex) &&
    (suggestion.status !== "PARTIAL" || PARTIAL_SAFE_RULES.has(safeAction.proof.rule)),
  );
}

/**
 * Proves a chord from its pre-action visible state. Only directly opened
 * covered neighbors need a safe REVEAL proof; cells later exposed by a zero
 * flood are consequences of that reveal and are deliberately not inspected.
 */
export function isCoachChordProven(
  suggestion: CoachSuggestion,
  currentVisibleState: VisibleBoardState,
  sourceIndex: number,
): boolean {
  if (
    !Number.isSafeInteger(sourceIndex) ||
    sourceIndex < 0 ||
    sourceIndex >= currentVisibleState.clues.length
  ) {
    return false;
  }
  const clue = currentVisibleState.clues[sourceIndex];
  if (clue === undefined || clue <= 0) return false;
  const claims = new Set(currentVisibleState.playerClaims);
  const neighbors = getNeighborIndices(
    currentVisibleState.width,
    currentVisibleState.height,
    sourceIndex,
  );
  const adjacentClaimCount = neighbors.filter((index) => claims.has(index)).length;
  if (adjacentClaimCount !== clue) return false;
  const unflaggedCovered = neighbors.filter((index) =>
    currentVisibleState.clues[index] === -1 && !claims.has(index)
  );
  return unflaggedCovered.length > 0 && unflaggedCovered.every((index) =>
    isCoachActionProven(suggestion, currentVisibleState, "REVEAL", index)
  );
}

function hasSameVisibleGeometry(
  initial: VisibleBoardState,
  current: VisibleBoardState,
): boolean {
  return initial.width === current.width &&
    initial.height === current.height &&
    initial.totalMines === current.totalMines &&
    compareNumberArrays(initial.clues, current.clues) === 0;
}

/**
 * Prepares one action from an already validated batch for its current step.
 * Earlier automatic flags change only `playerClaims`; because claims are never
 * solver facts, the same proof remains sound after rebinding its state hash.
 * Any clue change, unexpected flag, missing earlier flag, or reordered step
 * fails closed.
 */
export function coachMineActionForApplicationStep(
  suggestion: CoachSuggestion,
  initialVisibleState: VisibleBoardState,
  currentVisibleState: VisibleBoardState,
  stepIndex: number,
): CoachMineAction | null {
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 0) return null;
  const batch = coachMineActionsForApplication(suggestion, initialVisibleState);
  const action = batch[stepIndex];
  if (!action || !hasSameVisibleGeometry(initialVisibleState, currentVisibleState)) {
    return null;
  }
  const expectedClaims = new Set(initialVisibleState.playerClaims);
  for (let index = 0; index < stepIndex; index += 1) {
    const applied = batch[index];
    if (!applied) return null;
    expectedClaims.add(applied.cellIndex);
  }
  const actualClaims = [...currentVisibleState.playerClaims]
    .sort((left, right) => left - right);
  const expectedClaimIndexes = [...expectedClaims].sort((left, right) => left - right);
  if (
    new Set(actualClaims).size !== actualClaims.length ||
    compareNumberArrays(actualClaims, expectedClaimIndexes) !== 0 ||
    currentVisibleState.clues[action.cellIndex] !== -1 ||
    expectedClaims.has(action.cellIndex)
  ) {
    return null;
  }
  return {
    cellIndex: action.cellIndex,
    proof: {
      ...action.proof,
      stateHash: hashVisibleBoardState(currentVisibleState),
    },
  };
}

/**
 * Final fail-closed check before UI code highlights or applies an action.
 * PARTIAL results are actionable only when backed by local sound rules.
 */
export function isCoachSuggestionApplicable(
  suggestion: CoachSuggestion,
  currentVisibleState: VisibleBoardState,
): boolean {
  if (
    suggestion.action === undefined ||
    suggestion.cellIndex === undefined ||
    suggestion.proof === undefined
  ) {
    return false;
  }
  const currentHash = hashVisibleBoardState(currentVisibleState);
  if (
    suggestion.stateHash !== currentHash ||
    suggestion.proof.stateHash !== currentHash ||
    !suggestion.proof.targets.includes(suggestion.cellIndex) ||
    suggestion.cellIndex < 0 ||
    suggestion.cellIndex >= currentVisibleState.clues.length ||
    currentVisibleState.clues[suggestion.cellIndex] !== -1
  ) {
    return false;
  }
  const claimed = new Set(currentVisibleState.playerClaims).has(suggestion.cellIndex);
  const actionMatchesProof =
    (suggestion.action === "UNFLAG" && suggestion.proof.kind === "SAFE" && claimed) ||
    (suggestion.action === "FLAG" && suggestion.proof.kind === "MINE" && !claimed) ||
    (suggestion.action === "REVEAL" && suggestion.proof.kind === "SAFE" && !claimed);
  if (!actionMatchesProof) return false;
  if (suggestion.status === "READY") return true;
  return suggestion.status === "PARTIAL" && PARTIAL_SAFE_RULES.has(suggestion.proof.rule);
}
