import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  PROTOTYPE_EXPERT_SEEDS,
  chordCell,
  createBoard,
  createGameState,
  getProgress,
  hashGameState,
  revealCell,
  toggleFlag,
} from "@h-minesweeper/game-core";
import type {
  Board,
  BoardSpec,
  GameState,
  RevealDelta,
} from "@h-minesweeper/game-core";
import type { GuestSession } from "./types.js";
import type {
  ClientActionEnvelope,
  ReplayDocument,
  ReplayEvent,
  RoomPhase,
  WireSender,
} from "./types.js";

const PROTOCOL_VERSION = 1 as const;
const MAX_EVENT_RING = 256;
const MAX_ACTION_CACHE = 2_048;
const MAX_ACTIONS_PER_PLAYER_PER_MATCH = 50_000;
const MAX_REPLAYS_PER_ROOM = 16;
const MAX_PHASE_ZERO_ROUNDS_PER_ROOM = 15;
const REMATCH_WINDOW_MS = 60_000;

/** Offline-certified with the game-core `NG-Competitive-v1` solver. */
export const PHASE_ZERO_EXPERT_SEEDS = PROTOTYPE_EXPERT_SEEDS;

export interface RoomActorTimings {
  readonly countdownMs: number;
  readonly roundDurationMs: number;
  readonly terminalWindowMs: number;
  readonly progressIntervalMs: number;
}

export interface RoomActorOptions {
  readonly roomId: string;
  readonly roomCode: string;
  readonly host: GuestSession;
  readonly timings: RoomActorTimings;
  readonly now?: () => number;
  readonly boardSpecs?: readonly BoardSpec[];
}

interface CachedActionResult {
  readonly accepted: boolean;
  readonly rejectReason?: string;
  readonly delta?: RevealDelta;
  readonly stateHash: string;
}

interface PlayerRuntime {
  readonly guest: GuestSession;
  readonly joinedAt: number;
  connected: boolean;
  sender?: WireSender;
  connectionEpoch: number;
  ready: boolean;
  rematch: boolean;
  wins: number;
  game: GameState | undefined;
  terminal: "COMPLETE" | "MINE" | undefined;
  streamSeq: number;
  readonly eventRing: unknown[];
  readonly seenActionIds: Set<string>;
  readonly actionCache: Map<string, CachedActionResult>;
}

interface MatchResult {
  readonly outcome: "WIN" | "NO_CONTEST";
  readonly winnerGuestId?: string;
  readonly reason: string;
  readonly scores: Readonly<Record<string, number>>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultExpertSpecs(): BoardSpec[] {
  return PHASE_ZERO_EXPERT_SEEDS.map((seed) => ({
    width: 30,
    height: 16,
    mines: 99,
    seed,
    startIndex: 255,
    safeRadius: 1,
  }));
}

function clientBoardSpec(board: Board): Record<string, unknown> {
  return {
    width: board.spec.width,
    height: board.spec.height,
    mines: board.spec.mines,
    seed: board.spec.seed,
    startIndex: board.spec.startIndex,
    safeRadius: board.spec.safeRadius,
    seedCommitment: sha256(
      JSON.stringify({
        v: 1,
        seed: board.spec.seed,
        width: board.spec.width,
        height: board.spec.height,
        mines: board.spec.mines,
        startIndex: board.spec.startIndex,
        safeRadius: board.spec.safeRadius,
      }),
    ),
  };
}

export class RoomActor {
  readonly roomId: string;
  readonly roomCode: string;
  readonly #hostGuestId: string;

  #phase: RoomPhase = "LOBBY";
  #matchId = randomUUID();
  #round = 0;
  #totalRounds = 0;
  #boardCursor = 0;
  #board: Board | undefined;
  #deadline: number | undefined;
  #matchResult: MatchResult | undefined;
  #countdownTimer: NodeJS.Timeout | undefined;
  #roundTimer: NodeJS.Timeout | undefined;
  #terminalTimer: NodeJS.Timeout | undefined;
  #progressTimer: NodeJS.Timeout | undefined;
  #rematchTimer: NodeJS.Timeout | undefined;
  #lastProgressAt = Number.NEGATIVE_INFINITY;
  #lastActivityAt: number;
  #replaySeq = 0;
  readonly #players = new Map<string, PlayerRuntime>();
  readonly #replays = new Map<string, ReplayDocument>();
  readonly #boardSpecs: readonly BoardSpec[];
  readonly #timings: RoomActorTimings;
  readonly #now: () => number;

  constructor(options: RoomActorOptions) {
    this.roomId = options.roomId;
    this.roomCode = options.roomCode;
    this.#hostGuestId = options.host.guestId;
    this.#timings = options.timings;
    this.#now = options.now ?? Date.now;
    this.#lastActivityAt = this.#now();
    this.#boardSpecs =
      options.boardSpecs && options.boardSpecs.length > 0
        ? options.boardSpecs
        : defaultExpertSpecs();
    this.addPlayer(options.host);
    this.createReplay();
    this.record("ROOM_CREATED", options.host.guestId, {
      roomCode: this.roomCode,
    });
  }

  get phase(): RoomPhase {
    return this.#phase;
  }

  get matchId(): string {
    return this.#matchId;
  }

  get playerCount(): number {
    return this.#players.size;
  }

  hasPlayer(guestId: string): boolean {
    return this.#players.has(guestId);
  }

  isFull(): boolean {
    return this.#players.size >= 2;
  }

  getActivitySnapshot(): {
    readonly hasConnectedPlayers: boolean;
    readonly phase: RoomPhase;
    readonly lastActivityAt: number;
  } {
    return {
      hasConnectedPlayers: [...this.#players.values()].some(
        (player) => player.connected,
      ),
      phase: this.#phase,
      lastActivityAt: this.#lastActivityAt,
    };
  }

  addPlayer(guest: GuestSession): boolean {
    if (this.#players.has(guest.guestId) || this.isFull()) return false;
    this.#lastActivityAt = this.#now();
    this.#players.set(guest.guestId, {
      guest,
      joinedAt: this.#now(),
      connected: false,
      connectionEpoch: 0,
      ready: false,
      rematch: false,
      wins: 0,
      game: undefined,
      terminal: undefined,
      streamSeq: 0,
      eventRing: [],
      seenActionIds: new Set(),
      actionCache: new Map(),
    });
    if (this.#replays.has(this.#matchId)) {
      this.refreshReplayPlayers();
      this.record("PLAYER_JOINED", guest.guestId, {});
    }
    this.broadcastRoomState();
    return true;
  }

  connect(
    guestId: string,
    connectionEpoch: number,
    sender: WireSender,
  ): boolean {
    const player = this.#players.get(guestId);
    if (!player || connectionEpoch <= player.connectionEpoch) return false;

    player.sender = sender;
    player.connected = true;
    player.connectionEpoch = connectionEpoch;
    this.#lastActivityAt = this.#now();
    this.record("PLAYER_CONNECTED", guestId, { connectionEpoch });
    this.emitTo(player, "WELCOME", {
      sessionId: guestId,
      playerId: guestId,
      roomId: this.roomId,
      roomCode: this.roomCode,
      matchId: this.#matchId,
      connectionEpoch,
      serverTime: this.#now(),
    });
    this.sendSnapshot(player);
    this.broadcastRoomState();
    return true;
  }

  disconnect(guestId: string, connectionEpoch: number): void {
    const player = this.#players.get(guestId);
    if (
      !player ||
      !player.connected ||
      player.connectionEpoch !== connectionEpoch
    ) {
      return;
    }

    player.connected = false;
    delete player.sender;
    player.ready = false;
    this.#lastActivityAt = this.#now();
    this.record("PLAYER_DISCONNECTED", guestId, {
      connectionEpoch,
      phase: this.#phase,
    });

    if (
      this.#phase === "COUNTDOWN" ||
      this.#phase === "ACTIVE" ||
      this.#phase === "ROUND_RESULT"
    ) {
      const opponent = this.opponentOf(guestId);
      if (opponent?.connected) {
        this.finishMatch({
          outcome: "WIN",
          winnerGuestId: opponent.guest.guestId,
          reason: "TECHNICAL_DNF",
          scores: this.scoreRecord(),
        });
        return;
      }
    }

    this.broadcastRoomState();
  }

  handleAction(guestId: string, envelope: ClientActionEnvelope): void {
    const player = this.#players.get(guestId);
    if (!player?.connected) return;
    this.#lastActivityAt = this.#now();

    if (envelope.connectionEpoch !== player.connectionEpoch) {
      this.rejectAction(player, envelope.clientActionId, "STALE_CONNECTION");
      return;
    }
    if (envelope.matchId !== this.#matchId) {
      this.rejectAction(player, envelope.clientActionId, "MATCH_MISMATCH");
      return;
    }
    if (envelope.lastServerSeq > player.streamSeq) {
      this.rejectAction(player, envelope.clientActionId, "INVALID_SERVER_SEQ");
      return;
    }

    this.catchUp(player, envelope.lastServerSeq);

    const cached = player.actionCache.get(envelope.clientActionId);
    if (cached) {
      this.emitActionResult(player, envelope.clientActionId, cached, true);
      return;
    }
    if (player.seenActionIds.has(envelope.clientActionId)) {
      this.rejectAction(
        player,
        envelope.clientActionId,
        "DUPLICATE_ACTION",
      );
      return;
    }
    if (player.seenActionIds.size >= MAX_ACTIONS_PER_PLAYER_PER_MATCH) {
      this.rejectAction(player, envelope.clientActionId, "ACTION_LIMIT");
      return;
    }

    switch (envelope.actionType) {
      case "READY":
        this.handleReady(player, envelope.clientActionId);
        return;
      case "REMATCH":
        this.handleRematch(player, envelope.clientActionId);
        return;
      case "REVEAL":
      case "TOGGLE_FLAG":
      case "CHORD":
        this.handleBoardAction(player, envelope);
        return;
    }
  }

  getReplay(replayId: string): ReplayDocument | undefined {
    const replay = this.#replays.get(replayId);
    if (!replay || replay.status !== "COMPLETED") return undefined;
    return structuredClone(replay);
  }

  close(): void {
    this.clearTimers();
    this.#phase = "CLOSED";
    this.broadcastRoomState();
  }

  private handleReady(
    player: PlayerRuntime,
    clientActionId: string,
  ): void {
    if (this.#phase !== "LOBBY" && this.#phase !== "ROUND_RESULT") {
      this.rejectAndCache(player, clientActionId, "INVALID_PHASE");
      return;
    }
    if (this.#players.size !== 2) {
      this.rejectAndCache(player, clientActionId, "WAITING_FOR_OPPONENT");
      return;
    }

    player.ready = true;
    const result: CachedActionResult = {
      accepted: true,
      stateHash: this.hashRoomState(),
    };
    this.cacheAndEmit(player, clientActionId, result);
    this.record("READY", player.guest.guestId, {});
    this.broadcastRoomState();

    if ([...this.#players.values()].every((candidate) => candidate.ready)) {
      this.startCountdown();
    }
  }

  private handleRematch(
    player: PlayerRuntime,
    clientActionId: string,
  ): void {
    if (this.#phase !== "MATCH_RESULT" && this.#phase !== "REMATCH") {
      this.rejectAndCache(player, clientActionId, "INVALID_PHASE");
      return;
    }
    if (player.rematch) {
      this.rejectAndCache(player, clientActionId, "REMATCH_ALREADY_REQUESTED");
      return;
    }

    player.rematch = true;
    this.#phase = "REMATCH";
    const result: CachedActionResult = {
      accepted: true,
      stateHash: this.hashRoomState(),
    };
    this.cacheAndEmit(player, clientActionId, result);
    this.record("REMATCH_REQUESTED", player.guest.guestId, {});
    this.broadcastRoomState();

    if ([...this.#players.values()].every((candidate) => candidate.rematch)) {
      this.resetForRematch();
    } else if (!this.#rematchTimer) {
      this.#rematchTimer = setTimeout(
        () => this.expireRematch(),
        REMATCH_WINDOW_MS,
      );
      this.#rematchTimer.unref();
    }
  }

  private handleBoardAction(
    player: PlayerRuntime,
    envelope: ClientActionEnvelope,
  ): void {
    if (this.#phase !== "ACTIVE" || !player.game || player.terminal) {
      this.rejectAndCache(player, envelope.clientActionId, "INVALID_PHASE");
      return;
    }
    if (
      envelope.cellIndex === undefined ||
      !Number.isSafeInteger(envelope.cellIndex)
    ) {
      this.rejectAndCache(player, envelope.clientActionId, "CELL_REQUIRED");
      return;
    }
    if (this.#deadline !== undefined && this.#now() >= this.#deadline) {
      this.rejectAndCache(player, envelope.clientActionId, "ROUND_EXPIRED");
      this.settleTimeout();
      return;
    }

    const applyStartedAt = performance.now();
    let delta: RevealDelta;
    if (envelope.actionType === "REVEAL") {
      delta = revealCell(player.game, envelope.cellIndex);
    } else if (envelope.actionType === "TOGGLE_FLAG") {
      delta = toggleFlag(player.game, envelope.cellIndex);
    } else {
      delta = chordCell(player.game, envelope.cellIndex);
    }
    const serverApplyMs = performance.now() - applyStartedAt;

    const result: CachedActionResult = {
      accepted: delta.accepted,
      ...(delta.rejectReason === undefined
        ? {}
        : { rejectReason: delta.rejectReason }),
      delta,
      stateHash: delta.stateHash,
    };
    this.cacheAndEmit(player, envelope.clientActionId, result);
    this.record("ACTION", player.guest.guestId, {
      clientActionId: envelope.clientActionId,
      actionType: envelope.actionType,
      cellIndex: envelope.cellIndex,
      accepted: delta.accepted,
      rejectReason: delta.rejectReason,
      delta,
      clientMonoTelemetry: envelope.clientMonoTelemetry,
      serverApplyMs,
      serverStateHash: delta.stateHash,
    });

    if (!delta.accepted) return;
    this.scheduleProgress();
    if (delta.hitMine) {
      player.terminal = "MINE";
      this.scheduleTerminalSettlement();
    } else if (delta.completed) {
      player.terminal = "COMPLETE";
      this.scheduleTerminalSettlement();
    }
  }

  private startCountdown(): void {
    this.clearRoundTimers();
    if (this.#totalRounds >= MAX_PHASE_ZERO_ROUNDS_PER_ROOM) {
      this.finishMatch({
        outcome: "NO_CONTEST",
        reason: "PHASE_ZERO_ROUND_LIMIT",
        scores: this.scoreRecord(),
      });
      return;
    }
    this.#round += 1;
    this.#totalRounds += 1;
    const spec = this.#boardSpecs[this.#boardCursor % this.#boardSpecs.length];
    if (!spec) throw new Error("No board specification available");
    this.#boardCursor += 1;
    this.#board = createBoard(spec);
    this.#phase = "COUNTDOWN";
    this.#deadline = this.#now() + this.#timings.countdownMs;

    for (const player of this.#players.values()) {
      player.ready = false;
      player.terminal = undefined;
      player.game = createGameState(this.#board);
      this.emitTo(player, "COUNTDOWN", {
        matchId: this.#matchId,
        round: this.#round,
        deadline: this.#deadline,
        boardVisibility: "client_seed",
        boardSpec: clientBoardSpec(this.#board),
      });
    }
    this.record("COUNTDOWN", undefined, {
      round: this.#round,
      deadline: this.#deadline,
      boardVisibility: "client_seed",
      boardCommitment: clientBoardSpec(this.#board),
    });
    this.broadcastRoomState();
    this.#countdownTimer = setTimeout(
      () => this.activateRound(),
      this.#timings.countdownMs,
    );
  }

  private activateRound(): void {
    if (this.#phase !== "COUNTDOWN" || !this.#board) return;
    this.#phase = "ACTIVE";
    const startedAt = this.#now();
    this.#deadline = startedAt + this.#timings.roundDurationMs;
    this.#lastProgressAt = Number.NEGATIVE_INFINITY;

    for (const player of this.#players.values()) {
      if (!player.game) player.game = createGameState(this.#board);
      const initialDelta = revealCell(
        player.game,
        this.#board.spec.startIndex,
      );
      this.emitTo(player, "ROUND_ACTIVE", {
        matchId: this.#matchId,
        round: this.#round,
        startedAt,
        deadline: this.#deadline,
        initialDelta,
        stateHash: hashGameState(player.game),
      });
    }
    this.record("ROUND_ACTIVE", undefined, {
      round: this.#round,
      startedAt,
      deadline: this.#deadline,
      stateHash: this.hashRoomState(),
    });
    this.broadcastProgress();
    this.broadcastRoomState();
    this.#roundTimer = setTimeout(
      () => this.settleTimeout(),
      this.#timings.roundDurationMs,
    );
  }

  private scheduleTerminalSettlement(): void {
    if (this.#terminalTimer) return;
    this.#terminalTimer = setTimeout(
      () => this.settleTerminal(),
      this.#timings.terminalWindowMs,
    );
  }

  private settleTerminal(): void {
    if (this.#phase !== "ACTIVE") return;
    const players = [...this.#players.values()];
    const [first, second] = players;
    if (!first || !second) return;

    let winnerGuestId: string | undefined;
    let reason = "TERMINAL_DRAW";
    if (first.terminal === "COMPLETE" && second.terminal === "MINE") {
      winnerGuestId = first.guest.guestId;
      reason = "COMPLETION_BEATS_MINE";
    } else if (second.terminal === "COMPLETE" && first.terminal === "MINE") {
      winnerGuestId = second.guest.guestId;
      reason = "COMPLETION_BEATS_MINE";
    } else if (first.terminal && second.terminal) {
      reason =
        first.terminal === second.terminal
          ? `BOTH_${first.terminal}`
          : "TERMINAL_DRAW";
    } else {
      const terminalPlayer = first.terminal ? first : second.terminal ? second : undefined;
      if (!terminalPlayer) return;
      const opponent = terminalPlayer === first ? second : first;
      if (terminalPlayer.terminal === "COMPLETE") {
        winnerGuestId = terminalPlayer.guest.guestId;
        reason = "COMPLETED";
      } else {
        winnerGuestId = opponent.guest.guestId;
        reason = "OPPONENT_HIT_MINE";
      }
    }

    this.finishRound(winnerGuestId, reason);
  }

  private settleTimeout(): void {
    if (this.#phase !== "ACTIVE") return;
    if (this.#terminalTimer) {
      // A terminal action received before the deadline owns its full 50 ms
      // adjudication window. Actions received at/after the deadline are
      // rejected, so waiting cannot admit a late result.
      return;
    }
    const [first, second] = [...this.#players.values()];
    if (!first?.game || !second?.game) return;
    const firstProgress = getProgress(first.game);
    const secondProgress = getProgress(second.game);
    const winnerGuestId =
      firstProgress === secondProgress
        ? undefined
        : firstProgress > secondProgress
          ? first.guest.guestId
          : second.guest.guestId;
    this.finishRound(winnerGuestId, winnerGuestId ? "TIMEOUT_PROGRESS" : "TIMEOUT_DRAW");
  }

  private finishRound(
    winnerGuestId: string | undefined,
    reason: string,
  ): void {
    if (this.#phase !== "ACTIVE") return;
    this.clearRoundTimers();
    this.broadcastProgress();
    if (winnerGuestId) {
      const winner = this.#players.get(winnerGuestId);
      if (winner) winner.wins += 1;
    }

    const roundResult = {
      matchId: this.#matchId,
      round: this.#round,
      winnerGuestId,
      reason,
      scores: this.scoreRecord(),
      stateHash: this.hashRoomState(),
    };
    this.record("ROUND_RESULT", undefined, roundResult);
    this.broadcast("ROUND_RESULT", roundResult);

    const matchWinner = [...this.#players.values()].find(
      (player) => player.wins >= 2,
    );
    if (matchWinner) {
      this.finishMatch({
        outcome: "WIN",
        winnerGuestId: matchWinner.guest.guestId,
        reason: "FIRST_TO_TWO",
        scores: this.scoreRecord(),
      });
      return;
    }
    if (this.#round >= 5) {
      this.finishMatch({
        outcome: "NO_CONTEST",
        reason: "FIVE_ROUND_LIMIT",
        scores: this.scoreRecord(),
      });
      return;
    }

    this.#phase = "ROUND_RESULT";
    for (const player of this.#players.values()) {
      player.ready = false;
      player.terminal = undefined;
    }
    this.broadcastRoomState();
  }

  private finishMatch(result: MatchResult): void {
    if (
      this.#matchResult !== undefined ||
      this.#phase === "MATCH_RESULT" ||
      this.#phase === "CLOSED"
    ) {
      return;
    }
    this.clearRoundTimers();
    this.#phase = "MATCH_RESULT";
    this.#matchResult = result;
    this.record("MATCH_RESULT", undefined, result);
    const replay = this.#replays.get(this.#matchId);
    if (replay) {
      replay.status = "COMPLETED";
      replay.finishedAt = this.#now();
      replay.result = result;
    }
    this.broadcast("MATCH_RESULT", {
      matchId: this.#matchId,
      replayId: this.#matchId,
      ...result,
      stateHash: this.hashRoomState(),
    });
    this.broadcastRoomState();
  }

  private resetForRematch(): void {
    this.clearTimers();
    this.#matchId = randomUUID();
    this.#phase = "LOBBY";
    this.#round = 0;
    this.#board = undefined;
    this.#deadline = undefined;
    this.#matchResult = undefined;
    this.#replaySeq = 0;
    for (const player of this.#players.values()) {
      player.ready = false;
      player.rematch = false;
      player.wins = 0;
      player.game = undefined;
      player.terminal = undefined;
      player.seenActionIds.clear();
      player.actionCache.clear();
    }
    this.createReplay();
    this.record("REMATCH_STARTED", undefined, {});
    this.broadcast("REMATCH_STARTED", {
      roomId: this.roomId,
      matchId: this.#matchId,
    });
    this.broadcastRoomState();
  }

  private expireRematch(): void {
    this.#rematchTimer = undefined;
    if (this.#phase !== "REMATCH") return;
    this.#phase = "MATCH_RESULT";
    for (const player of this.#players.values()) {
      player.rematch = false;
    }
    this.broadcastRoomState();
  }

  private scheduleProgress(): void {
    const elapsed = this.#now() - this.#lastProgressAt;
    if (elapsed >= this.#timings.progressIntervalMs) {
      this.broadcastProgress();
      return;
    }
    if (this.#progressTimer) return;
    this.#progressTimer = setTimeout(() => {
      this.#progressTimer = undefined;
      this.broadcastProgress();
    }, Math.max(0, this.#timings.progressIntervalMs - elapsed));
  }

  private broadcastProgress(): void {
    if (this.#phase !== "ACTIVE" && this.#phase !== "ROUND_RESULT") return;
    this.#lastProgressAt = this.#now();
    const progress = [...this.#players.values()].map((player) => ({
      playerId: player.guest.guestId,
      progress: Math.round((player.game ? getProgress(player.game) : 0) * 100),
      progressPercent: Math.round(
        (player.game ? getProgress(player.game) : 0) * 100,
      ),
      connected: player.connected,
      outcome:
        player.terminal === "MINE"
          ? "LOST"
          : player.terminal === "COMPLETE"
            ? "WON"
            : "PLAYING",
    }));
    this.broadcast("PROGRESS", {
      matchId: this.#matchId,
      round: this.#round,
      progress,
    });
  }

  private catchUp(player: PlayerRuntime, lastServerSeq: number): void {
    if (lastServerSeq >= player.streamSeq) return;
    const first = player.eventRing[0] as
      | { readonly serverSeq?: number }
      | undefined;
    if (
      first?.serverSeq === undefined ||
      lastServerSeq < first.serverSeq - 1
    ) {
      this.sendSnapshot(player);
      return;
    }
    for (const rawMessage of player.eventRing) {
      const message = rawMessage as { readonly serverSeq?: number };
      if ((message.serverSeq ?? 0) > lastServerSeq) {
        player.sender?.send(rawMessage);
      }
    }
  }

  private sendSnapshot(player: PlayerRuntime): void {
    const game = player.game;
    const snapshot = {
      roomId: this.roomId,
      roomCode: this.roomCode,
      matchId: this.#matchId,
      phase: this.#phase,
      round: this.#round,
      deadline: this.#deadline,
      scores: this.scoreRecord(),
      players: this.playerSummaries(),
      boardVisibility: "client_seed",
      board: this.#board ? clientBoardSpec(this.#board) : undefined,
      ownGame:
        game === undefined
          ? undefined
          : {
              visibility: Array.from(game.visibility),
              revealed: Array.from(game.visibility, (visibility, index) =>
                visibility === 1
                  ? {
                      index,
                      value:
                        game.board.mines[index] === 1
                          ? -1
                          : game.board.adjacent[index] ?? 0,
                    }
                  : undefined,
              ).filter(Boolean),
              progress: getProgress(game),
              outcome: game.outcome,
              stateHash: hashGameState(game),
            },
      matchResult: this.#matchResult,
      stateHash: this.hashRoomState(),
    };
    this.emitTo(player, "SNAPSHOT", { snapshot });
  }

  private emitActionResult(
    player: PlayerRuntime,
    clientActionId: string,
    result: CachedActionResult,
    duplicate = false,
  ): void {
    this.emitTo(player, "ACTION_RESULT", {
      matchId: this.#matchId,
      ackClientActionId: clientActionId,
      accepted: result.accepted,
      ...(result.rejectReason === undefined
        ? {}
        : { rejectReason: result.rejectReason }),
      ...(result.delta === undefined ? {} : { delta: result.delta }),
      duplicate,
      stateHash: result.stateHash,
    });
  }

  private cacheAndEmit(
    player: PlayerRuntime,
    clientActionId: string,
    result: CachedActionResult,
  ): void {
    player.seenActionIds.add(clientActionId);
    player.actionCache.set(clientActionId, result);
    while (player.actionCache.size > MAX_ACTION_CACHE) {
      const oldest = player.actionCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      player.actionCache.delete(oldest);
    }
    this.emitActionResult(player, clientActionId, result);
  }

  private rejectAndCache(
    player: PlayerRuntime,
    clientActionId: string,
    rejectReason: string,
  ): void {
    this.cacheAndEmit(player, clientActionId, {
      accepted: false,
      rejectReason,
      stateHash: this.hashRoomState(),
    });
  }

  private rejectAction(
    player: PlayerRuntime,
    clientActionId: string,
    rejectReason: string,
  ): void {
    this.emitActionResult(player, clientActionId, {
      accepted: false,
      rejectReason,
      stateHash: this.hashRoomState(),
    });
  }

  private emitTo(
    player: PlayerRuntime,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    if (!player.sender && player.connectionEpoch === 0) return;
    player.streamSeq += 1;
    const message = {
      type,
      v: PROTOCOL_VERSION,
      serverSeq: player.streamSeq,
      ...payload,
    };
    player.eventRing.push(message);
    if (player.eventRing.length > MAX_EVENT_RING) player.eventRing.shift();
    player.sender?.send(message);
  }

  private broadcast(
    type: string,
    payload: Record<string, unknown>,
  ): void {
    for (const player of this.#players.values()) {
      this.emitTo(player, type, payload);
    }
  }

  private broadcastRoomState(): void {
    this.broadcast("ROOM_STATE", {
      roomId: this.roomId,
      roomCode: this.roomCode,
      matchId: this.#matchId,
      hostPlayerId: this.#hostGuestId,
      phase: this.#phase,
      round: this.#round,
      deadline: this.#deadline,
      players: this.playerSummaries(),
      scores: this.scoreRecord(),
      stateHash: this.hashRoomState(),
    });
  }

  private playerSummaries(): Array<Record<string, unknown>> {
    return [...this.#players.values()].map((player, index) => ({
      playerId: player.guest.guestId,
      guestId: player.guest.guestId,
      displayName: player.guest.displayName,
      seat: index + 1,
      connected: player.connected,
      ready: player.ready,
      rematch: player.rematch,
      wins: player.wins,
      progress: player.game ? Math.round(getProgress(player.game) * 100) : 0,
      score: player.wins,
      spectator: false,
      input: "DESKTOP",
    }));
  }

  private scoreRecord(): Readonly<Record<string, number>> {
    return Object.fromEntries(
      [...this.#players.values()].map((player) => [
        player.guest.guestId,
        player.wins,
      ]),
    );
  }

  private opponentOf(guestId: string): PlayerRuntime | undefined {
    return [...this.#players.values()].find(
      (player) => player.guest.guestId !== guestId,
    );
  }

  private hashRoomState(): string {
    return sha256(
      JSON.stringify({
        matchId: this.#matchId,
        phase: this.#phase,
        round: this.#round,
        deadline: this.#deadline,
        players: [...this.#players.values()]
          .map((player) => ({
            guestId: player.guest.guestId,
            connected: player.connected,
            ready: player.ready,
            rematch: player.rematch,
            wins: player.wins,
            terminal: player.terminal,
            gameHash: player.game ? hashGameState(player.game) : undefined,
          }))
          .sort((left, right) => left.guestId.localeCompare(right.guestId)),
      }),
    );
  }

  private createReplay(): void {
    if (this.#replays.size >= MAX_REPLAYS_PER_ROOM) {
      const oldestCompleted = [...this.#replays.entries()].find(
        ([, replay]) => replay.status === "COMPLETED",
      );
      if (oldestCompleted) this.#replays.delete(oldestCompleted[0]);
    }
    this.#replays.set(this.#matchId, {
      v: PROTOCOL_VERSION,
      replayId: this.#matchId,
      roomId: this.roomId,
      matchId: this.#matchId,
      roomCode: this.roomCode,
      createdAt: this.#now(),
      status: "ACTIVE",
      players: this.playerSummaries().map((player) => ({
        guestId: String(player.playerId),
        displayName: String(player.displayName),
      })),
      events: [],
    });
  }

  private refreshReplayPlayers(): void {
    const replay = this.#replays.get(this.#matchId);
    if (!replay || replay.status !== "ACTIVE") return;
    replay.players = [...this.#players.values()].map((player) => ({
      guestId: player.guest.guestId,
      displayName: player.guest.displayName,
    }));
  }

  private record(
    type: string,
    actorGuestId: string | undefined,
    payload: unknown,
  ): void {
    const replay = this.#replays.get(this.#matchId);
    if (!replay || replay.status !== "ACTIVE") return;
    this.#replaySeq += 1;
    const event: ReplayEvent = {
      seq: this.#replaySeq,
      at: this.#now(),
      type,
      ...(actorGuestId === undefined ? {} : { actorGuestId }),
      payload,
    };
    replay.events.push(event);
  }

  private clearRoundTimers(): void {
    if (this.#countdownTimer) clearTimeout(this.#countdownTimer);
    if (this.#roundTimer) clearTimeout(this.#roundTimer);
    if (this.#terminalTimer) clearTimeout(this.#terminalTimer);
    if (this.#progressTimer) clearTimeout(this.#progressTimer);
    this.#countdownTimer = undefined;
    this.#roundTimer = undefined;
    this.#terminalTimer = undefined;
    this.#progressTimer = undefined;
  }

  private clearTimers(): void {
    this.clearRoundTimers();
    if (this.#rematchTimer) clearTimeout(this.#rematchTimer);
    this.#rematchTimer = undefined;
  }
}
