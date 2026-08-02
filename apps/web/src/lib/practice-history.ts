import {
  CELL_FLAGGED,
  CELL_REVEALED,
  analyzeVisibleBoard,
  chordCell,
  createBoard,
  createGameState,
  hashBoard,
  hashGameState,
  hashVisibleBoardState,
  revealCell,
  toggleFlag,
  type ActionRejectReason,
  type BoardSpec,
  type CountedBoardActionType,
  type GameState,
  type VisibleBoardProof,
  type VisibleBoardState,
} from "@h-minesweeper/game-core";
import type { SoloGenerationMode, SoloPreset } from "./solo";
import {
  PRACTICE_REPLAY_STORE_NAME,
  PRACTICE_RUN_STORE_NAME,
  SOLO_HISTORY_DATABASE_VERSION,
  SOLO_HISTORY_MAX_RECORDS,
  SOLO_REPLAY_MAX_ACTIONS,
  SOLO_REPLAY_MAX_BYTES,
  openSoloHistoryDatabase,
} from "./solo-history";
import type {
  CoachAction,
  CoachSuggestion,
  PracticeAssistMode,
} from "./practice-coach";
import {
  createCoachRequest,
  parseCoachSuggestion,
  runCoachRequest,
} from "./practice-coach";

export const PRACTICE_RUN_SCHEMA_VERSION = 1 as const;
export const PRACTICE_REPLAY_SCHEMA_VERSION = 1 as const;
export const PRACTICE_HISTORY_EXPORT_SCHEMA_VERSION = 1 as const;
export const PRACTICE_HISTORY_IMPORT_MAX_BYTES = 64 * 1024 * 1024;

export type PracticeRunOutcome = "WON" | "LOST";
export type PracticeHintTrigger = "IDLE" | "REQUEST";
export type PracticeCoachActionTrigger = "AUTO_MARK" | "DEMONSTRATE";

interface PracticeReplayEventBase {
  readonly seq: number;
  readonly elapsedMs: number;
}

export interface PracticePlayerActionEventV1 extends PracticeReplayEventBase {
  readonly eventType: "PLAYER_ACTION";
  readonly actionType: CountedBoardActionType;
  readonly cellIndex: number;
  readonly physicalClicks: number;
  readonly preStateHash: string;
  readonly accepted: boolean;
  readonly rejectReason?: ActionRejectReason;
  readonly postStateHash: string;
}

export interface PracticeAssistanceShownEventV1 extends PracticeReplayEventBase {
  readonly eventType: "ASSISTANCE_SHOWN";
  readonly trigger: PracticeHintTrigger;
  readonly visibleStateHash: string;
  readonly suggestion: CoachSuggestion;
}

export interface PracticeCoachActionEventV1 extends PracticeReplayEventBase {
  readonly eventType: "COACH_ACTION";
  readonly trigger: PracticeCoachActionTrigger;
  readonly action: CoachAction;
  readonly cellIndex: number;
  readonly physicalClicks: 0;
  readonly proof: VisibleBoardProof;
  readonly preStateHash: string;
  readonly postStateHash: string;
}

export type PracticeReplayEventV1 =
  | PracticePlayerActionEventV1
  | PracticeAssistanceShownEventV1
  | PracticeCoachActionEventV1;

export interface PracticeReplayV1 {
  readonly schemaVersion: typeof PRACTICE_REPLAY_SCHEMA_VERSION;
  readonly recordId: string;
  readonly initialFlags: readonly number[];
  readonly events: readonly PracticeReplayEventV1[];
}

export interface PracticeRunRecordV1 {
  readonly schemaVersion: typeof PRACTICE_RUN_SCHEMA_VERSION;
  readonly kind: "GUIDED_PRACTICE";
  readonly recordId: string;
  readonly completedAt: string;
  readonly outcome: PracticeRunOutcome;
  readonly config: {
    readonly preset: SoloPreset;
    readonly width: number;
    readonly height: number;
    readonly mines: number;
    readonly generationMode: SoloGenerationMode;
  };
  readonly board: {
    readonly spec: BoardSpec;
    readonly boardHash: string;
    readonly generatorRulesVersion: number;
    readonly trustStatus: "LOCAL_UNVERIFIED";
  };
  readonly assistMode: PracticeAssistMode;
  readonly summary: {
    readonly elapsedMs: number;
    readonly playerActions: number;
    readonly hintsShown: number;
    readonly hintsRequested: number;
    readonly autoFlags: number;
    readonly demonstratedActions: number;
  };
  readonly replay: {
    readonly schemaVersion: typeof PRACTICE_REPLAY_SCHEMA_VERSION;
    readonly eventCount: number;
    readonly eventLogHash: string;
  };
}

export interface PracticeHistoryExportV1 {
  readonly format: "h-minesweeper-practice-history";
  readonly schemaVersion: typeof PRACTICE_HISTORY_EXPORT_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly recordCount: number;
  readonly records: readonly PracticeRunRecordV1[];
  readonly replays: readonly PracticeReplayV1[];
}

export interface PracticeHistoryCapacity {
  readonly recordCount: number;
  readonly warning: boolean;
  readonly full: boolean;
}

export interface PracticeHistoryReadResult extends PracticeHistoryCapacity {
  readonly records: readonly PracticeRunRecordV1[];
  readonly invalidRecordCount: number;
  readonly invalidReplayCount: number;
  readonly availableReplayRecordIds: readonly string[];
}

export interface PracticeHistoryImportResult extends PracticeHistoryCapacity {
  readonly imported: number;
  readonly skippedIdentical: number;
}

export interface PracticeHistoryStore {
  read(): Promise<PracticeHistoryReadResult>;
  readReplay(recordId: string): Promise<PracticeReplayV1 | null>;
  put(
    record: PracticeRunRecordV1,
    replay: PracticeReplayV1,
  ): Promise<PracticeHistoryCapacity>;
  importDocument(
    document: PracticeHistoryExportV1,
  ): Promise<PracticeHistoryImportResult>;
  clear(): Promise<void>;
}

export interface DerivedPracticeSummary {
  readonly elapsedMs: number;
  readonly playerActions: number;
  readonly hintsShown: number;
  readonly hintsRequested: number;
  readonly autoFlags: number;
  readonly demonstratedActions: number;
}

export class PracticeHistoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PracticeHistoryError";
  }
}

export class PracticeHistoryValidationError extends PracticeHistoryError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "PracticeHistoryValidationError";
    this.issues = [...issues];
  }
}

export class PracticeHistoryCapacityError extends PracticeHistoryError {
  constructor() {
    super("Practice history has reached the 10,000 record limit.");
    this.name = "PracticeHistoryCapacityError";
  }
}

export class PracticeHistoryConflictError extends PracticeHistoryError {
  constructor(recordId: string) {
    super(`Practice record ${recordId} already exists with different data.`);
    this.name = "PracticeHistoryConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function hashPracticeReplay(replay: PracticeReplayV1): string {
  return hashText(stableJson(replay));
}

function isSafeIntegerArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(Number.isSafeInteger);
}

function validateBoardSpec(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const issues: string[] = [];
  for (const field of ["width", "height", "mines", "startIndex", "safeRadius"] as const) {
    if (!Number.isSafeInteger(value[field])) issues.push(`${path}.${field} must be an integer`);
  }
  if (typeof value.seed !== "string" || value.seed.length < 1 || value.seed.length > 512) {
    issues.push(`${path}.seed is invalid`);
  }
  if (issues.length > 0) return issues;
  try {
    createBoard(value as unknown as BoardSpec);
  } catch {
    issues.push(`${path} cannot generate a valid board`);
  }
  return issues;
}

function validateProof(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const validRules = new Set([
    "SINGLE_SAFE", "SINGLE_MINE", "SUBSET_SAFE", "SUBSET_MINE",
    "GLOBAL_SAFE", "GLOBAL_MINE", "CSP_SAFE", "CSP_MINE",
  ]);
  const issues: string[] = [];
  if (!validRules.has(String(value.rule))) issues.push(`${path}.rule is invalid`);
  if (value.kind !== "SAFE" && value.kind !== "MINE") issues.push(`${path}.kind is invalid`);
  if (!isSafeIntegerArray(value.sources)) issues.push(`${path}.sources is invalid`);
  if (!isSafeIntegerArray(value.targets) || value.targets.length === 0) {
    issues.push(`${path}.targets is invalid`);
  }
  if (typeof value.stateHash !== "string" || !/^[a-f0-9]{8}$/u.test(value.stateHash)) {
    issues.push(`${path}.stateHash is invalid`);
  }
  return issues;
}

function validateSuggestion(value: unknown, path: string): string[] {
  return parseCoachSuggestion(value) ? [] : [`${path} is invalid`];
}

export function validatePracticeReplayV1(
  value: unknown,
  path = "replay",
): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const issues: string[] = [];
  if (value.schemaVersion !== PRACTICE_REPLAY_SCHEMA_VERSION) {
    issues.push(`${path}.schemaVersion is unsupported`);
  }
  if (typeof value.recordId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.recordId)) {
    issues.push(`${path}.recordId is invalid`);
  }
  if (!isSafeIntegerArray(value.initialFlags)) {
    issues.push(`${path}.initialFlags is invalid`);
  }
  if (!Array.isArray(value.events) || value.events.length > SOLO_REPLAY_MAX_ACTIONS) {
    issues.push(`${path}.events is invalid`);
    return issues;
  }
  let previousElapsed = 0;
  value.events.forEach((event, index) => {
    const eventPath = `${path}.events[${index}]`;
    if (!isRecord(event)) {
      issues.push(`${eventPath} must be an object`);
      return;
    }
    if (event.seq !== index + 1) issues.push(`${eventPath}.seq must be contiguous`);
    if (
      typeof event.elapsedMs !== "number" ||
      !Number.isFinite(event.elapsedMs) ||
      event.elapsedMs < previousElapsed
    ) {
      issues.push(`${eventPath}.elapsedMs is invalid`);
    } else {
      previousElapsed = event.elapsedMs;
    }
    if (event.eventType === "PLAYER_ACTION") {
      if (!["REVEAL", "TOGGLE_FLAG", "CHORD"].includes(String(event.actionType))) {
        issues.push(`${eventPath}.actionType is invalid`);
      }
      if (!Number.isSafeInteger(event.cellIndex) || (event.cellIndex as number) < 0) {
        issues.push(`${eventPath}.cellIndex is invalid`);
      }
      if (!Number.isSafeInteger(event.physicalClicks) || (event.physicalClicks as number) < 0) {
        issues.push(`${eventPath}.physicalClicks is invalid`);
      }
      if (typeof event.accepted !== "boolean") issues.push(`${eventPath}.accepted is invalid`);
      if (event.rejectReason !== undefined && typeof event.rejectReason !== "string") {
        issues.push(`${eventPath}.rejectReason is invalid`);
      }
      for (const field of ["preStateHash", "postStateHash"] as const) {
        if (typeof event[field] !== "string" || !/^[a-f0-9]{16}$/u.test(event[field] as string)) {
          issues.push(`${eventPath}.${field} is invalid`);
        }
      }
      return;
    }
    if (event.eventType === "ASSISTANCE_SHOWN") {
      if (event.trigger !== "IDLE" && event.trigger !== "REQUEST") {
        issues.push(`${eventPath}.trigger is invalid`);
      }
      if (typeof event.visibleStateHash !== "string" || !/^[a-f0-9]{8}$/u.test(event.visibleStateHash)) {
        issues.push(`${eventPath}.visibleStateHash is invalid`);
      }
      issues.push(...validateSuggestion(event.suggestion, `${eventPath}.suggestion`));
      return;
    }
    if (event.eventType === "COACH_ACTION") {
      if (event.trigger !== "AUTO_MARK" && event.trigger !== "DEMONSTRATE") {
        issues.push(`${eventPath}.trigger is invalid`);
      }
      if (!["REVEAL", "FLAG", "UNFLAG"].includes(String(event.action))) {
        issues.push(`${eventPath}.action is invalid`);
      }
      if (!Number.isSafeInteger(event.cellIndex) || (event.cellIndex as number) < 0) {
        issues.push(`${eventPath}.cellIndex is invalid`);
      }
      if (event.physicalClicks !== 0) issues.push(`${eventPath}.physicalClicks must be zero`);
      issues.push(...validateProof(event.proof, `${eventPath}.proof`));
      for (const field of ["preStateHash", "postStateHash"] as const) {
        if (typeof event[field] !== "string" || !/^[a-f0-9]{16}$/u.test(event[field] as string)) {
          issues.push(`${eventPath}.${field} is invalid`);
        }
      }
      return;
    }
    issues.push(`${eventPath}.eventType is invalid`);
  });
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > SOLO_REPLAY_MAX_BYTES) {
      issues.push(`${path} exceeds the replay byte limit`);
    }
  } catch {
    issues.push(`${path} is not serializable`);
  }
  return issues;
}

export function validatePracticeRunRecordV1(
  value: unknown,
  path = "record",
): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const issues: string[] = [];
  if (value.schemaVersion !== PRACTICE_RUN_SCHEMA_VERSION) issues.push(`${path}.schemaVersion is unsupported`);
  if (value.kind !== "GUIDED_PRACTICE") issues.push(`${path}.kind is invalid`);
  if (typeof value.recordId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.recordId)) {
    issues.push(`${path}.recordId is invalid`);
  }
  if (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))) {
    issues.push(`${path}.completedAt is invalid`);
  }
  if (value.outcome !== "WON" && value.outcome !== "LOST") issues.push(`${path}.outcome is invalid`);
  if (!isRecord(value.config)) {
    issues.push(`${path}.config is invalid`);
  } else {
    if (!["beginner", "intermediate", "expert", "custom"].includes(String(value.config.preset))) {
      issues.push(`${path}.config.preset is invalid`);
    }
    if (value.config.generationMode !== "classic" && value.config.generationMode !== "no_guess") {
      issues.push(`${path}.config.generationMode is invalid`);
    }
    for (const field of ["width", "height", "mines"] as const) {
      if (!Number.isSafeInteger(value.config[field]) || (value.config[field] as number) <= 0) {
        issues.push(`${path}.config.${field} is invalid`);
      }
    }
  }
  if (!isRecord(value.board)) {
    issues.push(`${path}.board is invalid`);
  } else {
    issues.push(...validateBoardSpec(value.board.spec, `${path}.board.spec`));
    if (typeof value.board.boardHash !== "string" || !/^[a-f0-9]{16}$/u.test(value.board.boardHash)) {
      issues.push(`${path}.board.boardHash is invalid`);
    }
    if (!Number.isSafeInteger(value.board.generatorRulesVersion) || (value.board.generatorRulesVersion as number) < 1) {
      issues.push(`${path}.board.generatorRulesVersion is invalid`);
    }
    if (value.board.trustStatus !== "LOCAL_UNVERIFIED") issues.push(`${path}.board.trustStatus is invalid`);
    if (validateBoardSpec(value.board.spec, `${path}.board.spec`).length === 0) {
      try {
        if (hashBoard(createBoard(value.board.spec as unknown as BoardSpec)) !== value.board.boardHash) {
          issues.push(`${path}.board.boardHash does not match the board`);
        }
      } catch {
        // The board validation issue above is enough.
      }
    }
  }
  if (value.assistMode !== "COACH" && value.assistMode !== "AUTO_MARK_MINES") {
    issues.push(`${path}.assistMode is invalid`);
  }
  if (!isRecord(value.summary)) {
    issues.push(`${path}.summary is invalid`);
  } else {
    for (const field of ["elapsedMs", "playerActions", "hintsShown", "hintsRequested", "autoFlags", "demonstratedActions"] as const) {
      const fieldValue = value.summary[field];
      if (
        typeof fieldValue !== "number" ||
        !Number.isFinite(fieldValue) ||
        fieldValue < 0 ||
        (field !== "elapsedMs" && !Number.isSafeInteger(fieldValue))
      ) {
        issues.push(`${path}.summary.${field} is invalid`);
      }
    }
  }
  if (!isRecord(value.replay)) {
    issues.push(`${path}.replay is invalid`);
  } else {
    if (value.replay.schemaVersion !== PRACTICE_REPLAY_SCHEMA_VERSION) issues.push(`${path}.replay.schemaVersion is invalid`);
    if (!Number.isSafeInteger(value.replay.eventCount) || (value.replay.eventCount as number) < 0) {
      issues.push(`${path}.replay.eventCount is invalid`);
    }
    if (typeof value.replay.eventLogHash !== "string" || !/^[a-f0-9]{8}$/u.test(value.replay.eventLogHash)) {
      issues.push(`${path}.replay.eventLogHash is invalid`);
    }
  }
  return issues;
}

function visibleState(
  state: GameState,
  provenMines: ReadonlySet<number> = new Set(),
): VisibleBoardState {
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
    ...([...provenMines].some((index) => playerClaims.includes(index))
      ? {
          provenMines: [...provenMines]
            .filter((index) => playerClaims.includes(index))
            .sort((left, right) => left - right),
        }
      : {}),
  };
}

function sameProof(left: VisibleBoardProof, right: VisibleBoardProof): boolean {
  return left.rule === right.rule && left.kind === right.kind &&
    stableJson(left.sources) === stableJson(right.sources) &&
    stableJson(left.targets) === stableJson(right.targets) &&
    left.stateHash === right.stateHash;
}

export function derivePracticeSummary(
  replay: PracticeReplayV1,
): DerivedPracticeSummary {
  return {
    elapsedMs: replay.events.at(-1)?.elapsedMs ?? 0,
    playerActions: replay.events.filter(({ eventType }) => eventType === "PLAYER_ACTION").length,
    hintsShown: replay.events.filter(({ eventType }) => eventType === "ASSISTANCE_SHOWN").length,
    hintsRequested: replay.events.filter(
      (event) => event.eventType === "ASSISTANCE_SHOWN" && event.trigger === "REQUEST",
    ).length,
    autoFlags: replay.events.filter(
      (event) =>
        event.eventType === "COACH_ACTION" &&
        event.trigger === "AUTO_MARK" &&
        event.action === "FLAG",
    ).length,
    demonstratedActions: replay.events.filter(
      (event) => event.eventType === "COACH_ACTION" && event.trigger === "DEMONSTRATE",
    ).length,
  };
}

function validatePracticePair(
  record: PracticeRunRecordV1,
  replay: PracticeReplayV1,
): readonly string[] {
  const issues = [
    ...validatePracticeRunRecordV1(record),
    ...validatePracticeReplayV1(replay),
  ];
  if (record.recordId !== replay.recordId) {
    issues.push("Practice record and replay IDs do not match");
  }
  if (record.replay.eventCount !== replay.events.length) {
    issues.push("Practice replay event count does not match");
  }
  if (record.replay.eventLogHash !== hashPracticeReplay(replay)) {
    issues.push("Practice replay event hash does not match");
  }
  if (
    record.config.width !== record.board.spec.width ||
    record.config.height !== record.board.spec.height ||
    record.config.mines !== record.board.spec.mines
  ) {
    issues.push("Practice configuration does not match the board specification");
  }
  const derivedSummary = derivePracticeSummary(replay);
  for (const field of [
    "elapsedMs",
    "playerActions",
    "hintsShown",
    "hintsRequested",
    "autoFlags",
    "demonstratedActions",
  ] as const) {
    if (record.summary[field] !== derivedSummary[field]) {
      issues.push(`Practice summary ${field} does not match the replay`);
    }
  }
  if (
    record.assistMode === "COACH" &&
    replay.events.some(
      (event) => event.eventType === "COACH_ACTION" && event.trigger === "AUTO_MARK",
    )
  ) {
    issues.push("Coach-only practice cannot contain automatic mine marking");
  }
  return issues;
}

function verifyProof(
  state: GameState,
  proof: VisibleBoardProof,
  provenMines: ReadonlySet<number>,
): void {
  const currentVisible = visibleState(state, provenMines);
  const legacyVisible = visibleState(state);
  const visible = proof.stateHash === hashVisibleBoardState(currentVisible)
    ? currentVisible
    : proof.stateHash === hashVisibleBoardState(legacyVisible)
      ? legacyVisible
      : null;
  if (!visible) {
    throw new PracticeHistoryValidationError(["Coach proof uses a stale visible state hash"]);
  }
  const analysis = analyzeVisibleBoard(visible);
  if (!analysis.proofs.some((candidate) => sameProof(candidate, proof))) {
    throw new PracticeHistoryValidationError(["Coach proof is not supported by the visible board"]);
  }
}

function applyPlayerAction(state: GameState, event: PracticePlayerActionEventV1) {
  return event.actionType === "REVEAL"
    ? revealCell(state, event.cellIndex)
    : event.actionType === "TOGGLE_FLAG"
      ? toggleFlag(state, event.cellIndex)
      : chordCell(state, event.cellIndex);
}

function applyCoachAction(state: GameState, event: PracticeCoachActionEventV1) {
  if (event.action === "REVEAL") return revealCell(state, event.cellIndex);
  const wasFlagged = state.visibility[event.cellIndex] === CELL_FLAGGED;
  if ((event.action === "FLAG" && wasFlagged) || (event.action === "UNFLAG" && !wasFlagged)) {
    throw new PracticeHistoryValidationError(["Coach flag action does not match the visible state"]);
  }
  return toggleFlag(state, event.cellIndex);
}

export function verifyPracticeReplay(
  record: PracticeRunRecordV1,
  replay: PracticeReplayV1,
): void {
  const pairIssues = validatePracticePair(record, replay);
  if (pairIssues.length > 0) throw new PracticeHistoryValidationError(pairIssues);
  const state = createGameState(createBoard(record.board.spec));
  const provenMines = new Set<number>();
  for (const index of replay.initialFlags) {
    const delta = toggleFlag(state, index);
    if (!delta.accepted) throw new PracticeHistoryValidationError(["Practice replay has an invalid initial flag"]);
  }
  for (let eventIndex = 0; eventIndex < replay.events.length; eventIndex += 1) {
    const event = replay.events[eventIndex]!;
    if (state.outcome !== "PLAYING") {
      throw new PracticeHistoryValidationError(["Practice replay contains an event after the game ended"]);
    }
    if (event.eventType === "ASSISTANCE_SHOWN") {
      const provenVisible = visibleState(state, provenMines);
      const legacyVisible = visibleState(state);
      const currentVisible = event.visibleStateHash === hashVisibleBoardState(provenVisible)
        ? provenVisible
        : event.visibleStateHash === hashVisibleBoardState(legacyVisible)
          ? legacyVisible
          : null;
      if (!currentVisible || event.suggestion.stateHash !== event.visibleStateHash) {
        throw new PracticeHistoryValidationError([`Assistance event ${event.seq} uses a stale state`]);
      }
      const expectedSuggestion = runCoachRequest(
        createCoachRequest(event.suggestion.requestId, currentVisible),
      );
      if (stableJson(expectedSuggestion) !== stableJson(event.suggestion)) {
        throw new PracticeHistoryValidationError([`Assistance event ${event.seq} does not match visible analysis`]);
      }
      continue;
    }
    if (event.preStateHash !== hashGameState(state)) {
      throw new PracticeHistoryValidationError([`Event ${event.seq} pre-state hash does not match`]);
    }
    if (event.eventType === "COACH_ACTION") {
      verifyProof(state, event.proof, provenMines);
      if (
        !event.proof.targets.includes(event.cellIndex) ||
        (event.proof.kind === "MINE" && event.action !== "FLAG") ||
        (event.proof.kind === "SAFE" && event.action === "FLAG") ||
        (event.trigger === "AUTO_MARK" && event.action !== "FLAG")
      ) {
        throw new PracticeHistoryValidationError([`Coach event ${event.seq} action does not match its proof`]);
      }
    }
    const delta = event.eventType === "PLAYER_ACTION"
      ? applyPlayerAction(state, event)
      : applyCoachAction(state, event);
    if (event.eventType === "COACH_ACTION" && !delta.accepted) {
      throw new PracticeHistoryValidationError([`Coach event ${event.seq} was not accepted`]);
    }
    if (event.eventType === "PLAYER_ACTION" && (
      delta.accepted !== event.accepted || delta.rejectReason !== event.rejectReason
    )) {
      throw new PracticeHistoryValidationError([`Player event ${event.seq} result does not match`]);
    }
    if (delta.stateHash !== event.postStateHash) {
      throw new PracticeHistoryValidationError([`Event ${event.seq} post-state hash does not match`]);
    }
    if (event.eventType === "COACH_ACTION") {
      if (event.action === "FLAG") provenMines.add(event.cellIndex);
      else if (event.action === "UNFLAG") provenMines.delete(event.cellIndex);
    } else if (
      event.actionType === "TOGGLE_FLAG" &&
      state.visibility[event.cellIndex] !== CELL_FLAGGED
    ) {
      provenMines.delete(event.cellIndex);
    }
    if (state.outcome !== "PLAYING" && eventIndex !== replay.events.length - 1) {
      throw new PracticeHistoryValidationError(["The terminal action must be the final replay event"]);
    }
  }
  if (state.outcome !== record.outcome) {
    throw new PracticeHistoryValidationError(["Practice replay outcome does not match the record"]);
  }
}

function capacity(recordCount: number): PracticeHistoryCapacity {
  return {
    recordCount,
    warning: recordCount >= 9_500,
    full: recordCount >= SOLO_HISTORY_MAX_RECORDS,
  };
}

function readResult(
  rawRecords: readonly unknown[],
  rawReplays: readonly unknown[],
): PracticeHistoryReadResult {
  const records = rawRecords.filter((value): value is PracticeRunRecordV1 =>
    validatePracticeRunRecordV1(value).length === 0,
  ).sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  const recordById = new Map(records.map((record) => [record.recordId, record] as const));
  const availableReplayRecordIds = new Set<string>();
  const unavailableReplayRecordIds = new Set<string>();
  let unlinkedInvalidReplayCount = 0;
  const replays: PracticeReplayV1[] = [];
  for (const rawReplay of rawReplays) {
    if (validatePracticeReplayV1(rawReplay).length === 0) {
      replays.push(rawReplay as PracticeReplayV1);
      continue;
    }
    const recordId = isRecord(rawReplay) && typeof rawReplay.recordId === "string"
      ? rawReplay.recordId
      : null;
    if (recordId && recordById.has(recordId)) unavailableReplayRecordIds.add(recordId);
    else unlinkedInvalidReplayCount += 1;
  }
  for (const replay of replays) {
    const record = recordById.get(replay.recordId);
    if (!record) {
      unlinkedInvalidReplayCount += 1;
      continue;
    }
    try {
      const issues = validatePracticePair(record, replay);
      if (issues.length > 0) throw new PracticeHistoryValidationError(issues);
      availableReplayRecordIds.add(record.recordId);
    } catch {
      unavailableReplayRecordIds.add(record.recordId);
    }
  }
  for (const record of records) {
    if (!availableReplayRecordIds.has(record.recordId)) {
      unavailableReplayRecordIds.add(record.recordId);
    }
  }
  return {
    ...capacity(rawRecords.length),
    records,
    invalidRecordCount: rawRecords.length - records.length,
    invalidReplayCount:
      unlinkedInvalidReplayCount + unavailableReplayRecordIds.size,
    availableReplayRecordIds: [...availableReplayRecordIds],
  };
}

export function createPracticeHistoryExport(
  records: readonly PracticeRunRecordV1[],
  replays: readonly PracticeReplayV1[],
  now = new Date(),
): PracticeHistoryExportV1 {
  validatePracticeDocumentCollections(records, replays);
  if (!Number.isFinite(now.getTime())) {
    throw new PracticeHistoryValidationError(["Practice history export date is invalid"]);
  }
  return {
    format: "h-minesweeper-practice-history",
    schemaVersion: PRACTICE_HISTORY_EXPORT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    recordCount: records.length,
    records: structuredClone(records),
    replays: structuredClone(replays),
  };
}

function validatePracticeDocumentCollections(
  records: readonly PracticeRunRecordV1[],
  replays: readonly PracticeReplayV1[],
): ReadonlyMap<string, PracticeReplayV1> {
  const issues: string[] = [];
  const recordIds = new Set<string>();
  for (const record of records) {
    if (recordIds.has(record.recordId)) issues.push(`Duplicate practice record ${record.recordId}`);
    recordIds.add(record.recordId);
  }
  const replayById = new Map<string, PracticeReplayV1>();
  for (const replay of replays) {
    if (replayById.has(replay.recordId)) issues.push(`Duplicate practice replay ${replay.recordId}`);
    replayById.set(replay.recordId, replay);
  }
  if (records.length !== replays.length) {
    issues.push("Practice records and replays must have a one-to-one relationship");
  }
  for (const replay of replays) {
    if (!recordIds.has(replay.recordId)) issues.push(`Unexpected replay for ${replay.recordId}`);
  }
  if (issues.length > 0) throw new PracticeHistoryValidationError(issues);
  for (const record of records) {
    const replay = replayById.get(record.recordId);
    if (!replay) throw new PracticeHistoryValidationError([`Missing replay for ${record.recordId}`]);
    verifyPracticeReplay(record, replay);
  }
  return replayById;
}

export function parsePracticeHistoryImport(json: string): PracticeHistoryExportV1 {
  if (new TextEncoder().encode(json).byteLength > PRACTICE_HISTORY_IMPORT_MAX_BYTES) {
    throw new PracticeHistoryValidationError(["Practice history import is too large"]);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new PracticeHistoryValidationError(["Practice history is not valid JSON"]);
  }
  if (!isRecord(value) || value.format !== "h-minesweeper-practice-history" || value.schemaVersion !== 1) {
    throw new PracticeHistoryValidationError(["Unsupported practice history document"]);
  }
  if (
    !Array.isArray(value.records) ||
    !Array.isArray(value.replays) ||
    value.records.length > SOLO_HISTORY_MAX_RECORDS ||
    value.replays.length > SOLO_HISTORY_MAX_RECORDS
  ) {
    throw new PracticeHistoryValidationError(["Practice history document has invalid collections"]);
  }
  const document = value as unknown as PracticeHistoryExportV1;
  if (document.recordCount !== document.records.length) {
    throw new PracticeHistoryValidationError(["Practice history record count does not match"]);
  }
  if (!Number.isFinite(Date.parse(document.exportedAt))) {
    throw new PracticeHistoryValidationError(["Practice history export date is invalid"]);
  }
  createPracticeHistoryExport(document.records, document.replays, new Date(document.exportedAt));
  return document;
}

function requestPromise<T>(request: IDBRequest<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(new PracticeHistoryError(message, {
      cause: request.error ?? undefined,
    })), { once: true });
  });
}

function transactionPromise(transaction: IDBTransaction, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(new PracticeHistoryError(message, {
      cause: transaction.error ?? undefined,
    })), { once: true });
    transaction.addEventListener("error", () => reject(new PracticeHistoryError(message, {
      cause: transaction.error ?? undefined,
    })), { once: true });
  });
}

export function createIndexedDbPracticeHistoryStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): PracticeHistoryStore {
  let databasePromise: Promise<IDBDatabase> | undefined;
  const database = () => {
    if (!factory) return Promise.reject(new PracticeHistoryError("IndexedDB is unavailable"));
    databasePromise ??= openSoloHistoryDatabase(factory).catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise;
  };
  return {
    async read() {
      const db = await database();
      const transaction = db.transaction([PRACTICE_RUN_STORE_NAME, PRACTICE_REPLAY_STORE_NAME], "readonly");
      const records = requestPromise(transaction.objectStore(PRACTICE_RUN_STORE_NAME).getAll(), "Could not read practice history");
      const replays = requestPromise(transaction.objectStore(PRACTICE_REPLAY_STORE_NAME).getAll(), "Could not read practice replays");
      const completed = transactionPromise(transaction, "Could not read practice history");
      const [rawRecords, rawReplays] = await Promise.all([records, replays]);
      await completed;
      return readResult(rawRecords, rawReplays);
    },
    async readReplay(recordId) {
      const db = await database();
      const transaction = db.transaction(PRACTICE_REPLAY_STORE_NAME, "readonly");
      const raw = await requestPromise(transaction.objectStore(PRACTICE_REPLAY_STORE_NAME).get(recordId), "Could not read practice replay");
      await transactionPromise(transaction, "Could not read practice replay");
      if (raw === undefined) return null;
      const issues = validatePracticeReplayV1(raw);
      if (issues.length > 0) throw new PracticeHistoryValidationError(issues);
      return raw as PracticeReplayV1;
    },
    async put(record, replay) {
      verifyPracticeReplay(record, replay);
      const db = await database();
      return new Promise<PracticeHistoryCapacity>((resolve, reject) => {
        const transaction = db.transaction([PRACTICE_RUN_STORE_NAME, PRACTICE_REPLAY_STORE_NAME], "readwrite");
        const runStore = transaction.objectStore(PRACTICE_RUN_STORE_NAME);
        const replayStore = transaction.objectStore(PRACTICE_REPLAY_STORE_NAME);
        let nextCount = 0;
        let failure: Error | null = null;
        const runsRequest = runStore.getAll();
        const replayRequest = replayStore.get(record.recordId);
        let runsReady = false;
        let replayReady = false;
        const commit = () => {
          if (!runsReady || !replayReady || failure) return;
          const runs = runsRequest.result;
          const previous = runs.find((entry) => isRecord(entry) && entry.recordId === record.recordId);
          const previousReplay = replayRequest.result;
          nextCount = runs.length + (previous ? 0 : 1);
          if (previous) {
            if (stableJson(previous) !== stableJson(record) || stableJson(previousReplay) !== stableJson(replay)) {
              failure = new PracticeHistoryConflictError(record.recordId);
              transaction.abort();
            }
            return;
          }
          if (nextCount > SOLO_HISTORY_MAX_RECORDS) {
            failure = new PracticeHistoryCapacityError();
            transaction.abort();
            return;
          }
          runStore.add(record);
          replayStore.add(replay);
        };
        runsRequest.addEventListener("success", () => { runsReady = true; commit(); }, { once: true });
        replayRequest.addEventListener("success", () => { replayReady = true; commit(); }, { once: true });
        transaction.addEventListener("complete", () => resolve(capacity(nextCount)), { once: true });
        transaction.addEventListener("abort", () => reject(failure ?? new PracticeHistoryError("Could not save practice history")), { once: true });
        transaction.addEventListener("error", () => {
          failure ??= new PracticeHistoryError("Could not save practice history", { cause: transaction.error ?? undefined });
        });
      });
    },
    async importDocument(document) {
      const parsed = parsePracticeHistoryImport(JSON.stringify(document));
      const parsedReplayById = new Map(
        parsed.replays.map((replay) => [replay.recordId, replay] as const),
      );
      const db = await database();
      return new Promise<PracticeHistoryImportResult>((resolve, reject) => {
        const transaction = db.transaction([PRACTICE_RUN_STORE_NAME, PRACTICE_REPLAY_STORE_NAME], "readwrite");
        const runStore = transaction.objectStore(PRACTICE_RUN_STORE_NAME);
        const replayStore = transaction.objectStore(PRACTICE_REPLAY_STORE_NAME);
        const runsRequest = runStore.getAll();
        const replaysRequest = replayStore.getAll();
        let failure: Error | null = null;
        let result: PracticeHistoryImportResult = { ...capacity(0), imported: 0, skippedIdentical: 0 };
        let runsReady = false;
        let replaysReady = false;
        const commit = () => {
          if (!runsReady || !replaysReady || failure) return;
          const existingRuns = new Map<string, unknown>(runsRequest.result.filter(isRecord).map((entry) => [String(entry.recordId), entry]));
          const existingReplays = new Map<string, unknown>(replaysRequest.result.filter(isRecord).map((entry) => [String(entry.recordId), entry]));
          let imported = 0;
          let skippedIdentical = 0;
          for (const record of parsed.records) {
            const replay = parsedReplayById.get(record.recordId)!;
            const previous = existingRuns.get(record.recordId);
            const previousReplay = existingReplays.get(record.recordId);
            if (!previous) {
              imported += 1;
              existingRuns.set(record.recordId, record);
              existingReplays.set(record.recordId, replay);
              continue;
            }
            if (stableJson(previous) === stableJson(record) && stableJson(previousReplay) === stableJson(replay)) {
              skippedIdentical += 1;
              continue;
            }
            failure = new PracticeHistoryConflictError(record.recordId);
            transaction.abort();
            return;
          }
          if (existingRuns.size > SOLO_HISTORY_MAX_RECORDS) {
            failure = new PracticeHistoryCapacityError();
            transaction.abort();
            return;
          }
          for (const record of parsed.records) {
            if (runsRequest.result.some((entry) => isRecord(entry) && entry.recordId === record.recordId)) continue;
            runStore.add(record);
            replayStore.add(parsedReplayById.get(record.recordId)!);
          }
          result = { ...capacity(existingRuns.size), imported, skippedIdentical };
        };
        runsRequest.addEventListener("success", () => { runsReady = true; commit(); }, { once: true });
        replaysRequest.addEventListener("success", () => { replaysReady = true; commit(); }, { once: true });
        transaction.addEventListener("complete", () => resolve(result), { once: true });
        transaction.addEventListener("abort", () => reject(failure ?? new PracticeHistoryError("Could not import practice history")), { once: true });
        transaction.addEventListener("error", () => {
          failure ??= new PracticeHistoryError("Could not import practice history", { cause: transaction.error ?? undefined });
        });
      });
    },
    async clear() {
      const db = await database();
      const transaction = db.transaction([PRACTICE_RUN_STORE_NAME, PRACTICE_REPLAY_STORE_NAME], "readwrite");
      transaction.objectStore(PRACTICE_RUN_STORE_NAME).clear();
      transaction.objectStore(PRACTICE_REPLAY_STORE_NAME).clear();
      await transactionPromise(transaction, "Could not clear practice history");
    },
  };
}

export function createMemoryPracticeHistoryStore(
  initialRecords: readonly unknown[] = [],
  initialReplays: readonly unknown[] = [],
): PracticeHistoryStore {
  let rawRecords = structuredClone([...initialRecords]);
  let rawReplays = structuredClone([...initialReplays]);
  return {
    async read() {
      return readResult(structuredClone(rawRecords), structuredClone(rawReplays));
    },
    async readReplay(recordId) {
      const replay = rawReplays.find((entry) => isRecord(entry) && entry.recordId === recordId);
      if (!replay) return null;
      const issues = validatePracticeReplayV1(replay);
      if (issues.length > 0) throw new PracticeHistoryValidationError(issues);
      return structuredClone(replay as unknown as PracticeReplayV1);
    },
    async put(record, replay) {
      verifyPracticeReplay(record, replay);
      const index = rawRecords.findIndex((entry) => isRecord(entry) && entry.recordId === record.recordId);
      const replayIndex = rawReplays.findIndex((entry) => isRecord(entry) && entry.recordId === record.recordId);
      if (index >= 0) {
        if (stableJson(rawRecords[index]) !== stableJson(record) || stableJson(rawReplays[replayIndex]) !== stableJson(replay)) {
          throw new PracticeHistoryConflictError(record.recordId);
        }
        return capacity(rawRecords.length);
      }
      if (rawRecords.length >= SOLO_HISTORY_MAX_RECORDS) throw new PracticeHistoryCapacityError();
      rawRecords.push(structuredClone(record));
      rawReplays.push(structuredClone(replay));
      return capacity(rawRecords.length);
    },
    async importDocument(document) {
      const parsed = parsePracticeHistoryImport(JSON.stringify(document));
      const parsedReplayById = new Map(
        parsed.replays.map((replay) => [replay.recordId, replay] as const),
      );
      const nextRecords = structuredClone(rawRecords);
      const nextReplays = structuredClone(rawReplays);
      let imported = 0;
      let skippedIdentical = 0;
      for (const record of parsed.records) {
        const replay = parsedReplayById.get(record.recordId)!;
        const index = nextRecords.findIndex((entry) => isRecord(entry) && entry.recordId === record.recordId);
        const replayIndex = nextReplays.findIndex((entry) => isRecord(entry) && entry.recordId === record.recordId);
        if (index < 0) {
          nextRecords.push(structuredClone(record));
          nextReplays.push(structuredClone(replay));
          imported += 1;
        } else if (stableJson(nextRecords[index]) === stableJson(record) && stableJson(nextReplays[replayIndex]) === stableJson(replay)) {
          skippedIdentical += 1;
        } else {
          throw new PracticeHistoryConflictError(record.recordId);
        }
      }
      if (nextRecords.length > SOLO_HISTORY_MAX_RECORDS) throw new PracticeHistoryCapacityError();
      rawRecords = nextRecords;
      rawReplays = nextReplays;
      return { ...capacity(rawRecords.length), imported, skippedIdentical };
    },
    async clear() {
      rawRecords = [];
      rawReplays = [];
    },
  };
}

export const PRACTICE_HISTORY_DATABASE_VERSION = SOLO_HISTORY_DATABASE_VERSION;
