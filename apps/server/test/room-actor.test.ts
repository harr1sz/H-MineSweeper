import { certifyNoGuess, createBoard } from "@h-minesweeper/game-core";
import type { BoardSpec } from "@h-minesweeper/game-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PHASE_ZERO_EXPERT_SEEDS,
  RoomActor,
} from "../src/room-actor.js";
import type {
  ClientActionEnvelope,
  GuestSession,
  WireSender,
} from "../src/types.js";

const boardSpec: BoardSpec = {
  width: 5,
  height: 5,
  mines: 8,
  seed: "room-actor-adjudication",
  startIndex: 12,
  safeRadius: 0,
};

function session(guestId: string, displayName: string): GuestSession {
  return {
    guestId,
    displayName,
    guestToken: `token-${guestId}-abcdefghijklmnopqrstuvwxyz`,
  };
}

function collector(messages: unknown[]): WireSender {
  return {
    send(message) {
      messages.push(message);
    },
  };
}

function lastServerSeq(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { serverSeq?: unknown } | undefined;
    if (typeof message?.serverSeq === "number") return message.serverSeq;
  }
  return 0;
}

function action(
  actor: RoomActor,
  messages: unknown[],
  clientActionId: string,
  actionType: ClientActionEnvelope["actionType"],
  cellIndex?: number,
): ClientActionEnvelope {
  return {
    v: 1,
    matchId: actor.matchId,
    connectionEpoch: 1,
    clientActionId,
    lastServerSeq: lastServerSeq(messages),
    actionType,
    ...(cellIndex === undefined ? {} : { cellIndex }),
    clientMonoTelemetry: 10,
  };
}

describe("RoomActor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ships 32 distinct Expert boards certified by NG-Competitive-v1", () => {
    expect(PHASE_ZERO_EXPERT_SEEDS).toHaveLength(32);
    expect(new Set(PHASE_ZERO_EXPERT_SEEDS)).toHaveLength(32);
    for (const seed of PHASE_ZERO_EXPERT_SEEDS) {
      const certificate = certifyNoGuess(
        createBoard({
          width: 30,
          height: 16,
          mines: 99,
          seed,
          startIndex: 255,
          safeRadius: 1,
        }),
      );
      expect(certificate?.ruleset).toBe("NG-Competitive-v1");
    }
  });

  it("deduplicates actions, adjudicates a Bo3, exposes replay, and resets rematch", async () => {
    const first = session("guest-a", "Alpha");
    const second = session("guest-b", "Bravo");
    const firstMessages: unknown[] = [];
    const secondMessages: unknown[] = [];
    const actor = new RoomActor({
      roomId: "room-id",
      roomCode: "ABC234",
      host: first,
      boardSpecs: [boardSpec],
      now: Date.now,
      timings: {
        countdownMs: 3,
        roundDurationMs: 1_000,
        terminalWindowMs: 5,
        progressIntervalMs: 100,
      },
    });
    expect(actor.addPlayer(second)).toBe(true);
    expect(actor.connect(first.guestId, 1, collector(firstMessages))).toBe(true);
    expect(actor.connect(second.guestId, 1, collector(secondMessages))).toBe(true);

    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "ready-a-1", "READY"),
    );
    actor.handleAction(
      second.guestId,
      action(actor, secondMessages, "ready-b-1", "READY"),
    );
    await vi.advanceTimersByTimeAsync(3);
    expect(actor.phase).toBe("ACTIVE");

    const board = createBoard(boardSpec);
    const mineIndex = board.mines.findIndex((value) => value === 1);
    expect(mineIndex).toBeGreaterThanOrEqual(0);

    const duplicate = action(
      actor,
      secondMessages,
      "same-toggle",
      "TOGGLE_FLAG",
      mineIndex,
    );
    actor.handleAction(second.guestId, duplicate);
    actor.handleAction(second.guestId, duplicate);

    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "mine-a-1", "REVEAL", mineIndex),
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(actor.phase).toBe("ROUND_RESULT");

    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "ready-a-2", "READY"),
    );
    actor.handleAction(
      second.guestId,
      action(actor, secondMessages, "ready-b-2", "READY"),
    );
    await vi.advanceTimersByTimeAsync(3);
    expect(actor.phase).toBe("ACTIVE");

    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "mine-a-2", "REVEAL", mineIndex),
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(actor.phase).toBe("MATCH_RESULT");

    const replayId = actor.matchId;
    const replay = actor.getReplay(replayId);
    expect(replay).toBeDefined();
    expect(
      replay?.events.filter(
        (event) =>
          event.type === "ACTION" &&
          (event.payload as { clientActionId?: string }).clientActionId ===
            "same-toggle",
      ),
    ).toHaveLength(1);
    const measuredAction = replay?.events.find(
      (event) => event.type === "ACTION",
    )?.payload as { serverApplyMs?: number } | undefined;
    expect(measuredAction?.serverApplyMs).toEqual(expect.any(Number));
    expect(measuredAction?.serverApplyMs).toBeGreaterThanOrEqual(0);
    expect(replay?.result).toMatchObject({
      outcome: "WIN",
      winnerGuestId: second.guestId,
      reason: "FIRST_TO_TWO",
    });

    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "rematch-a", "REMATCH"),
    );
    actor.handleAction(
      second.guestId,
      action(actor, secondMessages, "rematch-b", "REMATCH"),
    );
    expect(actor.phase).toBe("LOBBY");
    expect(actor.matchId).not.toBe(replayId);
    expect(actor.getReplay(replayId)).toBeDefined();
    actor.close();
  });

  it("preserves the terminal window when a mine is received just before timeout", async () => {
    const first = session("guest-a", "Alpha");
    const second = session("guest-b", "Bravo");
    const firstMessages: unknown[] = [];
    const secondMessages: unknown[] = [];
    const actor = new RoomActor({
      roomId: "terminal-window-room",
      roomCode: "TERM50",
      host: first,
      boardSpecs: [boardSpec],
      now: Date.now,
      timings: {
        countdownMs: 1,
        roundDurationMs: 100,
        terminalWindowMs: 50,
        progressIntervalMs: 10,
      },
    });
    actor.addPlayer(second);
    actor.connect(first.guestId, 1, collector(firstMessages));
    actor.connect(second.guestId, 1, collector(secondMessages));
    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "ready-a", "READY"),
    );
    actor.handleAction(
      second.guestId,
      action(actor, secondMessages, "ready-b", "READY"),
    );
    await vi.advanceTimersByTimeAsync(1);

    const mineIndex = createBoard(boardSpec).mines.findIndex(
      (value) => value === 1,
    );
    await vi.advanceTimersByTimeAsync(90);
    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "late-mine", "REVEAL", mineIndex),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(actor.phase).toBe("ACTIVE");

    await vi.advanceTimersByTimeAsync(40);
    expect(actor.phase).toBe("ROUND_RESULT");
    const result = [...firstMessages].reverse().find(
      (message) => (message as { type?: string }).type === "ROUND_RESULT",
    ) as { winnerGuestId?: string; reason?: string } | undefined;
    expect(result).toMatchObject({
      winnerGuestId: second.guestId,
      reason: "OPPONENT_HIT_MINE",
    });
    actor.close();
  });

  it("does not overwrite a completed match when a rematch voter disconnects", async () => {
    const first = session("guest-a", "Alpha");
    const second = session("guest-b", "Bravo");
    const firstMessages: unknown[] = [];
    const secondMessages: unknown[] = [];
    const actor = new RoomActor({
      roomId: "rematch-disconnect-room",
      roomCode: "REMTCH",
      host: first,
      boardSpecs: [boardSpec],
      now: Date.now,
      timings: {
        countdownMs: 1,
        roundDurationMs: 1_000,
        terminalWindowMs: 1,
        progressIntervalMs: 10,
      },
    });
    actor.addPlayer(second);
    actor.connect(first.guestId, 1, collector(firstMessages));
    actor.connect(second.guestId, 1, collector(secondMessages));
    const mineIndex = createBoard(boardSpec).mines.findIndex(
      (value) => value === 1,
    );

    for (let round = 0; round < 2; round += 1) {
      actor.handleAction(
        first.guestId,
        action(actor, firstMessages, `ready-a-${round}`, "READY"),
      );
      actor.handleAction(
        second.guestId,
        action(actor, secondMessages, `ready-b-${round}`, "READY"),
      );
      await vi.advanceTimersByTimeAsync(1);
      actor.handleAction(
        first.guestId,
        action(actor, firstMessages, `mine-a-${round}`, "REVEAL", mineIndex),
      );
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(actor.phase).toBe("MATCH_RESULT");
    const replayId = actor.matchId;
    const originalResult = actor.getReplay(replayId)?.result;
    const matchResultCount = firstMessages.filter(
      (message) => (message as { type?: string }).type === "MATCH_RESULT",
    ).length;

    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "rematch-a", "REMATCH"),
    );
    expect(actor.phase).toBe("REMATCH");
    actor.disconnect(second.guestId, 1);

    expect(actor.phase).toBe("REMATCH");
    expect(actor.getReplay(replayId)?.result).toEqual(originalResult);
    expect(
      firstMessages.filter(
        (message) => (message as { type?: string }).type === "MATCH_RESULT",
      ),
    ).toHaveLength(matchResultCount);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(actor.phase).toBe("MATCH_RESULT");
    expect(actor.getReplay(replayId)?.result).toEqual(originalResult);

    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "rematch-a-retry", "REMATCH"),
    );
    expect(actor.phase).toBe("REMATCH");
    actor.close();
  });

  it("keeps an idempotency tombstone after the detailed action cache evicts", async () => {
    const first = session("guest-a", "Alpha");
    const second = session("guest-b", "Bravo");
    const firstMessages: unknown[] = [];
    const secondMessages: unknown[] = [];
    const actor = new RoomActor({
      roomId: "idempotency-room",
      roomCode: "IDEMPT",
      host: first,
      boardSpecs: [boardSpec],
      now: Date.now,
      timings: {
        countdownMs: 1,
        roundDurationMs: 10_000,
        terminalWindowMs: 1,
        progressIntervalMs: 10,
      },
    });
    actor.addPlayer(second);
    actor.connect(first.guestId, 1, collector(firstMessages));
    actor.connect(second.guestId, 1, collector(secondMessages));
    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "ready-a", "READY"),
    );
    actor.handleAction(
      second.guestId,
      action(actor, secondMessages, "ready-b", "READY"),
    );
    await vi.advanceTimersByTimeAsync(1);

    const mineIndex = createBoard(boardSpec).mines.findIndex(
      (value) => value === 1,
    );
    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "old-toggle", "TOGGLE_FLAG", mineIndex),
    );
    for (let index = 0; index < 2_048; index += 1) {
      actor.handleAction(
        first.guestId,
        action(
          actor,
          firstMessages,
          `cache-pressure-${index}`,
          "REVEAL",
          boardSpec.startIndex,
        ),
      );
    }

    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "old-toggle", "TOGGLE_FLAG", mineIndex),
    );
    const duplicateResult = [...firstMessages].reverse().find(
      (message) =>
        (message as { ackClientActionId?: string }).ackClientActionId ===
        "old-toggle",
    ) as { rejectReason?: string } | undefined;
    expect(duplicateResult?.rejectReason).toBe("DUPLICATE_ACTION");

    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "still-flagged", "REVEAL", mineIndex),
    );
    const revealResult = [...firstMessages].reverse().find(
      (message) =>
        (message as { ackClientActionId?: string }).ackClientActionId ===
        "still-flagged",
    ) as { rejectReason?: string } | undefined;
    expect(revealResult?.rejectReason).toBe("FLAGGED");
    actor.close();
  });

  it("uses fifteen unique boards and then closes the Phase 0 test session", async () => {
    const first = session("guest-a", "Alpha");
    const second = session("guest-b", "Bravo");
    const firstMessages: unknown[] = [];
    const secondMessages: unknown[] = [];
    const actor = new RoomActor({
      roomId: "round-cap-room",
      roomCode: "CAP015",
      host: first,
      now: Date.now,
      timings: {
        countdownMs: 1,
        roundDurationMs: 1_000,
        terminalWindowMs: 1,
        progressIntervalMs: 10,
      },
    });
    actor.addPlayer(second);
    actor.connect(first.guestId, 1, collector(firstMessages));
    actor.connect(second.guestId, 1, collector(secondMessages));

    for (let roundIndex = 0; roundIndex < 15; roundIndex += 1) {
      if (actor.phase === "MATCH_RESULT") {
        actor.handleAction(
          first.guestId,
          action(actor, firstMessages, `rematch-a-${roundIndex}`, "REMATCH"),
        );
        actor.handleAction(
          second.guestId,
          action(actor, secondMessages, `rematch-b-${roundIndex}`, "REMATCH"),
        );
        expect(actor.phase).toBe("LOBBY");
      }
      actor.handleAction(
        first.guestId,
        action(actor, firstMessages, `ready-a-${roundIndex}`, "READY"),
      );
      actor.handleAction(
        second.guestId,
        action(actor, secondMessages, `ready-b-${roundIndex}`, "READY"),
      );
      await vi.advanceTimersByTimeAsync(1);
      const countdown = [...firstMessages].reverse().find(
        (message) => (message as { type?: string }).type === "COUNTDOWN",
      ) as { boardSpec?: BoardSpec } | undefined;
      if (!countdown?.boardSpec) throw new Error("Missing countdown board");
      const mineIndex = createBoard(countdown.boardSpec).mines.findIndex(
        (value) => value === 1,
      );
      actor.handleAction(
        first.guestId,
        action(
          actor,
          firstMessages,
          `mine-a-${roundIndex}`,
          "REVEAL",
          mineIndex,
        ),
      );
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(actor.phase).toBe("ROUND_RESULT");
    actor.handleAction(
      first.guestId,
      action(actor, firstMessages, "ready-cap-a", "READY"),
    );
    actor.handleAction(
      second.guestId,
      action(actor, secondMessages, "ready-cap-b", "READY"),
    );
    expect(actor.phase).toBe("MATCH_RESULT");

    const seeds = firstMessages
      .filter((message) => (message as { type?: string }).type === "COUNTDOWN")
      .map(
        (message) =>
          (message as { boardSpec: BoardSpec }).boardSpec.seed,
      );
    expect(seeds).toHaveLength(15);
    expect(new Set(seeds)).toHaveLength(15);
    const finalResult = [...firstMessages].reverse().find(
      (message) => (message as { type?: string }).type === "MATCH_RESULT",
    ) as { reason?: string; outcome?: string } | undefined;
    expect(finalResult).toMatchObject({
      outcome: "NO_CONTEST",
      reason: "PHASE_ZERO_ROUND_LIMIT",
    });
    actor.close();
  });
});
