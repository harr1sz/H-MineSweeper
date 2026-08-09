import {
  CELL_FLAGGED,
  CELL_QUESTIONED,
  calculate3BV,
  calculateCPS,
  calculateGameMetrics,
  chordCell,
  countBoardActions,
  createBoard,
  createGameState,
  cycleCellMark,
  getNeighborIndices,
  getProgress,
  hashBoard,
  hashGameState,
  hashVisibleBoardState,
  revealCell,
  toggleFlag,
  type BoardSpec,
  type ActionCountBreakdown,
  type CountedBoardAction,
  type GameState,
  type RevealDelta,
  type VisibleBoardProof,
  type VisibleBoardState,
} from "@h-minesweeper/game-core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  SOLO_PRESETS,
  countFlags,
  createPendingSoloGame,
  createSoloBoardSpec,
  createSoloSeed,
  getSoloConfigErrorCode,
  type NoGuessWorkerRequest,
  type NoGuessWorkerResponse,
  type SoloBoardConfig,
  type SoloGenerationMode,
  type SoloPreset,
} from "../lib/solo";
import {
  createSoloComboState,
  getSoloComboDeadlineMs,
  getSoloComboFeedbackKey,
  getSoloComboTier,
  reduceSoloCombo,
  type SoloComboActor,
  type SoloComboEvent,
  type SoloComboResetReason,
} from "../lib/solo-combo";
import {
  SOLO_GAME_RULES_VERSION,
  SOLO_METRIC_RULES_VERSION,
  SOLO_REPLAY_MAX_ACTIONS,
  SOLO_REPLAY_MAX_BYTES,
  SOLO_REPLAY_SCHEMA_VERSION,
  SOLO_RUN_SCHEMA_VERSION_V2,
  createIndexedDbSoloHistoryStore,
  hashSoloReplay,
  recordTrainingSessionTerminal,
  touchTrainingSession,
  type SoloHistoryCapacity,
  type SoloHistoryStore,
  type SoloReplayActionV1,
  type SoloReplayV1,
  type SoloRunRecord,
  type SoloRunRecordV2,
} from "../lib/solo-history";
import {
  SOLO_PREFERENCES_SCHEMA_VERSION,
  loadSoloPreferences,
  resolveSoloLaunchPreferences,
  saveSoloPreferences,
  type SoloPreferencesV1,
  type SoloTimerFormatPreference,
} from "../lib/solo-preferences";
import { formatSoloElapsedTime } from "../lib/solo-time";
import {
  metricValuesForHistoryRecord,
  resolveSoloMetricView,
} from "../lib/solo-metrics";
import type { PracticeLaunchContext } from "../lib/practice-launch";
import { percentile } from "../lib/performance";
import {
  activeAutoFlaggedIndexes,
  coachMineActionForApplicationStep,
  createCoachRequest,
  isCoachActionProven,
  isCoachChordProven,
  isCoachSuggestionApplicable,
  parseCoachSuggestion,
  visibleBoardStateForPractice,
  type CoachAction,
  type CoachSuggestion,
  type PracticeAssistMode,
  type SoloSessionKind,
} from "../lib/practice-coach";
import {
  PRACTICE_REPLAY_SCHEMA_VERSION,
  createIndexedDbPracticeHistoryStore,
  hashPracticeReplay,
  type PracticeAssistanceShownEventV1,
  type PracticeCoachActionEventV1,
  type PracticeHintTrigger,
  type PracticeReplayEventV1,
  type PracticeReplayV1,
  type PracticeRunRecordV1,
  PracticeHistoryCapacityError,
} from "../lib/practice-history";
import {
  CanvasBoard,
  resolveBoardPalette,
  type BoardAction,
  type BoardActionVisual,
  type BoardEffectsProfile,
  type BoardInputMeta,
  type BoardTheme,
} from "./CanvasBoard";
import { SoloHistory } from "./SoloHistory";
import { PracticeHistory } from "./PracticeHistory";
import { ComboStatus } from "./ComboStatus";
import { useTelemetry } from "./TelemetryPrivacy";
import { useLocale, type MessageDescriptor } from "../i18n";
import "./solo-game.css";

interface SoloGameProps {
  readonly effectsProfile: BoardEffectsProfile;
  readonly initialGenerationMode?: SoloGenerationMode;
  readonly initialSessionKind?: SoloSessionKind;
  readonly initialBoardConfig?: SoloBoardConfig;
  readonly initialSetupComplete?: boolean;
  readonly practiceLaunchContext?: PracticeLaunchContext;
  readonly reducedMotion: boolean;
  readonly onExit: () => void;
}

type SoloStatus = "READY" | "GENERATING" | "PLAYING" | "WON" | "LOST";
type StatsLevel = "basic" | "advanced" | "analysis";

interface RecordActionOptions {
  readonly physicalClicks?: number;
  readonly comboActor?: SoloComboActor;
  readonly actionAt?: number;
  readonly replayElapsedMs?: number;
}

interface PracticePreMineSnapshot {
  readonly game: GameState;
  readonly actionCount: number;
  readonly practiceEventCount: number;
  readonly practiceEventsOverflow: boolean;
  readonly lastReplayStateHash: string;
  readonly elapsedMs: number;
  readonly effectiveInteractionMs: number;
}

export const PRACTICE_COACH_IDLE_MS = 8_000;
export const PRACTICE_COACH_TIMEOUT_MS = 2_500;
const GUIDED_PRACTICE_STARTED_KEY = "hms-guided-practice-started-v1";

type PracticeSaveState = "IDLE" | "SAVING" | "SAVED" | "FAILED" | "TOO_LARGE";

function preferenceLoadMessage(
  errorCode: ReturnType<typeof loadSoloPreferences>["errorCode"],
): MessageDescriptor | null {
  if (errorCode === "INVALID_VERSION") return { id: "solo.preferenceInvalid" };
  if (errorCode === "CORRUPT_DATA") return { id: "solo.preferenceCorrupt" };
  if (errorCode === "READ_FAILED") return { id: "solo.preferenceReadFailed" };
  return null;
}

const EMPTY_ACTION_BREAKDOWN = countBoardActions([]);
export const SOLO_EFFECTIVE_INTERACTION_IDLE_CAP_MS = 30_000;

export interface SoloRunIdentity {
  readonly runId: string;
  readonly trainingSessionId: string;
}

export function createSoloRunIdentity(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined =
    globalThis.sessionStorage,
  now = Date.now(),
  createRunId: () => string = () => globalThis.crypto.randomUUID(),
): SoloRunIdentity {
  return Object.freeze({
    runId: createRunId(),
    trainingSessionId: touchTrainingSession(storage, now),
  });
}

export function cappedEffectiveInteractionGapMs(
  previousAt: number | null,
  currentAt: number,
  idleCapMs = SOLO_EFFECTIVE_INTERACTION_IDLE_CAP_MS,
): number {
  if (
    previousAt === null ||
    !Number.isFinite(previousAt) ||
    !Number.isFinite(currentAt) ||
    !Number.isFinite(idleCapMs) ||
    currentAt <= previousAt ||
    idleCapMs <= 0
  ) {
    return 0;
  }
  return Math.min(currentAt - previousAt, idleCapMs);
}

function appendActionBreakdown(
  current: ActionCountBreakdown,
  action: CountedBoardAction,
): ActionCountBreakdown {
  const added = countBoardActions([action]);
  return {
    rulesVersion: current.rulesVersion,
    countedClicks: current.countedClicks + added.countedClicks,
    physicalClicks: current.physicalClicks + added.physicalClicks,
    semanticActions: current.semanticActions + added.semanticActions,
    acceptedActions: current.acceptedActions + added.acceptedActions,
    wastedActions: current.wastedActions + added.wastedActions,
    rejectedActions: current.rejectedActions + added.rejectedActions,
    reveals: current.reveals + added.reveals,
    flagToggles: current.flagToggles + added.flagToggles,
    flags: current.flags + added.flags,
    unflags: current.unflags + added.unflags,
    chords: current.chords + added.chords,
  };
}

function formatMetric(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : value.toFixed(digits);
}

export interface PendingHistoryWriteSnapshot {
  readonly record: SoloRunRecord;
  readonly status: "queued" | "saving" | "failed";
  readonly error: string | null;
}

interface PendingHistoryWriteEntry {
  readonly record: SoloRunRecord;
  readonly replay?: SoloReplayV1;
  status: PendingHistoryWriteSnapshot["status"];
  error: string | null;
  attempt: Promise<PendingHistoryWriteResult> | undefined;
}

export type PendingHistoryWriteResult =
  | {
      readonly ok: true;
      readonly capacity: SoloHistoryCapacity;
    }
  | {
      readonly ok: false;
      readonly cause: unknown;
    };

const pendingHistoryWrites = new Map<string, PendingHistoryWriteEntry>();
const pendingHistoryListeners = new Set<() => void>();
let pendingHistoryVersion = 0;

function immutableHistoryRecord(
  record: SoloRunRecord,
): SoloRunRecord {
  return Object.freeze(structuredClone(record));
}

function notifyPendingHistoryChange(): void {
  pendingHistoryVersion += 1;
  for (const listener of pendingHistoryListeners) listener();
}

function subscribePendingHistory(listener: () => void): () => void {
  pendingHistoryListeners.add(listener);
  return () => pendingHistoryListeners.delete(listener);
}

export function enqueuePendingHistoryRecord(
  record: SoloRunRecord,
  replay?: SoloReplayV1,
): SoloRunRecord {
  const existing = pendingHistoryWrites.get(record.recordId);
  if (existing) return existing.record;
  const immutable = immutableHistoryRecord(record);
  pendingHistoryWrites.set(record.recordId, {
    record: immutable,
    ...(replay ? { replay: structuredClone(replay) } : {}),
    status: "queued",
    error: null,
    attempt: undefined,
  });
  notifyPendingHistoryChange();
  return immutable;
}

export function attemptPendingHistoryWrite(
  recordId: string,
  store: Pick<SoloHistoryStore, "put">,
): Promise<PendingHistoryWriteResult> {
  const entry = pendingHistoryWrites.get(recordId);
  if (!entry) {
    return Promise.resolve({
      ok: false,
      cause: new Error(`Pending history record ${recordId} does not exist`),
    });
  }
  if (entry.status === "saving" && entry.attempt) return entry.attempt;

  entry.status = "saving";
  entry.error = null;
  const attempt = (async (): Promise<PendingHistoryWriteResult> => {
    try {
      const capacity = entry.replay
        ? await store.put(entry.record, entry.replay)
        : await store.put(entry.record);
      if (pendingHistoryWrites.get(recordId) === entry) {
        pendingHistoryWrites.delete(recordId);
        notifyPendingHistoryChange();
      }
      return { ok: true, capacity };
    } catch (cause: unknown) {
      if (entry.record.schemaVersion === SOLO_RUN_SCHEMA_VERSION_V2 && entry.replay) {
        const summaryOnly: SoloRunRecordV2 = {
          ...entry.record,
          replay: {
            status: "UNAVAILABLE",
            reason: "STORAGE_FAILURE",
            schemaVersion: SOLO_REPLAY_SCHEMA_VERSION,
            actionCount: 0,
            actionLogHash: "",
          },
        };
        try {
          const capacity = await store.put(summaryOnly);
          if (pendingHistoryWrites.get(recordId) === entry) {
            pendingHistoryWrites.delete(recordId);
            notifyPendingHistoryChange();
          }
          return { ok: true, capacity };
        } catch {
          // Preserve the full pending entry so a later retry can still save it.
        }
      }
      if (pendingHistoryWrites.get(recordId) === entry) {
        entry.status = "failed";
        entry.error =
          cause instanceof Error
            ? cause.message
            : "SOLO_HISTORY_WRITE_FAILED";
        entry.attempt = undefined;
        notifyPendingHistoryChange();
      }
      return { ok: false, cause };
    }
  })();
  entry.attempt = attempt;
  notifyPendingHistoryChange();
  return attempt;
}

export function getPendingHistoryWrites(): readonly PendingHistoryWriteSnapshot[] {
  return Array.from(pendingHistoryWrites.values(), ({ record, status, error }) => ({
    record,
    status,
    error,
  }));
}

export function resetPendingHistoryWritesForTests(): void {
  pendingHistoryWrites.clear();
  notifyPendingHistoryChange();
}

const DEFAULT_CONFIG: SoloBoardConfig = {
  ...SOLO_PRESETS.beginner,
  mode: "classic",
};

const PRESET_KEYS: readonly Exclude<SoloPreset, "custom">[] = [
  "beginner",
  "intermediate",
  "expert",
];

function applyFlagsByIndex(
  flaggedIndexes: readonly number[],
  target: GameState,
): void {
  for (const index of flaggedIndexes) {
    if (index >= 0 && index < target.visibility.length) {
      target.visibility[index] = CELL_FLAGGED;
    }
  }
}

function applyQuestionsByIndex(
  questionedIndexes: readonly number[],
  target: GameState,
): void {
  for (const index of questionedIndexes) {
    if (index >= 0 && index < target.visibility.length) {
      target.visibility[index] = CELL_QUESTIONED;
    }
  }
}

function cloneGameState(state: GameState): GameState {
  return {
    board: state.board,
    visibility: new Uint8Array(state.visibility),
    revealedSafeCount: state.revealedSafeCount,
    outcome: state.outcome,
  };
}

function classifyHistoryFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("10,000") ||
    message.includes("容量") ||
    message.includes("quota")
  ) {
    return "QUOTA";
  }
  if (message.includes("序列化") || message.includes("schema")) {
    return "SERIALIZATION";
  }
  return "STORAGE";
}

export function SoloGame({
  effectsProfile,
  initialGenerationMode,
  initialSessionKind = "STANDARD",
  initialBoardConfig,
  initialSetupComplete = false,
  practiceLaunchContext,
  reducedMotion,
  onExit,
}: SoloGameProps) {
  const { locale, t } = useLocale();
  const configErrorDescriptor = useCallback((nextConfig: SoloBoardConfig): MessageDescriptor | null => {
    const error = getSoloConfigErrorCode(nextConfig);
    if (!error) return null;
    if (error.code === "WIDTH_RANGE") return { id: "solo.config.width" };
    if (error.code === "HEIGHT_RANGE") return { id: "solo.config.height" };
    if (error.code === "CELL_LIMIT") return { id: "solo.config.cells" };
    if (error.code === "MINE_RANGE") return { id: "solo.config.mines", values: { max: error.maxMines } };
    return { id: "solo.config.noGuessSize" };
  }, []);
  const { flush: flushTelemetry, track } = useTelemetry();
  const preferenceLoadRef = useRef(loadSoloPreferences());
  const restoredPreferences = preferenceLoadRef.current.preferences;
  const launchPreferences = resolveSoloLaunchPreferences(
    restoredPreferences,
    initialGenerationMode,
  );
  const acceptedOverride = initialBoardConfig && !getSoloConfigErrorCode(initialBoardConfig)
    ? initialBoardConfig
    : undefined;
  const initialConfig = acceptedOverride ?? launchPreferences.config;
  const launchMode = initialConfig.mode;
  const initialPreset: SoloPreset = acceptedOverride ? "custom" : launchPreferences.preset;
  const pendingSeedRef = useRef(createSoloSeed());
  const initialGame = useMemo(
    () => createPendingSoloGame(initialConfig, pendingSeedRef.current),
    [],
  );
  const gameRef = useRef(initialGame);
  const workerRef = useRef<Worker | null>(null);
  const workerTimeoutRef = useRef<number | null>(null);
  const workerRequestRef = useRef(0);
  const generationActiveRef = useRef(false);
  const coachWorkerRef = useRef<Worker | null>(null);
  const coachTimeoutRef = useRef<number | null>(null);
  const coachRequestRef = useRef(0);
  const coachFeedbackWorkerRef = useRef<Worker | null>(null);
  const coachFeedbackTimeoutRef = useRef<number | null>(null);
  const coachFeedbackRequestRef = useRef(0);
  const coachAnalysisRef = useRef<CoachSuggestion | null>(null);
  const practiceManualHintPendingRef = useRef(false);
  const practiceLastInteractionAtRef = useRef<number | null>(null);
  const practiceShownStateHashesRef = useRef(new Set<string>());
  const practiceSuppressedAutoFlagsRef = useRef(new Set<number>());
  const practiceAutoMarkEvidenceHashRef = useRef<string | null>(null);
  const practiceAutoMarkExplanationRef = useRef(false);
  const autoFlaggedIndexesRef = useRef(new Set<number>());
  const practiceEventsRef = useRef<PracticeReplayEventV1[]>([]);
  const practiceEventsOverflowRef = useRef(false);
  const practiceStartedAtRef = useRef<number | null>(null);
  const practiceSavedRunRef = useRef("");
  const practiceUsedAutoMarkRef = useRef(false);
  const practicePreMineSnapshotRef = useRef<PracticePreMineSnapshot | null>(null);
  const autoMarkMinesRef = useRef(false);
  const visualSequenceRef = useRef(0);
  const comboStateRef = useRef(createSoloComboState());
  const comboTimeoutRef = useRef<number | null>(null);
  const actionTraceRef = useRef<CountedBoardAction[]>([]);
  const replayActionTraceRef = useRef<SoloReplayActionV1[]>([]);
  const lastReplayStateHashRef = useRef(hashGameState(initialGame));
  const replayTruncationReasonRef = useRef<"ACTION_LIMIT" | "BYTE_LIMIT" | null>(null);
  const initialFlagsRef = useRef<readonly number[]>([]);
  const initialQuestionsRef = useRef<readonly number[]>([]);
  const boardSpecRef = useRef<BoardSpec | null>(null);
  const pendingReplaySpecRef = useRef<BoardSpec | null>(null);
  const historyStoreRef = useRef(createIndexedDbSoloHistoryStore());
  const practiceHistoryStoreRef = useRef(createIndexedDbPracticeHistoryStore());
  const runIdentityRef = useRef<SoloRunIdentity | null>(null);
  const runCompletedAtRef = useRef<number | null>(null);
  const historyEnqueuedRunRef = useRef("");
  const lastEffectiveInteractionAtRef = useRef<number | null>(null);
  const effectiveInteractionAccumulatedMsRef = useRef(0);
  const runEffectiveInteractionMsRef = useRef(0);
  const inputLatencySamplesRef = useRef<number[]>([]);
  const mountedRef = useRef(true);

  const [game, setGame] = useState(initialGame);
  const [revision, setRevision] = useState(0);
  const [config, setConfig] = useState<SoloBoardConfig>(initialConfig);
  const [preset, setPreset] = useState<SoloPreset>(initialPreset);
  const [mode, setMode] = useState<SoloGenerationMode>(launchMode);
  const [sessionKind, setSessionKind] =
    useState<SoloSessionKind>(initialSessionKind);
  const [setupComplete, setSetupComplete] = useState(initialSetupComplete);
  const [status, setStatus] = useState<SoloStatus>("READY");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(performance.now());
  const [actionBreakdown, setActionBreakdown] =
    useState<ActionCountBreakdown>(EMPTY_ACTION_BREAKDOWN);
  const [board3BV, setBoard3BV] = useState<number | null>(null);
  const [actionVisual, setActionVisual] = useState<BoardActionVisual>();
  const [comboState, setComboState] = useState(comboStateRef.current);
  const [coachAnalysis, setCoachAnalysis] = useState<CoachSuggestion | null>(null);
  const [displayedCoachSuggestion, setDisplayedCoachSuggestion] =
    useState<CoachSuggestion | null>(null);
  const [coachBusy, setCoachBusy] = useState(false);
  const [coachTransportError, setCoachTransportError] = useState(false);
  const [coachIdleSeconds, setCoachIdleSeconds] = useState(8);
  const [autoMarkMines, setAutoMarkMines] = useState(false);
  const [autoFlaggedIndexes, setAutoFlaggedIndexes] =
    useState<ReadonlySet<number>>(() => new Set());
  const [practiceSaveState, setPracticeSaveState] =
    useState<PracticeSaveState>("IDLE");
  const [practiceHistoryRefresh, setPracticeHistoryRefresh] = useState(0);
  const [showPracticeHistory, setShowPracticeHistory] = useState(true);
  const [statsLevel, setStatsLevel] = useState<StatsLevel>(
    launchPreferences.statsLevel,
  );
  const [boardTheme, setBoardTheme] = useState<BoardTheme>(
    launchPreferences.boardTheme,
  );
  const [questionMarksEnabled, setQuestionMarksEnabled] = useState(
    launchPreferences.questionMarksEnabled,
  );
  const [timerFormat, setTimerFormat] = useState<SoloTimerFormatPreference>(
    launchPreferences.timerFormat,
  );
  const [legacyPersonalBestMs, setLegacyPersonalBestMs] =
    useState<number | null>(null);
  const [currentRulesPersonalBestMs, setCurrentRulesPersonalBestMs] =
    useState<number | null>(null);
  const [isNewPersonalBest, setIsNewPersonalBest] = useState(false);
  const [coarsePointer] = useState(
    () => window.matchMedia("(pointer: coarse)").matches,
  );
  const [notice, setNotice] = useState<MessageDescriptor | null>(
    () => preferenceLoadMessage(preferenceLoadRef.current.errorCode) ?? {
      id: initialSessionKind === "GUIDED_PRACTICE"
        ? launchMode === "no_guess"
          ? "practice.setup.noGuessRecommended"
          : "practice.setup.classicWarning"
        : launchMode === "no_guess"
          ? "solo.noGuessDescription"
          : "solo.classicDescription",
    },
  );
  const [seed, setSeed] = useState("");
  const [boardHash, setBoardHash] = useState("");
  const [generationSummary, setGenerationSummary] =
    useState<MessageDescriptor | null>(null);
  const [terminalDetonatedIndex, setTerminalDetonatedIndex] = useState<number>();
  const [draftWidth, setDraftWidth] = useState(String(initialConfig.width));
  const [draftHeight, setDraftHeight] = useState(String(initialConfig.height));
  const [draftMines, setDraftMines] = useState(String(initialConfig.mines));
  const [pendingWriteVersion, setPendingWriteVersion] = useState(
    pendingHistoryVersion,
  );
  const handleCurrentBestChange = useCallback((elapsed: number | null) => {
    setCurrentRulesPersonalBestMs(elapsed);
  }, []);
  const handleLegacyPersonalBestChange = useCallback(
    (elapsed: number | null) => {
      setLegacyPersonalBestMs(elapsed);
    },
    [],
  );

  const replaceGame = useCallback((next: GameState) => {
    gameRef.current = next;
    setGame(next);
    setRevision((value) => value + 1);
  }, []);

  const setCurrentCoachAnalysis = useCallback(
    (suggestion: CoachSuggestion | null) => {
      coachAnalysisRef.current = suggestion;
      setCoachAnalysis(suggestion);
    },
    [],
  );

  const cancelCoachAnalysis = useCallback(() => {
    coachRequestRef.current += 1;
    coachWorkerRef.current?.terminate();
    coachWorkerRef.current = null;
    if (coachTimeoutRef.current !== null) {
      window.clearTimeout(coachTimeoutRef.current);
      coachTimeoutRef.current = null;
    }
    setCoachBusy(false);
  }, []);

  const cancelCoachFeedbackAnalysis = useCallback(() => {
    coachFeedbackRequestRef.current += 1;
    coachFeedbackWorkerRef.current?.terminate();
    coachFeedbackWorkerRef.current = null;
    if (coachFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(coachFeedbackTimeoutRef.current);
      coachFeedbackTimeoutRef.current = null;
    }
  }, []);

  const appendPracticeEvent = useCallback(
    (
      createEvent: (seq: number, elapsedMs: number) => PracticeReplayEventV1,
      actionAt = performance.now(),
    ) => {
      if (practiceEventsOverflowRef.current) return;
      if (practiceEventsRef.current.length >= SOLO_REPLAY_MAX_ACTIONS) {
        practiceEventsOverflowRef.current = true;
        return;
      }
      const beganAt = practiceStartedAtRef.current;
      practiceEventsRef.current.push(createEvent(
        practiceEventsRef.current.length + 1,
        beganAt === null ? 0 : Math.max(0, actionAt - beganAt),
      ));
    },
    [],
  );

  const recordEffectiveInteraction = useCallback((now: number): number => {
    if (document.visibilityState !== "visible") {
      lastEffectiveInteractionAtRef.current = null;
      return effectiveInteractionAccumulatedMsRef.current;
    }
    effectiveInteractionAccumulatedMsRef.current +=
      cappedEffectiveInteractionGapMs(
        lastEffectiveInteractionAtRef.current,
        now,
      );
    lastEffectiveInteractionAtRef.current = now;
    return effectiveInteractionAccumulatedMsRef.current;
  }, []);

  const applyComboEvent = useCallback((event: SoloComboEvent) => {
    const previous = comboStateRef.current;
    const next = reduceSoloCombo(previous, event);
    if (next === previous) return;

    if (comboTimeoutRef.current !== null) {
      window.clearTimeout(comboTimeoutRef.current);
      comboTimeoutRef.current = null;
    }
    comboStateRef.current = next;
    setComboState(next);

    const scheduleExpiry = (): void => {
      const deadline = getSoloComboDeadlineMs(comboStateRef.current);
      if (deadline === null) return;
      const delayMs = Math.max(1, deadline - performance.now() + 1);
      comboTimeoutRef.current = window.setTimeout(() => {
        comboTimeoutRef.current = null;
        const current = comboStateRef.current;
        const expired = reduceSoloCombo(current, {
          type: "EXPIRE",
          atMs: performance.now(),
        });
        if (expired === current) {
          scheduleExpiry();
          return;
        }
        comboStateRef.current = expired;
        setComboState(expired);
      }, delayMs);
    };
    scheduleExpiry();
  }, []);

  const clearCombo = useCallback(
    (reason: SoloComboResetReason = "NEW_GAME") => {
      applyComboEvent({ type: "RESET", reason });
    },
    [applyComboEvent],
  );

  const cancelGeneration = useCallback(() => {
    generationActiveRef.current = false;
    workerRequestRef.current += 1;
    workerRef.current?.terminate();
    workerRef.current = null;
    if (workerTimeoutRef.current !== null) {
      window.clearTimeout(workerTimeoutRef.current);
      workerTimeoutRef.current = null;
    }
  }, []);

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        cancelGeneration();
        cancelCoachAnalysis();
        cancelCoachFeedbackAnalysis();
        if (comboTimeoutRef.current !== null) {
          window.clearTimeout(comboTimeoutRef.current);
        }
      };
    },
    [cancelCoachAnalysis, cancelCoachFeedbackAnalysis, cancelGeneration],
  );

  useEffect(() => {
    const resetHiddenCombo = () => {
      if (document.visibilityState !== "visible") {
        clearCombo("PAGE_HIDDEN");
      }
    };
    document.addEventListener("visibilitychange", resetHiddenCombo);
    return () =>
      document.removeEventListener("visibilitychange", resetHiddenCombo);
  }, [clearCombo]);

  useEffect(
    () =>
      subscribePendingHistory(() => {
        setPendingWriteVersion(pendingHistoryVersion);
      }),
    [],
  );

  useEffect(() => {
    if (sessionKind !== "GUIDED_PRACTICE" || !setupComplete) return;
    try {
      localStorage.setItem(GUIDED_PRACTICE_STARTED_KEY, "1");
    } catch {
      // Practice remains available when browser storage is blocked.
    }
  }, [sessionKind, setupComplete]);

  useEffect(() => {
    if (status !== "PLAYING") return;
    const timer = window.setInterval(() => setClockNow(performance.now()), 50);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (status !== "PLAYING") return;
    const updateInteractionAnchor = () => {
      if (document.visibilityState === "visible") {
        lastEffectiveInteractionAtRef.current ??= performance.now();
      } else {
        lastEffectiveInteractionAtRef.current = null;
      }
    };
    updateInteractionAnchor();
    document.addEventListener("visibilitychange", updateInteractionAnchor);
    return () =>
      document.removeEventListener("visibilitychange", updateInteractionAnchor);
  }, [status]);

  const resetBoard = useCallback(
    (
      nextConfig: SoloBoardConfig = config,
      nextPreset: SoloPreset = preset,
      nextSessionKind: SoloSessionKind = sessionKind,
    ) => {
      cancelGeneration();
      cancelCoachAnalysis();
      cancelCoachFeedbackAnalysis();
      pendingSeedRef.current = createSoloSeed();
      const pending = createPendingSoloGame(
        nextConfig,
        pendingSeedRef.current,
      );
      replaceGame(pending);
      setConfig(nextConfig);
      setPreset(nextPreset);
      setMode(nextConfig.mode);
      setSessionKind(nextSessionKind);
      setStatus("READY");
      setStartedAt(null);
      setFinishedAt(null);
      setClockNow(performance.now());
      actionTraceRef.current = [];
      replayActionTraceRef.current = [];
      lastReplayStateHashRef.current = hashGameState(pending);
      replayTruncationReasonRef.current = null;
      practiceEventsRef.current = [];
      practiceEventsOverflowRef.current = false;
      practiceStartedAtRef.current = null;
      practiceSavedRunRef.current = "";
      practiceUsedAutoMarkRef.current = false;
      practicePreMineSnapshotRef.current = null;
      practiceManualHintPendingRef.current = false;
      practiceLastInteractionAtRef.current = null;
      practiceShownStateHashesRef.current.clear();
      practiceSuppressedAutoFlagsRef.current.clear();
      practiceAutoMarkEvidenceHashRef.current = null;
      practiceAutoMarkExplanationRef.current = false;
      autoFlaggedIndexesRef.current.clear();
      autoMarkMinesRef.current = false;
      initialFlagsRef.current = [];
      initialQuestionsRef.current = [];
      boardSpecRef.current = null;
      pendingReplaySpecRef.current = null;
      runIdentityRef.current = null;
      runCompletedAtRef.current = null;
      historyEnqueuedRunRef.current = "";
      lastEffectiveInteractionAtRef.current = null;
      effectiveInteractionAccumulatedMsRef.current = 0;
      runEffectiveInteractionMsRef.current = 0;
      inputLatencySamplesRef.current = [];
      setActionBreakdown(EMPTY_ACTION_BREAKDOWN);
      setBoard3BV(null);
      setActionVisual(undefined);
      clearCombo();
      setCurrentCoachAnalysis(null);
      setDisplayedCoachSuggestion(null);
      setCoachTransportError(false);
      setCoachIdleSeconds(8);
      setAutoMarkMines(false);
      setAutoFlaggedIndexes(new Set());
      setPracticeSaveState("IDLE");
      setShowPracticeHistory(true);
      setLegacyPersonalBestMs(null);
      setCurrentRulesPersonalBestMs(null);
      setIsNewPersonalBest(false);
      setSeed("");
      setBoardHash("");
      setGenerationSummary(null);
      setTerminalDetonatedIndex(undefined);
      setNotice({
        id: nextSessionKind === "GUIDED_PRACTICE"
          ? nextConfig.mode === "no_guess"
            ? "practice.setup.noGuessRecommended"
            : "practice.setup.classicWarning"
          : nextConfig.mode === "no_guess"
            ? "solo.noGuessDescription"
            : "solo.classicDescription",
      });
    },
    [
      cancelCoachAnalysis,
      cancelCoachFeedbackAnalysis,
      cancelGeneration,
      clearCombo,
      config,
      preset,
      replaceGame,
      sessionKind,
      setCurrentCoachAnalysis,
    ],
  );

  const finishIfTerminal = useCallback(
    (next: GameState, completedAt: number) => {
      if (next.outcome === "PLAYING") {
        setStatus("PLAYING");
        return;
      }
      cancelCoachFeedbackAnalysis();
      setFinishedAt(completedAt);
      setClockNow(completedAt);
      runCompletedAtRef.current = Date.now();
      lastEffectiveInteractionAtRef.current = null;
      runEffectiveInteractionMsRef.current =
        effectiveInteractionAccumulatedMsRef.current;
      if (sessionKind === "GUIDED_PRACTICE") {
        setShowPracticeHistory(false);
      }
      setStatus(next.outcome === "WON" ? "WON" : "LOST");
      setNotice({
        id: next.outcome === "WON"
          ? "solo.wonNotice"
          : "solo.lostNotice",
      });
    },
    [cancelCoachFeedbackAnalysis, sessionKind],
  );

  const recordAction = useCallback(
    (
      actionType: BoardAction,
      originIndex: number,
      delta: RevealDelta,
      preStateHash: string,
      options: RecordActionOptions = {},
    ) => {
      const physicalClicks = options.physicalClicks ?? 1;
      const actionAt = options.actionAt ?? performance.now();
      const safeReveals = delta.revealed.reduce(
        (count, cell) => count + (cell.value >= 0 ? 1 : 0),
        0,
      );
      const countedAction: CountedBoardAction = {
        actionType,
        accepted: delta.accepted,
        physicalClicks,
        ...(delta.flagged === undefined
          ? {}
          : { flagged: delta.flagged.flagged }),
      };
      if (delta.hitMine) {
        setTerminalDetonatedIndex(
          delta.revealed.find((cell) => cell.value < 0)?.index ?? originIndex,
        );
      }
      actionTraceRef.current.push(countedAction);
      if (sessionKind === "GUIDED_PRACTICE") {
        appendPracticeEvent(
          (seq, elapsedMs) => ({
            eventType: "PLAYER_ACTION",
            seq,
            elapsedMs,
            actionType,
            cellIndex: originIndex,
            physicalClicks,
            preStateHash,
            accepted: delta.accepted,
            ...(delta.rejectReason ? { rejectReason: delta.rejectReason } : {}),
            postStateHash: delta.stateHash,
          }),
          actionAt,
        );
        if (delta.revealed.some(({ value }) => value >= 0)) {
          practiceSuppressedAutoFlagsRef.current.clear();
          practiceAutoMarkEvidenceHashRef.current = null;
        }
        if (delta.flagged?.flagged === false) {
          if (autoFlaggedIndexesRef.current.has(originIndex)) {
            practiceSuppressedAutoFlagsRef.current.add(originIndex);
            autoFlaggedIndexesRef.current.delete(originIndex);
          }
          setAutoFlaggedIndexes((current) => {
            if (!current.has(originIndex)) return current;
            const next = new Set(current);
            next.delete(originIndex);
            return next;
          });
        }
      } else if (replayActionTraceRef.current.length < SOLO_REPLAY_MAX_ACTIONS) {
        replayActionTraceRef.current.push({
          seq: replayActionTraceRef.current.length + 1,
          elapsedMs: options.replayElapsedMs ??
            (startedAt === null ? 0 : Math.max(0, actionAt - startedAt)),
          actionType,
          cellIndex: originIndex,
          physicalClicks,
          preStateHash,
          accepted: delta.accepted,
          ...(delta.rejectReason ? { rejectReason: delta.rejectReason } : {}),
          postStateHash: delta.stateHash,
        });
      } else {
        replayTruncationReasonRef.current = "ACTION_LIMIT";
      }
      lastReplayStateHashRef.current = delta.stateHash;
      setActionBreakdown((current) =>
        appendActionBreakdown(current, countedAction),
      );

      visualSequenceRef.current += 1;
      setActionVisual({
        id: visualSequenceRef.current,
        actionType,
        originIndex,
        changedIndexes: [
          ...delta.revealed.map((cell) => cell.index),
          ...(delta.flagged === undefined ? [] : [delta.flagged.index]),
          ...(delta.questioned === undefined ? [] : [delta.questioned.index]),
        ],
        accepted: delta.accepted,
        revealedSafeCount: safeReveals,
      });

      const comboAction =
        actionType === "TOGGLE_FLAG"
          ? delta.flagged?.flagged === false
            ? "UNFLAG"
            : "FLAG"
          : actionType;
      applyComboEvent({
        type: "ACTION",
        actor: options.comboActor ?? "PLAYER",
        action: comboAction,
        accepted: delta.accepted,
        safeCellsRevealed: safeReveals,
        hitMine: delta.hitMine === true,
        atMs: actionAt,
      });
    },
    [appendPracticeEvent, applyComboEvent, sessionKind, startedAt],
  );

  const beginGame = useCallback(
    (
      spec: BoardSpec,
      firstIndex: number,
      flaggedIndexes: readonly number[],
      options: {
        readonly generation?: MessageDescriptor;
        readonly physicalClicks?: number;
      } = {},
    ) => {
      const next = createGameState(createBoard(spec));
      const questionedIndexes = Array.from(
        gameRef.current.visibility,
        (visibility, index) =>
          visibility === CELL_QUESTIONED ? index : -1,
      ).filter((index) => index >= 0);
      applyFlagsByIndex(flaggedIndexes, next);
      applyQuestionsByIndex(questionedIndexes, next);
      initialFlagsRef.current = [...new Set(flaggedIndexes)].sort((a, b) => a - b);
      initialQuestionsRef.current = [...new Set(questionedIndexes)].sort((a, b) => a - b);
      boardSpecRef.current = Object.freeze({ ...spec });
      const beganAt = performance.now();
      const nextRunIdentity = sessionKind === "GUIDED_PRACTICE"
        ? {
            runId: globalThis.crypto.randomUUID(),
            trainingSessionId: globalThis.crypto.randomUUID(),
          }
        : createSoloRunIdentity();
      runIdentityRef.current = nextRunIdentity;
      runCompletedAtRef.current = null;
      historyEnqueuedRunRef.current = "";
      effectiveInteractionAccumulatedMsRef.current = 0;
      lastEffectiveInteractionAtRef.current =
        document.visibilityState === "visible" ? beganAt : null;
      runEffectiveInteractionMsRef.current = 0;
      const preStateHash = hashGameState(next);
      lastReplayStateHashRef.current = preStateHash;
      const delta = revealCell(next, firstIndex);
      if (sessionKind === "GUIDED_PRACTICE") {
        practiceStartedAtRef.current = beganAt;
        practiceLastInteractionAtRef.current = beganAt;
      }
      setStartedAt(beganAt);
      setFinishedAt(null);
      setClockNow(beganAt);
      setSeed(spec.seed);
      const calculatedBoardHash = hashBoard(next.board);
      setBoardHash(calculatedBoardHash);
      setGenerationSummary(options.generation ?? null);
      setBoard3BV(calculate3BV(next.board).value);
      track(
        sessionKind === "GUIDED_PRACTICE"
          ? "practice_run_started"
          : "solo_run_started",
        {
          trainingSessionId: nextRunIdentity.trainingSessionId,
          preset,
          generationMode: config.mode,
          width: config.width,
          height: config.height,
          mines: config.mines,
          ...(sessionKind === "GUIDED_PRACTICE"
            ? {
                assistMode: autoMarkMinesRef.current
                  ? "AUTO_MARK_MINES"
                  : "COACH",
              }
            : {}),
        },
      );
      replaceGame(next);
      finishIfTerminal(next, beganAt);
      recordAction(
        "REVEAL",
        firstIndex,
        delta,
        preStateHash,
        {
          physicalClicks: options.physicalClicks ?? 1,
          comboActor: "PLAYER",
          actionAt: beganAt,
          replayElapsedMs: 0,
        },
      );
      return next.outcome;
    },
    [config, finishIfTerminal, preset, recordAction, replaceGame, sessionKind, track],
  );

  const generateNoGuess = useCallback(
    (
      firstIndex: number,
      flaggedIndexes: readonly number[],
      physicalClicks: number,
    ) => {
      if (generationActiveRef.current) return;
      cancelGeneration();
      generationActiveRef.current = true;
      const requestId = workerRequestRef.current;
      const generationStartedAt = performance.now();
      const generationTelemetryEvent = sessionKind === "GUIDED_PRACTICE"
        ? "practice_no_guess_generation_finished"
        : "no_guess_generation_finished";
      setStatus("GENERATING");
      setNotice({ id: "solo.generatingNotice" });

      let worker: Worker;
      try {
        worker = new Worker(
          new URL("../workers/noGuessWorker.ts", import.meta.url),
          { type: "module" },
        );
      } catch {
        generationActiveRef.current = false;
        setStatus("READY");
        setNotice({ id: "solo.workerUnavailable" });
        track(generationTelemetryEvent, {
          preset,
          success: false,
          attempts: 0,
          elapsedMs: performance.now() - generationStartedAt,
          failureReason: "GENERATION_ERROR",
        });
        return;
      }
      workerRef.current = worker;
      const request: NoGuessWorkerRequest = {
        requestId,
        config,
        startIndex: firstIndex,
        maxAttempts: 50,
        maxDurationMs: 5_000,
      };

      const fail = (message: MessageDescriptor, failureReason: string) => {
        if (requestId !== workerRequestRef.current) return;
        worker.terminate();
        workerRef.current = null;
        generationActiveRef.current = false;
        if (workerTimeoutRef.current !== null) {
          window.clearTimeout(workerTimeoutRef.current);
          workerTimeoutRef.current = null;
        }
        setStatus("READY");
        setNotice(message);
        track(generationTelemetryEvent, {
          preset,
          success: false,
          attempts: 0,
          elapsedMs: performance.now() - generationStartedAt,
          failureReason,
        });
      };

      worker.onmessage = (event: MessageEvent<NoGuessWorkerResponse>) => {
        if (
          event.data.requestId !== requestId ||
          requestId !== workerRequestRef.current
        ) {
          return;
        }
        worker.terminate();
        workerRef.current = null;
        generationActiveRef.current = false;
        if (workerTimeoutRef.current !== null) {
          window.clearTimeout(workerTimeoutRef.current);
          workerTimeoutRef.current = null;
        }
        if (!event.data.ok) {
          setStatus("READY");
          setNotice({ id: "solo.generationLimit" });
          track(generationTelemetryEvent, {
            preset,
            success: false,
            attempts: event.data.attempts,
            elapsedMs: event.data.elapsedMs,
            failureReason: "ATTEMPT_LIMIT",
          });
          return;
        }
        track(generationTelemetryEvent, {
          preset,
          success: true,
          attempts: event.data.attempts,
          elapsedMs: event.data.elapsedMs,
        });
        const outcome = beginGame(
          event.data.spec,
          firstIndex,
          flaggedIndexes,
          {
            generation: {
              id: "solo.generationSummary",
              values: {
                attempts: event.data.attempts,
                elapsed: event.data.elapsedMs.toFixed(0),
              },
            },
            physicalClicks,
          },
        );
        if (outcome === "PLAYING") {
          setNotice({ id: "solo.generationVerified" });
        }
      };
      worker.onerror = () => {
        fail(
          { id: "solo.generationFailed" },
          "GENERATION_ERROR",
        );
      };
      workerTimeoutRef.current = window.setTimeout(() => {
        fail(
          { id: "solo.generationTimeout" },
          "TIME_LIMIT",
        );
      }, 5_000);
      try {
        worker.postMessage(request);
      } catch {
        fail(
          { id: "solo.generationPostFailed" },
          "GENERATION_ERROR",
        );
      }
    },
    [beginGame, cancelGeneration, config, preset, sessionKind, track],
  );

  const resolvePracticeActionFeedback = useCallback(
    (
      visibleState: VisibleBoardState,
      boardAction: BoardAction,
      coachAction: CoachAction,
      cellIndex: number,
      expectedPostStateHash: string,
    ) => {
      cancelCoachFeedbackAnalysis();
      const requestId = coachFeedbackRequestRef.current;
      const requestedHash = hashVisibleBoardState(visibleState);
      const closeWorker = () => {
        coachFeedbackWorkerRef.current?.terminate();
        coachFeedbackWorkerRef.current = null;
        if (coachFeedbackTimeoutRef.current !== null) {
          window.clearTimeout(coachFeedbackTimeoutRef.current);
          coachFeedbackTimeoutRef.current = null;
        }
      };
      const finish = (suggestion: CoachSuggestion | null) => {
        if (requestId !== coachFeedbackRequestRef.current) return;
        closeWorker();
        if (
          suggestion === null ||
          suggestion.requestId !== requestId ||
          suggestion.stateHash !== requestedHash ||
          gameRef.current.outcome !== "PLAYING" ||
          hashGameState(gameRef.current) !== expectedPostStateHash
        ) {
          return;
        }
        const proven = boardAction === "CHORD"
          ? isCoachChordProven(suggestion, visibleState, cellIndex)
          : isCoachActionProven(suggestion, visibleState, coachAction, cellIndex);
        if (proven) {
          setNotice({ id: "practice.feedback.proven" });
          return;
        }
        if (
          suggestion.status !== "READY" &&
          suggestion.status !== "NO_FORCED_MOVE"
        ) {
          return;
        }
        setNotice({
          id: boardAction === "TOGGLE_FLAG"
            ? "practice.feedback.flagUnproven"
            : "practice.feedback.safeUnproven",
        });
      };

      let worker: Worker;
      try {
        worker = new Worker(
          new URL("../workers/practiceCoachWorker.ts", import.meta.url),
          { type: "module" },
        );
      } catch {
        return;
      }
      coachFeedbackWorkerRef.current = worker;
      worker.onmessage = (event: MessageEvent<unknown>) => {
        finish(parseCoachSuggestion(event.data));
      };
      worker.onerror = () => finish(null);
      worker.onmessageerror = () => finish(null);
      coachFeedbackTimeoutRef.current = window.setTimeout(
        () => finish(null),
        PRACTICE_COACH_TIMEOUT_MS,
      );
      try {
        worker.postMessage(createCoachRequest(requestId, visibleState));
      } catch {
        finish(null);
      }
    },
    [cancelCoachFeedbackAnalysis],
  );

  const handleBoardAction = useCallback(
    (
      action: BoardAction,
      cellIndex: number,
      inputMeta: BoardInputMeta,
    ) => {
      const current = gameRef.current;
      if (
        status === "GENERATING" ||
        status === "WON" ||
        status === "LOST"
      ) {
        return;
      }
      cancelCoachFeedbackAnalysis();
      setNotice(null);
      const { physicalClicks } = inputMeta;

      if (status === "READY") {
        if (action === "TOGGLE_FLAG") {
          if (questionMarksEnabled) cycleCellMark(current, cellIndex);
          else toggleFlag(current, cellIndex);
          setRevision((value) => value + 1);
          setNotice({ id: "solo.initialFlags" });
          return;
        }
        if (action === "CHORD") {
          chordCell(current, cellIndex);
          setNotice({ id: "solo.initialChord" });
          return;
        }
        if (current.visibility[cellIndex] === CELL_FLAGGED) {
          setNotice({ id: "solo.flaggedReveal" });
          return;
        }

        const flaggedIndexes = Array.from(
          current.visibility,
          (visibility, index) =>
            visibility === CELL_FLAGGED ? index : -1,
        ).filter((index) => index >= 0);
        const pendingReplaySpec = pendingReplaySpecRef.current;
        if (pendingReplaySpec !== null) {
          pendingReplaySpecRef.current = null;
          const outcome = beginGame(
            pendingReplaySpec,
            cellIndex,
            flaggedIndexes,
            { physicalClicks },
          );
          if (outcome === "PLAYING") {
            setNotice({ id: "solo.sameBoardPlaying" });
          }
          return;
        }
        if (config.mode === "no_guess") {
          generateNoGuess(cellIndex, flaggedIndexes, physicalClicks);
          return;
        }
        const spec = createSoloBoardSpec(
          config,
          cellIndex,
          pendingSeedRef.current,
        );
        const outcome = beginGame(spec, cellIndex, flaggedIndexes, {
          physicalClicks,
        });
        if (outcome === "PLAYING") {
          setNotice({ id: "solo.classicStarted" });
        }
        return;
      }

      const actionAt = performance.now();
      const practicePreActionSnapshot = sessionKind === "GUIDED_PRACTICE"
        ? {
            game: cloneGameState(current),
            actionCount: actionTraceRef.current.length,
            practiceEventCount: practiceEventsRef.current.length,
            practiceEventsOverflow: practiceEventsOverflowRef.current,
            lastReplayStateHash: lastReplayStateHashRef.current,
            elapsedMs: startedAt === null ? 0 : Math.max(0, actionAt - startedAt),
            effectiveInteractionMs: effectiveInteractionAccumulatedMsRef.current,
          } satisfies PracticePreMineSnapshot
        : null;
      recordEffectiveInteraction(actionAt);
      if (sessionKind === "GUIDED_PRACTICE") {
        practiceLastInteractionAtRef.current = actionAt;
        setDisplayedCoachSuggestion(null);
      }
      const preStateHash = lastReplayStateHashRef.current;
      const visibleBefore = sessionKind === "GUIDED_PRACTICE"
        ? visibleBoardStateForPractice(current, autoFlaggedIndexesRef.current)
        : null;
      const suggestionBefore = coachAnalysisRef.current;
      const expectedCoachAction: CoachAction | null = action === "TOGGLE_FLAG"
        ? current.visibility[cellIndex] === CELL_FLAGGED
          ? "UNFLAG"
          : current.visibility[cellIndex] === CELL_QUESTIONED && questionMarksEnabled
            ? null
            : "FLAG"
        : "REVEAL";
      const followedProof = visibleBefore !== null && suggestionBefore !== null &&
        (action === "CHORD"
          ? isCoachChordProven(suggestionBefore, visibleBefore, cellIndex)
          : expectedCoachAction !== null && isCoachActionProven(
            suggestionBefore,
            visibleBefore,
            expectedCoachAction,
            cellIndex,
          ));
      const coachAnalysisWasConclusive = visibleBefore !== null &&
        suggestionBefore !== null &&
        suggestionBefore.stateHash === hashVisibleBoardState(visibleBefore) &&
        (suggestionBefore.status === "READY" ||
          suggestionBefore.status === "NO_FORCED_MOVE");
      const delta =
        action === "REVEAL"
          ? revealCell(current, cellIndex)
          : action === "TOGGLE_FLAG"
            ? questionMarksEnabled
              ? cycleCellMark(current, cellIndex)
              : toggleFlag(current, cellIndex)
            : chordCell(current, cellIndex);
      const postStateHash = hashGameState(current);
      if (delta.hitMine === true && practicePreActionSnapshot !== null) {
        practicePreMineSnapshotRef.current = practicePreActionSnapshot;
      }
      recordAction(
        action,
        cellIndex,
        delta,
        preStateHash,
        {
          physicalClicks,
          comboActor: "PLAYER",
          actionAt,
        },
      );
      if (!delta.accepted) {
        setNotice({
          id: delta.rejectReason === "FLAG_COUNT_MISMATCH"
            ? "solo.chordRejected"
            : "solo.actionUnchanged",
        });
      } else if (sessionKind === "GUIDED_PRACTICE") {
        if (followedProof) {
          setNotice({ id: "practice.feedback.proven" });
        } else if (
          action !== "TOGGLE_FLAG" &&
          delta.hitMine !== true &&
          delta.revealed.some(({ value }) => value >= 0)
        ) {
          setNotice({
            id: coachAnalysisWasConclusive
              ? "practice.feedback.safeUnproven"
              : "practice.feedback.notEvaluated",
          });
        } else if (action === "TOGGLE_FLAG" && expectedCoachAction !== null) {
          setNotice({
            id: coachAnalysisWasConclusive
              ? "practice.feedback.flagUnproven"
              : "practice.feedback.notEvaluated",
          });
        }
        if (
          !followedProof &&
          !coachAnalysisWasConclusive &&
          visibleBefore !== null &&
          expectedCoachAction !== null &&
          (action === "TOGGLE_FLAG" || (
            delta.hitMine !== true &&
            delta.revealed.some(({ value }) => value >= 0)
          ))
        ) {
          resolvePracticeActionFeedback(
            visibleBefore,
            action,
            expectedCoachAction,
            cellIndex,
            postStateHash,
          );
        }
      }
      replaceGame(current);
      finishIfTerminal(current, actionAt);
    },
    [
      beginGame,
      cancelCoachFeedbackAnalysis,
      config,
      finishIfTerminal,
      generateNoGuess,
      questionMarksEnabled,
      recordEffectiveInteraction,
      recordAction,
      replaceGame,
      resolvePracticeActionFeedback,
      sessionKind,
      startedAt,
      status,
    ],
  );

  const showCoachSuggestion = useCallback(
    (suggestion: CoachSuggestion, trigger: PracticeHintTrigger) => {
      const current = gameRef.current;
      if (sessionKind !== "GUIDED_PRACTICE" || current.outcome !== "PLAYING") {
        return false;
      }
      const visible = visibleBoardStateForPractice(current, autoFlaggedIndexesRef.current);
      const visibleStateHash = hashVisibleBoardState(visible);
      if (suggestion.stateHash !== visibleStateHash) {
        setNotice({ id: "practice.coach.stale" });
        return false;
      }
      if (
        trigger === "IDLE" &&
        practiceShownStateHashesRef.current.has(visibleStateHash)
      ) {
        return false;
      }
      if (trigger === "IDLE") {
        practiceShownStateHashesRef.current.add(visibleStateHash);
      }
      setDisplayedCoachSuggestion(suggestion);
      appendPracticeEvent(
        (seq, elapsedMs): PracticeAssistanceShownEventV1 => ({
          eventType: "ASSISTANCE_SHOWN",
          seq,
          elapsedMs,
          trigger,
          visibleStateHash,
          suggestion: structuredClone(suggestion),
        }),
      );
      track("practice_hint_shown", {
        trigger,
        status: suggestion.status,
        action: suggestion.action ?? "NONE",
      });
      return true;
    },
    [appendPracticeEvent, sessionKind, track],
  );

  const applyCoachAction = useCallback(
    (
      suggestion: CoachSuggestion,
      trigger: PracticeCoachActionEventV1["trigger"],
    ) => {
      const current = gameRef.current;
      if (sessionKind !== "GUIDED_PRACTICE" || current.outcome !== "PLAYING") {
        return false;
      }
      cancelCoachFeedbackAnalysis();
      const visible = visibleBoardStateForPractice(current, autoFlaggedIndexesRef.current);
      if (!isCoachSuggestionApplicable(suggestion, visible)) return false;
      if (
        trigger === "AUTO_MARK" &&
        (suggestion.action !== "FLAG" ||
          practiceSuppressedAutoFlagsRef.current.has(suggestion.cellIndex!))
      ) {
        return false;
      }
      const action = suggestion.action!;
      const cellIndex = suggestion.cellIndex!;
      const proof = suggestion.proof!;
      const preStateHash = hashGameState(current);
      const actionAt = performance.now();
      const delta = action === "REVEAL"
        ? revealCell(current, cellIndex)
        : toggleFlag(current, cellIndex);
      if (!delta.accepted) return false;

      appendPracticeEvent(
        (seq, elapsedMs): PracticeCoachActionEventV1 => ({
          eventType: "COACH_ACTION",
          seq,
          elapsedMs,
          trigger,
          action,
          cellIndex,
          physicalClicks: 0,
          proof: structuredClone(proof),
          preStateHash,
          postStateHash: delta.stateHash,
        }),
        actionAt,
      );
      lastReplayStateHashRef.current = delta.stateHash;
      practiceLastInteractionAtRef.current = actionAt;
      if (trigger === "AUTO_MARK") {
        practiceUsedAutoMarkRef.current = true;
        autoFlaggedIndexesRef.current.add(cellIndex);
        setAutoFlaggedIndexes((currentIndexes) => {
          const next = new Set(currentIndexes);
          next.add(cellIndex);
          return next;
        });
      } else if (action === "UNFLAG") {
        autoFlaggedIndexesRef.current.delete(cellIndex);
        setAutoFlaggedIndexes((currentIndexes) => {
          if (!currentIndexes.has(cellIndex)) return currentIndexes;
          const next = new Set(currentIndexes);
          next.delete(cellIndex);
          return next;
        });
      }
      if (delta.revealed.some(({ value }) => value >= 0)) {
        practiceSuppressedAutoFlagsRef.current.clear();
        practiceAutoMarkEvidenceHashRef.current = null;
      }

      const safeReveals = delta.revealed.filter(({ value }) => value >= 0).length;
      visualSequenceRef.current += 1;
      setActionVisual({
        id: visualSequenceRef.current,
        actionType: action === "REVEAL" ? "REVEAL" : "TOGGLE_FLAG",
        originIndex: cellIndex,
        changedIndexes: [
          ...delta.revealed.map(({ index }) => index),
          ...(delta.flagged ? [delta.flagged.index] : []),
        ],
        accepted: true,
        revealedSafeCount: safeReveals,
      });
      applyComboEvent({
        type: "ACTION",
        actor: "COACH",
        action,
        accepted: true,
        safeCellsRevealed: safeReveals,
        hitMine: delta.hitMine === true,
        atMs: actionAt,
      });
      setDisplayedCoachSuggestion(null);
      setCurrentCoachAnalysis(null);
      track("practice_assist_applied", {
        trigger,
        action,
      });
      replaceGame(current);
      finishIfTerminal(current, actionAt);
      return true;
    },
    [
      appendPracticeEvent,
      applyComboEvent,
      cancelCoachFeedbackAnalysis,
      finishIfTerminal,
      replaceGame,
      sessionKind,
      setCurrentCoachAnalysis,
      track,
    ],
  );

  const applyAutomaticMineBatch = useCallback(
    (suggestion: CoachSuggestion) => {
      const current = gameRef.current;
      if (current.outcome !== "PLAYING") return false;
      const initialVisible = visibleBoardStateForPractice(
        current,
        autoFlaggedIndexesRef.current,
      );
      const evidenceHash = hashVisibleBoardState({
        ...initialVisible,
        playerClaims: [],
        provenMines: [],
      });
      if (practiceAutoMarkEvidenceHashRef.current === evidenceHash) return false;
      practiceAutoMarkEvidenceHashRef.current = evidenceHash;

      const batchSuggestion: CoachSuggestion = {
        ...suggestion,
        mineActions: suggestion.mineActions.filter(
          ({ cellIndex }) => !practiceSuppressedAutoFlagsRef.current.has(cellIndex),
        ),
      };
      let applied = false;
      const appliedIndexes: number[] = [];
      let firstAppliedAction: ReturnType<typeof coachMineActionForApplicationStep> = null;
      for (let stepIndex = 0; ; stepIndex += 1) {
        const latest = gameRef.current;
        if (latest.outcome !== "PLAYING") break;
        const latestVisible = visibleBoardStateForPractice(
          latest,
          autoFlaggedIndexesRef.current,
        );
        const mineAction = coachMineActionForApplicationStep(
          batchSuggestion,
          initialVisible,
          latestVisible,
          stepIndex,
        );
        if (!mineAction) break;
        const reboundSuggestion: CoachSuggestion = {
          ...batchSuggestion,
          stateHash: mineAction.proof.stateHash,
          mineActions: [mineAction],
          action: "FLAG",
          cellIndex: mineAction.cellIndex,
          proof: mineAction.proof,
        };
        if (!applyCoachAction(reboundSuggestion, "AUTO_MARK")) break;
        firstAppliedAction ??= mineAction;
        appliedIndexes.push(mineAction.cellIndex);
        applied = true;
      }
      if (applied && firstAppliedAction) {
        // React batches the individual flag state updates into one paint. Give
        // Canvas the complete dirty set so every flag glyph is redrawn, not
        // just the final action while earlier cells only show the coach dot.
        visualSequenceRef.current += 1;
        setActionVisual({
          id: visualSequenceRef.current,
          actionType: "TOGGLE_FLAG",
          originIndex: firstAppliedAction.cellIndex,
          changedIndexes: appliedIndexes,
          accepted: true,
          revealedSafeCount: 0,
        });
        const latestVisible = visibleBoardStateForPractice(
          gameRef.current,
          autoFlaggedIndexesRef.current,
        );
        const latestHash = hashVisibleBoardState(latestVisible);
        const proof = { ...firstAppliedAction.proof, stateHash: latestHash };
        practiceAutoMarkExplanationRef.current = true;
        setDisplayedCoachSuggestion({
          ...batchSuggestion,
          stateHash: latestHash,
          action: "FLAG",
          cellIndex: firstAppliedAction.cellIndex,
          proof,
          mineActions: [{ cellIndex: firstAppliedAction.cellIndex, proof }],
        });
      }
      return applied;
    },
    [applyCoachAction],
  );

  const requestCoachAnalysis = useCallback(
    (manualRequest = false) => {
      const current = gameRef.current;
      if (sessionKind !== "GUIDED_PRACTICE" || current.outcome !== "PLAYING") {
        return;
      }
      if (manualRequest) practiceManualHintPendingRef.current = true;
      cancelCoachAnalysis();
      const visibleState = visibleBoardStateForPractice(
        current,
        autoFlaggedIndexesRef.current,
      );
      const requestedHash = hashVisibleBoardState(visibleState);
      const requestId = coachRequestRef.current + 1;
      coachRequestRef.current = requestId;
      setCurrentCoachAnalysis(null);
      setCoachTransportError(false);
      setCoachBusy(true);

      const finishWithTransportError = () => {
        if (requestId !== coachRequestRef.current) return;
        coachWorkerRef.current?.terminate();
        coachWorkerRef.current = null;
        if (coachTimeoutRef.current !== null) {
          window.clearTimeout(coachTimeoutRef.current);
          coachTimeoutRef.current = null;
        }
        setCoachBusy(false);
        setCurrentCoachAnalysis(null);
        setDisplayedCoachSuggestion(null);
        setCoachTransportError(true);
        practiceManualHintPendingRef.current = false;
        setNotice({ id: "practice.coach.error" });
      };

      const finishWithSuggestion = (suggestion: CoachSuggestion) => {
        if (requestId !== coachRequestRef.current) return;
        coachWorkerRef.current?.terminate();
        coachWorkerRef.current = null;
        if (coachTimeoutRef.current !== null) {
          window.clearTimeout(coachTimeoutRef.current);
          coachTimeoutRef.current = null;
        }
        setCoachBusy(false);
        const latest = gameRef.current;
        if (latest.outcome !== "PLAYING") return;
        const latestVisible = visibleBoardStateForPractice(
          latest,
          autoFlaggedIndexesRef.current,
        );
        if (
          suggestion.requestId !== requestId ||
          suggestion.stateHash !== requestedHash ||
          suggestion.stateHash !== hashVisibleBoardState(latestVisible)
        ) {
          if (practiceManualHintPendingRef.current) {
            practiceManualHintPendingRef.current = false;
            setNotice({ id: "practice.coach.stale" });
          }
          return;
        }
        setCurrentCoachAnalysis(suggestion);
        setCoachTransportError(false);
        if (practiceManualHintPendingRef.current) {
          practiceManualHintPendingRef.current = false;
          showCoachSuggestion(suggestion, "REQUEST");
          return;
        }
        if (suggestion.status === "ERROR" || suggestion.status === "CONTRADICTION") {
          practiceShownStateHashesRef.current.add(suggestion.stateHash);
          setDisplayedCoachSuggestion(suggestion);
          setNotice({
            id: suggestion.status === "ERROR"
              ? "practice.coach.error"
              : "practice.coach.contradiction",
          });
          return;
        }
        if (autoMarkMinesRef.current) {
          applyAutomaticMineBatch(suggestion);
        }
      };

      let worker: Worker;
      try {
        worker = new Worker(
          new URL("../workers/practiceCoachWorker.ts", import.meta.url),
          { type: "module" },
        );
      } catch {
        finishWithTransportError();
        return;
      }
      coachWorkerRef.current = worker;
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const suggestion = parseCoachSuggestion(event.data);
        if (suggestion) finishWithSuggestion(suggestion);
        else finishWithTransportError();
      };
      worker.onerror = () => {
        finishWithTransportError();
      };
      worker.onmessageerror = () => {
        finishWithTransportError();
      };
      coachTimeoutRef.current = window.setTimeout(() => {
        finishWithTransportError();
      }, PRACTICE_COACH_TIMEOUT_MS);
      try {
        worker.postMessage(createCoachRequest(requestId, visibleState));
      } catch {
        finishWithTransportError();
      }
    },
    [
      applyAutomaticMineBatch,
      cancelCoachAnalysis,
      sessionKind,
      setCurrentCoachAnalysis,
      showCoachSuggestion,
    ],
  );

  const requestImmediateHint = useCallback(() => {
    const current = gameRef.current;
    if (current.outcome !== "PLAYING") {
      setNotice({ id: "practice.coach.waitingFirstMove" });
      return;
    }
    const visible = visibleBoardStateForPractice(current, autoFlaggedIndexesRef.current);
    const analysis = coachAnalysisRef.current;
    if (analysis && analysis.stateHash === hashVisibleBoardState(visible)) {
      showCoachSuggestion(analysis, "REQUEST");
      return;
    }
    setNotice({ id: "practice.coach.analyzing" });
    requestCoachAnalysis(true);
  }, [requestCoachAnalysis, showCoachSuggestion]);

  const demonstrateNextStep = useCallback(() => {
    const current = gameRef.current;
    if (current.outcome !== "PLAYING") {
      setNotice({ id: "practice.coach.waitingFirstMove" });
      return;
    }
    const suggestion = coachAnalysisRef.current;
    if (!suggestion) {
      setNotice({ id: "practice.demo.unavailable" });
      requestCoachAnalysis(false);
      return;
    }
    if (!applyCoachAction(suggestion, "DEMONSTRATE")) {
      setNotice({ id: "practice.demo.actionFailed" });
    }
  }, [applyCoachAction, requestCoachAnalysis]);

  const toggleAutoMarkMines = useCallback(() => {
    const next = !autoMarkMinesRef.current;
    autoMarkMinesRef.current = next;
    setAutoMarkMines(next);
    if (!next) return;
    practiceAutoMarkEvidenceHashRef.current = null;
    practiceUsedAutoMarkRef.current = true;
    const suggestion = coachAnalysisRef.current;
    if (suggestion) applyAutomaticMineBatch(suggestion);
  }, [applyAutomaticMineBatch]);

  useEffect(() => {
    if (sessionKind !== "GUIDED_PRACTICE" || status !== "PLAYING") {
      cancelCoachAnalysis();
      setCurrentCoachAnalysis(null);
      setDisplayedCoachSuggestion(null);
      return;
    }
    if (practiceAutoMarkExplanationRef.current) {
      practiceAutoMarkExplanationRef.current = false;
    } else {
      setDisplayedCoachSuggestion(null);
    }
    setCoachIdleSeconds(8);
    requestCoachAnalysis(false);
    return cancelCoachAnalysis;
  }, [
    cancelCoachAnalysis,
    requestCoachAnalysis,
    revision,
    sessionKind,
    setCurrentCoachAnalysis,
    status,
  ]);

  useEffect(() => {
    if (
      sessionKind !== "GUIDED_PRACTICE" ||
      status !== "PLAYING" ||
      coachAnalysis === null ||
      practiceShownStateHashesRef.current.has(coachAnalysis.stateHash)
    ) {
      return;
    }
    const tick = () => {
      if (document.visibilityState !== "visible") {
        practiceLastInteractionAtRef.current = null;
        setCoachIdleSeconds(8);
        return;
      }
      const now = performance.now();
      practiceLastInteractionAtRef.current ??= now;
      const remainingMs = Math.max(
        0,
        PRACTICE_COACH_IDLE_MS - (now - practiceLastInteractionAtRef.current),
      );
      setCoachIdleSeconds(Math.max(0, Math.ceil(remainingMs / 1_000)));
      if (remainingMs === 0) showCoachSuggestion(coachAnalysis, "IDLE");
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [coachAnalysis, sessionKind, showCoachSuggestion, status]);

  const choosePreset = (
    nextPreset: Exclude<SoloPreset, "custom">,
  ) => {
    const nextConfig: SoloBoardConfig = {
      ...SOLO_PRESETS[nextPreset],
      mode,
    };
    setDraftWidth(String(nextConfig.width));
    setDraftHeight(String(nextConfig.height));
    setDraftMines(String(nextConfig.mines));
    resetBoard(nextConfig, nextPreset);
    persistPreferences(nextConfig, nextPreset);
  };

  const chooseSessionKind = (nextSessionKind: SoloSessionKind) => {
    let isFirstGuidedPractice = false;
    if (nextSessionKind === "GUIDED_PRACTICE") {
      try {
        isFirstGuidedPractice = localStorage.getItem(GUIDED_PRACTICE_STARTED_KEY) === null;
      } catch {
        isFirstGuidedPractice = true;
      }
    }
    const nextPreset = isFirstGuidedPractice ? "beginner" : preset;
    const nextConfig: SoloBoardConfig = nextSessionKind === "GUIDED_PRACTICE"
      ? {
          ...(isFirstGuidedPractice ? SOLO_PRESETS.beginner : config),
          mode: "no_guess",
        }
      : config;
    if (isFirstGuidedPractice) {
      setStatsLevel("basic");
      setDraftWidth(String(nextConfig.width));
      setDraftHeight(String(nextConfig.height));
      setDraftMines(String(nextConfig.mines));
    }
    resetBoard(nextConfig, nextPreset, nextSessionKind);
    persistPreferences(nextConfig, nextPreset, isFirstGuidedPractice ? "basic" : statsLevel);
  };

  const chooseMode = (nextMode: SoloGenerationMode) => {
    const nextConfig = { ...config, mode: nextMode };
    const error = configErrorDescriptor(nextConfig);
    if (error) {
      setNotice(error);
      return;
    }
    resetBoard(nextConfig, preset);
    persistPreferences(nextConfig, preset);
  };

  const applyCustom = () => {
    const nextConfig: SoloBoardConfig = {
      width: Number(draftWidth),
      height: Number(draftHeight),
      mines: Number(draftMines),
      mode,
    };
    const error = configErrorDescriptor(nextConfig);
    if (error) {
      setNotice(error);
      return;
    }
    resetBoard(nextConfig, "custom");
    persistPreferences(nextConfig, "custom");
  };

  const chooseCustom = () => {
    setPreset("custom");
    setNotice({ id: "solo.customPrompt" });
  };

  const startConfiguredGame = () => {
    const nextConfig: SoloBoardConfig =
      preset === "custom"
        ? {
            width: Number(draftWidth),
            height: Number(draftHeight),
            mines: Number(draftMines),
            mode,
          }
        : config;
    const error = configErrorDescriptor(nextConfig);
    if (error) {
      setNotice(error);
      return;
    }
    resetBoard(nextConfig, preset);
    persistPreferences(nextConfig, preset);
    setSetupComplete(true);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const returnToSetup = () => {
    resetBoard(config, preset);
    setSetupComplete(false);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const exitSolo = () => {
    cancelGeneration();
    cancelCoachAnalysis();
    cancelCoachFeedbackAnalysis();
    clearCombo("EXIT_BOARD");
    onExit();
  };

  const persistPreferences = (
    nextConfig: SoloBoardConfig,
    nextPreset: SoloPreset,
    nextStatsLevel: StatsLevel = statsLevel,
    nextBoardTheme: BoardTheme = boardTheme,
    nextQuestionMarksEnabled: boolean = questionMarksEnabled,
    nextTimerFormat: SoloTimerFormatPreference = timerFormat,
  ) => {
    const preferences: SoloPreferencesV1 = {
      schemaVersion: SOLO_PREFERENCES_SCHEMA_VERSION,
      preset: nextPreset,
      config: nextConfig,
      statsLevel: nextStatsLevel,
      boardTheme: nextBoardTheme,
      questionMarksEnabled: nextQuestionMarksEnabled,
      timerFormat: nextTimerFormat,
    };
    try {
      saveSoloPreferences(preferences);
      return true;
    } catch {
      setNotice({ id: "solo.preferenceSaveFailed" });
      return false;
    }
  };

  const chooseStatsLevel = (next: StatsLevel) => {
    setStatsLevel(next);
    persistPreferences(config, preset, next, boardTheme);
  };

  const chooseBoardTheme = (next: BoardTheme) => {
    setBoardTheme(next);
    persistPreferences(config, preset, statsLevel, next);
  };

  const chooseQuestionMarks = (next: boolean) => {
    setQuestionMarksEnabled(next);
    persistPreferences(config, preset, statsLevel, boardTheme, next, timerFormat);
  };

  const chooseTimerFormat = (next: SoloTimerFormatPreference) => {
    setTimerFormat(next);
    persistPreferences(
      config,
      preset,
      statsLevel,
      boardTheme,
      questionMarksEnabled,
      next,
    );
  };

  useEffect(() => {
    if (initialGenerationMode !== undefined) {
      persistPreferences(initialConfig, initialPreset);
    }
  }, []);

  const replaySameBoard = () => {
    const currentSpec = boardSpecRef.current;
    if (
      sessionKind !== "STANDARD" ||
      (status !== "WON" && status !== "LOST") ||
      currentSpec === null
    ) {
      return;
    }
    const replaySpec = Object.freeze({ ...currentSpec });
    resetBoard(config, preset, "STANDARD");
    pendingReplaySpecRef.current = replaySpec;
    replaceGame(createGameState(createBoard(replaySpec)));
    setNotice({ id: "solo.sameBoardStarted" });
  };

  const rewindPracticeBeforeMine = () => {
    const snapshot = practicePreMineSnapshotRef.current;
    if (
      sessionKind !== "GUIDED_PRACTICE" ||
      status !== "LOST" ||
      practiceSaveState === "SAVING" ||
      snapshot === null
    ) {
      return;
    }
    cancelGeneration();
    cancelCoachAnalysis();
    cancelCoachFeedbackAnalysis();
    const now = performance.now();
    const rebasedStartedAt = now - snapshot.elapsedMs;
    const restoredGame = cloneGameState(snapshot.game);
    actionTraceRef.current = actionTraceRef.current.slice(0, snapshot.actionCount);
    practiceEventsRef.current = practiceEventsRef.current.slice(
      0,
      snapshot.practiceEventCount,
    );
    practiceEventsOverflowRef.current = snapshot.practiceEventsOverflow;
    lastReplayStateHashRef.current = snapshot.lastReplayStateHash;
    practiceStartedAtRef.current = rebasedStartedAt;
    practiceLastInteractionAtRef.current = now;
    practiceManualHintPendingRef.current = false;
    practiceShownStateHashesRef.current.clear();
    practiceAutoMarkEvidenceHashRef.current = null;
    practiceAutoMarkExplanationRef.current = false;
    practiceSavedRunRef.current = "";
    practicePreMineSnapshotRef.current = null;
    runIdentityRef.current = {
      runId: globalThis.crypto.randomUUID(),
      trainingSessionId: globalThis.crypto.randomUUID(),
    };
    runCompletedAtRef.current = null;
    historyEnqueuedRunRef.current = "";
    effectiveInteractionAccumulatedMsRef.current = snapshot.effectiveInteractionMs;
    lastEffectiveInteractionAtRef.current = now;
    runEffectiveInteractionMsRef.current = 0;
    setStartedAt(rebasedStartedAt);
    setFinishedAt(null);
    setClockNow(now);
    setStatus("PLAYING");
    setActionBreakdown(countBoardActions(actionTraceRef.current));
    setActionVisual(undefined);
    clearCombo();
    setCurrentCoachAnalysis(null);
    setDisplayedCoachSuggestion(null);
    setCoachTransportError(false);
    setCoachIdleSeconds(8);
    setPracticeSaveState("IDLE");
    setShowPracticeHistory(false);
    setTerminalDetonatedIndex(undefined);
    replaceGame(restoredGame);
    setNotice({ id: "practice.result.rewindNotice" });
  };

  const flags = countFlags(game);
  const elapsedMs =
    startedAt === null ? 0 : (finishedAt ?? clockNow) - startedAt;
  const cps = calculateCPS(
    coarsePointer
      ? actionBreakdown.semanticActions
      : actionBreakdown.physicalClicks,
    elapsedMs,
  );
  const metricView = resolveSoloMetricView({
    sessionKind,
    status,
    board3BV,
    elapsedMs,
    physicalClicks: actionBreakdown.physicalClicks,
  });
  const { threeBvPerSecond, ioe } = metricView;
  const currentRunId = runIdentityRef.current?.runId ?? "";
  const canRewindPractice = sessionKind === "GUIDED_PRACTICE" &&
    status === "LOST" && practicePreMineSnapshotRef.current !== null;
  const currentHistoryPending = sessionKind === "STANDARD" &&
    getPendingHistoryWrites().some(
      ({ record }) => record.recordId === currentRunId,
    );
  const reviewFinalBoard = () => {
    const target = document.getElementById("solo-board");
    if (!target) return;
    target.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "center",
    });
    target.focus({ preventScroll: true });
  };
  const openPracticeHistory = () => {
    setShowPracticeHistory(true);
    window.requestAnimationFrame(() => {
      document.getElementById("practice-history")?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    });
  };

  useEffect(() => {
    const runIdentity = runIdentityRef.current;
    if (
      sessionKind !== "GUIDED_PRACTICE" ||
      (status !== "WON" && status !== "LOST") ||
      runIdentity === null ||
      runCompletedAtRef.current === null ||
      practiceSavedRunRef.current === runIdentity.runId
    ) {
      return;
    }
    practiceSavedRunRef.current = runIdentity.runId;
    const boardSpec = boardSpecRef.current;
    if (boardSpec === null) return;
    const events = structuredClone(practiceEventsRef.current);
    const replay: PracticeReplayV1 = {
      schemaVersion: PRACTICE_REPLAY_SCHEMA_VERSION,
      recordId: runIdentity.runId,
      initialFlags: initialFlagsRef.current,
      initialQuestions: initialQuestionsRef.current,
      questionMarksEnabled,
      events,
    };
    const replayBytes = new TextEncoder().encode(JSON.stringify(replay)).byteLength;
    if (
      practiceEventsOverflowRef.current ||
      replayBytes > SOLO_REPLAY_MAX_BYTES
    ) {
      setPracticeSaveState("TOO_LARGE");
      setNotice({ id: "practice.result.replayTooLarge" });
      track("practice_run_terminal", {
        trainingSessionId: runIdentity.trainingSessionId,
        preset,
        generationMode: config.mode,
        outcome: status,
        elapsedMs,
        playerActions: events.filter(({ eventType }) => eventType === "PLAYER_ACTION").length,
        hintsShown: events.filter(({ eventType }) => eventType === "ASSISTANCE_SHOWN").length,
        hintsRequested: events.filter((event) => event.eventType === "ASSISTANCE_SHOWN" && event.trigger === "REQUEST").length,
        autoFlags: events.filter((event) => event.eventType === "COACH_ACTION" && event.trigger === "AUTO_MARK" && event.action === "FLAG").length,
        demonstratedActions: events.filter((event) => event.eventType === "COACH_ACTION" && event.trigger === "DEMONSTRATE").length,
        historySaved: false,
        historyFailureReason: "REPLAY_LIMIT",
      });
      void flushTelemetry();
      return;
    }
    const summary = {
      elapsedMs,
      playerActions: events.filter(({ eventType }) => eventType === "PLAYER_ACTION").length,
      hintsShown: events.filter(({ eventType }) => eventType === "ASSISTANCE_SHOWN").length,
      hintsRequested: events.filter((event) => event.eventType === "ASSISTANCE_SHOWN" && event.trigger === "REQUEST").length,
      autoFlags: events.filter((event) => event.eventType === "COACH_ACTION" && event.trigger === "AUTO_MARK" && event.action === "FLAG").length,
      demonstratedActions: events.filter((event) => event.eventType === "COACH_ACTION" && event.trigger === "DEMONSTRATE").length,
    };
    const record: PracticeRunRecordV1 = {
      schemaVersion: 1,
      kind: "GUIDED_PRACTICE",
      recordId: runIdentity.runId,
      completedAt: new Date(runCompletedAtRef.current).toISOString(),
      outcome: status,
      config: {
        preset,
        width: config.width,
        height: config.height,
        mines: config.mines,
        generationMode: config.mode,
      },
      board: {
        spec: boardSpec,
        boardHash,
        generatorRulesVersion: 1,
        trustStatus: "LOCAL_UNVERIFIED",
      },
      assistMode: practiceUsedAutoMarkRef.current
        ? "AUTO_MARK_MINES"
        : "COACH",
      summary,
      replay: {
        schemaVersion: PRACTICE_REPLAY_SCHEMA_VERSION,
        eventCount: replay.events.length,
        eventLogHash: hashPracticeReplay(replay),
      },
    };
    setPracticeSaveState("SAVING");
    void practiceHistoryStoreRef.current.put(record, replay).then(
      (capacity) => {
        if (!mountedRef.current || runIdentityRef.current?.runId !== runIdentity.runId) return;
        setPracticeSaveState("SAVED");
        setPracticeHistoryRefresh((value) => value + 1);
        setNotice({ id: capacity.full ? "practice.history.full" : "practice.result.saved" });
        track("practice_run_terminal", {
          trainingSessionId: runIdentity.trainingSessionId,
          preset,
          generationMode: config.mode,
          outcome: status,
          ...summary,
          historySaved: true,
          historyFailureReason: null,
        });
        void flushTelemetry();
      },
      (error: unknown) => {
        if (!mountedRef.current || runIdentityRef.current?.runId !== runIdentity.runId) return;
        setPracticeSaveState("FAILED");
        setNotice({
          id: error instanceof PracticeHistoryCapacityError
            ? "practice.history.full"
            : "practice.result.saveFailed",
        });
        track("practice_run_terminal", {
          trainingSessionId: runIdentity.trainingSessionId,
          preset,
          generationMode: config.mode,
          outcome: status,
          ...summary,
          historySaved: false,
          historyFailureReason: classifyHistoryFailure(error),
        });
        void flushTelemetry();
      },
    );
  }, [
    boardHash,
    config,
    elapsedMs,
    flushTelemetry,
    game.board,
    preset,
    sessionKind,
    status,
    track,
  ]);

  useEffect(() => {
    const runIdentity = runIdentityRef.current;
    if (
      sessionKind !== "STANDARD" ||
      (status !== "WON" && status !== "LOST") ||
      runIdentity === null ||
      runCompletedAtRef.current === null ||
      historyEnqueuedRunRef.current === runIdentity.runId
    ) {
      return;
    }

    const { runId, trainingSessionId } = runIdentity;
    historyEnqueuedRunRef.current = runId;
    const completedAt = runCompletedAtRef.current;
    const inputSamples = [...inputLatencySamplesRef.current];
    const metrics = calculateGameMetrics({
      board: game.board,
      elapsedMs,
      actions: actionTraceRef.current,
    });
    const actions = countBoardActions(actionTraceRef.current);
    const completionMetrics = metricValuesForHistoryRecord(status, metrics);
    const boardSpec = boardSpecRef.current;
    if (boardSpec === null) return;
    let replayActions = [...replayActionTraceRef.current];
    let replay: SoloReplayV1 = {
      schemaVersion: SOLO_REPLAY_SCHEMA_VERSION,
      recordId: runId,
      initialFlags: initialFlagsRef.current,
      initialQuestions: initialQuestionsRef.current,
      questionMarksEnabled,
      actions: replayActions,
    };
    const encoder = new TextEncoder();
    if (encoder.encode(JSON.stringify(replay)).byteLength > SOLO_REPLAY_MAX_BYTES) {
      let low = 0;
      let high = replayActions.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const candidate = { ...replay, actions: replayActions.slice(0, middle) };
        if (encoder.encode(JSON.stringify(candidate)).byteLength <= SOLO_REPLAY_MAX_BYTES) low = middle;
        else high = middle - 1;
      }
      replayActions = replayActions.slice(0, low);
      replay = { ...replay, actions: replayActions };
      replayTruncationReasonRef.current = "BYTE_LIMIT";
    }
    const replayStatus = replayTruncationReasonRef.current;
    const replaySummary: SoloRunRecordV2["replay"] =
      replayStatus === null
        ? {
            status: "COMPLETE",
            schemaVersion: SOLO_REPLAY_SCHEMA_VERSION,
            actionCount: replay.actions.length,
            actionLogHash: hashSoloReplay(replay),
          }
        : {
            status: "TRUNCATED",
            reason: replayStatus,
            schemaVersion: SOLO_REPLAY_SCHEMA_VERSION,
            actionCount: replay.actions.length,
            actionLogHash: hashSoloReplay(replay),
          };
    const record: SoloRunRecordV2 = {
      schemaVersion: SOLO_RUN_SCHEMA_VERSION_V2,
      recordId: runId,
      trainingSessionId,
      completedAt: new Date(completedAt).toISOString(),
      outcome: status,
      config: {
        preset,
        width: config.width,
        height: config.height,
        mines: config.mines,
        generationMode: config.mode,
      },
      board: {
        spec: boardSpec,
        boardHash,
        generatorRulesVersion: 1,
        trustStatus: "LOCAL_UNVERIFIED",
      },
      rules: {
        metricRulesVersion: SOLO_METRIC_RULES_VERSION,
        gameRulesVersion: SOLO_GAME_RULES_VERSION,
      },
      metrics: {
        elapsedMs: metrics.elapsedMs,
        board3BV: metrics.board3BV,
        cps: metrics.cps,
        threeBvPerSecond: completionMetrics.threeBvPerSecond,
        ioe: completionMetrics.ioe,
        physicalClicks: metrics.physicalClicks,
        semanticActions: metrics.semanticActions,
        acceptedActions: metrics.acceptedActions,
        wastedActions: metrics.wastedActions,
        reveals: actions.reveals,
        flags: actions.flags,
        unflags: actions.unflags,
        chords: actions.chords,
      },
      replay: replaySummary,
    };

    enqueuePendingHistoryRecord(record, replay);
    const runEffectiveInteractionMs = runEffectiveInteractionMsRef.current;
    const trainingProgress =
      preset === "custom"
        ? {
            terminalBoardCount: 0,
            effectiveInteractionMs: 0,
          }
        : recordTrainingSessionTerminal(
            trainingSessionId,
            runEffectiveInteractionMs,
          );
    const inputP95Ms = percentile(inputSamples, 0.95);
    const reportTerminal = (
      historySaved: boolean,
      historyFailureReason: string | null,
    ) => {
      track("solo_run_terminal", {
        trainingSessionId,
        preset,
        generationMode: config.mode,
        outcome: status,
        elapsedMs,
        terminalBoardCount: trainingProgress.terminalBoardCount,
        effectiveInteractionMs: trainingProgress.effectiveInteractionMs,
        runEffectiveInteractionMs,
        historySaved,
        historyFailureReason,
        inputSampleCount: inputSamples.length,
        inputP95Ms,
      });
      void flushTelemetry();
    };

    void attemptPendingHistoryWrite(runId, historyStoreRef.current).then(
      (result) => {
        if (result.ok) {
          if (
            mountedRef.current &&
            runIdentityRef.current?.runId === runId
          ) {
            if (
              status === "WON" &&
              (currentRulesPersonalBestMs === null ||
                elapsedMs < currentRulesPersonalBestMs)
            ) {
              setCurrentRulesPersonalBestMs(elapsedMs);
              setIsNewPersonalBest(true);
            }
            if (result.capacity.warning) {
              setNotice({
                id: "solo.historyCapacityNotice",
                values: { count: result.capacity.recordCount.toLocaleString() },
              });
            }
          }
          reportTerminal(true, null);
          return;
        }
        reportTerminal(false, classifyHistoryFailure(result.cause));
      },
    );
  }, [
    boardHash,
    config,
    currentRulesPersonalBestMs,
    elapsedMs,
    game.board,
    preset,
    seed,
    sessionKind,
    status,
    flushTelemetry,
    track,
    t,
  ]);
  const boardCoachOverlay = useMemo(
    () => sessionKind === "GUIDED_PRACTICE"
      ? {
          ...(displayedCoachSuggestion?.proof
            ? { sourceIndexes: displayedCoachSuggestion.proof.sources }
            : {}),
          ...(displayedCoachSuggestion?.cellIndex === undefined
            ? {}
            : { targetIndex: displayedCoachSuggestion.cellIndex }),
          ...(displayedCoachSuggestion?.action === undefined
            ? {}
            : { action: displayedCoachSuggestion.action }),
          autoFlaggedIndexes: activeAutoFlaggedIndexes(
            autoFlaggedIndexes,
            game.visibility,
          ),
        }
      : undefined,
    [autoFlaggedIndexes, displayedCoachSuggestion, game.visibility, revision, sessionKind],
  );
  const displayedCoachVisibleState = useMemo<VisibleBoardState | null>(() => {
    if (
      sessionKind !== "GUIDED_PRACTICE" ||
      game.outcome !== "PLAYING" ||
      displayedCoachSuggestion === null
    ) {
      return null;
    }
    const visible = visibleBoardStateForPractice(game, autoFlaggedIndexesRef.current);
    return hashVisibleBoardState(visible) === displayedCoachSuggestion.stateHash
      ? visible
      : null;
  }, [displayedCoachSuggestion, game, revision, sessionKind]);
  const displayedProofConstraints = useMemo(() => {
    const proof = displayedCoachSuggestion?.proof;
    if (!proof || !displayedCoachVisibleState) return [];
    return proof.sources.map((source) => ({
      source,
      clue: displayedCoachVisibleState.clues[source] ?? 0,
      coveredCells: getNeighborIndices(
        displayedCoachVisibleState.width,
        displayedCoachVisibleState.height,
        source,
      ).filter((index) => (displayedCoachVisibleState.clues[index] ?? -1) < 0).length,
    }));
  }, [displayedCoachSuggestion, displayedCoachVisibleState]);
  const progress = Math.round(getProgress(game) * 100);
  const comboTier = getSoloComboTier(comboState.count);
  const failedPendingHistoryWrites = sessionKind === "STANDARD"
    ? getPendingHistoryWrites().filter(
    (pending) => pending.status === "failed",
      )
    : [];
  const practiceCoordinate = (cellIndex: number) => t("practice.coordinate", {
    row: Math.floor(cellIndex / config.width) + 1,
    column: (cellIndex % config.width) + 1,
  });
  const displayedProofUsesGlobalMineCount = Boolean(
    displayedCoachSuggestion?.proof &&
    (displayedCoachSuggestion.proof.rule.startsWith("GLOBAL") ||
      displayedCoachSuggestion.proof.rule.startsWith("CSP")),
  );
  const displayedProofGlobalCalculation =
    displayedProofUsesGlobalMineCount && displayedCoachVisibleState
      ? t("practice.coach.globalValue", {
          mines: displayedCoachVisibleState.totalMines,
          covered: displayedCoachVisibleState.clues.filter((clue) => clue < 0).length,
        })
      : "";
  const displayedProofSourceDescription = [
    ...displayedProofConstraints.map(({ source, clue }) => t(
      "practice.coach.sourceValue",
      { coordinate: practiceCoordinate(source), clue },
    )),
    ...(displayedProofUsesGlobalMineCount ? [t("practice.coach.wholeBoard")] : []),
  ].join(t("replay.listSeparator"));
  const displayedProofCalculation = [
    ...displayedProofConstraints.map(({ clue, coveredCells }) => t(
      "practice.coach.constraintValue",
      { clue, covered: coveredCells },
    )),
    ...(displayedProofGlobalCalculation ? [displayedProofGlobalCalculation] : []),
  ].join(t("replay.listSeparator"));
  const practiceActionDescription = (suggestion: CoachSuggestion) => {
    if (suggestion.status === "ERROR") return t("practice.coach.error");
    if (suggestion.status === "CONTRADICTION") return t("practice.coach.contradiction");
    if (suggestion.status === "NO_FORCED_MOVE") return t("practice.coach.noMove");
    if (suggestion.status === "PARTIAL" && suggestion.action === undefined) {
      return t("practice.coach.partial");
    }
    if (suggestion.action === undefined || suggestion.cellIndex === undefined) {
      return t("practice.coach.unavailable");
    }
    const coordinate = practiceCoordinate(suggestion.cellIndex);
    return t(
      suggestion.action === "FLAG"
        ? "practice.action.flag"
        : suggestion.action === "UNFLAG"
          ? "practice.action.unflag"
          : "practice.action.reveal",
      { coordinate },
    );
  };
  const practiceProofDescription = (proof: VisibleBoardProof) => {
    const sources = proof.sources.map(practiceCoordinate).join(t("replay.listSeparator"));
    if (proof.rule === "SINGLE_MINE") return t("practice.reason.singleMine", { sources });
    if (proof.rule === "SINGLE_SAFE") return t("practice.reason.singleSafe", { sources });
    if (proof.rule.startsWith("SUBSET")) return t("practice.reason.subset", { sources });
    if (proof.rule.startsWith("GLOBAL")) return t("practice.reason.global");
    return t("practice.reason.csp", { sources });
  };
  const coachPanelMessage = displayedCoachSuggestion
    ? practiceActionDescription(displayedCoachSuggestion)
    : status === "READY"
      ? t("practice.coach.waitingFirstMove")
      : coachTransportError
        ? t("practice.coach.error")
        : coachBusy || coachAnalysis === null
        ? t("practice.coach.analyzing")
        : practiceShownStateHashesRef.current.has(coachAnalysis.stateHash)
          ? t("practice.coach.shownOnce")
          : t("practice.coach.idleCountdown", { seconds: coachIdleSeconds });
  const practiceAssistCount = practiceEventsRef.current.filter(
    ({ eventType }) => eventType !== "PLAYER_ACTION",
  ).length;
  const statusLabel =
    status === "READY"
      ? t("solo.status.ready")
      : status === "GENERATING"
        ? t("solo.status.generating")
        : status === "PLAYING"
          ? t("solo.status.playing")
          : status === "WON"
            ? t("solo.status.won")
            : t("solo.status.lost");
  if (!setupComplete) {
    return (
      <section className="solo-shell solo-setup-shell">
        <div className="solo-header solo-setup-header">
          <div>
            <span className="panel-kicker">{t("solo.kicker.configuration")}</span>
            <h1>{t("solo.setup.title")}</h1>
            <p>{t("solo.setup.description")}</p>
          </div>
          <button className="secondary-button solo-exit" type="button" onClick={exitSolo}>
            {t("solo.backModes")}
          </button>
        </div>

        <div className="solo-setup-panel" aria-label={t("solo.setup.aria")}>
          <div className="solo-setup-section">
            <div className="solo-setup-heading">
              <span>01</span>
              <div>
                <strong>{t("practice.setup.sessionKind")}</strong>
                <small>{t("practice.setup.help")}</small>
              </div>
            </div>
            <div className="solo-mode-tabs practice-session-tabs">
              <button
                className={`solo-mode${sessionKind === "STANDARD" ? " is-active" : ""}`}
                type="button"
                aria-pressed={sessionKind === "STANDARD"}
                onClick={() => chooseSessionKind("STANDARD")}
              >
                {t("practice.setup.standard")}
              </button>
              <button
                className={`solo-mode${sessionKind === "GUIDED_PRACTICE" ? " is-active" : ""}`}
                type="button"
                aria-pressed={sessionKind === "GUIDED_PRACTICE"}
                onClick={() => chooseSessionKind("GUIDED_PRACTICE")}
              >
                {t("practice.setup.guided")}
              </button>
            </div>
          </div>

          <div className="solo-setup-section">
            <div className="solo-setup-heading">
              <span>02</span>
              <div>
                <strong>{t("solo.boardSpec")}</strong>
                <small>{t("solo.boardSpecHelp")}</small>
              </div>
            </div>
            <div className="solo-tabs">
              {PRESET_KEYS.map(
                (key) => (
                  <button
                    className={`solo-tab${preset === key ? " is-active" : ""}`}
                    key={key}
                    type="button"
                    onClick={() => choosePreset(key)}
                  >
                    {t(key === "beginner" ? "solo.beginner" : key === "intermediate" ? "solo.intermediate" : "solo.expert")}
                    <small>
                      {SOLO_PRESETS[key].width}×{SOLO_PRESETS[key].height} /{" "}
                      {SOLO_PRESETS[key].mines}
                    </small>
                  </button>
                ),
              )}
              <button
                className={`solo-tab${preset === "custom" ? " is-active" : ""}`}
                type="button"
                onClick={chooseCustom}
              >
                {t("solo.custom")}
                <small>5–100 / ≤10K</small>
              </button>
            </div>

            {preset === "custom" && (
              <div
                className="solo-custom-settings"
                role="group"
                aria-label={t("solo.customSettings")}
              >
                <div className="solo-custom-grid">
                  <label>
                    <span>{t("solo.width")}</span>
                    <input
                      aria-label={t("solo.customWidth")}
                      inputMode="numeric"
                      max="100"
                      min="5"
                      type="number"
                      value={draftWidth}
                      onChange={(event) => setDraftWidth(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t("solo.height")}</span>
                    <input
                      aria-label={t("solo.customHeight")}
                      inputMode="numeric"
                      max="100"
                      min="5"
                      type="number"
                      value={draftHeight}
                      onChange={(event) => setDraftHeight(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t("solo.mines")}</span>
                    <input
                      aria-label={t("solo.customMines")}
                      inputMode="numeric"
                      min="1"
                      type="number"
                      value={draftMines}
                      onChange={(event) => setDraftMines(event.target.value)}
                    />
                  </label>
                  <button className="secondary-button" type="button" onClick={applyCustom}>
                    {t("solo.validateCustom")}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="solo-setup-section">
            <div className="solo-setup-heading">
              <span>03</span>
              <div>
                <strong>{t("solo.generation")}</strong>
                <small>{t("solo.generationHelp")}</small>
              </div>
            </div>
            <div className="solo-mode-tabs">
              <button
                className={`solo-mode${mode === "classic" ? " is-active" : ""}`}
                type="button"
                onClick={() => chooseMode("classic")}
              >
                {t("solo.classic")}
              </button>
              <button
                className={`solo-mode${mode === "no_guess" ? " is-active" : ""}`}
                type="button"
                onClick={() => chooseMode("no_guess")}
              >
                {t("solo.noGuess")}
              </button>
            </div>
          </div>

          <div className="solo-setup-section solo-display-preferences">
            <div className="solo-setup-heading">
              <span>04</span>
              <div>
                <strong>{t("solo.displayPreferences")}</strong>
                <small>{t("solo.displayPreferencesHelp")}</small>
              </div>
            </div>

            <div className="solo-preference-list">
              <div className="solo-preference-row">
                <div className="solo-preference-copy">
                  <strong>{t("solo.dataLevel")}</strong>
                  <small>{t("solo.dataLevelHelp")}</small>
                </div>
                <div className="solo-compact-tabs" role="group" aria-label={t("solo.dataLevelAria")}>
                  {(
                    [
                      ["basic", t("solo.basic")],
                      ["advanced", t("solo.advanced")],
                      ["analysis", t("solo.details")],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      className={statsLevel === value ? "is-active" : ""}
                      key={value}
                      type="button"
                      aria-pressed={statsLevel === value}
                      onClick={() => chooseStatsLevel(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="solo-preference-row solo-theme-row">
                <div className="solo-preference-copy">
                  <strong>{t("solo.boardDisplay")}</strong>
                  <small>{t("solo.boardDisplayHelp")}</small>
                </div>
                <div className="solo-compact-tabs solo-theme-tabs" role="group" aria-label={t("solo.boardDisplayAria")}>
                  {(
                    [
                      ["classic", t("solo.professional")],
                      ["black-gold", t("solo.comfort")],
                      ["high-contrast", t("solo.highContrast")],
                      ["ivory-tactical", t("solo.ivoryTactical")],
                    ] as const
                  ).map(([value, label]) => {
                    const palette = resolveBoardPalette(value);
                    return (
                      <button
                        className={boardTheme === value ? "is-active" : ""}
                        key={value}
                        type="button"
                        aria-pressed={boardTheme === value}
                        onClick={() => chooseBoardTheme(value)}
                      >
                        <span
                          aria-hidden="true"
                          className="solo-theme-swatch"
                          style={{
                            background: `linear-gradient(135deg, ${palette.hiddenA} 0 50%, ${palette.revealed} 50% 100%)`,
                            borderColor: palette.revealedLine,
                            color: palette.numberColors[1],
                          }}
                        >
                          1
                        </span>
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <details className="solo-advanced-settings">
            <summary>
              <span>{t("solo.advancedSettings")}</span>
              <small>{t("solo.advancedSettingsHelp")}</small>
            </summary>
            <div className="solo-preference-list">
              <div className="solo-preference-row">
                <div className="solo-preference-copy">
                  <strong>{t("solo.questionMarks")}</strong>
                  <small>{t("solo.questionMarksHelp")}</small>
                </div>
                <div className="solo-compact-tabs solo-binary-tabs" role="group" aria-label={t("solo.questionMarksAria")}>
                  <button
                    className={!questionMarksEnabled ? "is-active" : ""}
                    type="button"
                    aria-pressed={!questionMarksEnabled}
                    onClick={() => chooseQuestionMarks(false)}
                  >
                    {t("solo.off")}
                  </button>
                  <button
                    className={questionMarksEnabled ? "is-active" : ""}
                    type="button"
                    aria-pressed={questionMarksEnabled}
                    onClick={() => chooseQuestionMarks(true)}
                  >
                    {t("solo.on")}
                  </button>
                </div>
              </div>

              <div className="solo-preference-row">
                <div className="solo-preference-copy">
                  <strong>{t("solo.timerFormat")}</strong>
                  <small>{t("solo.timerFormatHelp")}</small>
                </div>
                <div className="solo-compact-tabs solo-binary-tabs" role="group" aria-label={t("solo.timerFormatAria")}>
                  <button
                    className={timerFormat === "clock" ? "is-active" : ""}
                    type="button"
                    aria-pressed={timerFormat === "clock"}
                    onClick={() => chooseTimerFormat("clock")}
                  >
                    {t("solo.timerClock")}
                  </button>
                  <button
                    className={timerFormat === "seconds" ? "is-active" : ""}
                    type="button"
                    aria-pressed={timerFormat === "seconds"}
                    onClick={() => chooseTimerFormat("seconds")}
                  >
                    {t("solo.timerSeconds")}
                  </button>
                </div>
              </div>
            </div>
          </details>

          <div className="solo-setup-launch">
            <div>
              <span>{t("solo.runPlan")}</span>
              <strong>
                {t(sessionKind === "GUIDED_PRACTICE" ? "practice.setup.guided" : "practice.setup.standard")} ·{" "}
                {preset === "custom" ? t("solo.custom") : t(preset === "beginner" ? "solo.beginner" : preset === "intermediate" ? "solo.intermediate" : "solo.expert")} ·{" "}
                {draftWidth}×{draftHeight} / {draftMines} ·{" "}
                {mode === "no_guess" ? t("solo.noGuess") : t("solo.classic")}
              </strong>
              <p role="status">
                {notice ? t(notice.id, notice.values) : t("solo.readyHelp")}
              </p>
            </div>
            <button className="primary-button" type="button" onClick={startConfiguredGame}>
              {t("solo.start")}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="solo-shell">
      <a
        className="skip-link"
        href="#solo-board"
        onClick={(event) => {
          const target = document.getElementById("solo-board");
          if (!target) return;
          event.preventDefault();
          target.focus();
          event.currentTarget.blur();
        }}
      >
        {t("solo.skipBoard")}
      </a>
      <div className="solo-header">
        <div>
          <span className="panel-kicker">
            {t(sessionKind === "GUIDED_PRACTICE" ? "practice.setup.guided" : "solo.kicker.game")}
          </span>
          <h1>{t("solo.gameTitle")}</h1>
          <p>
            {preset === "custom" ? t("solo.custom") : t(preset === "beginner" ? "solo.beginner" : preset === "intermediate" ? "solo.intermediate" : "solo.expert")} · {config.width}×{config.height} / {config.mines} ·{" "}
            {t(config.mode === "no_guess" ? "solo.noGuess" : "solo.classic")}
          </p>
          {sessionKind === "GUIDED_PRACTICE" && (
            <>
              <span className="practice-not-scored">{t("practice.notScored")}</span>
              {practiceLaunchContext && (
                <p className="practice-launch-context">
                  {t(`practice.launch.${practiceLaunchContext.errorCategory}`, {
                    step: practiceLaunchContext.replayStep,
                  })}
                </p>
              )}
            </>
          )}
        </div>
        <button className="secondary-button solo-exit" type="button" onClick={returnToSetup}>
          {t(status === "PLAYING" || status === "GENERATING" ? "solo.endAndChange" : "solo.changeConfig")}
        </button>
      </div>

      <div className="solo-game-layout">
        <div
          className="board-stage solo-board-stage"
          id="solo-board"
          tabIndex={-1}
        >
          <div className="board-toolbar">
            <span>{t("solo.control.reveal")}</span>
            <span>{t(questionMarksEnabled ? "solo.control.mark" : "solo.control.flag")}</span>
            <span>{t("solo.control.chord")}</span>
            <span>{t(config.mode === "no_guess" ? "solo.mode.noGuess" : "solo.mode.classic")}</span>
            {sessionKind === "GUIDED_PRACTICE" && (
              <span>{t("practice.notScored")}</span>
            )}
            <ComboStatus
              count={comboState.count}
              tier={comboTier}
              label={t("solo.flowCombo")}
              message={t(getSoloComboFeedbackKey(comboState.count))}
              lastIncrementAtMs={comboState.lastIncrementAtMs}
            />
          </div>
          <CanvasBoard
            {...(actionVisual === undefined ? {} : { actionVisual })}
            {...(sessionKind === "GUIDED_PRACTICE"
              ? { ariaDescribedBy: "practice-coach-announcement" }
              : {})}
            boardTheme={boardTheme}
            questionMarksEnabled={questionMarksEnabled}
            disabled={
              status === "GENERATING" || status === "WON" || status === "LOST"
            }
            effectsProfile={effectsProfile}
            game={game}
            coachOverlay={boardCoachOverlay}
            reducedMotion={reducedMotion}
            revision={revision}
            showTerminalMines
            {...(terminalDetonatedIndex === undefined ? {} : { terminalDetonatedIndex })}
            onAction={handleBoardAction}
            onInputLatency={(latencyMs) => {
              if (inputLatencySamplesRef.current.length < 2_000) {
                inputLatencySamplesRef.current.push(latencyMs);
              }
            }}
          />

          {status === "GENERATING" && (
            <div className="solo-generating" aria-live="assertive">
              <span className="panel-kicker">{t("solo.kicker.noGuessGeneration")}</span>
              <strong>{t("solo.generatingTitle")}</strong>
              <p>{t("solo.generatingDescription")}</p>
            </div>
          )}

        </div>

        <aside className="solo-side-panel">
          {sessionKind === "GUIDED_PRACTICE" && (
            <section className="practice-coach-panel" aria-labelledby="practice-coach-title">
              <div className="practice-coach-heading">
                <div>
                  <span className="panel-kicker">{t("practice.setup.guided")}</span>
                  <h2 id="practice-coach-title">{t("practice.coach.title")}</h2>
                </div>
                <span className={`practice-coach-state${coachBusy ? " is-busy" : ""}`} aria-hidden="true" />
              </div>
              <p>{t("practice.coach.description")}</p>
              <div
                id="practice-coach-announcement"
                className="practice-coach-message"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {coachPanelMessage}
                {displayedCoachSuggestion?.proof && (
                  <span className="visually-hidden">
                    {` ${practiceProofDescription(displayedCoachSuggestion.proof)} ${
                      displayedProofCalculation
                    }`}
                  </span>
                )}
              </div>
              {status !== "READY" && (
                <>
                  {displayedCoachSuggestion?.proof && displayedCoachSuggestion.cellIndex !== undefined && (
                    <dl className="practice-coach-proof">
                  <div>
                    <dt>{t("practice.coach.target")}</dt>
                    <dd>{practiceCoordinate(displayedCoachSuggestion.cellIndex)}</dd>
                  </div>
                  <div>
                    <dt>{t("practice.coach.source")}</dt>
                    <dd>
                      {displayedProofSourceDescription || t("practice.coach.wholeBoard")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("practice.coach.calculation")}</dt>
                    <dd>
                      {displayedProofCalculation || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("practice.coach.proof")}</dt>
                    <dd>{practiceProofDescription(displayedCoachSuggestion.proof)}</dd>
                  </div>
                    </dl>
                  )}
                  <div className="practice-coach-actions">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={status === "GENERATING" || status === "WON" || status === "LOST"}
                      onClick={requestImmediateHint}
                    >
                      {t("practice.coach.hintNow")}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={status === "GENERATING" || status === "WON" || status === "LOST"}
                      onClick={demonstrateNextStep}
                    >
                      {t("practice.coach.demonstrate")}
                    </button>
                  </div>
                  <label className="practice-auto-mark">
                    <input
                      type="checkbox"
                      checked={autoMarkMines}
                      disabled={status === "GENERATING" || status === "WON" || status === "LOST"}
                      onChange={toggleAutoMarkMines}
                    />
                    <span>
                      <strong>{t("practice.coach.autoMark")}</strong>
                      <small>{t("practice.coach.autoMarkHelp")}</small>
                    </span>
                  </label>
                </>
              )}
            </section>
          )}
          {(status === "WON" || status === "LOST") && (
            <section className="solo-terminal-panel" role="status" aria-live="assertive">
              <span className="panel-kicker">{t("solo.kicker.result")}</span>
              <h2>{t(status === "WON" ? "solo.result.won" : "solo.result.lost")}</h2>
              <p>{formatSoloElapsedTime(elapsedMs, timerFormat, locale)} · {t("solo.resultActions", { count: actionBreakdown.semanticActions })}</p>
              {sessionKind === "GUIDED_PRACTICE" ? (
                <div className="solo-result-metrics practice-result-metrics">
                  <span>{t("practice.notScored")}</span>
                  <b>{t("practice.history.playerActions")} {actionBreakdown.semanticActions}</b>
                  <b>{t("practice.history.assists")} {practiceAssistCount}</b>
                </div>
              ) : (
                <div className="solo-result-metrics">
                  <span>{t(isNewPersonalBest ? "solo.newPersonalBestLocal" : "solo.localUnverified")}</span>
                  <b>{t("solo.boardComplexity")} {board3BV ?? "—"}</b>
                  <b>{t("solo.clearSpeed")} {formatMetric(threeBvPerSecond)}</b>
                  <b>{t("solo.efficiency")} {ioe === null ? "—" : `${(ioe * 100).toFixed(1)}%`}</b>
                  {status === "LOST" && <small>{t("solo.completionMetricUnavailable")}</small>}
                </div>
              )}
              <div className="solo-terminal-legend" aria-label={t("solo.legend.aria")}>
                <span>{t("solo.legend.detonated")}</span>
                <span>{t("solo.legend.mine")}</span>
                <span>{t("solo.legend.correctFlag")}</span>
                <span>{t("solo.legend.wrongFlag")}</span>
              </div>
              <div className="result-actions">
                {canRewindPractice && practiceSaveState !== "SAVING" && (
                  <button
                    className="primary-button"
                    type="button"
                    onClick={rewindPracticeBeforeMine}
                  >
                    {t("practice.result.rewind")}
                  </button>
                )}
                {sessionKind === "GUIDED_PRACTICE" ? (
                  practiceSaveState === "SAVING" ? (
                    <button className="primary-button" type="button" disabled>{t("solo.savingReplay")}</button>
                  ) : practiceSaveState === "SAVED" ? (
                    <a className={canRewindPractice ? "secondary-button" : "primary-button"} href={`#/solo/practice/replay/${encodeURIComponent(currentRunId)}`}>{t("practice.result.reviewReplay")}</a>
                  ) : (
                    <button className={canRewindPractice ? "secondary-button" : "primary-button"} type="button" onClick={reviewFinalBoard}>{t("practice.result.reviewBoard")}</button>
                  )
                ) : currentHistoryPending ? (
                  <button className="primary-button" type="button" disabled>{t("solo.savingReplay")}</button>
                ) : (
                  <a className="primary-button" href={`#/solo/replay/${encodeURIComponent(currentRunId)}`}>{t("solo.analyze")}</a>
                )}
                {sessionKind === "GUIDED_PRACTICE" && practiceSaveState === "SAVED" && (
                  <button className="secondary-button" type="button" onClick={reviewFinalBoard}>{t("practice.result.reviewBoard")}</button>
                )}
                {sessionKind === "GUIDED_PRACTICE" && practiceSaveState !== "SAVING" && (
                  <button className="secondary-button" type="button" onClick={openPracticeHistory}>{t("practice.result.history")}</button>
                )}
                {sessionKind === "STANDARD" && (
                  <button className="secondary-button" type="button" onClick={replaySameBoard}>{t("solo.replaySameBoard")}</button>
                )}
                {sessionKind === "STANDARD" && (
                  <button className="secondary-button" type="button" onClick={() => resetBoard()}>{t("solo.sameBoard")}</button>
                )}
                <button className="secondary-button" type="button" onClick={exitSolo}>{t("solo.home")}</button>
              </div>
            </section>
          )}
          <span className="panel-kicker">{t("solo.kicker.metrics")}</span>
          <div className="solo-status-line">
            <strong>{statusLabel}</strong>
            <i className={`solo-status-dot status-${status.toLowerCase()}`} />
          </div>
          <div className="solo-clock">{formatSoloElapsedTime(elapsedMs, timerFormat, locale)}</div>

          <div className="solo-stats">
            <div>
              <span>{t("solo.remainingMines")}</span>
              <strong>{status === "WON" ? 0 : config.mines - flags}</strong>
            </div>
            <div>
              <span>{t("solo.safeProgress")}</span>
              <strong>{progress}%</strong>
            </div>
            <div>
              <span>{status === "WON" || status === "LOST"
                ? t("solo.finalCps")
                : t("solo.currentCps")}</span>
              <strong>{formatMetric(cps)}</strong>
            </div>
            <div>
              <span>{t("solo.board")}</span>
              <strong>
                {config.width}×{config.height}
              </strong>
            </div>
            {sessionKind === "STANDARD" && (
              <div>
                <span>{t("solo.currentBest")}</span>
                <strong>
                  {currentRulesPersonalBestMs === null
                    ? "—"
                    : formatSoloElapsedTime(currentRulesPersonalBestMs, timerFormat, locale)}
                </strong>
              </div>
            )}
            {sessionKind === "STANDARD" && legacyPersonalBestMs !== null && (
              <div>
                <span>{t("solo.legacyBest")}</span>
                <strong>{formatSoloElapsedTime(legacyPersonalBestMs, timerFormat, locale)}</strong>
              </div>
            )}
            <div>
              <span>{t("solo.verification")}</span>
              <strong className="solo-trust-label">{t("solo.local")}</strong>
            </div>
          </div>

          {sessionKind === "STANDARD" && statsLevel !== "basic" && (
            <div className="solo-stats solo-stats-advanced">
              <div title={t("solo.board3bvHelp")}>
                <span>{t("solo.boardComplexity")}</span>
                <strong>{board3BV ?? "—"}</strong>
              </div>
              <div title={t("solo.metricHelp")}>
                <span>{t("solo.clearSpeed")}</span>
                <strong>{metricView.completionState === "PENDING"
                  ? t("solo.completionMetricPending")
                  : formatMetric(threeBvPerSecond)}</strong>
              </div>
              <div title={t("solo.metricHelp")}>
                <span>{t("solo.efficiency")}</span>
                <strong>
                  {metricView.completionState === "PENDING"
                    ? t("solo.completionMetricPending")
                    : ioe === null ? "—" : `${(ioe * 100).toFixed(1)}%`}
                </strong>
              </div>
            </div>
          )}

          {statsLevel === "analysis" && (
            <details className="solo-analysis" open={status === "WON" || status === "LOST"}>
              <summary>{t("solo.actionDetails")}</summary>
              <div aria-label={t("solo.actionAnalysis")}>
              <span>
                {t("solo.physicalClicks")} <b>{actionBreakdown.physicalClicks}</b>
              </span>
              <span>
                {t("solo.acceptedActions")} <b>{actionBreakdown.acceptedActions}</b>
              </span>
              <span>
                {t("solo.wastedActions")} <b>{actionBreakdown.wastedActions}</b>
              </span>
              <span>
                {t("solo.revealChord")} <b>{actionBreakdown.reveals} / {actionBreakdown.chords}</b>
              </span>
              <span>
                {t("solo.flagUnflag")} <b>{actionBreakdown.flags} / {actionBreakdown.unflags}</b>
              </span>
              </div>
            </details>
          )}

          <div className="solo-progress-track">
            <i style={{ width: `${progress}%` }} />
          </div>

          <div className="solo-notice" aria-live="polite">
            {notice ? t(notice.id, notice.values) : t("solo.mantra")}
          </div>

          {(seed || generationSummary) && (
            <div className="solo-proof">
              <span>{t("solo.boardAudit")}</span>
              {generationSummary && <b>{t(generationSummary.id, generationSummary.values)}</b>}
              {boardHash && <code>{boardHash.slice(0, 16)}</code>}
              {seed && <small title={seed}>{seed.slice(-18)}</small>}
            </div>
          )}

          <button
            className="secondary-button solo-new-board"
            type="button"
            onClick={() => resetBoard()}
          >
            {t("solo.abandon")}
          </button>
        </aside>
      </div>
      {failedPendingHistoryWrites.map((pending) => (
        <div
          className="solo-history-save-error"
          key={pending.record.recordId}
          role="alert"
        >
          <span>
            {t(pending.error?.includes("IndexedDB") ? "solo.saveFailedIndexedDb" : "solo.saveFailed", { id: pending.record.recordId.slice(0, 8) })}
          </span>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              void attemptPendingHistoryWrite(
                pending.record.recordId,
                historyStoreRef.current,
              );
            }}
          >
            {t("solo.retrySave")}
          </button>
        </div>
      ))}
      {sessionKind === "GUIDED_PRACTICE" ? (
        (status !== "WON" && status !== "LOST") || showPracticeHistory ? (
          <PracticeHistory
            refreshToken={practiceHistoryRefresh}
            store={practiceHistoryStoreRef.current}
            timerFormat={timerFormat}
          />
        ) : null
      ) : (
        <SoloHistory
          config={config}
          preset={preset}
          metricRulesVersion={SOLO_METRIC_RULES_VERSION}
          gameRulesVersion={SOLO_GAME_RULES_VERSION}
          refreshToken={pendingWriteVersion}
          timerFormat={timerFormat}
          store={historyStoreRef.current}
          onCurrentBestChange={handleCurrentBestChange}
          onLegacyPersonalBestChange={handleLegacyPersonalBestChange}
        />
      )}
    </section>
  );
}
