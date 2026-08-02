import {
  CELL_FLAGGED,
  CELL_REVEALED,
  analyzeVisibleBoard,
  chordCell,
  createBoard,
  createGameState,
  revealCell,
  toggleFlag,
  type GameState,
  type VisibleBoardAnalysis,
  type VisibleBoardState,
} from "@h-minesweeper/game-core";
import {
  verifyPracticeReplay,
  type PracticeReplayEventV1,
  type PracticeReplayV1,
  type PracticeRunRecordV1,
} from "../lib/practice-history";

export interface PracticeReplayWorkerRequest {
  readonly requestId: number;
  readonly record: PracticeRunRecordV1;
  readonly replay: PracticeReplayV1;
}

export type PracticeReplayWorkerResponse =
  | {
      readonly requestId: number;
      readonly ok: true;
      readonly steps: readonly {
        readonly seq: number;
        readonly eventType: PracticeReplayEventV1["eventType"];
        readonly before: VisibleBoardAnalysis;
        readonly revealed: readonly { readonly index: number; readonly value: number }[];
        readonly flagChange?: { readonly index: number; readonly flagged: boolean };
        readonly accepted?: boolean;
        readonly hitMine: boolean;
        readonly outcome: GameState["outcome"];
      }[];
      readonly terminal: {
        readonly cells: readonly number[];
        readonly detonatedMine?: number;
        readonly otherMines: readonly number[];
        readonly correctFlags: readonly number[];
        readonly wrongFlags: readonly number[];
      };
    }
  | {
      readonly requestId: number;
      readonly ok: false;
      readonly errorCode: "PRACTICE_REPLAY_INTEGRITY_FAILED" | "PRACTICE_REPLAY_BUILD_FAILED";
    };

function visibleState(
  state: GameState,
  provenMines: ReadonlySet<number> = new Set(),
): VisibleBoardState {
  const playerClaims = Array.from(state.visibility, (visibility, index) =>
    visibility === CELL_FLAGGED ? index : -1,
  ).filter((index) => index >= 0);
  const activeProvenMines = [...provenMines]
    .filter((index) => playerClaims.includes(index))
    .sort((left, right) => left - right);
  return {
    width: state.board.spec.width,
    height: state.board.spec.height,
    totalMines: state.board.spec.mines,
    clues: Array.from(state.visibility, (visibility, index) =>
      visibility === CELL_REVEALED ? (state.board.adjacent[index] ?? 0) : -1,
    ),
    playerClaims,
    ...(activeProvenMines.length > 0 ? { provenMines: activeProvenMines } : {}),
  };
}

function applyEvent(state: GameState, event: PracticeReplayEventV1) {
  if (event.eventType === "ASSISTANCE_SHOWN") return null;
  if (event.eventType === "PLAYER_ACTION") {
    return event.actionType === "REVEAL"
      ? revealCell(state, event.cellIndex)
      : event.actionType === "TOGGLE_FLAG"
        ? toggleFlag(state, event.cellIndex)
        : chordCell(state, event.cellIndex);
  }
  return event.action === "REVEAL"
    ? revealCell(state, event.cellIndex)
    : toggleFlag(state, event.cellIndex);
}

function buildResult(
  request: PracticeReplayWorkerRequest,
): PracticeReplayWorkerResponse {
  try {
    verifyPracticeReplay(request.record, request.replay);
  } catch {
    return {
      requestId: request.requestId,
      ok: false,
      errorCode: "PRACTICE_REPLAY_INTEGRITY_FAILED",
    };
  }
  try {
    const state = createGameState(createBoard(request.record.board.spec));
    const provenMines = new Set<number>();
    for (const index of request.replay.initialFlags) toggleFlag(state, index);
    let detonatedMine: number | undefined;
    const steps = request.replay.events.map((event) => {
      const before = analyzeVisibleBoard(visibleState(state, provenMines));
      const delta = applyEvent(state, event);
      if (event.eventType === "COACH_ACTION") {
        if (event.action === "FLAG") provenMines.add(event.cellIndex);
        else if (event.action === "UNFLAG") provenMines.delete(event.cellIndex);
      } else if (
        event.eventType === "PLAYER_ACTION" &&
        event.actionType === "TOGGLE_FLAG" &&
        state.visibility[event.cellIndex] !== CELL_FLAGGED
      ) {
        provenMines.delete(event.cellIndex);
      }
      const hitMine = delta?.hitMine === true;
      if (hitMine) {
        detonatedMine = delta?.revealed.find(({ value }) => value < 0)?.index;
      }
      return {
        seq: event.seq,
        eventType: event.eventType,
        before,
        revealed: delta?.revealed.map(({ index, value }) => ({ index, value })) ?? [],
        ...(delta?.flagged ? {
          flagChange: {
            index: delta.flagged.index,
            flagged: delta.flagged.flagged,
          },
        } : {}),
        ...(event.eventType === "PLAYER_ACTION" ? { accepted: event.accepted } : {}),
        hitMine,
        outcome: state.outcome,
      };
    });
    const mines = Array.from(state.board.mines, (mine, index) => mine === 1 ? index : -1)
      .filter((index) => index >= 0);
    const flags = Array.from(state.visibility, (visibility, index) =>
      visibility === CELL_FLAGGED ? index : -1,
    ).filter((index) => index >= 0);
    const correctFlags = flags.filter((index) => state.board.mines[index] === 1);
    const wrongFlags = flags.filter((index) => state.board.mines[index] !== 1);
    const terminalCells = Array.from(state.visibility, (visibility, index) =>
      visibility === CELL_REVEALED
        ? (state.board.adjacent[index] ?? 0)
        : visibility === CELL_FLAGGED ? -3 : -2
    );
    return {
      requestId: request.requestId,
      ok: true,
      steps,
      terminal: {
        cells: terminalCells,
        ...(detonatedMine === undefined ? {} : { detonatedMine }),
        otherMines: mines.filter((index) => index !== detonatedMine),
        correctFlags,
        wrongFlags,
      },
    };
  } catch {
    return {
      requestId: request.requestId,
      ok: false,
      errorCode: "PRACTICE_REPLAY_BUILD_FAILED",
    };
  }
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<PracticeReplayWorkerRequest>) => void) | null;
  postMessage(message: PracticeReplayWorkerResponse): void;
}

const workerScope = globalThis as unknown as WorkerScope;
workerScope.onmessage = (event) => workerScope.postMessage(buildResult(event.data));

export { buildResult as buildPracticeReplayResult };
