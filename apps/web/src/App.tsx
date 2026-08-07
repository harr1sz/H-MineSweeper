import {
  PROTOCOL_VERSION,
  chordCell,
  createBoard,
  createGameState,
  getProgress,
  hashGameState,
  revealCell,
  toggleFlag,
  type ClientActionEnvelope,
  type GameState,
  type RoomPlayer,
  type ServerMessage,
} from "@h-minesweeper/game-core";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardAction, BoardActionVisual } from "./components/CanvasBoard";
import type { ProgressPoint } from "./components/ProgressChart";
import {
  ApiError,
  createGuestSession,
  createRoom,
  joinRoom,
  replayUrl,
} from "./lib/api";
import { formatDuration, formatRtt, normalizeRoomCode } from "./lib/format";
import { percentile, recordMetric } from "./lib/performance";
import type { SoloBoardConfig, SoloGenerationMode } from "./lib/solo";
import { loadSoloPreferences } from "./lib/solo-preferences";
import type { SoloSessionKind } from "./lib/practice-coach";
import { purgeRetiredAcademyProgress } from "./lib/retired-academy";
import { parsePracticeLaunchContext } from "./lib/practice-launch";
import { useTelemetry } from "./components/TelemetryPrivacy";

const SoloGame = lazy(() => import("./components/SoloGame").then((module) => ({ default: module.SoloGame })));
const ReplayReview = lazy(() => import("./components/ReplayReview").then((module) => ({ default: module.ReplayReview })));
const PracticeReplayReview = lazy(() => import("./components/PracticeReplayReview").then((module) => ({ default: module.PracticeReplayReview })));
const CanvasBoard = lazy(() => import("./components/CanvasBoard").then((module) => ({ default: module.CanvasBoard })));
const ProgressChart = lazy(() => import("./components/ProgressChart").then((module) => ({ default: module.ProgressChart })));
import {
  RealtimeClient,
  captureOptimisticGameState,
  classifyReliableSequence,
  planActionReconciliation,
  rollbackOptimisticGameState,
  type ConnectionStatus,
  type OptimisticGameSnapshot,
} from "./lib/realtime";
import { DUEL_EXPERIMENT_ENABLED } from "./lib/build-config";
import {
  LocaleToggle,
  useLocale,
  type MessageDescriptor,
} from "./i18n";

type UiPhase =
  | "HOME"
  | "LOBBY"
  | "COUNTDOWN"
  | "ACTIVE"
  | "ROUND_RESULT"
  | "MATCH_RESULT";

type HomeMode = "solo" | "duel";
type LocalMode = "solo" | "replay" | "practice-replay" | null;
type MotionPreference = "system" | "full" | "reduced";
type EffectsProfile = "full" | "lite" | "essential";

const MOTION_PREFERENCE_KEY = "hms-motion-preference";
const EFFECTS_PROFILE_KEY = "hms-effects-profile";
interface PendingOptimisticAction {
  readonly preAction: OptimisticGameSnapshot;
  readonly optimisticStateHash: string;
}

function readLocalModeFromLocation(): LocalMode {
  if (window.location.hash.startsWith("#/solo/practice/replay/")) return "practice-replay";
  if (window.location.hash.startsWith("#/solo/replay/")) return "replay";
  if (window.location.hash.startsWith("#/solo")) return "solo";
  return null;
}

function readPracticeReplayRecordId(): string {
  try {
    const recordId = decodeURIComponent(window.location.hash.slice("#/solo/practice/replay/".length));
    return /^[A-Za-z0-9._:-]{1,128}$/.test(recordId) ? recordId : "";
  } catch {
    return "";
  }
}

function readReplayRecordId(): string {
  try {
    const recordId = decodeURIComponent(window.location.hash.slice("#/solo/replay/".length));
    return /^[A-Za-z0-9._:-]{1,128}$/.test(recordId) ? recordId : "";
  } catch {
    return "";
  }
}

function readInvitedRoomCode(): string {
  if (!DUEL_EXPERIMENT_ENABLED) return "";
  const code = normalizeRoomCode(
    new URLSearchParams(window.location.search).get("room") ?? "",
  );
  return code.length === 6 ? code : "";
}

function readInitialHomeMode(): HomeMode {
  return readInvitedRoomCode() ? "duel" : "solo";
}

function duelEntryError(error: unknown): MessageDescriptor {
  if (!(error instanceof ApiError)) {
    return { id: "duel.entry.generic" };
  }
  if (error.code === "ROOM_FULL") {
    return { id: "duel.entry.full" };
  }
  if (error.code === "ROOM_NOT_FOUND") {
    return { id: "duel.entry.notFound" };
  }
  if (error.code === "ALREADY_JOINED") {
    return { id: "duel.entry.joined" };
  }
  if (error.code === "RATE_LIMITED") {
    return { id: "duel.entry.rateLimited" };
  }
  return { id: "duel.entry.generic" };
}

function duelInviteUrl(roomCode: string): string {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("room", roomCode);
  return url.toString();
}

function readSoloLaunchModeFromLocation(): SoloGenerationMode {
  if (window.location.hash.startsWith("#/solo/practice")) return "no_guess";
  return window.location.hash === "#/solo/no-guess"
    ? "no_guess"
    : "classic";
}

function readSoloSessionKindFromLocation(): SoloSessionKind {
  return window.location.hash.startsWith("#/solo/practice")
    ? "GUIDED_PRACTICE"
    : "STANDARD";
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences are best-effort. Storage failures must not block play.
  }
}

function readMotionPreference(): MotionPreference {
  const stored = safeLocalStorageGet(MOTION_PREFERENCE_KEY);
  return stored === "full" || stored === "reduced" ? stored : "system";
}

function readEffectsProfile(): EffectsProfile {
  const stored = safeLocalStorageGet(EFFECTS_PROFILE_KEY);
  return stored === "lite" || stored === "essential" ? stored : "full";
}

function nextMotionPreference(current: MotionPreference): MotionPreference {
  if (current === "system") return "full";
  if (current === "full") return "reduced";
  return "system";
}

function nextEffectsProfile(current: EffectsProfile): EffectsProfile {
  if (current === "full") return "lite";
  if (current === "lite") return "essential";
  return "full";
}

function downgradeEffects(current: EffectsProfile): EffectsProfile {
  if (current === "full") return "lite";
  return "essential";
}

interface PlayerSummary {
  playerId: string;
  displayName: string;
  seat: number;
  connected: boolean;
  ready: boolean;
  rematch?: boolean;
  progress: number;
  score: number;
}

interface ResultSummary {
  title: MessageDescriptor;
  detail: MessageDescriptor;
  winnerId?: string;
  reason?: string;
}

function clampProgress(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function resultCopy(
  winnerId: string | undefined,
  localPlayerId: string,
  reason: string | undefined,
  match: boolean,
): ResultSummary {
  if (!winnerId) {
    return {
      title: { id: match ? "duel.result.matchDraw" : "duel.result.roundDraw" },
      detail: match
        ? { id: "duel.result.noMatch" }
        : reason === "NO_CONTEST"
          ? { id: "duel.result.noRound" }
          : { id: "duel.result.nextBoard" },
      ...(reason === undefined ? {} : { reason }),
    };
  }
  const won = winnerId === localPlayerId;
  return {
    title: { id: match ? won ? "duel.result.matchWin" : "duel.result.matchLoss" : won ? "duel.result.roundWin" : "duel.result.roundLoss" },
    detail: { id: won ? "duel.result.winDetail" : "duel.result.lossDetail" },
    winnerId,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function App() {
  const { persistenceWarning, t } = useLocale();
  const { flush: flushTelemetry, track } = useTelemetry();
  const realtimeRef = useRef(new RealtimeClient());
  const gameRef = useRef<GameState | null>(null);
  const actionCounterRef = useRef(0);
  const matchVisualSequenceRef = useRef(0);
  const pendingActionsRef = useRef(
    new Map<string, PendingOptimisticAction>(),
  );
  const processedServerSeqRef = useRef(0);
  const processedProgressSeqRef = useRef(0);
  const snapshotRequiredRef = useRef(false);
  const protocolBlockedRef = useRef(false);
  const authoritativeHashRef = useRef("");
  const playerIdRef = useRef("");
  const roundStartedAtRef = useRef<number | null>(null);
  const roundRef = useRef(1);
  const inviteOpenedTrackedRef = useRef(false);
  const phaseRef = useRef<UiPhase>("HOME");
  const connectedOnceRef = useRef(false);
  const leaveRoomRef = useRef<() => void>(() => undefined);
  const [phase, setPhase] = useState<UiPhase>("HOME");
  const [localMode, setLocalMode] = useState<LocalMode>(
    readLocalModeFromLocation,
  );
  const [soloLaunchMode, setSoloLaunchMode] =
    useState<SoloGenerationMode>(readSoloLaunchModeFromLocation);
  const [soloSessionKind, setSoloSessionKind] =
    useState<SoloSessionKind>(readSoloSessionKindFromLocation);
  const [soloLaunchConfig, setSoloLaunchConfig] = useState<SoloBoardConfig | undefined>();
  const [soloLaunchSetupComplete, setSoloLaunchSetupComplete] = useState(false);
  const practiceLaunchContext = parsePracticeLaunchContext(window.location.hash);
  const [homeMode, setHomeMode] = useState<HomeMode>(readInitialHomeMode);
  const [connection, setConnection] = useState<ConnectionStatus>("disconnected");
  const [displayName, setDisplayName] = useState(
    () => safeLocalStorageGet("hms-display-name") ?? "",
  );
  const [joinCode, setJoinCode] = useState(readInvitedRoomCode);
  const [roomId, setRoomId] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [matchId, setMatchId] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [connectionEpoch, setConnectionEpoch] = useState(1);
  const [lastServerSeq, setLastServerSeq] = useState(0);
  const [players, setPlayers] = useState<PlayerSummary[]>([]);
  const [round, setRound] = useState(1);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [countdownDeadline, setCountdownDeadline] = useState<number | null>(null);
  const [roundStartedAt, setRoundStartedAt] = useState<number | null>(null);
  const [roundFinishedAt, setRoundFinishedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [gameRevision, setGameRevision] = useState(0);
  const [matchActionVisual, setMatchActionVisual] =
    useState<BoardActionVisual>();
  const [result, setResult] = useState<ResultSummary | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [replayId, setReplayId] = useState("");
  const [authoritativeHash, setAuthoritativeHash] = useState("");
  const [progressHistory, setProgressHistory] = useState<ProgressPoint[]>([]);
  const [error, setError] = useState<MessageDescriptor | null>(null);
  const [notice, setNotice] = useState<MessageDescriptor | null>(null);
  const [busy, setBusy] = useState(false);
  const [motionPreference, setMotionPreference] = useState<MotionPreference>(
    readMotionPreference,
  );
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [effectsPreference, setEffectsPreference] = useState<EffectsProfile>(
    readEffectsProfile,
  );
  const [sessionEffects, setSessionEffects] = useState<EffectsProfile>(
    readEffectsProfile,
  );
  const [inputLatency, setInputLatency] = useState<number | null>(null);
  const [rttTick, setRttTick] = useState(0);

  const localPlayer = players.find((player) => player.playerId === playerId);
  const opponent = players.find((player) => player.playerId !== playerId);
  const game = gameRef.current;
  const rttMs = realtimeRef.current.rttMs;
  const reducedMotion =
    systemReducedMotion || motionPreference === "reduced";
  const savedSoloPreferences = useMemo(
    () => loadSoloPreferences().preferences,
    [localMode],
  );
  const effectsProfile: EffectsProfile = reducedMotion
    ? "essential"
    : sessionEffects;
  void rttTick;
  playerIdRef.current = playerId;
  roundStartedAtRef.current = roundStartedAt;
  roundRef.current = round;
  phaseRef.current = phase;
  authoritativeHashRef.current = authoritativeHash;

  useEffect(() => {
    purgeRetiredAcademyProgress();
  }, []);

  useEffect(() => {
    const invitedRoomCode = readInvitedRoomCode();
    if (!invitedRoomCode || inviteOpenedTrackedRef.current) return;
    inviteOpenedTrackedRef.current = true;
    track("duel_invite_opened", { source: "invite" });
    void flushTelemetry();
  }, [flushTelemetry, track]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setRttTick((value) => value + 1);
    }, phase === "ACTIVE" || phase === "COUNTDOWN" ? 50 : 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => () => realtimeRef.current.disconnect(), []);

  useEffect(() => {
    const handleNavigation = () => {
      const nextLocalMode = readLocalModeFromLocation();
      if (nextLocalMode !== null) {
        leaveRoomRef.current();
      }
      setLocalMode(nextLocalMode);
      setSoloLaunchMode(readSoloLaunchModeFromLocation());
      setSoloSessionKind(readSoloSessionKindFromLocation());
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    window.addEventListener("popstate", handleNavigation);
    window.addEventListener("hashchange", handleNavigation);
    return () => {
      window.removeEventListener("popstate", handleNavigation);
      window.removeEventListener("hashchange", handleNavigation);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemReducedMotion(event.matches);
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    setSessionEffects(effectsPreference);
  }, [effectsPreference]);

  useEffect(() => {
    if (reducedMotion || effectsProfile === "essential") return;
    if (!("PerformanceObserver" in window)) return;
    let downgraded = false;
    const observer = new PerformanceObserver((list) => {
      if (
        downgraded ||
        !list.getEntries().some((entry) => entry.duration >= 50)
      ) {
        return;
      }
      downgraded = true;
      setSessionEffects((current) => downgradeEffects(current));
    });
    try {
      observer.observe({ type: "longtask" });
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, [effectsProfile, reducedMotion]);

  useEffect(() => {
    if (reducedMotion || effectsProfile === "essential") return;
    let inputCursor =
      globalThis.__HMS_PERF_COUNTS__?.pointerNextPaintMs ?? 0;
    let frameCursor =
      globalThis.__HMS_PERF_COUNTS__?.boardAnimationFrameIntervalMs ?? 0;
    let consecutiveSlowInputWindows = 0;
    let downgraded = false;
    const timer = window.setInterval(() => {
      const inputSamples =
        globalThis.__HMS_PERF__?.pointerNextPaintMs ?? [];
      const frameSamples =
        globalThis.__HMS_PERF__?.boardAnimationFrameIntervalMs ?? [];
      const inputCount =
        globalThis.__HMS_PERF_COUNTS__?.pointerNextPaintMs ?? 0;
      const frameCount =
        globalThis.__HMS_PERF_COUNTS__?.boardAnimationFrameIntervalMs ?? 0;
      const inputDelta = Math.min(
        Math.max(0, inputCount - inputCursor),
        inputSamples.length,
      );
      const frameDelta = Math.min(
        Math.max(0, frameCount - frameCursor),
        frameSamples.length,
      );
      const nextInputSamples =
        inputDelta === 0 ? [] : inputSamples.slice(-inputDelta);
      const nextFrameSamples =
        frameDelta === 0 ? [] : frameSamples.slice(-frameDelta);
      inputCursor = inputCount;
      frameCursor = frameCount;

      const inputP95 = percentile(nextInputSamples, 0.95);
      const frameP95 = percentile(nextFrameSamples, 0.95);
      if (inputP95 !== null && inputP95 > 16.7) {
        consecutiveSlowInputWindows += 1;
      } else if (nextInputSamples.length > 0) {
        consecutiveSlowInputWindows = 0;
      }
      if (
        downgraded ||
        (consecutiveSlowInputWindows < 2 &&
          (frameP95 === null || frameP95 <= 20))
      ) {
        return;
      }
      downgraded = true;
      setSessionEffects((current) => downgradeEffects(current));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [effectsProfile, reducedMotion]);

  const markTechnicalDisconnect = useCallback(() => {
    if (phaseRef.current === "MATCH_RESULT") return;
    phaseRef.current = "MATCH_RESULT";
    pendingActionsRef.current.clear();
    setPlayers((current) =>
      current.map((player) =>
        player.playerId === playerIdRef.current
          ? { ...player, connected: false }
          : player,
      ),
    );
    setNotice(null);
    setConnectionLost(true);
    setRoundFinishedAt((current) => current ?? Date.now());
    setResult({
      title: { id: "duel.result.technical" },
      detail: { id: "duel.result.technicalDetail" },
      reason: "TECHNICAL_DNF",
    });
    setPhase("MATCH_RESULT");
    track("duel_dnf", {
      reason: "DISCONNECTED",
      round: roundRef.current,
    });
    void flushTelemetry();
  }, [flushTelemetry, track]);

  const failIntegrity = useCallback((detail: MessageDescriptor) => {
    pendingActionsRef.current.clear();
    phaseRef.current = "MATCH_RESULT";
    setConnectionLost(true);
    setRoundFinishedAt((current) => current ?? Date.now());
    setResult({
      title: { id: "duel.result.integrity" },
      detail,
      reason: "STATE_DIVERGENCE",
    });
    setError({ id: "duel.error.integrity" });
    setPhase("MATCH_RESULT");
    realtimeRef.current.disconnect();
    track("duel_dnf", {
      reason: "STATE_DIVERGED",
      round: roundRef.current,
    });
    void flushTelemetry();
  }, [flushTelemetry, track]);

  const handleConnectionStatus = useCallback(
    (status: ConnectionStatus) => {
      setConnection(status);
      if (status === "connected") {
        connectedOnceRef.current = true;
        return;
      }
      if (
        !connectedOnceRef.current ||
        (status !== "disconnected" && status !== "error")
      ) {
        return;
      }
      if (phaseRef.current === "HOME" || phaseRef.current === "MATCH_RESULT") {
        return;
      }
      if (phaseRef.current === "LOBBY") {
        setError({ id: "duel.error.connectionLost" });
        setPhase("HOME");
        return;
      }
      markTechnicalDisconnect();
    },
    [markTechnicalDisconnect, t],
  );

  const sendAction = useCallback(
    (
      actionType: "READY" | BoardAction | "REMATCH",
      cellIndex?: number,
      baseStateHash = authoritativeHashRef.current,
      pendingAction?: PendingOptimisticAction,
    ) => {
      if (!baseStateHash) {
        setError({ id: "duel.error.noBaseline" });
        return false;
      }
      actionCounterRef.current += 1;
      const clientActionId = `${playerId || "pending"}-${actionCounterRef.current}`;
      if (pendingAction !== undefined) {
        pendingActionsRef.current.set(clientActionId, pendingAction);
      }
      const envelope: ClientActionEnvelope = {
        v: PROTOCOL_VERSION,
        matchId: matchId || roomId,
        connectionEpoch,
        clientActionId,
        lastServerSeq,
        baseStateHash,
        actionType,
        ...(cellIndex === undefined ? {} : { cellIndex }),
        clientMonoTelemetry: performance.now(),
      };
      const sent = realtimeRef.current.send({
        type: "ACTION",
        envelope,
      });
      if (!sent) {
        pendingActionsRef.current.delete(clientActionId);
        setError({ id: "duel.error.unavailable" });
      }
      return sent;
    },
    [connectionEpoch, lastServerSeq, matchId, playerId, roomId, t],
  );

  const updatePlayers = useCallback(
    (
      nextPlayers: readonly RoomPlayer[],
      nextScores?: Readonly<Record<string, number>>,
    ) => {
      setPlayers(
        nextPlayers.map((player) => ({
          playerId: player.playerId,
          displayName: player.displayName,
          seat: player.seat,
          connected: player.connected,
          ready: player.ready,
          rematch: player.rematch,
          progress: clampProgress(player.progress),
          score: nextScores?.[player.playerId] ?? player.score,
        })),
      );
    },
    [],
  );

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      if (protocolBlockedRef.current && message.type !== "ERROR") {
        return;
      }
      if ("serverSeq" in message && typeof message.serverSeq === "number") {
        const sequenceStatus = classifyReliableSequence(
          processedServerSeqRef.current,
          message.serverSeq,
        );
        if (sequenceStatus === "DUPLICATE") return;
        if (sequenceStatus === "GAP") {
          failIntegrity({ id: "duel.integrity.sequenceGap" });
          return;
        }
        processedServerSeqRef.current = message.serverSeq;
        setLastServerSeq(message.serverSeq);
      }

      switch (message.type) {
        case "WELCOME": {
          processedProgressSeqRef.current = 0;
          setPlayerId(message.playerId);
          setRoomId(message.roomId);
          setRoomCode(message.roomCode);
          setMatchId(message.matchId);
          setConnectionEpoch(message.connectionEpoch);
          setPhase("LOBBY");
          setNotice({ id: "duel.notice.connected" });
          break;
        }
        case "ROOM_STATE": {
          updatePlayers(message.players, message.scores);
          setAuthoritativeHash(message.stateHash);
          if (message.matchId) setMatchId(message.matchId);
          if (message.phase === "REMATCH") {
            const votes = message.players.filter((player) => player.rematch).length;
            setNotice({ id: "duel.notice.rematchVotes", values: { votes } });
          } else if (message.phase !== "CLOSED") {
            setPhase(message.phase);
          }
          break;
        }
        case "COUNTDOWN": {
          if (
            message.boardVisibility !== "client_seed" ||
            !("seed" in message.boardSpec)
          ) {
            setError({ id: "duel.error.privateBoard" });
            return;
          }
          try {
            gameRef.current = createGameState(createBoard(message.boardSpec));
            setGameRevision((value) => value + 1);
          } catch (cause) {
            setError({ id: "duel.error.boardGeneration" });
          }
          setRound(message.round);
          setCountdownDeadline(
            message.deadline - realtimeRef.current.serverOffsetMs,
          );
          setRoundStartedAt(null);
          setRoundFinishedAt(null);
          setMatchActionVisual(undefined);
          setAuthoritativeHash("");
          pendingActionsRef.current.clear();
          snapshotRequiredRef.current = false;
          setProgressHistory([]);
          setResult(null);
          setConnectionLost(false);
          setPhase("COUNTDOWN");
          break;
        }
        case "ROUND_ACTIVE": {
          const activeGame = gameRef.current;
          if (activeGame) {
            revealCell(activeGame, activeGame.board.spec.startIndex);
            setGameRevision((value) => value + 1);
          }
          setRoundStartedAt(
            message.startedAt - realtimeRef.current.serverOffsetMs,
          );
          setAuthoritativeHash(message.stateHash);
          setCountdownDeadline(null);
          setPhase("ACTIVE");
          track("duel_started", { round: message.round });
          break;
        }
        case "ACTION_RESULT": {
          const pendingAction = pendingActionsRef.current.get(
            message.ackClientActionId,
          );
          pendingActionsRef.current.delete(message.ackClientActionId);
          const reconciliationPlan = planActionReconciliation(
            message.reconcile,
            pendingActionsRef.current.size,
          );
          if (message.accepted === false) {
            setNotice({ id: "duel.notice.rejected" });
          }
          if (reconciliationPlan === "WAIT_FOR_SNAPSHOT") {
            snapshotRequiredRef.current = true;
            setNotice({ id: "duel.notice.reconciling" });
            return;
          }
          const activeGame = gameRef.current;
          if (
            reconciliationPlan === "ROLLBACK" &&
            pendingAction &&
            activeGame
          ) {
            rollbackOptimisticGameState(activeGame, pendingAction.preAction);
            setMatchActionVisual(undefined);
            setGameRevision((value) => value + 1);
          }
          if (
            reconciliationPlan !== "DEFER" &&
            pendingAction &&
            activeGame
          ) {
            const localStateHash = hashGameState(activeGame);
            const expectedLocalHash =
              message.reconcile === "ROLLBACK"
                ? message.authoritativeStateHash
                : pendingAction.optimisticStateHash;
            if (
              localStateHash !== expectedLocalHash ||
              localStateHash !== message.authoritativeStateHash
            ) {
              failIntegrity({ id: "duel.integrity.actionHash" });
              return;
            }
          }
          setAuthoritativeHash(message.authoritativeStateHash);
          break;
        }
        case "PROGRESS": {
          if (message.progressSeq <= processedProgressSeqRef.current) {
            return;
          }
          processedProgressSeqRef.current = message.progressSeq;
          const progress = message.progress;
          setPlayers((current) =>
            current.map((player) => {
              const next = progress.find(
                (entry) => entry.playerId === player.playerId,
              );
              return next
                ? {
                    ...player,
                    progress: clampProgress(next.progress),
                    connected: next.connected,
                  }
                : player;
            }),
          );
          setProgressHistory((history) => [
            ...history.slice(-599),
            {
              elapsedMs: Math.max(
                0,
                Date.now() - (roundStartedAtRef.current ?? Date.now()),
              ),
              players: Object.fromEntries(
                progress.map((player) => [
                  player.playerId,
                  clampProgress(player.progress),
                ]),
              ),
            },
          ]);
          break;
        }
        case "ROUND_RESULT": {
          setScores(message.scores);
          setAuthoritativeHash(message.stateHash);
          setRound(message.round);
          setRoundFinishedAt(Date.now());
          setResult(
            resultCopy(
              message.winnerGuestId,
              playerIdRef.current,
              message.reason,
              false,
            ),
          );
          setPhase("ROUND_RESULT");
          break;
        }
        case "MATCH_RESULT": {
          setScores(message.scores);
          setAuthoritativeHash(message.stateHash);
          setRoundFinishedAt((current) => current ?? Date.now());
          setReplayId(message.replayId);
          setResult(
            resultCopy(
              message.winnerGuestId,
              playerIdRef.current,
              message.reason,
              true,
            ),
          );
          setPhase("MATCH_RESULT");
          track("duel_completed", {
            outcome:
              message.outcome === "NO_CONTEST"
                ? "DRAW"
                : message.winnerGuestId === playerIdRef.current
                  ? "WIN"
                  : "LOSS",
            rounds: roundRef.current,
          });
          void flushTelemetry();
          break;
        }
        case "REMATCH_STARTED": {
          setMatchId(message.matchId);
          gameRef.current = null;
          setGameRevision((value) => value + 1);
          setRound(1);
          setScores({});
          setResult(null);
          setReplayId("");
          setAuthoritativeHash("");
          setMatchActionVisual(undefined);
          setConnectionLost(false);
          setProgressHistory([]);
          pendingActionsRef.current.clear();
          processedProgressSeqRef.current = 0;
          snapshotRequiredRef.current = false;
          setRoundFinishedAt(null);
          setPhase("LOBBY");
          setNotice({ id: "duel.notice.newMatch" });
          break;
        }
        case "SNAPSHOT": {
          const snapshot = message.snapshot;
          snapshotRequiredRef.current = false;
          pendingActionsRef.current.clear();
          setRoomId(snapshot.roomId);
          setRoomCode(snapshot.roomCode);
          setMatchId(snapshot.matchId);
          setRound(snapshot.round);
          setScores(snapshot.scores);
          updatePlayers(snapshot.players, snapshot.scores);
          if (snapshot.matchResult) {
            setReplayId(snapshot.matchId);
            setRoundFinishedAt((current) => current ?? Date.now());
            setResult(
              resultCopy(
                snapshot.matchResult.winnerGuestId,
                playerIdRef.current,
                snapshot.matchResult.reason,
                true,
              ),
            );
          }
          if (
            snapshot.board &&
            "seed" in snapshot.board &&
            snapshot.ownGame
          ) {
            try {
              const restored = createGameState(createBoard(snapshot.board));
              if (
                snapshot.ownGame.visibility.length !== restored.visibility.length
              ) {
                failIntegrity({ id: "duel.integrity.snapshotSize" });
                return;
              }
              restored.visibility.set(snapshot.ownGame.visibility);
              restored.revealedSafeCount = restored.visibility.reduce(
                (count, visibility, index) =>
                  count +
                  (visibility === 1 && restored.board.mines[index] !== 1 ? 1 : 0),
                0,
              );
              restored.outcome = snapshot.ownGame.outcome;
              if (hashGameState(restored) !== snapshot.ownGame.stateHash) {
                failIntegrity({ id: "duel.integrity.snapshotHash" });
                return;
              }
              gameRef.current = restored;
              setAuthoritativeHash(snapshot.ownGame.stateHash);
              setGameRevision((value) => value + 1);
            } catch {
              failIntegrity({ id: "duel.integrity.snapshotRestore" });
              return;
            }
          } else {
            setAuthoritativeHash(snapshot.stateHash);
          }
          if (snapshot.deadline !== undefined && snapshot.phase === "COUNTDOWN") {
            setCountdownDeadline(
              snapshot.deadline - realtimeRef.current.serverOffsetMs,
            );
          }
          if (snapshot.phase === "REMATCH") {
            setNotice({ id: "duel.notice.rematchWaiting" });
          } else if (snapshot.phase !== "CLOSED") {
            setPhase(snapshot.phase);
          }
          break;
        }
        case "ERROR": {
          if (message.code === "UPGRADE_REQUIRED") {
            protocolBlockedRef.current = true;
            snapshotRequiredRef.current = true;
            pendingActionsRef.current.clear();
            setError({ id: "duel.error.protocol" });
            setNotice({ id: "duel.notice.upgrade" });
            break;
          }
          setError({ id: "duel.entry.generic" });
          break;
        }
        case "PONG": {
          break;
        }
      }
    },
    [failIntegrity, flushTelemetry, t, track, updatePlayers],
  );

  const enterRoom = async (mode: "create" | "join") => {
    if (!DUEL_EXPERIMENT_ENABLED) {
      setError({ id: "duel.error.closed" });
      return;
    }
    const name = displayName.trim();
    if (name.length < 2) {
      setError({ id: "duel.error.nickname" });
      return;
    }
    if (mode === "join" && joinCode.length !== 6) {
      setError({ id: "duel.error.roomCode" });
      return;
    }

    setBusy(true);
    const entryStartedAt = performance.now();
    setError(null);
    setNotice(null);
    safeLocalStorageSet("hms-display-name", name);
    try {
      const guest = await createGuestSession(name);
      const room = mode === "create"
        ? await createRoom(guest.guestToken)
        : await joinRoom(joinCode, guest.guestToken);
      setRoomId(room.roomId);
      setRoomCode(room.roomCode);
      connectedOnceRef.current = false;
      processedServerSeqRef.current = 0;
      processedProgressSeqRef.current = 0;
      snapshotRequiredRef.current = false;
      protocolBlockedRef.current = false;
      setLastServerSeq(0);
      await realtimeRef.current.connect(
        room.ticket,
        handleMessage,
        handleConnectionStatus,
      );
      if (mode === "create") {
        track("duel_invite_created", {
          source: "home",
          stageDurationMs: performance.now() - entryStartedAt,
        });
      } else {
        track("duel_joined", {
          stageDurationMs: performance.now() - entryStartedAt,
        });
      }
      void flushTelemetry();
    } catch (cause) {
      setError(duelEntryError(cause));
      setConnection("error");
    } finally {
      setBusy(false);
    }
  };

  const handleBoardAction = (action: BoardAction, cellIndex: number) => {
    const activeGame = gameRef.current;
    if (
      !activeGame ||
      phase !== "ACTIVE" ||
      connection !== "connected" ||
      snapshotRequiredRef.current
    ) {
      return;
    }
    const started = performance.now();
    const preAction = captureOptimisticGameState(activeGame);
    const baseStateHash = hashGameState(activeGame);
    const delta =
      action === "REVEAL"
        ? revealCell(activeGame, cellIndex)
        : action === "TOGGLE_FLAG"
          ? toggleFlag(activeGame, cellIndex)
          : chordCell(activeGame, cellIndex);
    matchVisualSequenceRef.current += 1;
    setMatchActionVisual({
      id: matchVisualSequenceRef.current,
      actionType: action,
      originIndex: cellIndex,
      changedIndexes: [
        ...delta.revealed.map((cell) => cell.index),
        ...(delta.flagged === undefined ? [] : [delta.flagged.index]),
      ],
      accepted: delta.accepted,
      revealedSafeCount: delta.revealed.reduce(
        (count, cell) => count + (cell.value >= 0 ? 1 : 0),
        0,
      ),
    });
    setGameRevision((value) => value + 1);
    const sent = sendAction(action, cellIndex, baseStateHash, {
      preAction,
      optimisticStateHash: hashGameState(activeGame),
    });
    if (!sent) {
      rollbackOptimisticGameState(activeGame, preAction);
      setMatchActionVisual(undefined);
      setGameRevision((value) => value + 1);
      markTechnicalDisconnect();
    }
    recordMetric("actionApplyMs", performance.now() - started);
  };

  const leaveRoom = () => {
    realtimeRef.current.disconnect();
    gameRef.current = null;
    setPhase("HOME");
    setConnection("disconnected");
    setPlayers([]);
    setRoomId("");
    setRoomCode("");
    setMatchId("");
    setResult(null);
    setConnectionLost(false);
    connectedOnceRef.current = false;
    processedServerSeqRef.current = 0;
    processedProgressSeqRef.current = 0;
    snapshotRequiredRef.current = false;
    protocolBlockedRef.current = false;
    setLastServerSeq(0);
    setAuthoritativeHash("");
    setMatchActionVisual(undefined);
    pendingActionsRef.current.clear();
    setError(null);
    setNotice(null);
  };
  leaveRoomRef.current = leaveRoom;

  const pushLocalMode = (
    nextMode: Exclude<LocalMode, null>,
    soloMode: SoloGenerationMode = "classic",
    sessionKind: SoloSessionKind = "STANDARD",
  ) => {
    const hash =
      sessionKind === "GUIDED_PRACTICE"
          ? "#/solo/practice"
          : soloMode === "no_guess"
          ? "#/solo/no-guess"
          : "#/solo";
    window.history.pushState(
      { hmsLocalMode: nextMode, soloGenerationMode: soloMode, soloSessionKind: sessionKind },
      "",
      hash,
    );
    setSoloLaunchMode(soloMode);
    setSoloSessionKind(sessionKind);
    setLocalMode(nextMode);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const enterSolo = (
    soloMode: SoloGenerationMode = "classic",
    sessionKind: SoloSessionKind = "STANDARD",
    launchConfig?: SoloBoardConfig,
    skipSetup = false,
  ) => {
    leaveRoom();
    setSoloLaunchConfig(launchConfig);
    setSoloLaunchSetupComplete(skipSetup);
    track("mode_selected", {
      mode: sessionKind === "GUIDED_PRACTICE" ? "guided_practice" : "solo",
      source: "home",
    });
    pushLocalMode("solo", soloMode, sessionKind);
  };

  const exitLocalMode = () => {
    if (window.history.state?.hmsLocalMode) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setLocalMode(null);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const chooseHomeMode = (nextMode: HomeMode) => {
    if (nextMode === homeMode) return;
    setHomeMode(nextMode);
    track("mode_selected", {
      mode: nextMode,
      source: "home",
    });
    setError(null);
    setNotice(null);
  };

  const playerLabels = useMemo(
    () => Object.fromEntries(players.map((player) => [player.playerId, player.displayName])),
    [players],
  );

  const countdown = countdownDeadline === null
    ? null
    : Math.max(0, Math.ceil((countdownDeadline - now) / 1_000));
  const elapsed =
    roundStartedAt === null ? 0 : (roundFinishedAt ?? now) - roundStartedAt;
  const ownProgress = localPlayer?.progress ?? (game ? getProgress(game) * 100 : 0);
  const opponentProgress = opponent?.progress ?? 0;
  const lead = ownProgress === opponentProgress
    ? "EVEN"
    : ownProgress > opponentProgress
      ? "LEADING"
      : "TRAILING";

  return (
    <div
      className={`app-shell effects-${effectsProfile}${reducedMotion ? " reduced-motion" : ""}`}
    >
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          const target = document.getElementById("main-content");
          if (!target) return;
          event.preventDefault();
          target.focus();
          event.currentTarget.blur();
        }}
      >
        {t("nav.skip")}
      </a>
      <header className="topbar">
        <button
          className="brand-button"
          type="button"
          onClick={
            localMode
              ? exitLocalMode
              : phase === "HOME"
                ? undefined
                : leaveRoom
          }
        >
          <span className="brand-mark">H</span>
          <span>
            <strong>{t("brand.minesweeper")}</strong>
            <small>{t("brand.subtitle")}</small>
          </span>
        </button>
        <div className="topbar-status" aria-live="polite">
          <span
            className={`status-dot status-${localMode ? "connected" : connection}`}
          />
          {localMode
            ? localMode === "solo"
              ? t("status.localSolo")
              : localMode === "replay"
                ? t("status.localReplay")
              : t("status.practiceReplay")
            : connection === "connected"
              ? t("status.online")
              : t("status.standby")}
          <span className="divider" />
          {localMode || !DUEL_EXPERIMENT_ENABLED ? t("status.noNetwork") : formatRtt(rttMs)}
          <LocaleToggle className="text-toggle language-toggle" />
          <button
            className="text-toggle"
            type="button"
            aria-label={t("motion.aria")}
            onClick={() => {
              const next = nextMotionPreference(motionPreference);
              setMotionPreference(next);
              safeLocalStorageSet(MOTION_PREFERENCE_KEY, next);
            }}
          >
            {t("motion.label")}
            {motionPreference === "system"
              ? t("motion.system")
              : motionPreference === "full"
                ? t("motion.full")
                : t("motion.reduced")}
          </button>
          <button
            className="text-toggle effects-toggle"
            type="button"
            aria-label={t("effects.aria")}
            disabled={reducedMotion}
            onClick={() => {
              const next = nextEffectsProfile(effectsPreference);
              setEffectsPreference(next);
              setSessionEffects(next);
              safeLocalStorageSet(EFFECTS_PROFILE_KEY, next);
            }}
          >
            {t("effects.label")}
            {effectsProfile === "full"
              ? t("effects.full")
              : effectsProfile === "lite"
                ? t("effects.lite")
                : t("effects.essential")}
          </button>
        </div>
      </header>

      {persistenceWarning && (
        <div className="locale-warning" role="status">
          {persistenceWarning}
        </div>
      )}

      <main id="main-content" tabIndex={-1}>
        <Suspense fallback={<div className="loading-panel" role="status">{t("common.loading")}</div>}>
        {localMode === "practice-replay" ? (
          <PracticeReplayReview recordId={readPracticeReplayRecordId()} onExit={exitLocalMode} />
        ) : localMode === "replay" ? (
          <ReplayReview recordId={readReplayRecordId()} onExit={exitLocalMode} />
        ) : localMode === "solo" ? (
          <SoloGame
            key={`solo-${soloSessionKind}-${soloLaunchMode}-${practiceLaunchContext?.sourceRecordId ?? "direct"}-${soloLaunchConfig?.width ?? "saved"}-${soloLaunchConfig?.height ?? "saved"}-${soloLaunchConfig?.mines ?? "saved"}`}
            effectsProfile={effectsProfile}
            initialGenerationMode={soloLaunchMode}
            initialSessionKind={soloSessionKind}
            {...(practiceLaunchContext
              ? {
                  initialBoardConfig: {
                    ...practiceLaunchContext.board,
                    mode: "no_guess" as const,
                  },
                  initialSetupComplete: true,
                  practiceLaunchContext,
                }
              : soloLaunchConfig ? {
                  initialBoardConfig: soloLaunchConfig,
                  initialSetupComplete: soloLaunchSetupComplete,
                } : {})}
            reducedMotion={reducedMotion}
            onExit={exitLocalMode}
          />
        ) : phase === "HOME" || !DUEL_EXPERIMENT_ENABLED ? (
          <section
            className={`home-grid home-mode-${homeMode}${DUEL_EXPERIMENT_ENABLED ? "" : " duel-experiment-disabled"}`}
          >
            <div
              className={`home-hero-visual mode-${homeMode}`}
              data-testid="home-hero-visual"
              aria-hidden="true"
            >
              <img
                className="duel-grid-layer"
                src="/hero-grid-glow-v1.png"
                alt=""
                draggable={false}
              />
              <img
                className="home-mode-board"
                src={
                  homeMode === "solo" ? "/hero-solo-verified-v1.svg" : "/hero-board-h-v2.svg"
                }
                alt=""
                draggable={false}
              />
            </div>
            <div
              className={`hero-copy hero-mode-copy mode-${homeMode}${reducedMotion ? " reduced-motion" : ""}`}
              key={homeMode}
              aria-live="polite"
              aria-atomic="true"
            >
              <p className="eyebrow">
                {t(homeMode === "solo" ? "home.solo.eyebrow" : "home.duel.eyebrow")}
              </p>
              <h1>
                {t(homeMode === "solo" ? "home.solo.title" : "home.duel.title")}
              </h1>
              <p className="hero-description">
                {t(homeMode === "solo" ? "home.solo.description" : "home.duel.description")}
              </p>
              <div className="protocol-list" aria-label={t("home.capabilities")}>
                {homeMode === "solo" ? (
                  <>
                    <span><b>01</b> {t("home.solo.feature1")}</span>
                    <span><b>02</b> {t("home.solo.feature2")}</span>
                    <span><b>03</b> {t("home.solo.feature3")}</span>
                  </>
                ) : (
                  <>
                    <span><b>01</b> {t("duel.home.expertBoard")}</span>
                    <span><b>02</b> {t("duel.home.bestOfThree")}</span>
                    <span><b>03</b> {t("duel.home.serverValidated")}</span>
                  </>
                )}
              </div>
            </div>

            <div className="entry-panel">
              <div className="panel-kicker">{t("home.enterGrid")}</div>
              <h2>{t("home.choose")}</h2>
              <div
                className={`home-mode-switch mode-${homeMode}`}
                role="group"
                aria-label={t("home.modeLabel")}
              >
                <button
                  className="home-mode-option"
                  type="button"
                  aria-pressed={homeMode === "solo"}
                  disabled={busy}
                  onClick={() => chooseHomeMode("solo")}
                >
                  <span>01</span>
                  <strong>{t("home.solo")}</strong>
                  <small>{t("home.local")}</small>
                </button>
                <button
                  className="home-mode-option"
                  type="button"
                  aria-pressed={homeMode === "duel"}
                  disabled={busy}
                  onClick={() => chooseHomeMode("duel")}
                >
                  <span>02</span>
                  <strong>{t("home.duel")}</strong>
                  <small>{t(DUEL_EXPERIMENT_ENABLED ? "duel.home.realtime" : "duel.home.paused")}</small>
                </button>
              </div>

              <div
                className={`home-mode-panel mode-${homeMode}${reducedMotion ? " reduced-motion" : ""}`}
                key={`panel-${homeMode}`}
              >
                {homeMode === "solo" ? (
                  <>
                    {savedSoloPreferences ? (
                      <>
                        <button
                          className="primary-button"
                          type="button"
                          onClick={() => {
                            enterSolo(
                              savedSoloPreferences.config.mode,
                              "STANDARD",
                              savedSoloPreferences.config,
                              true,
                            );
                          }}
                        >
                          {t("home.solo.continue")}
                        </button>
                        <button
                          className="secondary-button home-reconfigure"
                          type="button"
                          onClick={() => enterSolo()}
                        >
                          {t("home.solo.reconfigure")}
                        </button>
                      </>
                    ) : (
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => enterSolo()}
                      >
                        {t("home.solo.enter")}
                      </button>
                    )}
                    <p className="entry-mode-note">
                      {t("home.solo.note")}
                    </p>
                    <div className="entry-feature-list" aria-label={t("home.soloCapabilities")}>
                      <span>{t("home.solo.detail1")}</span>
                      <span>{t("home.solo.detail2")}</span>
                      <span>{t("home.solo.detail3")}</span>
                    </div>
                  </>
                ) : !DUEL_EXPERIMENT_ENABLED ? (
                  <>
                    <button className="primary-button" type="button" disabled>
                      {t("home.duel.paused")}
                    </button>
                    <p className="entry-mode-note">
                      {t("home.duel.pausedNote")}
                    </p>
                    <div className="entry-feature-list" aria-label={t("home.duelStatus")}>
                      <span>{t("home.duel.detail1")}</span>
                      <span>{t("home.duel.detail2")}</span>
                      <span>{t("home.duel.detail3")}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <label>
                      <span>{t("duel.playerCallsign")}</span>
                      <input
                        autoComplete="nickname"
                        maxLength={20}
                        placeholder={t("duel.nickname")}
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                      />
                    </label>
                    <button
                      className="secondary-button entry-duel-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void enterRoom("create")}
                    >
                      {t(busy ? "duel.connecting" : "duel.create")}
                    </button>
                    <div className="or-divider"><span>{t("duel.orJoin")}</span></div>
                    <div className="join-row">
                      <input
                        aria-label={t("duel.roomCodeAria")}
                        className="code-input"
                        inputMode="text"
                        placeholder={t("duel.roomCodePlaceholder")}
                        value={joinCode}
                        onChange={(event) => setJoinCode(normalizeRoomCode(event.target.value))}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void enterRoom("join");
                        }}
                      />
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busy || joinCode.length !== 6}
                        onClick={() => void enterRoom("join")}
                      >
                        {t("duel.join")}
                      </button>
                    </div>
                    <p className="privacy-note">
                      {t("duel.privacy")}
                    </p>
                  </>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="match-shell">
            <div className="match-meta">
              <div>
                <span className="meta-label">{t("duel.room")}</span>
                <button
                  className="room-code"
                  type="button"
                  title={t("duel.copyCode")}
                  onClick={() => {
                    void navigator.clipboard.writeText(roomCode);
                    setNotice({ id: "duel.codeCopied" });
                  }}
                >
                  {roomCode || "------"}
                </button>
              </div>
              <div>
                <span className="meta-label">{t("duel.format")}</span>
                <strong>{t("duel.formatRound", { round })}</strong>
              </div>
              <div>
                <span className="meta-label">{t("duel.clock")}</span>
                <strong className="race-clock">{formatDuration(elapsed)}</strong>
              </div>
              <div>
                <span className="meta-label">{t("duel.state")}</span>
                <strong className={`lead-state lead-${lead.toLowerCase()}`}>
                  {t(lead === "EVEN" ? "duel.state.even" : lead === "LEADING" ? "duel.state.leading" : "duel.state.trailing")}
                </strong>
              </div>
            </div>

            {phase === "LOBBY" ? (
              <div className="lobby-layout">
                <div className="lobby-main">
                  <p className="eyebrow">{t("duel.privateRoom", { room: roomCode })}</p>
                  <h1>{t("duel.lobbyTitle")}</h1>
                  <p>{t("duel.lobbyDescription")}</p>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(duelInviteUrl(roomCode))
                        .then(
                          () => setNotice({ id: "duel.inviteCopied" }),
                          () => setError({ id: "duel.inviteCopyFailed" }),
                        );
                    }}
                  >
                    {t("duel.copyInvite")}
                  </button>
                  <div className="seat-grid">
                    {[1, 2].map((seat) => {
                      const player = players.find((entry) => entry.seat === seat);
                      return (
                        <div className={`seat-card${player ? " occupied" : ""}`} key={seat}>
                          <span className="seat-number">0{seat}</span>
                          <div>
                            <strong>{player?.displayName ?? t("duel.seat.open")}</strong>
                            <small>
                              {player
                                ? player.ready
                                  ? t("duel.seat.ready")
                                  : t("duel.seat.connected")
                                : t("duel.seat.waiting")}
                            </small>
                          </div>
                          <i className={player?.ready ? "ready-light active" : "ready-light"} />
                        </div>
                      );
                    })}
                  </div>
                  <button
                    className="primary-button ready-button"
                    type="button"
                    disabled={!localPlayer || localPlayer.ready}
                    onClick={() => sendAction("READY")}
                  >
                    {t(localPlayer?.ready ? "duel.readyWaiting" : "duel.ready")}
                  </button>
                </div>
                <aside className="rules-card">
                  <span className="panel-kicker">{t("duel.matchProtocol")}</span>
                  <ol>
                    <li><b>{t("duel.ruleSame")}</b><span>{t("duel.ruleSameDetail")}</span></li>
                    <li><b>{t("duel.ruleMine")}</b><span>{t("duel.ruleMineDetail")}</span></li>
                    <li><b>{t("duel.ruleBestOfThree")}</b><span>{t("duel.ruleBestOfThreeDetail")}</span></li>
                  </ol>
                </aside>
              </div>
            ) : (
              <div className="game-layout">
                <div className="board-stage">
                  <div className="board-toolbar">
                    <span>{t("solo.control.reveal")}</span>
                    <span>{t("solo.control.flag")}</span>
                    <span>{t("solo.control.chord")}</span>
                    <span>{t("duel.localLatency", { value: inputLatency === null ? "—" : `${inputLatency.toFixed(1)}ms` })}</span>
                  </div>
                  <CanvasBoard
                    {...(matchActionVisual === undefined
                      ? {}
                      : { actionVisual: matchActionVisual })}
                    disabled={phase !== "ACTIVE" || connection !== "connected"}
                    effectsProfile={effectsProfile}
                    game={game}
                    reducedMotion={reducedMotion}
                    revision={gameRevision}
                    onAction={handleBoardAction}
                    onInputLatency={setInputLatency}
                  />
                  {phase === "COUNTDOWN" && (
                    <div className="countdown-overlay" aria-live="assertive">
                      <span>{t("duel.countdownRound", { round })}</span>
                      <strong>{countdown ?? 3}</strong>
                      <small>{t("duel.synchronizing")}</small>
                    </div>
                  )}
                  {(phase === "ROUND_RESULT" || phase === "MATCH_RESULT") && result && (
                    <div
                      className="result-overlay"
                      role="status"
                      aria-live="assertive"
                      aria-atomic="true"
                    >
                      <span className="panel-kicker">
                        {t(phase === "MATCH_RESULT" ? "duel.result.matchComplete" : "duel.result.roundComplete")}
                      </span>
                      <h2>{t(result.title.id, result.title.values)}</h2>
                      <p>{t(result.detail.id, result.detail.values)}</p>
                      <div className="result-actions">
                        {connectionLost ? (
                          <button className="primary-button" type="button" onClick={leaveRoom}>
                            {t("duel.backHome")}
                          </button>
                        ) : phase === "ROUND_RESULT" ? (
                          <button className="primary-button" type="button" onClick={() => sendAction("READY")}>
                            {t("duel.nextRound")}
                          </button>
                        ) : (
                          <button
                            className="primary-button"
                            type="button"
                            disabled={localPlayer?.rematch === true}
                            onClick={() => sendAction("REMATCH")}
                          >
                            {t(localPlayer?.rematch ? "duel.rematchWaiting" : "duel.rematch")}
                          </button>
                        )}
                        {replayId && (
                          <a className="secondary-button button-link" download href={replayUrl(replayId)}>
                            {t("duel.downloadReplay")}
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <aside className="race-panel">
                  <span className="panel-kicker">{t("duel.liveTelemetry")}</span>
                  {players.length === 0 && <p className="muted">{t("duel.waitingTelemetry")}</p>}
                  {players.map((player) => (
                    <div
                      className={`racer${player.playerId === playerId ? " is-local" : ""}`}
                      key={player.playerId}
                    >
                      <div className="racer-title">
                        <span>
                          <small>{t(player.playerId === playerId ? "duel.player.you" : "duel.player.rival")}</small>
                          <strong>{player.displayName}</strong>
                        </span>
                        <b>{player.score ?? scores[player.playerId] ?? 0}</b>
                      </div>
                      <div className="progress-track">
                        <i style={{ width: `${player.progress ?? 0}%` }} />
                      </div>
                      <div className="progress-caption">
                        <span>{t("duel.safeProgress", { percent: player.progress ?? 0 })}</span>
                        <span>{t(player.connected ? "duel.connection.online" : "duel.connection.dropped")}</span>
                      </div>
                    </div>
                  ))}
                  <ProgressChart
                    history={progressHistory}
                    labels={playerLabels}
                    playerIds={[
                      ...(playerId ? [playerId] : []),
                      ...players
                        .filter((player) => player.playerId !== playerId)
                        .map((player) => player.playerId),
                    ]}
                  />
                  <div className="integrity-note">
                    <span>{t("duel.authoritativeHash")}</span>
                    <code>{authoritativeHash.slice(0, 12) || "------------"}</code>
                  </div>
                </aside>
              </div>
            )}
          </section>
        )}
        </Suspense>
      </main>

      {(error || notice) && (
        <div className={`toast${error ? " toast-error" : ""}`} role={error ? "alert" : "status"}>
          <span>{error ? t(error.id, error.values) : notice ? t(notice.id, notice.values) : ""}</span>
          <button
            type="button"
            aria-label={t("duel.closeNotice")}
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
          >
            ×
          </button>
        </div>
      )}

    </div>
  );
}
