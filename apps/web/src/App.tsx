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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Academy } from "./components/Academy";
import {
  CanvasBoard,
  type BoardAction,
  type BoardActionVisual,
} from "./components/CanvasBoard";
import {
  ProgressChart,
  type ProgressPoint,
} from "./components/ProgressChart";
import { SoloGame } from "./components/SoloGame";
import {
  ApiError,
  createGuestSession,
  createRoom,
  joinRoom,
  replayUrl,
} from "./lib/api";
import { formatDuration, formatRtt, normalizeRoomCode } from "./lib/format";
import { percentile, recordMetric } from "./lib/performance";
import type { SoloGenerationMode } from "./lib/solo";
import { useTelemetry } from "./components/TelemetryPrivacy";
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

type UiPhase =
  | "HOME"
  | "LOBBY"
  | "COUNTDOWN"
  | "ACTIVE"
  | "ROUND_RESULT"
  | "MATCH_RESULT";

type HomeMode = "solo" | "academy" | "duel";
type LocalMode = "solo" | "academy" | null;
type MotionPreference = "system" | "full" | "reduced";
type EffectsProfile = "full" | "lite" | "essential";

const MOTION_PREFERENCE_KEY = "hms-motion-preference";
const EFFECTS_PROFILE_KEY = "hms-effects-profile";
interface PendingOptimisticAction {
  readonly preAction: OptimisticGameSnapshot;
  readonly optimisticStateHash: string;
}

function readLocalModeFromLocation(): LocalMode {
  if (window.location.hash.startsWith("#/solo")) return "solo";
  if (window.location.hash === "#/academy") return "academy";
  return null;
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

function duelEntryError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "无法进入 1v1 房间；你可以返回单人训练，不会影响本地历史。";
  }
  if (error.code === "ROOM_FULL") {
    return "该房间已有两名玩家。请让房主创建新邀请，或返回单人训练。";
  }
  if (error.code === "ROOM_NOT_FOUND") {
    return "房间不存在、已过期或比赛已结束。请检查邀请链接，或让房主重新创建。";
  }
  if (error.code === "ALREADY_JOINED") {
    return "这个测试身份已经在该房间中；请回到原页面，或创建新房间。";
  }
  if (error.code === "RATE_LIMITED") {
    return "进入房间过于频繁，请稍后重试；单人训练仍可继续。";
  }
  return error.message || "无法进入 1v1 房间。";
}

function duelInviteUrl(roomCode: string): string {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("room", roomCode);
  return url.toString();
}

function readSoloLaunchModeFromLocation(): SoloGenerationMode {
  return window.location.hash === "#/solo/no-guess"
    ? "no_guess"
    : "classic";
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
  title: string;
  detail: string;
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
  const prefix = match ? "整场" : "本轮";
  if (!winnerId) {
    return {
      title: `${prefix}平局`,
      detail: match
        ? "本场不计结果"
        : reason === "NO_CONTEST"
          ? "本局不计结果"
          : "双方进入下一张棋盘",
      ...(reason === undefined ? {} : { reason }),
    };
  }
  const won = winnerId === localPlayerId;
  return {
    title: won ? `${prefix}胜利` : `${prefix}失利`,
    detail: won ? "节奏、判断、执行——你先完成了协议。" : "复盘领先变化，下一局立刻追回来。",
    winnerId,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function App() {
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
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    window.addEventListener("popstate", handleNavigation);
    return () => window.removeEventListener("popstate", handleNavigation);
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
      setNotice("已降低装饰效果以保持操作响应。");
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
      setNotice("检测到输入或动画帧预算回退，已降低装饰效果。");
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
    setNotice("");
    setConnectionLost(true);
    setRoundFinishedAt((current) => current ?? Date.now());
    setResult({
      title: "技术 DNF",
      detail: "实时连接已中断，本场操作已冻结。阶段 0 不提供重连。",
      reason: "TECHNICAL_DNF",
    });
    setPhase("MATCH_RESULT");
    track("duel_dnf", {
      reason: "DISCONNECTED",
      round: roundRef.current,
    });
    void flushTelemetry();
  }, [flushTelemetry, track]);

  const failIntegrity = useCallback((detail: string) => {
    pendingActionsRef.current.clear();
    phaseRef.current = "MATCH_RESULT";
    setConnectionLost(true);
    setRoundFinishedAt((current) => current ?? Date.now());
    setResult({
      title: "状态完整性失败",
      detail,
      reason: "STATE_DIVERGENCE",
    });
    setError("客户端与权威状态不一致，本场已安全冻结。");
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
        setError("实时连接已中断，请重新创建或加入房间。");
        setPhase("HOME");
        return;
      }
      markTechnicalDisconnect();
    },
    [markTechnicalDisconnect],
  );

  const sendAction = useCallback(
    (
      actionType: "READY" | BoardAction | "REMATCH",
      cellIndex?: number,
      baseStateHash = authoritativeHashRef.current,
      pendingAction?: PendingOptimisticAction,
    ) => {
      if (!baseStateHash) {
        setError("尚未取得可提交操作的权威状态基线。");
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
        setError("实时连接不可用，操作未发送。");
      }
      return sent;
    },
    [connectionEpoch, lastServerSeq, matchId, playerId, roomId],
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
          failIntegrity("检测到不可恢复的服务端序号缺口；阶段 0 按技术 DNF 处理。");
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
          setNotice("实时通道已建立");
          break;
        }
        case "ROOM_STATE": {
          updatePlayers(message.players, message.scores);
          setAuthoritativeHash(message.stateHash);
          if (message.matchId) setMatchId(message.matchId);
          if (message.phase === "REMATCH") {
            const votes = message.players.filter((player) => player.rematch).length;
            setNotice(`重赛确认 ${votes}/2`);
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
            setError("当前 Alpha 客户端不支持服务器保密棋盘。");
            return;
          }
          try {
            gameRef.current = createGameState(createBoard(message.boardSpec));
            setGameRevision((value) => value + 1);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "棋盘生成失败");
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
            setNotice(message.rejectReason ?? "操作未被服务器接受");
          }
          if (reconciliationPlan === "WAIT_FOR_SNAPSHOT") {
            snapshotRequiredRef.current = true;
            setNotice("操作需要权威快照对账，后续输入已暂时冻结。");
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
              failIntegrity("操作对账后本地棋盘与权威状态哈希不一致。");
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
          setNotice("新比赛已建立，等待双方准备");
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
                failIntegrity("权威快照尺寸与棋盘清单不一致。");
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
                failIntegrity("权威快照未通过本地确定性哈希校验。");
                return;
              }
              gameRef.current = restored;
              setAuthoritativeHash(snapshot.ownGame.stateHash);
              setGameRevision((value) => value + 1);
            } catch {
              failIntegrity("权威快照无法按当前规则版本恢复。");
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
            setNotice("等待对手确认重赛");
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
            setError("客户端版本与实时服务不兼容，请刷新或升级后重试。");
            setNotice("需要升级客户端");
            break;
          }
          setError(message.message);
          break;
        }
        case "PONG": {
          break;
        }
      }
    },
    [failIntegrity, flushTelemetry, track, updatePlayers],
  );

  const enterRoom = async (mode: "create" | "join") => {
    if (!DUEL_EXPERIMENT_ENABLED) {
      setError("1v1 实验当前关闭；专业单人训练仍可正常使用。");
      return;
    }
    const name = displayName.trim();
    if (name.length < 2) {
      setError("昵称至少需要 2 个字符");
      return;
    }
    if (mode === "join" && joinCode.length !== 6) {
      setError("请输入 6 位房间码");
      return;
    }

    setBusy(true);
    const entryStartedAt = performance.now();
    setError("");
    setNotice("");
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
    setError("");
    setNotice("");
  };
  leaveRoomRef.current = leaveRoom;

  const pushLocalMode = (
    nextMode: Exclude<LocalMode, null>,
    soloMode: SoloGenerationMode = "classic",
  ) => {
    const hash =
      nextMode === "academy"
        ? "#/academy"
        : soloMode === "no_guess"
          ? "#/solo/no-guess"
          : "#/solo";
    window.history.pushState(
      { hmsLocalMode: nextMode, soloGenerationMode: soloMode },
      "",
      hash,
    );
    setSoloLaunchMode(soloMode);
    setLocalMode(nextMode);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const enterSolo = (soloMode: SoloGenerationMode = "classic") => {
    leaveRoom();
    track("mode_selected", { mode: "solo", source: "home" });
    pushLocalMode("solo", soloMode);
  };

  const enterAcademy = () => {
    leaveRoom();
    track("mode_selected", { mode: "academy", source: "home" });
    pushLocalMode("academy");
  };

  const openSoloFromAcademy = (soloMode: SoloGenerationMode) => {
    leaveRoom();
    track("mode_selected", { mode: "solo", source: "navigation" });
    const hash =
      soloMode === "no_guess" ? "#/solo/no-guess" : "#/solo";
    window.history.replaceState(
      { hmsLocalMode: "solo", soloGenerationMode: soloMode },
      "",
      hash,
    );
    setSoloLaunchMode(soloMode);
    setLocalMode("solo");
    window.scrollTo({ top: 0, behavior: "auto" });
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
    setError("");
    setNotice("");
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
      <a className="skip-link" href="#main-content">
        跳到主要内容
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
            <strong>MINESWEEPER</strong>
            <small>PROFESSIONAL SOLO / ALPHA</small>
          </span>
        </button>
        <div className="topbar-status" aria-live="polite">
          <span
            className={`status-dot status-${localMode ? "connected" : connection}`}
          />
          {localMode
            ? localMode === "solo"
              ? "LOCAL SOLO"
              : "ACADEMY"
            : connection === "connected"
              ? "REALTIME ONLINE"
              : "LOCAL STANDBY"}
          <span className="divider" />
          {localMode ? "NO NETWORK" : formatRtt(rttMs)}
          <button
            className="text-toggle"
            type="button"
            aria-label="切换动态效果偏好"
            onClick={() => {
              const next = nextMotionPreference(motionPreference);
              setMotionPreference(next);
              safeLocalStorageSet(MOTION_PREFERENCE_KEY, next);
            }}
          >
            动效：
            {motionPreference === "system"
              ? "跟随系统"
              : motionPreference === "full"
                ? "完整"
                : "减少"}
          </button>
          <button
            className="text-toggle effects-toggle"
            type="button"
            aria-label="切换装饰效果档位"
            disabled={reducedMotion}
            onClick={() => {
              const next = nextEffectsProfile(effectsPreference);
              setEffectsPreference(next);
              setSessionEffects(next);
              safeLocalStorageSet(EFFECTS_PROFILE_KEY, next);
            }}
          >
            特效：
            {effectsProfile === "full"
              ? "完整"
              : effectsProfile === "lite"
                ? "轻量"
                : "核心"}
          </button>
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        {localMode === "solo" ? (
          <SoloGame
            key={`solo-${soloLaunchMode}`}
            effectsProfile={effectsProfile}
            initialGenerationMode={soloLaunchMode}
            reducedMotion={reducedMotion}
            onExit={exitLocalMode}
          />
        ) : localMode === "academy" ? (
          <Academy
            reducedMotion={reducedMotion}
            onExit={exitLocalMode}
            onOpenSolo={openSoloFromAcademy}
          />
        ) : phase === "HOME" || !DUEL_EXPERIMENT_ENABLED ? (
          <section
            className={`home-grid home-mode-${homeMode}${DUEL_EXPERIMENT_ENABLED ? "" : " duel-experiment-disabled"}`}
          >
            <div
              className={`duel-hero-visual${homeMode === "duel" ? " is-active" : ""}`}
              aria-hidden="true"
            >
              <img
                className="duel-grid-layer"
                src="/hero-grid-glow-v1.png"
                alt=""
                draggable={false}
              />
              <img
                className="duel-board-layer"
                src="/hero-board-h-v2.svg"
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
                {homeMode === "solo"
                  ? "BUILD A MEMORY. TRAIN THE GAP."
                  : homeMode === "academy"
                    ? "LEARN THE LOGIC. OWN THE BOARD."
                    : "SAME BOARD. SAME CLOCK. NO EXCUSES."}
              </p>
              <h1>
                {homeMode === "solo" ? (
                  <>每一局，<br />都成为下一局的依据。</>
                ) : homeMode === "academy" ? (
                  <>看懂每一步，<br />再把速度练成本能。</>
                ) : (
                  <>扫雷，终于<br />有了对手。</>
                )}
              </h1>
              <p className="hero-description">
                {homeMode === "solo" ? (
                  <>
                    用可信的本地历史看见速度、效率与无效动作的变化。
                    数据留在本机；完成、复盘、调整，再开下一局。
                  </>
                ) : homeMode === "academy" ? (
                  <>
                    从剩余雷数和共有区开始，不背脱离棋形的口诀。
                    每一步都能看到依据，再把正确判断练成直觉。
                  </>
                ) : (
                  <>
                    同一张确定性棋盘，两名玩家同时开局。没有随机攻击，
                    没有数值道具——只有判断、节奏和执行。
                  </>
                )}
              </p>
              <div className="protocol-list" aria-label="原型能力">
                {homeMode === "solo" ? (
                  <>
                    <span><b>01</b> 初 · 中 · 高 · 自定义</span>
                    <span><b>02</b> 同规格历史 / PB / 趋势</span>
                    <span><b>03</b> JSON 导出与本地控制</span>
                  </>
                ) : homeMode === "academy" ? (
                  <>
                    <span><b>01</b> 4 章逻辑课程</span>
                    <span><b>02</b> 分级提示 / 反例</span>
                    <span><b>03</b> 本地学习进度</span>
                  </>
                ) : (
                  <>
                    <span><b>01</b> Expert 30×16 / 99</span>
                    <span><b>02</b> Best of 3</span>
                    <span><b>03</b> Server validated</span>
                  </>
                )}
              </div>
            </div>

            <div className="entry-panel">
              <div className="panel-kicker">ENTER THE GRID</div>
              <h2>选择玩法</h2>
              <div
                className={`home-mode-switch mode-${homeMode}`}
                role="group"
                aria-label="游戏模式"
              >
                <button
                  className="home-mode-option"
                  type="button"
                  aria-pressed={homeMode === "solo"}
                  disabled={busy}
                  onClick={() => chooseHomeMode("solo")}
                >
                  <span>01</span>
                  <strong>单人游戏</strong>
                  <small>LOCAL</small>
                </button>
                <button
                  className="home-mode-option"
                  type="button"
                  aria-pressed={homeMode === "academy"}
                  disabled={busy}
                  onClick={() => chooseHomeMode("academy")}
                >
                  <span>02</span>
                  <strong>扫雷学院</strong>
                  <small>LEARN</small>
                </button>
                <button
                  className="home-mode-option"
                  type="button"
                  aria-pressed={homeMode === "duel"}
                  disabled={busy}
                  onClick={() => chooseHomeMode("duel")}
                >
                  <span>03</span>
                  <strong>1v1 对战</strong>
                  <small>{DUEL_EXPERIMENT_ENABLED ? "REALTIME" : "PAUSED"}</small>
                </button>
              </div>

              <div
                className={`home-mode-panel mode-${homeMode}${reducedMotion ? " reduced-motion" : ""}`}
                key={`panel-${homeMode}`}
              >
                {homeMode === "solo" ? (
                  <>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => enterSolo()}
                    >
                      单人游戏 · 立即开局
                    </button>
                    <p className="entry-mode-note">
                      完成终局后写入版本化本地历史；刷新或重启浏览器后仍可复盘。
                    </p>
                    <div className="entry-feature-list" aria-label="单人模式能力">
                      <span>首击 3×3 安全</span>
                      <span>经典随机 / 无猜</span>
                      <span>同规格可信趋势</span>
                    </div>
                  </>
                ) : homeMode === "academy" ? (
                  <>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={enterAcademy}
                    >
                      扫雷学院 · 开始第一课
                    </button>
                    <p className="entry-mode-note">
                      从数字和剩余雷数开始；提示只逐级展开，不会直接替你解题。
                    </p>
                    <div className="entry-feature-list" aria-label="扫雷学院能力">
                      <span>无需注册即可学习</span>
                      <span>Proof 驱动提示</span>
                      <span>进度保存在本机</span>
                    </div>
                  </>
                ) : !DUEL_EXPERIMENT_ENABLED ? (
                  <>
                    <button className="primary-button" type="button" disabled>
                      1v1 暂时维护中
                    </button>
                    <p className="entry-mode-note">
                      多人游戏仍是产品的一部分；当前环境已通过独立开关暂停实时服务。
                    </p>
                    <div className="entry-feature-list" aria-label="1v1 模式状态">
                      <span>入口保持可见</span>
                      <span>单人模式不受影响</span>
                      <span>服务恢复后即可建房</span>
                    </div>
                  </>
                ) : (
                  <>
                    <label>
                      <span>PLAYER CALLSIGN</span>
                      <input
                        autoComplete="nickname"
                        maxLength={20}
                        placeholder="输入昵称"
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
                      {busy ? "建立实时通道…" : "创建 1v1 房间"}
                    </button>
                    <div className="or-divider"><span>或者加入已有房间</span></div>
                    <div className="join-row">
                      <input
                        aria-label="六位房间码"
                        className="code-input"
                        inputMode="text"
                        placeholder="ROOM CODE"
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
                        加入
                      </button>
                    </div>
                    <p className="privacy-note">
                      实验功能可独立关闭；任何 1v1 故障都不阻塞专业单人 Alpha。
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
                <span className="meta-label">ROOM</span>
                <button
                  className="room-code"
                  type="button"
                  title="复制房间码"
                  onClick={() => {
                    void navigator.clipboard.writeText(roomCode);
                    setNotice("房间码已复制");
                  }}
                >
                  {roomCode || "------"}
                </button>
              </div>
              <div>
                <span className="meta-label">FORMAT</span>
                <strong>BO3 · ROUND {round}</strong>
              </div>
              <div>
                <span className="meta-label">CLOCK</span>
                <strong className="race-clock">{formatDuration(elapsed)}</strong>
              </div>
              <div>
                <span className="meta-label">STATE</span>
                <strong className={`lead-state lead-${lead.toLowerCase()}`}>{lead}</strong>
              </div>
            </div>

            {phase === "LOBBY" ? (
              <div className="lobby-layout">
                <div className="lobby-main">
                  <p className="eyebrow">PRIVATE DUEL / {roomCode}</p>
                  <h1>等待两名玩家锁定席位</h1>
                  <p>分享房间码。双方准备后，服务器统一启动三秒倒计时。</p>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(duelInviteUrl(roomCode))
                        .then(
                          () => setNotice("邀请链接已复制；打开后会自动预填房间码。"),
                          () => setError("邀请链接复制失败，请手动分享房间码。"),
                        );
                    }}
                  >
                    复制邀请链接
                  </button>
                  <div className="seat-grid">
                    {[1, 2].map((seat) => {
                      const player = players.find((entry) => entry.seat === seat);
                      return (
                        <div className={`seat-card${player ? " occupied" : ""}`} key={seat}>
                          <span className="seat-number">0{seat}</span>
                          <div>
                            <strong>{player?.displayName ?? "OPEN SEAT"}</strong>
                            <small>
                              {player
                                ? player.ready
                                  ? "READY / LOCKED"
                                  : "CONNECTED / NOT READY"
                                : "WAITING FOR PLAYER"}
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
                    {localPlayer?.ready ? "已锁定 · 等待对手" : "准备比赛"}
                  </button>
                </div>
                <aside className="rules-card">
                  <span className="panel-kicker">MATCH PROTOCOL</span>
                  <ol>
                    <li><b>同一棋盘</b><span>相同 seed 与安全起点</span></li>
                    <li><b>触雷判负</b><span>本轮立即进入裁定窗口</span></li>
                    <li><b>先胜两轮</b><span>平局不计胜局</span></li>
                  </ol>
                </aside>
              </div>
            ) : (
              <div className="game-layout">
                <div className="board-stage">
                  <div className="board-toolbar">
                    <span>左键 REVEAL</span>
                    <span>右键 FLAG</span>
                    <span>中键 / 左右键 CHORD</span>
                    <span>LOCAL {inputLatency === null ? "—" : `${inputLatency.toFixed(1)}ms`}</span>
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
                      <span>ROUND {round}</span>
                      <strong>{countdown ?? 3}</strong>
                      <small>SYNCHRONIZING BOTH CLIENTS</small>
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
                        {phase === "MATCH_RESULT" ? "MATCH COMPLETE" : "ROUND COMPLETE"}
                      </span>
                      <h2>{result.title}</h2>
                      <p>{result.detail}</p>
                      <div className="result-actions">
                        {connectionLost ? (
                          <button className="primary-button" type="button" onClick={leaveRoom}>
                            返回首页
                          </button>
                        ) : phase === "ROUND_RESULT" ? (
                          <button className="primary-button" type="button" onClick={() => sendAction("READY")}>
                            准备下一轮
                          </button>
                        ) : (
                          <button
                            className="primary-button"
                            type="button"
                            disabled={localPlayer?.rematch === true}
                            onClick={() => sendAction("REMATCH")}
                          >
                            {localPlayer?.rematch ? "已确认 · 等待对手" : "立即重赛"}
                          </button>
                        )}
                        {replayId && (
                          <a className="secondary-button button-link" download href={replayUrl(replayId)}>
                            下载回放 JSON
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <aside className="race-panel">
                  <span className="panel-kicker">LIVE RACE TELEMETRY</span>
                  {players.length === 0 && <p className="muted">等待比赛遥测…</p>}
                  {players.map((player) => (
                    <div
                      className={`racer${player.playerId === playerId ? " is-local" : ""}`}
                      key={player.playerId}
                    >
                      <div className="racer-title">
                        <span>
                          <small>{player.playerId === playerId ? "YOU" : "RIVAL"}</small>
                          <strong>{player.displayName}</strong>
                        </span>
                        <b>{player.score ?? scores[player.playerId] ?? 0}</b>
                      </div>
                      <div className="progress-track">
                        <i style={{ width: `${player.progress ?? 0}%` }} />
                      </div>
                      <div className="progress-caption">
                        <span>{player.progress ?? 0}% SAFE CELLS</span>
                        <span>{player.connected ? "ONLINE" : "DROPPED"}</span>
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
                    <span>AUTHORITATIVE HASH</span>
                    <code>{authoritativeHash.slice(0, 12) || "------------"}</code>
                  </div>
                </aside>
              </div>
            )}
          </section>
        )}
      </main>

      {(error || notice) && (
        <div className={`toast${error ? " toast-error" : ""}`} role={error ? "alert" : "status"}>
          <span>{error || notice}</span>
          <button
            type="button"
            aria-label="关闭通知"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            ×
          </button>
        </div>
      )}

      <footer>
        <span>PHASE 0.5 / EXPERIENCE &amp; LEARNING BUILD</span>
        <span>NO ITEMS · NO RANDOM ATTACKS · NO PAY TO WIN</span>
      </footer>
    </div>
  );
}
