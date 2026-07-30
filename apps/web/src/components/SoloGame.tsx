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
  getSoloConfigError,
  type NoGuessWorkerRequest,
  type NoGuessWorkerResponse,
  type SoloBoardConfig,
  type SoloGenerationMode,
  type SoloPreset,
} from "../lib/solo";
import {
  SOLO_GAME_RULES_VERSION,
  SOLO_METRIC_RULES_VERSION,
  SOLO_RUN_SCHEMA_VERSION,
  createIndexedDbSoloHistoryStore,
  recordTrainingSessionTerminal,
  touchTrainingSession,
  type SoloHistoryCapacity,
  type SoloHistoryStore,
  type SoloRunRecordV1,
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
import "./solo-game.css";

interface SoloGameProps {
  readonly effectsProfile: BoardEffectsProfile;
  readonly initialGenerationMode?: SoloGenerationMode;
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

function comboCopy(combo: number): string {
  if (combo >= 12) return "逻辑风暴";
  if (combo >= 8) return "清场连击";
  if (combo >= 5) return "节奏正热";
  return "判断上线";
}

export interface PendingHistoryWriteSnapshot {
  readonly record: SoloRunRecordV1;
  readonly status: "queued" | "saving" | "failed";
  readonly error: string | null;
}

interface PendingHistoryWriteEntry {
  readonly record: SoloRunRecordV1;
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
  record: SoloRunRecordV1,
): SoloRunRecordV1 {
  return Object.freeze({
    ...record,
    config: Object.freeze({ ...record.config }),
    board: Object.freeze({ ...record.board }),
    rules: Object.freeze({ ...record.rules }),
    metrics: Object.freeze({ ...record.metrics }),
  });
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
  record: SoloRunRecordV1,
): SoloRunRecordV1 {
  const existing = pendingHistoryWrites.get(record.recordId);
  if (existing) return existing.record;
  const immutable = immutableHistoryRecord(record);
  pendingHistoryWrites.set(record.recordId, {
    record: immutable,
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
      const capacity = await store.put(entry.record);
      if (pendingHistoryWrites.get(recordId) === entry) {
        pendingHistoryWrites.delete(recordId);
        notifyPendingHistoryChange();
      }
      return { ok: true, capacity };
    } catch (cause: unknown) {
      if (pendingHistoryWrites.get(recordId) === entry) {
        entry.status = "failed";
        entry.error =
          cause instanceof Error
            ? cause.message
            : "本局成绩未能写入本地历史。";
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

const PRESET_LABELS: Readonly<
  Record<Exclude<SoloPreset, "custom">, string>
> = {
  beginner: "初级",
  intermediate: "中级",
  expert: "高级",
};

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
  reducedMotion,
  onExit,
}: SoloGameProps) {
  const { flush: flushTelemetry, track } = useTelemetry();
  const preferenceLoadRef = useRef(loadSoloPreferences());
  const restoredPreferences = preferenceLoadRef.current.preferences;
  const launchPreferences = resolveSoloLaunchPreferences(
    restoredPreferences,
    initialGenerationMode,
  );
  const launchMode = launchPreferences.config.mode;
  const initialConfig = launchPreferences.config;
  const initialPreset = launchPreferences.preset;
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
      ? "首击后后台生成可逻辑解出的无猜棋盘，最多尝试 50 次或 5 秒。"
      : "任意位置首击，周围 3×3 保证安全。"),
  );
  const [seed, setSeed] = useState("");
  const [boardHash, setBoardHash] = useState("");
  const [generationSummary, setGenerationSummary] = useState("");
  const [reviewingTerminalBoard, setReviewingTerminalBoard] = useState(false);
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
      setReviewingTerminalBoard(false);
      setNotice(
        nextConfig.mode === "no_guess"
          ? "首击后后台生成可逻辑解出的无猜棋盘，最多尝试 50 次或 5 秒。"
          : "任意位置首击，周围 3×3 保证安全。",
      );
    },
    [cancelGeneration, clearCombo, config, preset, replaceGame],
  );

  const finishIfTerminal = useCallback(
    (next: GameState, completedAt: number) => {
      if (next.outcome === "PLAYING") {
        setStatus("PLAYING");
        return;
      }
      setFinishedAt(completedAt);
      setReviewingTerminalBoard(false);
      setClockNow(completedAt);
      runCompletedAtRef.current = Date.now();
      lastEffectiveInteractionAtRef.current = null;
      runEffectiveInteractionMsRef.current =
        effectiveInteractionAccumulatedMsRef.current;
      setStatus(next.outcome === "WON" ? "WON" : "LOST");
      setNotice(
        next.outcome === "WON"
          ? "棋盘已清空。可以立即开始下一张。"
          : "触雷，本局结束。所有雷位已公开。",
      );
    },
    [],
  );

  const recordAction = useCallback(
    (
      actionType: BoardAction,
      originIndex: number,
      delta: RevealDelta,
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
      actionTraceRef.current.push(countedAction);
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
    [clearCombo],
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
      const beganAt = performance.now();
      const nextRunIdentity = createSoloRunIdentity();
      runIdentityRef.current = nextRunIdentity;
      runCompletedAtRef.current = null;
      historyEnqueuedRunRef.current = "";
      effectiveInteractionAccumulatedMsRef.current = 0;
      lastEffectiveInteractionAtRef.current =
        document.visibilityState === "visible" ? beganAt : null;
      runEffectiveInteractionMsRef.current = 0;
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
      setNotice("正在后台寻找无猜棋盘，计时尚未开始…");

      let worker: Worker;
      try {
        worker = new Worker(
          new URL("../workers/noGuessWorker.ts", import.meta.url),
          { type: "module" },
        );
      } catch {
        generationActiveRef.current = false;
        setStatus("READY");
        setNotice("无猜生成器无法启动，请检查浏览器安全策略或改用经典随机。");
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
            "在 50 次尝试内没有找到无猜棋盘，请调整尺寸、雷数或改用经典随机。",
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
            generation: `${event.data.attempts} 次尝试 · ${event.data.elapsedMs.toFixed(0)}ms`,
            physicalClicks,
          },
        );
        if (outcome === "PLAYING") {
          setNotice("无猜棋盘已验证，计时开始。");
        }
      };
      worker.onerror = () => {
        fail(
          "无猜生成器启动失败，请改用经典随机后重试。",
          "GENERATION_ERROR",
        );
      };
      workerTimeoutRef.current = window.setTimeout(() => {
        fail(
          "无猜生成超过 5 秒，请调整尺寸、雷数或改用经典随机。",
          "TIME_LIMIT",
        );
      }, 5_000);
      try {
        worker.postMessage(request);
      } catch {
        fail(
          "无猜生成器无法接收任务，请改用经典随机后重试。",
          "GENERATION_ERROR",
        );
      }
    },
    [beginGame, cancelGeneration, config, preset, track],
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
          setNotice("首击前旗标会保留，但不计入正式操作统计。");
          return;
        }
        if (action === "CHORD") {
          chordCell(current, cellIndex);
          setNotice("首击前没有可和弦的数字格。");
          return;
        }
        if (current.visibility[cellIndex] === CELL_FLAGGED) {
          setNotice("该格已插旗，请先取消旗标。");
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
          setNotice("经典随机棋盘，计时开始。");
        }
        return;
      }

      const comboEligible =
        action === "CHORD" ||
        (action === "REVEAL" && isProvablySafeCell(current, cellIndex));
      const actionAt = performance.now();
      recordEffectiveInteraction(actionAt);
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
        comboEligible,
        physicalClicks,
      );
      if (!delta.accepted) {
        setNotice(
          delta.rejectReason === "FLAG_COUNT_MISMATCH"
            ? "相邻旗数还不等于数字，和弦未执行。"
            : "这个动作没有改变棋盘。",
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
    const error = getSoloConfigError(nextConfig);
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
    const error = getSoloConfigError(nextConfig);
    if (error) {
      setNotice(error);
      return;
    }
    resetBoard(nextConfig, "custom");
    persistPreferences(nextConfig, "custom");
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
          : "单人偏好未能保存；本局可继续。",
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
    const record: SoloRunRecordV1 = {
      schemaVersion: SOLO_RUN_SCHEMA_VERSION,
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
        seed,
        boardHash,
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
    };

    enqueuePendingHistoryRecord(record);
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
                `本局已保存。本地历史容量 ${result.capacity.recordCount.toLocaleString()}/10,000，请及时导出并按需删除。`,
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
  ]);
  const progress = Math.round(getProgress(game) * 100);
  const failedPendingHistoryWrites = getPendingHistoryWrites().filter(
    (pending) => pending.status === "failed",
  );
  const statusLabel =
    status === "READY"
      ? "等待首击"
      : status === "GENERATING"
        ? "生成中"
        : status === "PLAYING"
          ? "进行中"
          : status === "WON"
            ? "已完成"
            : "已触雷";

  return (
    <section className="solo-shell">
      <a className="skip-link" href="#solo-board">
        跳到棋盘
      </a>
      <div className="solo-header">
        <div>
          <span className="panel-kicker">LOCAL / SINGLE PLAYER</span>
          <h1>经典扫雷</h1>
          <p>无需等待对手。首击安全、完整计时，支持经典随机与可验证无猜棋盘。</p>
        </div>
        <button className="secondary-button solo-exit" type="button" onClick={exitSolo}>
          返回模式选择
        </button>
      </div>

      <div className="solo-config" aria-label="单人棋盘设置">
        <div className="solo-config-group">
          <span className="meta-label">难度</span>
          <div className="solo-tabs">
            {(Object.keys(PRESET_LABELS) as Array<Exclude<SoloPreset, "custom">>).map(
              (key) => (
                <button
                  className={`solo-tab${preset === key ? " is-active" : ""}`}
                  key={key}
                  type="button"
                  onClick={() => choosePreset(key)}
                >
                  {PRESET_LABELS[key]}
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
              onClick={applyCustom}
            >
              自定义
              <small>5–100 / ≤10K</small>
            </button>
          </div>
        </div>

        <div className="solo-config-group">
          <span className="meta-label">生成规则</span>
          <div className="solo-mode-tabs">
            <button
              className={`solo-mode${mode === "classic" ? " is-active" : ""}`}
              type="button"
              onClick={() => chooseMode("classic")}
            >
              经典随机
            </button>
            <button
              className={`solo-mode${mode === "no_guess" ? " is-active" : ""}`}
              type="button"
              onClick={() => chooseMode("no_guess")}
            >
              无猜模式
            </button>
          </div>
        </div>

        <div className="solo-custom-grid">
          <label>
            <span>宽</span>
            <input
              aria-label="自定义宽度"
              inputMode="numeric"
              max="100"
              min="5"
              type="number"
              value={draftWidth}
              onChange={(event) => setDraftWidth(event.target.value)}
            />
          </label>
          <label>
            <span>高</span>
            <input
              aria-label="自定义高度"
              inputMode="numeric"
              max="100"
              min="5"
              type="number"
              value={draftHeight}
              onChange={(event) => setDraftHeight(event.target.value)}
            />
          </label>
          <label>
            <span>雷</span>
            <input
              aria-label="自定义雷数"
              inputMode="numeric"
              min="1"
              type="number"
              value={draftMines}
              onChange={(event) => setDraftMines(event.target.value)}
            />
          </label>
          <button className="secondary-button" type="button" onClick={applyCustom}>
            应用自定义
          </button>
        </div>
      </div>

      <div className="solo-game-layout">
        <div
          className="board-stage solo-board-stage"
          id="solo-board"
          tabIndex={-1}
        >
          <div className="board-toolbar">
            <span>左键 REVEAL</span>
            <span>右键 FLAG</span>
            <span>中键 / 左右键 CHORD</span>
            <span>{config.mode === "no_guess" ? "NO-GUESS" : "CLASSIC"}</span>
            {reviewingTerminalBoard && (
              <button
                className="board-toolbar-action"
                type="button"
                onClick={() => setReviewingTerminalBoard(false)}
              >
                查看结算
              </button>
            )}
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
              <span>FLOW COMBO</span>
              <strong>×{combo}</strong>
              <em>{comboCopy(combo)}</em>
            </div>
          )}

          {status === "GENERATING" && (
            <div className="solo-generating" aria-live="assertive">
              <span className="panel-kicker">NO-GUESS GENERATION V1</span>
              <strong>生成无猜棋盘</strong>
              <p>最多 50 次尝试或 5 秒；生成时间不会计入成绩。</p>
            </div>
          )}

          {(status === "WON" || status === "LOST") &&
            !reviewingTerminalBoard && (
            <div
              className="result-overlay"
              role="status"
              aria-live="assertive"
              aria-atomic="true"
            >
              <span className="panel-kicker">SINGLE PLAYER RESULT</span>
              <h2>{status === "WON" ? "棋盘完成" : "触雷"}</h2>
              <p>
                {formatSoloTime(elapsedMs)} · {actionBreakdown.semanticActions} 次操作 ·{" "}
                {config.width}×{config.height} / {config.mines}
              </p>
              <div className="solo-result-metrics">
                <span>
                  {isNewPersonalBest
                    ? "NEW PERSONAL BEST · LOCAL_UNVERIFIED"
                    : "LOCAL_UNVERIFIED"}
                </span>
                <b>3BV {board3BV ?? "—"}</b>
                <b>3BV/s {formatMetric(threeBvPerSecond)}</b>
                <b>IOE {ioe === null ? "—" : `${(ioe * 100).toFixed(1)}%`}</b>
              </div>
              <div className="result-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setReviewingTerminalBoard(true)}
                >
                  查看棋盘
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => resetBoard()}
                >
                  新棋盘
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={exitSolo}
                >
                  返回首页
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="solo-side-panel">
          <span className="panel-kicker">RUN METRICS</span>
          <div className="solo-status-line">
            <strong>{statusLabel}</strong>
            <i className={`solo-status-dot status-${status.toLowerCase()}`} />
          </div>
          <div className="solo-clock">{formatSoloTime(elapsedMs)}</div>

          <div className="solo-option-block">
            <span className="meta-label">数据层级</span>
            <div className="solo-compact-tabs" role="group" aria-label="统计数据层级">
              {(
                [
                  ["basic", "基础"],
                  ["advanced", "高级"],
                  ["analysis", "分析"],
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

          <div className="solo-stats">
            <div>
              <span>剩余雷数</span>
              <strong>{status === "WON" ? 0 : config.mines - flags}</strong>
            </div>
            <div>
              <span>安全格进度</span>
              <strong>{progress}%</strong>
            </div>
            <div>
              <span>操作</span>
              <strong>{actionBreakdown.semanticActions}</strong>
            </div>
            <div>
              <span>棋盘</span>
              <strong>
                {config.width}×{config.height}
              </strong>
            </div>
            <div>
              <span>当前规则最佳</span>
              <strong>
                {currentRulesPersonalBestMs === null
                  ? "—"
                  : formatSoloTime(currentRulesPersonalBestMs)}
              </strong>
            </div>
            {legacyPersonalBestMs !== null && (
              <div>
                <span>旧版 PB 参考</span>
                <strong>{formatSoloTime(legacyPersonalBestMs)}</strong>
              </div>
            )}
            <div>
              <span>验证状态</span>
              <strong className="solo-trust-label">LOCAL</strong>
            </div>
          </div>

          {statsLevel !== "basic" && (
            <div className="solo-stats solo-stats-advanced">
              <div>
                <span>{coarsePointer ? "动作/秒" : "CPS / Cl/s"}</span>
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
                <span>{status === "WON" ? "IOE" : "IOE（过程）"}</span>
                <strong>
                  {ioe === null ? "—" : `${(ioe * 100).toFixed(1)}%`}
                </strong>
              </div>
            </div>
          )}

          {statsLevel === "analysis" && (
            <div className="solo-analysis" aria-label="动作分析">
              <span>
                物理点击 <b>{actionBreakdown.physicalClicks}</b>
              </span>
              <span>
                接受动作 <b>{actionBreakdown.acceptedActions}</b>
              </span>
              <span>
                无效动作 <b>{actionBreakdown.wastedActions}</b>
              </span>
              <span>
                揭格 / 和弦 <b>{actionBreakdown.reveals} / {actionBreakdown.chords}</b>
              </span>
              <span>
                插旗 / 取消 <b>{actionBreakdown.flags} / {actionBreakdown.unflags}</b>
              </span>
            </div>
          )}

          <div className="solo-progress-track">
            <i style={{ width: `${progress}%` }} />
          </div>

          <div className="solo-option-block solo-theme-block">
            <span className="meta-label">棋盘显示</span>
            <div className="solo-compact-tabs" role="group" aria-label="棋盘显示方案">
              {(
                [
                  ["black-gold", "舒适"],
                  ["classic", "专业"],
                  ["high-contrast", "高对比"],
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

          <div className="solo-notice" aria-live="polite">
            {notice || "判断、节奏、执行。"}
          </div>

          {(seed || generationSummary) && (
            <div className="solo-proof">
              <span>BOARD AUDIT</span>
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
            放弃并换一张
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
            记录 {pending.record.recordId.slice(0, 8)} 保存失败：
            {pending.error ?? "本局成绩未能写入本地历史。"}
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
            重试保存
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
