import {
  CELL_FLAGGED,
  calculate3BV,
  calculate3BVPerSecond,
  calculateCPS,
  calculateGameMetrics,
  calculateIOE,
  chordCell,
  countBoardActions,
  createBoard,
  createGameState,
  getProgress,
  hashBoard,
  hashGameState,
  isProvablySafeCell,
  revealCell,
  toggleFlag,
  type BoardSpec,
  type ActionCountBreakdown,
  type CountedBoardAction,
  type GameState,
  type RevealDelta,
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
} from "../lib/solo-preferences";
import { percentile } from "../lib/performance";
import {
  CanvasBoard,
  type BoardAction,
  type BoardActionVisual,
  type BoardEffectsProfile,
  type BoardInputMeta,
  type BoardTheme,
} from "./CanvasBoard";
import { SoloHistory } from "./SoloHistory";
import { useTelemetry } from "./TelemetryPrivacy";
import { useLocale } from "../i18n";
import "./solo-game.css";

interface SoloGameProps {
  readonly effectsProfile: BoardEffectsProfile;
  readonly initialGenerationMode?: SoloGenerationMode;
  readonly initialBoardConfig?: SoloBoardConfig;
  readonly reducedMotion: boolean;
  readonly onExit: () => void;
}

type SoloStatus = "READY" | "GENERATING" | "PLAYING" | "WON" | "LOST";
type StatsLevel = "basic" | "advanced" | "analysis";

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

function formatSoloTime(elapsedMs: number): string {
  const centiseconds = Math.floor(Math.max(0, elapsedMs) / 10);
  const minutes = Math.floor(centiseconds / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

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
  initialBoardConfig,
  reducedMotion,
  onExit,
}: SoloGameProps) {
  const { locale, t } = useLocale();
  const configErrorMessage = useCallback((nextConfig: SoloBoardConfig) => {
    const error = getSoloConfigErrorCode(nextConfig);
    if (!error) return "";
    if (error.code === "WIDTH_RANGE") return t("solo.config.width");
    if (error.code === "HEIGHT_RANGE") return t("solo.config.height");
    if (error.code === "CELL_LIMIT") return t("solo.config.cells");
    if (error.code === "MINE_RANGE") return t("solo.config.mines", { max: error.maxMines });
    return t("solo.config.noGuessSize");
  }, [t]);
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
  const visualSequenceRef = useRef(0);
  const lastComboAtRef = useRef<number | null>(null);
  const comboTimeoutRef = useRef<number | null>(null);
  const actionTraceRef = useRef<CountedBoardAction[]>([]);
  const replayActionTraceRef = useRef<SoloReplayActionV1[]>([]);
  const lastReplayStateHashRef = useRef(hashGameState(initialGame));
  const replayTruncationReasonRef = useRef<"ACTION_LIMIT" | "BYTE_LIMIT" | null>(null);
  const initialFlagsRef = useRef<readonly number[]>([]);
  const boardSpecRef = useRef<BoardSpec | null>(null);
  const historyStoreRef = useRef(createIndexedDbSoloHistoryStore());
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
  const [setupComplete, setSetupComplete] = useState(false);
  const [status, setStatus] = useState<SoloStatus>("READY");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(performance.now());
  const [actionBreakdown, setActionBreakdown] =
    useState<ActionCountBreakdown>(EMPTY_ACTION_BREAKDOWN);
  const [board3BV, setBoard3BV] = useState<number | null>(null);
  const [actionVisual, setActionVisual] = useState<BoardActionVisual>();
  const [combo, setCombo] = useState(0);
  const [statsLevel, setStatsLevel] = useState<StatsLevel>(
    launchPreferences.statsLevel,
  );
  const [boardTheme, setBoardTheme] = useState<BoardTheme>(
    launchPreferences.boardTheme,
  );
  const [legacyPersonalBestMs, setLegacyPersonalBestMs] =
    useState<number | null>(null);
  const [currentRulesPersonalBestMs, setCurrentRulesPersonalBestMs] =
    useState<number | null>(null);
  const [isNewPersonalBest, setIsNewPersonalBest] = useState(false);
  const [coarsePointer] = useState(
    () => window.matchMedia("(pointer: coarse)").matches,
  );
  const [notice, setNotice] = useState(
    preferenceLoadRef.current.error ??
      (launchMode === "no_guess"
      ? t("solo.noGuessDescription")
      : t("solo.classicDescription")),
  );
  const [seed, setSeed] = useState("");
  const [boardHash, setBoardHash] = useState("");
  const [generationSummary, setGenerationSummary] = useState("");
  const [terminalDetonatedIndex, setTerminalDetonatedIndex] = useState<number>();
  const [draftWidth, setDraftWidth] = useState(String(initialConfig.width));
  const [draftHeight, setDraftHeight] = useState(String(initialConfig.height));
  const [draftMines, setDraftMines] = useState(String(initialConfig.mines));
  const [pendingWriteVersion, setPendingWriteVersion] = useState(
    pendingHistoryVersion,
  );
  useEffect(() => {
    setNotice(
      status === "GENERATING"
        ? t("solo.generatingNotice")
        : status === "WON"
          ? t("solo.wonNotice")
          : status === "LOST"
            ? t("solo.lostNotice")
            : status === "READY"
              ? t(config.mode === "no_guess" ? "solo.noGuessDescription" : "solo.classicDescription")
              : t("solo.mantra"),
    );
    // Preserve the run while refreshing status copy in the selected locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);
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

  const clearCombo = useCallback(() => {
    lastComboAtRef.current = null;
    if (comboTimeoutRef.current !== null) {
      window.clearTimeout(comboTimeoutRef.current);
      comboTimeoutRef.current = null;
    }
    setCombo(0);
  }, []);

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
        if (comboTimeoutRef.current !== null) {
          window.clearTimeout(comboTimeoutRef.current);
        }
      };
    },
    [cancelGeneration],
  );

  useEffect(
    () =>
      subscribePendingHistory(() => {
        setPendingWriteVersion(pendingHistoryVersion);
      }),
    [],
  );

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
    ) => {
      cancelGeneration();
      pendingSeedRef.current = createSoloSeed();
      const pending = createPendingSoloGame(
        nextConfig,
        pendingSeedRef.current,
      );
      replaceGame(pending);
      setConfig(nextConfig);
      setPreset(nextPreset);
      setMode(nextConfig.mode);
      setStatus("READY");
      setStartedAt(null);
      setFinishedAt(null);
      setClockNow(performance.now());
      actionTraceRef.current = [];
      replayActionTraceRef.current = [];
      lastReplayStateHashRef.current = hashGameState(pending);
      replayTruncationReasonRef.current = null;
      initialFlagsRef.current = [];
      boardSpecRef.current = null;
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
      setLegacyPersonalBestMs(null);
      setCurrentRulesPersonalBestMs(null);
      setIsNewPersonalBest(false);
      setSeed("");
      setBoardHash("");
      setGenerationSummary("");
      setTerminalDetonatedIndex(undefined);
      setNotice(
        nextConfig.mode === "no_guess"
          ? t("solo.noGuessDescription")
          : t("solo.classicDescription"),
      );
    },
    [cancelGeneration, clearCombo, config, preset, replaceGame, t],
  );

  const finishIfTerminal = useCallback(
    (next: GameState, completedAt: number) => {
      if (next.outcome === "PLAYING") {
        setStatus("PLAYING");
        return;
      }
      setFinishedAt(completedAt);
      setClockNow(completedAt);
      runCompletedAtRef.current = Date.now();
      lastEffectiveInteractionAtRef.current = null;
      runEffectiveInteractionMsRef.current =
        effectiveInteractionAccumulatedMsRef.current;
      setStatus(next.outcome === "WON" ? "WON" : "LOST");
      setNotice(
        next.outcome === "WON"
          ? t("solo.wonNotice")
          : t("solo.lostNotice"),
      );
    },
    [t],
  );

  const recordAction = useCallback(
    (
      actionType: BoardAction,
      originIndex: number,
      delta: RevealDelta,
      preStateHash: string,
      comboEligible = false,
      physicalClicks = 1,
    ) => {
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
      if (replayActionTraceRef.current.length < SOLO_REPLAY_MAX_ACTIONS) {
        replayActionTraceRef.current.push({
          seq: replayActionTraceRef.current.length + 1,
          elapsedMs:
            startedAt === null ? 0 : Math.max(0, performance.now() - startedAt),
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
        ],
        accepted: delta.accepted,
        revealedSafeCount: safeReveals,
      });

      if (
        !delta.accepted ||
        delta.hitMine === true ||
        ((actionType === "REVEAL" || actionType === "CHORD") &&
          (safeReveals === 0 || !comboEligible))
      ) {
        clearCombo();
        return;
      }
      if (
        actionType !== "REVEAL" &&
        actionType !== "CHORD"
      ) {
        return;
      }

      const now = performance.now();
      const continuesCombo =
        lastComboAtRef.current !== null &&
        now - lastComboAtRef.current <= 900;
      lastComboAtRef.current = now;
      setCombo((current) => (continuesCombo ? current + 1 : 1));
      if (comboTimeoutRef.current !== null) {
        window.clearTimeout(comboTimeoutRef.current);
      }
      comboTimeoutRef.current = window.setTimeout(() => {
        lastComboAtRef.current = null;
        setCombo(0);
        comboTimeoutRef.current = null;
      }, 900);
    },
    [clearCombo, startedAt],
  );

  const beginGame = useCallback(
    (
      spec: BoardSpec,
      firstIndex: number,
      flaggedIndexes: readonly number[],
      options: {
        readonly generation?: string;
        readonly physicalClicks?: number;
      } = {},
    ) => {
      const next = createGameState(createBoard(spec));
      applyFlagsByIndex(flaggedIndexes, next);
      initialFlagsRef.current = [...new Set(flaggedIndexes)].sort((a, b) => a - b);
      boardSpecRef.current = Object.freeze({ ...spec });
      const beganAt = performance.now();
      const nextRunIdentity = createSoloRunIdentity();
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
      setStartedAt(beganAt);
      setFinishedAt(null);
      setClockNow(beganAt);
      setSeed(spec.seed);
      const calculatedBoardHash = hashBoard(next.board);
      setBoardHash(calculatedBoardHash);
      setGenerationSummary(options.generation ?? "");
      setBoard3BV(calculate3BV(next.board).value);
      track("solo_run_started", {
        trainingSessionId: nextRunIdentity.trainingSessionId,
        preset,
        generationMode: config.mode,
        width: config.width,
        height: config.height,
        mines: config.mines,
      });
      replaceGame(next);
      finishIfTerminal(next, beganAt);
      recordAction(
        "REVEAL",
        firstIndex,
        delta,
        preStateHash,
        delta.accepted && delta.hitMine !== true,
        options.physicalClicks ?? 1,
      );
      return next.outcome;
    },
    [config, finishIfTerminal, preset, recordAction, replaceGame, track],
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
      setStatus("GENERATING");
      setNotice(t("solo.generatingNotice"));

      let worker: Worker;
      try {
        worker = new Worker(
          new URL("../workers/noGuessWorker.ts", import.meta.url),
          { type: "module" },
        );
      } catch {
        generationActiveRef.current = false;
        setStatus("READY");
        setNotice(t("solo.workerUnavailable"));
        track("no_guess_generation_finished", {
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

      const fail = (message: string, failureReason: string) => {
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
        track("no_guess_generation_finished", {
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
          setNotice(
            t("solo.generationLimit"),
          );
          track("no_guess_generation_finished", {
            preset,
            success: false,
            attempts: event.data.attempts,
            elapsedMs: event.data.elapsedMs,
            failureReason: "ATTEMPT_LIMIT",
          });
          return;
        }
        track("no_guess_generation_finished", {
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
            generation: t("solo.generationSummary", { attempts: event.data.attempts, elapsed: event.data.elapsedMs.toFixed(0) }),
            physicalClicks,
          },
        );
        if (outcome === "PLAYING") {
          setNotice(t("solo.generationVerified"));
        }
      };
      worker.onerror = () => {
        fail(
          t("solo.generationFailed"),
          "GENERATION_ERROR",
        );
      };
      workerTimeoutRef.current = window.setTimeout(() => {
        fail(
          t("solo.generationTimeout"),
          "TIME_LIMIT",
        );
      }, 5_000);
      try {
        worker.postMessage(request);
      } catch {
        fail(
          t("solo.generationPostFailed"),
          "GENERATION_ERROR",
        );
      }
    },
    [beginGame, cancelGeneration, config, preset, t, track],
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
      setNotice("");
      const { physicalClicks } = inputMeta;

      if (status === "READY") {
        if (action === "TOGGLE_FLAG") {
          toggleFlag(current, cellIndex);
          setRevision((value) => value + 1);
          setNotice(t("solo.initialFlags"));
          return;
        }
        if (action === "CHORD") {
          chordCell(current, cellIndex);
          setNotice(t("solo.initialChord"));
          return;
        }
        if (current.visibility[cellIndex] === CELL_FLAGGED) {
          setNotice(t("solo.flaggedReveal"));
          return;
        }

        const flaggedIndexes = Array.from(
          current.visibility,
          (visibility, index) =>
            visibility === CELL_FLAGGED ? index : -1,
        ).filter((index) => index >= 0);
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
          setNotice(t("solo.classicStarted"));
        }
        return;
      }

      const comboEligible =
        action === "CHORD" ||
        (action === "REVEAL" && isProvablySafeCell(current, cellIndex));
      const actionAt = performance.now();
      recordEffectiveInteraction(actionAt);
      const preStateHash = lastReplayStateHashRef.current;
      const delta =
        action === "REVEAL"
          ? revealCell(current, cellIndex)
          : action === "TOGGLE_FLAG"
            ? toggleFlag(current, cellIndex)
            : chordCell(current, cellIndex);
      recordAction(
        action,
        cellIndex,
        delta,
        preStateHash,
        comboEligible,
        physicalClicks,
      );
      if (!delta.accepted) {
        setNotice(
          delta.rejectReason === "FLAG_COUNT_MISMATCH"
            ? t("solo.chordRejected")
            : t("solo.actionUnchanged"),
        );
      }
      replaceGame(current);
      finishIfTerminal(current, actionAt);
    },
    [
      beginGame,
      config,
      finishIfTerminal,
      generateNoGuess,
      recordEffectiveInteraction,
      recordAction,
      replaceGame,
      status,
      t,
    ],
  );

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

  const chooseMode = (nextMode: SoloGenerationMode) => {
    const nextConfig = { ...config, mode: nextMode };
    const error = configErrorMessage(nextConfig);
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
    const error = configErrorMessage(nextConfig);
    if (error) {
      setNotice(error);
      return;
    }
    resetBoard(nextConfig, "custom");
    persistPreferences(nextConfig, "custom");
  };

  const chooseCustom = () => {
    setPreset("custom");
    setNotice(t("solo.customPrompt"));
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
    const error = configErrorMessage(nextConfig);
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
    onExit();
  };

  const persistPreferences = (
    nextConfig: SoloBoardConfig,
    nextPreset: SoloPreset,
    nextStatsLevel: StatsLevel = statsLevel,
    nextBoardTheme: BoardTheme = boardTheme,
  ) => {
    const preferences: SoloPreferencesV1 = {
      schemaVersion: SOLO_PREFERENCES_SCHEMA_VERSION,
      preset: nextPreset,
      config: nextConfig,
      statsLevel: nextStatsLevel,
      boardTheme: nextBoardTheme,
    };
    try {
      saveSoloPreferences(preferences);
      return true;
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? cause.message
          : t("solo.preferenceSaveFailed"),
      );
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

  useEffect(() => {
    if (initialGenerationMode !== undefined) {
      persistPreferences(initialConfig, initialPreset);
    }
  }, []);

  const flags = countFlags(game);
  const elapsedMs =
    startedAt === null ? 0 : (finishedAt ?? clockNow) - startedAt;
  const cps = calculateCPS(
    coarsePointer
      ? actionBreakdown.semanticActions
      : actionBreakdown.physicalClicks,
    elapsedMs,
  );
  const threeBvPerSecond =
    board3BV === null ? null : calculate3BVPerSecond(board3BV, elapsedMs);
  const ioe =
    board3BV === null
      ? null
      : calculateIOE(board3BV, actionBreakdown.physicalClicks);
  const currentRunId = runIdentityRef.current?.runId ?? "";
  const currentHistoryPending = getPendingHistoryWrites().some(
    ({ record }) => record.recordId === currentRunId,
  );
  useEffect(() => {
    const runIdentity = runIdentityRef.current;
    if (
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
    const boardSpec = boardSpecRef.current;
    if (boardSpec === null) return;
    let replayActions = [...replayActionTraceRef.current];
    let replay: SoloReplayV1 = {
      schemaVersion: SOLO_REPLAY_SCHEMA_VERSION,
      recordId: runId,
      initialFlags: initialFlagsRef.current,
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
        threeBvPerSecond: metrics.threeBvPerSecond,
        ioe: metrics.ioe,
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
              setNotice(
                t("solo.historyCapacityNotice", { count: result.capacity.recordCount.toLocaleString() }),
              );
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
    status,
    flushTelemetry,
    track,
    t,
  ]);
  const progress = Math.round(getProgress(game) * 100);
  const failedPendingHistoryWrites = getPendingHistoryWrites().filter(
    (pending) => pending.status === "failed",
  );
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
            <div className={`solo-custom-grid${preset === "custom" ? " is-enabled" : ""}`}>
              <label>
                <span>{t("solo.width")}</span>
                <input
                  aria-label={t("solo.customWidth")}
                  inputMode="numeric"
                  max="100"
                  min="5"
                  type="number"
                  disabled={preset !== "custom"}
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
                  disabled={preset !== "custom"}
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
                  disabled={preset !== "custom"}
                  value={draftMines}
                  onChange={(event) => setDraftMines(event.target.value)}
                />
              </label>
              <button
                className="secondary-button"
                type="button"
                disabled={preset !== "custom"}
                onClick={applyCustom}
              >
                {t("solo.validateCustom")}
              </button>
            </div>
          </div>

          <div className="solo-setup-section">
            <div className="solo-setup-heading">
              <span>02</span>
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

          <div className="solo-setup-section solo-setup-section-split">
            <div>
              <div className="solo-setup-heading">
                <span>03</span>
                <div>
                  <strong>{t("solo.dataLevel")}</strong>
                  <small>{t("solo.dataLevelHelp")}</small>
                </div>
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
            <div>
              <div className="solo-setup-heading">
                <span>04</span>
                <div>
                  <strong>{t("solo.boardDisplay")}</strong>
                  <small>{t("solo.boardDisplayHelp")}</small>
                </div>
              </div>
              <div className="solo-compact-tabs" role="group" aria-label={t("solo.boardDisplayAria")}>
                {(
                  [
                    ["black-gold", t("solo.comfort")],
                    ["classic", t("solo.professional")],
                    ["high-contrast", t("solo.highContrast")],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    className={boardTheme === value ? "is-active" : ""}
                    key={value}
                    type="button"
                    aria-pressed={boardTheme === value}
                    onClick={() => chooseBoardTheme(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="solo-setup-launch">
            <div>
              <span>{t("solo.runPlan")}</span>
              <strong>
                {preset === "custom" ? t("solo.custom") : t(preset === "beginner" ? "solo.beginner" : preset === "intermediate" ? "solo.intermediate" : "solo.expert")} ·{" "}
                {draftWidth}×{draftHeight} / {draftMines} ·{" "}
                {mode === "no_guess" ? t("solo.noGuess") : t("solo.classic")}
              </strong>
              <p role="status">{notice || t("solo.readyHelp")}</p>
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
          <span className="panel-kicker">{t("solo.kicker.game")}</span>
          <h1>{t("solo.gameTitle")}</h1>
          <p>
            {preset === "custom" ? t("solo.custom") : t(preset === "beginner" ? "solo.beginner" : preset === "intermediate" ? "solo.intermediate" : "solo.expert")} · {config.width}×{config.height} / {config.mines} ·{" "}
            {t(config.mode === "no_guess" ? "solo.noGuess" : "solo.classic")}
          </p>
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
            <span>{t("solo.control.flag")}</span>
            <span>{t("solo.control.chord")}</span>
            <span>{config.mode === "no_guess" ? "NO-GUESS" : "CLASSIC"}</span>
          </div>
          <CanvasBoard
            {...(actionVisual === undefined ? {} : { actionVisual })}
            boardTheme={boardTheme}
            disabled={
              status === "GENERATING" || status === "WON" || status === "LOST"
            }
            effectsProfile={effectsProfile}
            game={game}
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

          {combo >= 3 && (
            <div
              className={`flow-combo combo-${Math.min(combo, 12)}`}
              aria-live="polite"
            >
              <span>{t("solo.flowCombo")}</span>
              <strong>×{combo}</strong>
              <em>{t(combo >= 12 ? "solo.combo.max" : combo >= 8 ? "solo.combo.high" : combo >= 5 ? "solo.combo.medium" : "solo.combo.low")}</em>
            </div>
          )}

          {status === "GENERATING" && (
            <div className="solo-generating" aria-live="assertive">
              <span className="panel-kicker">{t("solo.kicker.noGuessGeneration")}</span>
              <strong>{t("solo.generatingTitle")}</strong>
              <p>{t("solo.generatingDescription")}</p>
            </div>
          )}

        </div>

        <aside className="solo-side-panel">
          {(status === "WON" || status === "LOST") && (
            <section className="solo-terminal-panel" role="status" aria-live="assertive">
              <span className="panel-kicker">{t("solo.kicker.result")}</span>
              <h2>{t(status === "WON" ? "solo.result.won" : "solo.result.lost")}</h2>
              <p>{formatSoloTime(elapsedMs)} · {t("solo.resultActions", { count: actionBreakdown.semanticActions })}</p>
              <div className="solo-result-metrics">
                <span>{t(isNewPersonalBest ? "solo.newPersonalBestLocal" : "solo.localUnverified")}</span>
                <b>3BV {board3BV ?? "—"}</b>
                <b>3BV/s {formatMetric(threeBvPerSecond)}</b>
                <b>IOE {ioe === null ? "—" : `${(ioe * 100).toFixed(1)}%`}</b>
              </div>
              <div className="solo-terminal-legend" aria-label={t("solo.legend.aria")}>
                <span>{t("solo.legend.detonated")}</span>
                <span>{t("solo.legend.mine")}</span>
                <span>{t("solo.legend.correctFlag")}</span>
                <span>{t("solo.legend.wrongFlag")}</span>
              </div>
              <div className="result-actions">
                {currentHistoryPending ? (
                  <button className="primary-button" type="button" disabled>{t("solo.savingReplay")}</button>
                ) : (
                  <a className="primary-button" href={`#/solo/replay/${encodeURIComponent(currentRunId)}`}>{t("solo.analyze")}</a>
                )}
                <button className="secondary-button" type="button" onClick={() => resetBoard()}>{t("solo.sameBoard")}</button>
                <button className="secondary-button" type="button" onClick={exitSolo}>{t("solo.home")}</button>
              </div>
            </section>
          )}
          <span className="panel-kicker">{t("solo.kicker.metrics")}</span>
          <div className="solo-status-line">
            <strong>{statusLabel}</strong>
            <i className={`solo-status-dot status-${status.toLowerCase()}`} />
          </div>
          <div className="solo-clock">{formatSoloTime(elapsedMs)}</div>

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
              <span>{t("solo.actions")}</span>
              <strong>{actionBreakdown.semanticActions}</strong>
            </div>
            <div>
              <span>{t("solo.board")}</span>
              <strong>
                {config.width}×{config.height}
              </strong>
            </div>
            <div>
              <span>{t("solo.currentBest")}</span>
              <strong>
                {currentRulesPersonalBestMs === null
                  ? "—"
                  : formatSoloTime(currentRulesPersonalBestMs)}
              </strong>
            </div>
            {legacyPersonalBestMs !== null && (
              <div>
                <span>{t("solo.legacyBest")}</span>
                <strong>{formatSoloTime(legacyPersonalBestMs)}</strong>
              </div>
            )}
            <div>
              <span>{t("solo.verification")}</span>
              <strong className="solo-trust-label">{t("solo.local")}</strong>
            </div>
          </div>

          {statsLevel !== "basic" && (
            <div className="solo-stats solo-stats-advanced">
              <div>
                <span>{coarsePointer ? t("solo.actionsPerSecond") : "CPS / Cl/s"}</span>
                <strong>{formatMetric(cps)}</strong>
              </div>
              <div>
                <span>3BV</span>
                <strong>{board3BV ?? "—"}</strong>
              </div>
              <div>
                <span>3BV/s</span>
                <strong>{formatMetric(threeBvPerSecond)}</strong>
              </div>
              <div>
                <span>{status === "WON" ? "IOE" : t("solo.ioeProgress")}</span>
                <strong>
                  {ioe === null ? "—" : `${(ioe * 100).toFixed(1)}%`}
                </strong>
              </div>
            </div>
          )}

          {statsLevel === "analysis" && (
            <div className="solo-analysis" aria-label={t("solo.actionAnalysis")}>
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
          )}

          <div className="solo-progress-track">
            <i style={{ width: `${progress}%` }} />
          </div>

          <div className="solo-notice" aria-live="polite">
            {notice || t("solo.mantra")}
          </div>

          {(seed || generationSummary) && (
            <div className="solo-proof">
              <span>{t("solo.boardAudit")}</span>
              {generationSummary && <b>{generationSummary}</b>}
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
      <SoloHistory
        config={config}
        preset={preset}
        metricRulesVersion={SOLO_METRIC_RULES_VERSION}
        gameRulesVersion={SOLO_GAME_RULES_VERSION}
        refreshToken={pendingWriteVersion}
        store={historyStoreRef.current}
        onCurrentBestChange={handleCurrentBestChange}
        onLegacyPersonalBestChange={handleLegacyPersonalBestChange}
      />
    </section>
  );
}
