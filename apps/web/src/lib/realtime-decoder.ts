import {
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@h-minesweeper/game-core";

const reliableTypes = new Set([
  "WELCOME",
  "ROOM_STATE",
  "COUNTDOWN",
  "ROUND_ACTIVE",
  "ACTION_RESULT",
  "ROUND_RESULT",
  "MATCH_RESULT",
  "REMATCH_STARTED",
  "SNAPSHOT",
]);

const phases = new Set([
  "LOBBY",
  "COUNTDOWN",
  "ACTIVE",
  "ROUND_RESULT",
  "MATCH_RESULT",
  "REMATCH",
  "CLOSED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isScores(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (score) => isSequence(score),
    )
  );
}

function isPlayer(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.playerId) &&
    isString(value.guestId) &&
    typeof value.displayName === "string" &&
    isSequence(value.seat) &&
    typeof value.connected === "boolean" &&
    typeof value.ready === "boolean" &&
    typeof value.rematch === "boolean" &&
    isSequence(value.wins) &&
    isFiniteNumber(value.progress) &&
    isFiniteNumber(value.score) &&
    typeof value.spectator === "boolean" &&
    (value.input === "DESKTOP" || value.input === "TOUCH")
  );
}

function isPlayers(value: unknown): boolean {
  return Array.isArray(value) && value.every(isPlayer);
}

function isBoardSpec(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSequence(value.width) &&
    Number(value.width) > 0 &&
    isSequence(value.height) &&
    Number(value.height) > 0 &&
    isSequence(value.mines) &&
    isString(value.seedCommitment) &&
    isSequence(value.startIndex) &&
    isSequence(value.safeRadius) &&
    (value.seed === undefined || isString(value.seed))
  );
}

function isDelta(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.accepted === "boolean" &&
    Array.isArray(value.revealed) &&
    value.revealed.every(
      (cell) =>
        isRecord(cell) &&
        isSequence(cell.index) &&
        Number.isInteger(cell.value) &&
        Number(cell.value) >= -1 &&
        Number(cell.value) <= 8,
    ) &&
    isFiniteNumber(value.progress) &&
    isString(value.stateHash) &&
    (value.flagged === undefined ||
      (isRecord(value.flagged) &&
        isSequence(value.flagged.index) &&
        typeof value.flagged.flagged === "boolean")) &&
    (value.hitMine === undefined || typeof value.hitMine === "boolean") &&
    (value.completed === undefined || typeof value.completed === "boolean") &&
    (value.rejectReason === undefined || typeof value.rejectReason === "string")
  );
}

function hasReliableHeader(value: Record<string, unknown>): boolean {
  return (
    value.v === PROTOCOL_VERSION &&
    isString(value.type) &&
    reliableTypes.has(value.type) &&
    isSequence(value.serverSeq)
  );
}

function isProgressEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.playerId) &&
    isFiniteNumber(value.progress) &&
    isFiniteNumber(value.progressPercent) &&
    typeof value.connected === "boolean" &&
    (value.outcome === "PLAYING" ||
      value.outcome === "WON" ||
      value.outcome === "LOST" ||
      value.outcome === "DNF")
  );
}

export function requiresProtocolUpgrade(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.type) &&
    typeof value.v === "number" &&
    value.v !== PROTOCOL_VERSION
  );
}

function isSnapshotMatchResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.outcome === "WIN" || value.outcome === "NO_CONTEST") &&
    (value.winnerGuestId === undefined || isString(value.winnerGuestId)) &&
    isString(value.reason) &&
    isScores(value.scores)
  );
}

export function decodeServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION || !isString(value.type)) {
    return null;
  }

  if (value.type === "PONG") {
    return isFiniteNumber(value.at) && isFiniteNumber(value.serverTime)
      ? value as unknown as ServerMessage
      : null;
  }
  if (value.type === "ERROR") {
    return (
      isString(value.code) &&
      typeof value.message === "string" &&
      typeof value.retryable === "boolean" &&
      (value.serverSeq === undefined || isSequence(value.serverSeq))
    )
      ? value as unknown as ServerMessage
      : null;
  }
  if (value.type === "PROGRESS") {
    return (
      isString(value.matchId) &&
      isSequence(value.round) &&
      isSequence(value.progressSeq) &&
      isFiniteNumber(value.generatedAt) &&
      Array.isArray(value.progress) &&
      value.progress.every(isProgressEntry) &&
      value.serverSeq === undefined
    )
      ? value as unknown as ServerMessage
      : null;
  }

  if (!hasReliableHeader(value)) return null;

  switch (value.type) {
    case "WELCOME":
      return (
        isString(value.sessionId) &&
        isString(value.playerId) &&
        isString(value.roomId) &&
        isString(value.roomCode) &&
        isString(value.matchId) &&
        isSequence(value.connectionEpoch) &&
        isFiniteNumber(value.serverTime)
      )
        ? value as unknown as ServerMessage
        : null;
    case "ROOM_STATE":
      return (
        isString(value.roomId) &&
        isString(value.roomCode) &&
        (value.matchId === undefined || isString(value.matchId)) &&
        isString(value.hostPlayerId) &&
        isPlayers(value.players) &&
        isString(value.phase) &&
        phases.has(value.phase) &&
        isScores(value.scores) &&
        isSequence(value.round) &&
        (value.deadline === undefined || isFiniteNumber(value.deadline)) &&
        isString(value.stateHash)
      )
        ? value as unknown as ServerMessage
        : null;
    case "COUNTDOWN":
      return (
        isString(value.matchId) &&
        (value.boardVisibility === "client_seed" ||
          value.boardVisibility === "server_secret") &&
        isBoardSpec(value.boardSpec) &&
        isFiniteNumber(value.deadline) &&
        isSequence(value.round)
      )
        ? value as unknown as ServerMessage
        : null;
    case "ROUND_ACTIVE":
      return (
        isString(value.matchId) &&
        isDelta(value.initialDelta) &&
        isString(value.stateHash) &&
        isFiniteNumber(value.startedAt) &&
        isFiniteNumber(value.deadline) &&
        isSequence(value.round)
      )
        ? value as unknown as ServerMessage
        : null;
    case "ACTION_RESULT":
      return (
        isString(value.matchId) &&
        isString(value.ackClientActionId) &&
        typeof value.accepted === "boolean" &&
        (value.rejectReason === undefined ||
          typeof value.rejectReason === "string") &&
        (value.delta === undefined || isDelta(value.delta)) &&
        typeof value.duplicate === "boolean" &&
        isString(value.authoritativeStateHash) &&
        (value.reconcile === "NONE" ||
          value.reconcile === "ROLLBACK" ||
          value.reconcile === "SNAPSHOT_REQUIRED")
      )
        ? value as unknown as ServerMessage
        : null;
    case "ROUND_RESULT":
      return (
        isString(value.matchId) &&
        isSequence(value.round) &&
        (value.winnerGuestId === undefined || isString(value.winnerGuestId)) &&
        isString(value.reason) &&
        isScores(value.scores) &&
        isString(value.stateHash)
      )
        ? value as unknown as ServerMessage
        : null;
    case "MATCH_RESULT":
      return (
        isString(value.matchId) &&
        isString(value.replayId) &&
        (value.outcome === "WIN" || value.outcome === "NO_CONTEST") &&
        (value.winnerGuestId === undefined || isString(value.winnerGuestId)) &&
        isString(value.reason) &&
        isScores(value.scores) &&
        isString(value.stateHash)
      )
        ? value as unknown as ServerMessage
        : null;
    case "REMATCH_STARTED":
      return isString(value.roomId) && isString(value.matchId)
        ? value as unknown as ServerMessage
        : null;
    case "SNAPSHOT": {
      const snapshot = value.snapshot;
      return (
        isRecord(snapshot) &&
        isString(snapshot.roomId) &&
        isString(snapshot.roomCode) &&
        isString(snapshot.matchId) &&
        isString(snapshot.phase) &&
        phases.has(snapshot.phase) &&
        isSequence(snapshot.round) &&
        (snapshot.deadline === undefined ||
          isFiniteNumber(snapshot.deadline)) &&
        isScores(snapshot.scores) &&
        isPlayers(snapshot.players) &&
        (snapshot.boardVisibility === "client_seed" ||
          snapshot.boardVisibility === "server_secret") &&
        (snapshot.board === undefined || isBoardSpec(snapshot.board)) &&
        isString(snapshot.stateHash) &&
        (snapshot.matchResult === undefined ||
          isSnapshotMatchResult(snapshot.matchResult)) &&
        (snapshot.ownGame === undefined ||
          (isRecord(snapshot.ownGame) &&
            Array.isArray(snapshot.ownGame.visibility) &&
            snapshot.ownGame.visibility.every(
              (entry) => entry === 0 || entry === 1 || entry === 2,
            ) &&
            Array.isArray(snapshot.ownGame.revealed) &&
            isFiniteNumber(snapshot.ownGame.progress) &&
            (snapshot.ownGame.outcome === "PLAYING" ||
              snapshot.ownGame.outcome === "WON" ||
              snapshot.ownGame.outcome === "LOST") &&
            isString(snapshot.ownGame.stateHash)))
      )
        ? value as unknown as ServerMessage
        : null;
    }
    default:
      return null;
  }
}
