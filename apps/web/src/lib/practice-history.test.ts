import {
  CELL_REVEALED,
  createBoard,
  createGameState,
  hashBoard,
  hashGameState,
  hashVisibleBoardState,
  revealCell,
  type BoardSpec,
  type VisibleBoardState,
} from "@h-minesweeper/game-core";
import { describe, expect, it } from "vitest";
import { createCoachRequest, runCoachRequest } from "./practice-coach";
import {
  PRACTICE_HISTORY_DATABASE_VERSION,
  PracticeHistoryCapacityError,
  createMemoryPracticeHistoryStore,
  createPracticeHistoryExport,
  hashPracticeReplay,
  parsePracticeHistoryImport,
  verifyPracticeReplay,
  type PracticeReplayV1,
  type PracticeRunRecordV1,
} from "./practice-history";

function completedPractice(): {
  readonly record: PracticeRunRecordV1;
  readonly replay: PracticeReplayV1;
} {
  const spec: BoardSpec = {
    width: 5,
    height: 5,
    mines: 1,
    seed: "practice-history-test",
    startIndex: 0,
    safeRadius: 0,
  };
  const board = createBoard(spec);
  const state = createGameState(board);
  const visibleBefore: VisibleBoardState = {
    width: 5,
    height: 5,
    totalMines: 1,
    clues: Array.from({ length: 25 }, () => -1),
    playerClaims: [],
  };
  const events: PracticeReplayV1["events"][number][] = [
    {
      seq: 1,
      elapsedMs: 0,
      eventType: "ASSISTANCE_SHOWN",
      trigger: "REQUEST",
      visibleStateHash: hashVisibleBoardState(visibleBefore),
      suggestion: runCoachRequest(createCoachRequest(1, visibleBefore)),
    },
  ];
  for (let cellIndex = 0; cellIndex < board.mines.length; cellIndex += 1) {
    if (board.mines[cellIndex] === 1 || state.visibility[cellIndex] === CELL_REVEALED) continue;
    const preStateHash = hashGameState(state);
    const delta = revealCell(state, cellIndex);
    events.push({
      seq: events.length + 1,
      elapsedMs: events.length * 120,
      eventType: "PLAYER_ACTION",
      actionType: "REVEAL",
      cellIndex,
      physicalClicks: 1,
      preStateHash,
      accepted: delta.accepted,
      postStateHash: delta.stateHash,
    });
  }
  expect(state.outcome).toBe("WON");
  const replayWithoutHash: PracticeReplayV1 = {
    schemaVersion: 1,
    recordId: "practice-1",
    initialFlags: [],
    events,
  };
  const record: PracticeRunRecordV1 = {
    schemaVersion: 1,
    kind: "GUIDED_PRACTICE",
    recordId: replayWithoutHash.recordId,
    completedAt: "2026-08-02T01:00:00.000Z",
    outcome: "WON",
    config: {
      preset: "custom",
      width: spec.width,
      height: spec.height,
      mines: spec.mines,
      generationMode: "classic",
    },
    board: {
      spec,
      boardHash: hashBoard(board),
      generatorRulesVersion: 1,
      trustStatus: "LOCAL_UNVERIFIED",
    },
    assistMode: "COACH",
    summary: {
      elapsedMs: events.at(-1)?.elapsedMs ?? 0,
      playerActions: events.filter((event) => event.eventType === "PLAYER_ACTION").length,
      hintsShown: 1,
      hintsRequested: 1,
      autoFlags: 0,
      demonstratedActions: 0,
    },
    replay: {
      schemaVersion: 1,
      eventCount: replayWithoutHash.events.length,
      eventLogHash: hashPracticeReplay(replayWithoutHash),
    },
  };
  return { record, replay: replayWithoutHash };
}

describe("practice history isolation and replay verification", () => {
  it("uses IndexedDB v4 and verifies an assistance-aware terminal replay", () => {
    expect(PRACTICE_HISTORY_DATABASE_VERSION).toBe(4);
    const { record, replay } = completedPractice();
    expect(() => verifyPracticeReplay(record, replay)).not.toThrow();
  });

  it("fails closed when a replay event is changed", () => {
    const { record, replay } = completedPractice();
    const changed: PracticeReplayV1 = {
      ...replay,
      events: replay.events.map((event) =>
        event.eventType === "PLAYER_ACTION"
          ? { ...event, postStateHash: "0000000000000000" }
          : event,
      ),
    };
    expect(() => verifyPracticeReplay(record, changed)).toThrow();
  });

  it("stores practice records separately and treats identical writes as idempotent", async () => {
    const { record, replay } = completedPractice();
    const store = createMemoryPracticeHistoryStore();
    await expect(store.put(record, replay)).resolves.toMatchObject({ recordCount: 1 });
    await expect(store.put(record, replay)).resolves.toMatchObject({ recordCount: 1 });
    await expect(store.read()).resolves.toMatchObject({
      recordCount: 1,
      invalidRecordCount: 0,
      invalidReplayCount: 0,
      availableReplayRecordIds: [record.recordId],
    });
  });

  it("reports a valid practice record whose replay is missing", async () => {
    const { record } = completedPractice();
    const store = createMemoryPracticeHistoryStore([record], []);

    await expect(store.read()).resolves.toMatchObject({
      recordCount: 1,
      invalidRecordCount: 0,
      invalidReplayCount: 1,
      availableReplayRecordIds: [],
    });
  });

  it("reports full capacity without silently removing an older practice record", async () => {
    const { record, replay } = completedPractice();
    const existing = Array.from({ length: 10_000 }, (_, index) => ({
      recordId: `existing-practice-${index}`,
    }));
    const store = createMemoryPracticeHistoryStore(existing, []);
    await expect(store.put(record, replay)).rejects.toBeInstanceOf(
      PracticeHistoryCapacityError,
    );
    await expect(store.put(record, replay)).rejects.toBeInstanceOf(
      PracticeHistoryCapacityError,
    );
  });

  it("exports and imports an atomic standalone practice document", async () => {
    const { record, replay } = completedPractice();
    const document = createPracticeHistoryExport(
      [record],
      [replay],
      new Date("2026-08-02T02:00:00.000Z"),
    );
    expect(parsePracticeHistoryImport(JSON.stringify(document))).toEqual(document);

    const store = createMemoryPracticeHistoryStore();
    await expect(store.importDocument(document)).resolves.toMatchObject({
      imported: 1,
      skippedIdentical: 0,
      recordCount: 1,
    });
    await expect(store.importDocument(document)).resolves.toMatchObject({
      imported: 0,
      skippedIdentical: 1,
      recordCount: 1,
    });
  });

  it("rejects duplicate replay IDs before an atomic import writes anything", async () => {
    const { record, replay } = completedPractice();
    const document = createPracticeHistoryExport([record], [replay]);
    const duplicateReplayDocument = {
      ...document,
      replays: [
        {
          ...replay,
          events: replay.events.map((event) =>
            event.eventType === "PLAYER_ACTION"
              ? { ...event, postStateHash: "0000000000000000" }
              : event,
          ),
        },
        replay,
      ],
    };
    expect(() => parsePracticeHistoryImport(JSON.stringify(duplicateReplayDocument)))
      .toThrow(/Duplicate practice replay|one-to-one/u);

    const store = createMemoryPracticeHistoryStore();
    await expect(store.importDocument(duplicateReplayDocument as never)).rejects.toThrow();
    await expect(store.read()).resolves.toMatchObject({ recordCount: 0 });
  });

  it("derives summary fields from replay events and binds configuration to the board", () => {
    const { record, replay } = completedPractice();
    expect(() => verifyPracticeReplay({
      ...record,
      summary: { ...record.summary, hintsShown: record.summary.hintsShown + 1 },
    }, replay)).toThrow(/summary hintsShown/u);
    expect(() => verifyPracticeReplay({
      ...record,
      config: { ...record.config, width: record.config.width + 1 },
    }, replay)).toThrow(/configuration/u);
    expect(() => verifyPracticeReplay({
      ...record,
      summary: { ...record.summary, playerActions: 0.5 },
    }, replay)).toThrow(/playerActions/u);
  });

  it("requires the terminal action to be the final replay event", () => {
    const { record, replay } = completedPractice();
    const terminal = replay.events.at(-1)!;
    if (terminal.eventType !== "PLAYER_ACTION") throw new Error("Expected a terminal player action");
    const trailingEvent = {
      seq: replay.events.length + 1,
      elapsedMs: terminal.elapsedMs + 1,
      eventType: "PLAYER_ACTION" as const,
      actionType: "REVEAL" as const,
      cellIndex: terminal.cellIndex,
      physicalClicks: 1,
      preStateHash: terminal.postStateHash,
      accepted: false,
      rejectReason: "GAME_OVER" as const,
      postStateHash: terminal.postStateHash,
    };
    const changedReplay: PracticeReplayV1 = {
      ...replay,
      events: [...replay.events, trailingEvent],
    };
    const changedRecord: PracticeRunRecordV1 = {
      ...record,
      summary: {
        ...record.summary,
        elapsedMs: trailingEvent.elapsedMs,
        playerActions: record.summary.playerActions + 1,
      },
      replay: {
        ...record.replay,
        eventCount: changedReplay.events.length,
        eventLogHash: hashPracticeReplay(changedReplay),
      },
    };
    expect(() => verifyPracticeReplay(changedRecord, changedReplay))
      .toThrow(/terminal action|after the game ended/u);
  });
});
