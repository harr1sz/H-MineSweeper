import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SoloHistoryCapacity,
  SoloRunRecordV1,
} from "../lib/solo-history";
import { SOLO_TRAINING_SESSION_IDLE_MS } from "../lib/solo-history";
import {
  attemptPendingHistoryWrite,
  cappedEffectiveInteractionGapMs,
  createSoloRunIdentity,
  enqueuePendingHistoryRecord,
  getPendingHistoryWrites,
  resetPendingHistoryWritesForTests,
  SOLO_EFFECTIVE_INTERACTION_IDLE_CAP_MS,
} from "./SoloGame";

function record(recordId: string): SoloRunRecordV1 {
  return {
    schemaVersion: 1,
    recordId,
    trainingSessionId: "training-session-1",
    completedAt: "2026-07-30T08:00:00.000Z",
    outcome: "LOST",
    config: {
      preset: "beginner",
      width: 9,
      height: 9,
      mines: 10,
      generationMode: "classic",
    },
    board: {
      seed: `seed-${recordId}`,
      boardHash: `hash-${recordId}`,
      trustStatus: "LOCAL_UNVERIFIED",
    },
    rules: {
      metricRulesVersion: 1,
      gameRulesVersion: 1,
    },
    metrics: {
      elapsedMs: 1_000,
      board3BV: 10,
      cps: 1,
      threeBvPerSecond: 1,
      ioe: 1,
      physicalClicks: 1,
      semanticActions: 1,
      acceptedActions: 1,
      wastedActions: 0,
      reveals: 1,
      flags: 0,
      unflags: 0,
      chords: 0,
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const capacity: SoloHistoryCapacity = {
  recordCount: 1,
  warning: false,
  full: false,
};

describe("pending solo history writes", () => {
  beforeEach(() => {
    resetPendingHistoryWritesForTests();
  });

  it("retains the immutable failed record across a new board and retries it once", async () => {
    const delayedFailure = deferred<SoloHistoryCapacity>();
    const firstStore = {
      put: vi.fn(() => delayedFailure.promise),
    };
    const firstRecord = record("run-a");
    enqueuePendingHistoryRecord(firstRecord);
    const firstAttempt = attemptPendingHistoryWrite("run-a", firstStore);

    // Starting another board must not replace the record owned by the delayed
    // write, even if code outside the queue still holds the source object.
    enqueuePendingHistoryRecord(record("run-b"));
    (firstRecord.config as { width: number }).width = 30;
    delayedFailure.reject(new Error("IndexedDB temporarily unavailable"));
    await expect(firstAttempt).resolves.toMatchObject({ ok: false });

    const failed = getPendingHistoryWrites().find(
      (pending) => pending.record.recordId === "run-a",
    );
    expect(failed).toMatchObject({
      status: "failed",
      error: "IndexedDB temporarily unavailable",
      record: {
        recordId: "run-a",
        config: { width: 9 },
      },
    });
    expect(
      getPendingHistoryWrites().map((pending) => pending.record.recordId),
    ).toEqual(["run-a", "run-b"]);

    const delayedRetry = deferred<SoloHistoryCapacity>();
    const retryStore = {
      put: vi.fn(() => delayedRetry.promise),
    };
    const retry = attemptPendingHistoryWrite("run-a", retryStore);
    const duplicateRetry = attemptPendingHistoryWrite("run-a", retryStore);
    expect(retry).toBe(duplicateRetry);
    expect(retryStore.put).toHaveBeenCalledTimes(1);
    expect(retryStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: "run-a" }),
    );

    delayedRetry.resolve(capacity);
    await expect(retry).resolves.toEqual({ ok: true, capacity });
    await expect(duplicateRetry).resolves.toEqual({ ok: true, capacity });
    expect(
      getPendingHistoryWrites().map((pending) => pending.record.recordId),
    ).toEqual(["run-b"]);
  });
});

describe("solo effective interaction timing", () => {
  it("counts visible inter-action time only up to the frozen idle cap", () => {
    expect(cappedEffectiveInteractionGapMs(null, 5_000)).toBe(0);
    expect(cappedEffectiveInteractionGapMs(1_000, 6_000)).toBe(5_000);
    expect(cappedEffectiveInteractionGapMs(1_000, 61_000)).toBe(
      SOLO_EFFECTIVE_INTERACTION_IDLE_CAP_MS,
    );
  });

  it("rejects reversed or invalid timing samples", () => {
    expect(cappedEffectiveInteractionGapMs(5_000, 4_999)).toBe(0);
    expect(cappedEffectiveInteractionGapMs(Number.NaN, 5_000)).toBe(0);
    expect(cappedEffectiveInteractionGapMs(1_000, Number.POSITIVE_INFINITY))
      .toBe(0);
    expect(cappedEffectiveInteractionGapMs(1_000, 2_000, 0)).toBe(0);
  });
});

describe("solo run training-session identity", () => {
  it("rotates after 30 minutes idle without a remount and keeps each run binding immutable", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const firstRun = createSoloRunIdentity(
      storage,
      1_000,
      () => "run-before-idle",
    );
    const firstRunTrainingSessionId = firstRun.trainingSessionId;

    const afterIdleRun = createSoloRunIdentity(
      storage,
      1_000 + SOLO_TRAINING_SESSION_IDLE_MS,
      () => "run-after-idle",
    );

    expect(afterIdleRun.runId).toBe("run-after-idle");
    expect(afterIdleRun.trainingSessionId).not.toBe(firstRunTrainingSessionId);
    expect(firstRun).toEqual({
      runId: "run-before-idle",
      trainingSessionId: firstRunTrainingSessionId,
    });
    expect(Object.isFrozen(firstRun)).toBe(true);
  });
});
