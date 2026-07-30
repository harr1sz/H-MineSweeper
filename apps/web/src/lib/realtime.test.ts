import {
  PROTOCOL_VERSION,
  createBoard,
  createGameState,
  hashGameState,
  toggleFlag,
} from "@h-minesweeper/game-core";
import { describe, expect, it } from "vitest";
import {
  captureOptimisticGameState,
  classifyReliableSequence,
  decodeRealtimePayload,
  planActionReconciliation,
  rollbackOptimisticGameState,
} from "./realtime";
import {
  decodeServerMessage,
  requiresProtocolUpgrade,
} from "./realtime-decoder";

describe("realtime protocol decoding", () => {
  it("accepts independent progress samples without a reliable server sequence", () => {
    const decoded = decodeServerMessage({
      type: "PROGRESS",
      v: PROTOCOL_VERSION,
      matchId: "match-1",
      round: 1,
      progressSeq: 7,
      generatedAt: 123_456,
      progress: [
        {
          playerId: "guest-a",
          progress: 42,
          progressPercent: 42,
          connected: true,
          outcome: "PLAYING",
        },
      ],
    });

    expect(decoded).toMatchObject({
      type: "PROGRESS",
      progressSeq: 7,
      generatedAt: 123_456,
    });
    expect(decoded).not.toHaveProperty("serverSeq");
  });

  it("rejects unknown versions, unknown types, and malformed action results", () => {
    expect(
      decodeServerMessage({
        type: "PROGRESS",
        v: 1,
        matchId: "match-1",
        round: 1,
        progressSeq: 1,
        generatedAt: 1,
        progress: [],
      }),
    ).toBeNull();
    expect(requiresProtocolUpgrade({ type: "WELCOME", v: 1 })).toBe(true);
    expect(
      decodeServerMessage({ type: "FUTURE_EVENT", v: PROTOCOL_VERSION }),
    ).toBeNull();
    expect(
      decodeServerMessage({
        type: "ACTION_RESULT",
        v: PROTOCOL_VERSION,
        serverSeq: 3,
        matchId: "match-1",
        ackClientActionId: "action-1",
        accepted: false,
        duplicate: false,
        authoritativeStateHash: "abc",
        reconcile: "ERASE_LOCAL_STATE",
      }),
    ).toBeNull();
  });

  it("does not let a discarded first message hide an initial reliable gap", () => {
    expect(
      decodeServerMessage({
        type: "WELCOME",
        v: PROTOCOL_VERSION,
        serverSeq: 1,
        sessionId: "session",
      }),
    ).toBeNull();
    expect(classifyReliableSequence(0, 2)).toBe("GAP");
    expect(classifyReliableSequence(0, 1)).toBe("NEXT");
  });

  it("turns invalid JSON and old protocol messages into unsequenced UI errors", () => {
    expect(decodeRealtimePayload("{not-json")).toMatchObject({
      type: "ERROR",
      code: "INVALID_PROTOCOL_MESSAGE",
      retryable: true,
    });
    expect(decodeRealtimePayload(JSON.stringify({
      type: "WELCOME",
      v: 1,
      serverSeq: 1,
    }))).toMatchObject({
      type: "ERROR",
      code: "UPGRADE_REQUIRED",
      retryable: false,
    });
    expect(decodeRealtimePayload("{not-json")).not.toHaveProperty("serverSeq");
  });
});

describe("optimistic realtime reconciliation", () => {
  it("defers verification while later optimistic actions remain in flight", () => {
    expect(planActionReconciliation("NONE", 2)).toBe("DEFER");
    expect(planActionReconciliation("NONE", 0)).toBe("VERIFY");
    expect(planActionReconciliation("ROLLBACK", 1))
      .toBe("WAIT_FOR_SNAPSHOT");
    expect(planActionReconciliation("ROLLBACK", 0)).toBe("ROLLBACK");
  });

  it("restores the exact pre-action state for a rejected optimistic action", () => {
    const game = createGameState(
      createBoard({
        width: 5,
        height: 5,
        mines: 3,
        seed: "rollback-boundary",
        startIndex: 12,
        safeRadius: 0,
      }),
    );
    const beforeHash = hashGameState(game);
    const preAction = captureOptimisticGameState(game);

    expect(toggleFlag(game, 0).accepted).toBe(true);
    expect(hashGameState(game)).not.toBe(beforeHash);

    rollbackOptimisticGameState(game, preAction);

    expect(hashGameState(game)).toBe(beforeHash);
    expect(game.visibility).toEqual(preAction.visibility);
    expect(game.revealedSafeCount).toBe(preAction.revealedSafeCount);
    expect(game.outcome).toBe(preAction.outcome);
  });
});
