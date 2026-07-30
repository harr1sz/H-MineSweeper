import { describe, expect, it } from "vitest";
import {
  SOLO_GAME_RULES_VERSION,
  SOLO_HISTORY_MAX_RECORDS,
  SOLO_HISTORY_WARNING_RECORDS,
  SOLO_LEGACY_PERSONAL_BEST_PREFIX,
  SOLO_METRIC_RULES_VERSION,
  SOLO_TRAINING_SESSION_IDLE_MS,
  SoloHistoryCapacityError,
  SoloHistoryConflictError,
  SoloHistoryValidationError,
  calculateSoloTrend,
  createMemorySoloHistoryStore,
  createSoloHistoryExport,
  createSoloHistoryRecoveryExport,
  createSoloLegacyPersonalBestRecoveryExport,
  getOrCreateTrainingSessionId,
  isSoloLegacyPersonalBestMetadataV1,
  isSoloRunRecordV1,
  parseSoloHistoryImport,
  recordTrainingSessionTerminal,
  sameSoloConfigurationAndRules,
  touchTrainingSession,
  type SoloRunRecordV1,
} from "./solo-history";
import type { SoloBoardConfig } from "./solo";

const CONFIG: SoloBoardConfig = {
  width: 9,
  height: 9,
  mines: 10,
  mode: "no_guess",
};

function record(
  recordId: string,
  completedAt: number,
  elapsedMs: number,
  options: {
    readonly mode?: SoloBoardConfig["mode"];
    readonly metricRulesVersion?: number;
    readonly gameRulesVersion?: number;
    readonly outcome?: SoloRunRecordV1["outcome"];
    readonly speed?: number | null;
    readonly ioe?: number | null;
  } = {},
): SoloRunRecordV1 {
  return {
    schemaVersion: 1,
    recordId,
    trainingSessionId: "training-session-a",
    completedAt: new Date(completedAt).toISOString(),
    outcome: options.outcome ?? "WON",
    config: {
      preset: "beginner",
      width: CONFIG.width,
      height: CONFIG.height,
      mines: CONFIG.mines,
      generationMode: options.mode ?? CONFIG.mode,
    },
    board: {
      seed: `seed-${recordId}`,
      boardHash: `hash-${recordId}`,
      trustStatus: "LOCAL_UNVERIFIED",
    },
    rules: {
      metricRulesVersion:
        options.metricRulesVersion ?? SOLO_METRIC_RULES_VERSION,
      gameRulesVersion:
        options.gameRulesVersion ?? SOLO_GAME_RULES_VERSION,
    },
    metrics: {
      elapsedMs,
      board3BV: 20,
      cps: 1,
      threeBvPerSecond:
        options.speed === undefined ? 1.5 : options.speed,
      ioe: options.ioe === undefined ? 0.8 : options.ioe,
      physicalClicks: 12,
      semanticActions: 11,
      acceptedActions: 10,
      wastedActions: 1,
      reveals: 7,
      flags: 2,
      unflags: 1,
      chords: 1,
    },
  };
}

function manyRecords(count: number, offset = 0): SoloRunRecordV1[] {
  return Array.from({ length: count }, (_, index) =>
    record(`run-${offset + index}`, offset + index, 1_000 + index),
  );
}

function legacyPersonalBestStorage(entries: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(entries));
  return {
    storage: {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
    },
    values,
  };
}

describe("solo history data contract", () => {
  it("validates the full versioned record contract", () => {
    const valid = record("valid", 100, 2_000);
    expect(isSoloRunRecordV1(valid)).toBe(true);
    expect(
      isSoloRunRecordV1({
        ...valid,
        board: { ...valid.board, boardHash: "" },
      }),
    ).toBe(false);
    expect(
      isSoloRunRecordV1({
        ...valid,
        metrics: { ...valid.metrics, chords: undefined },
      }),
    ).toBe(false);
    expect(
      isSoloRunRecordV1({
        ...valid,
        metrics: { ...valid.metrics, board3BV: null },
      }),
    ).toBe(true);
    expect(
      isSoloRunRecordV1({
        ...valid,
        metrics: { ...valid.metrics, flagToggles: 3 },
      }),
    ).toBe(false);
    expect(
      isSoloRunRecordV1({
        ...valid,
        config: { ...valid.config, width: 101, preset: "custom" },
      }),
    ).toBe(false);
    expect(
      isSoloRunRecordV1({
        ...valid,
        config: { ...valid.config, width: 16 },
      }),
    ).toBe(false);
    expect(typeof valid.rules.metricRulesVersion).toBe("number");
    expect(typeof valid.rules.gameRulesVersion).toBe("number");
  });

  it("treats an identical retry as a no-op and rejects mutable recordId reuse", async () => {
    const store = createMemorySoloHistoryStore();
    const original = record("same-run", 100, 2_000);
    await store.put(original);
    await expect(store.put(structuredClone(original))).resolves.toMatchObject({
      recordCount: 1,
    });
    await expect(
      store.put(record("same-run", 200, 1_500)),
    ).rejects.toBeInstanceOf(SoloHistoryConflictError);

    const snapshot = await store.read();
    expect(snapshot.recordCount).toBe(1);
    expect(snapshot.records[0]?.metrics.elapsedMs).toBe(2_000);
  });

  it("warns at 9,500 and rejects new records at 10,000 without deleting old data", async () => {
    const warningStore = createMemorySoloHistoryStore(
      manyRecords(SOLO_HISTORY_WARNING_RECORDS - 1),
    );
    const warning = await warningStore.put(
      record("warning-edge", 20_000, 1_000),
    );
    expect(warning.warning).toBe(true);
    expect(warning.recordCount).toBe(SOLO_HISTORY_WARNING_RECORDS);

    const fullRecords = manyRecords(SOLO_HISTORY_MAX_RECORDS);
    const fullStore = createMemorySoloHistoryStore(fullRecords);
    await expect(
      fullStore.put(record("overflow", 30_000, 1_000)),
    ).rejects.toBeInstanceOf(SoloHistoryCapacityError);
    expect((await fullStore.read()).recordCount).toBe(
      SOLO_HISTORY_MAX_RECORDS,
    );

    await expect(fullStore.put(structuredClone(fullRecords[0]!))).resolves
      .toMatchObject({ full: true });
    expect((await fullStore.read()).records).toHaveLength(
      SOLO_HISTORY_MAX_RECORDS,
    );
  });

  it("exports, validates, imports, and idempotently reimports a full batch", async () => {
    const exported = createSoloHistoryExport([
      record("older", 100, 2_000),
      record("newer", 200, 1_000),
    ], new Date("2026-07-30T00:00:00.000Z"));
    const parsed = parseSoloHistoryImport(JSON.stringify(exported));
    expect(parsed.map((entry) => entry.recordId)).toEqual(["newer", "older"]);

    const store = createMemorySoloHistoryStore();
    await expect(store.importRecords(parsed)).resolves.toMatchObject({
      imported: 2,
      skippedIdentical: 0,
    });
    await expect(store.importRecords(parsed)).resolves.toMatchObject({
      imported: 0,
      skippedIdentical: 2,
    });
    expect((await store.read()).recordCount).toBe(2);
  });

  it("atomically rejects an invalid, conflicting, or over-capacity batch", async () => {
    const existing = record("existing", 100, 2_000);
    const store = createMemorySoloHistoryStore([existing]);
    await expect(
      store.importRecords([
        record("new", 200, 1_000),
        { broken: true },
      ]),
    ).rejects.toBeInstanceOf(SoloHistoryValidationError);
    expect((await store.read()).recordCount).toBe(1);

    await expect(
      store.importRecords([
        { ...existing, metrics: { ...existing.metrics, elapsedMs: 999 } },
        record("another", 300, 900),
      ]),
    ).rejects.toBeInstanceOf(SoloHistoryConflictError);
    expect((await store.read()).recordCount).toBe(1);

    const almostFull = createMemorySoloHistoryStore(
      manyRecords(SOLO_HISTORY_MAX_RECORDS - 1),
    );
    await expect(
      almostFull.importRecords([
        record("new-a", 30_000, 900),
        record("new-b", 30_001, 800),
      ]),
    ).rejects.toBeInstanceOf(SoloHistoryCapacityError);
    expect((await almostFull.read()).recordCount).toBe(
      SOLO_HISTORY_MAX_RECORDS - 1,
    );
  });

  it("reports corrupt records and preserves their raw recovery export", async () => {
    const corrupt = { recordId: "corrupt", schemaVersion: 99, payload: "keep" };
    const store = createMemorySoloHistoryStore([
      record("valid", 100, 2_000),
      corrupt,
    ]);
    const snapshot = await store.read();
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.invalidRecordCount).toBe(1);
    expect(snapshot.rawRecords).toHaveLength(2);

    const recovery = createSoloHistoryRecoveryExport(
      snapshot.rawRecords,
      new Date("2026-07-30T00:00:00.000Z"),
    );
    expect(recovery.records).toContainEqual(corrupt);
    expect(() =>
      parseSoloHistoryImport(JSON.stringify(recovery)),
    ).toThrow(SoloHistoryValidationError);
  });

  it("migrates legacy personal bests into independent metadata exactly once", async () => {
    const sourceKey =
      `${SOLO_LEGACY_PERSONAL_BEST_PREFIX}:9x9:10:no_guess`;
    const rawValue = JSON.stringify({
      elapsedMs: 12_345,
      completedAt: Date.UTC(2026, 6, 29, 8),
      metricRulesVersion: "HMS-statistics-v1",
      trustStatus: "LOCAL_UNVERIFIED",
    });
    const source = legacyPersonalBestStorage({
      [sourceKey]: rawValue,
      unrelated: JSON.stringify({ elapsedMs: 1 }),
    });
    const store = createMemorySoloHistoryStore();
    const first = await store.migrateLegacyPersonalBests(
      source.storage,
      new Date("2026-07-30T00:00:00.000Z"),
    );
    expect(first).toMatchObject({
      migrated: 1,
      skippedExisting: 0,
      invalidMetadataCount: 0,
      invalidSources: [],
    });
    expect(first.metadata).toHaveLength(1);
    expect(first.metadata[0]).toMatchObject({
      schemaVersion: 1,
      kind: "LEGACY_PERSONAL_BEST",
      migratedAt: "2026-07-30T00:00:00.000Z",
      source: {
        storage: "localStorage",
        key: sourceKey,
        rawValue,
      },
      config: {
        width: 9,
        height: 9,
        mines: 10,
        generationMode: "no_guess",
      },
      best: {
        elapsedMs: 12_345,
        completedAt: "2026-07-29T08:00:00.000Z",
        metricRulesVersion: "HMS-statistics-v1",
        gameRulesVersion: null,
        trustStatus: "LOCAL_UNVERIFIED",
      },
    });
    expect(isSoloLegacyPersonalBestMetadataV1(first.metadata[0])).toBe(true);
    expect(isSoloRunRecordV1(first.metadata[0])).toBe(false);
    expect((await store.read()).records).toHaveLength(0);

    const second = await store.migrateLegacyPersonalBests(
      source.storage,
      new Date("2026-07-31T00:00:00.000Z"),
    );
    expect(second).toMatchObject({ migrated: 0, skippedExisting: 1 });
    expect(second.metadata).toHaveLength(1);
    expect(second.metadata[0]?.migratedAt).toBe(
      "2026-07-30T00:00:00.000Z",
    );
    expect(source.values.get(sourceKey)).toBe(rawValue);

    await store.clear();
    expect((await store.read()).recordCount).toBe(0);
    const afterHistoryDelete = await store.migrateLegacyPersonalBests(
      source.storage,
    );
    expect(afterHistoryDelete.metadata).toHaveLength(1);
  });

  it("preserves malformed legacy sources and corrupt metadata for recovery", async () => {
    const sourceKey = `${SOLO_LEGACY_PERSONAL_BEST_PREFIX}:9x9:10:classic`;
    const conflictedSourceKey =
      `${SOLO_LEGACY_PERSONAL_BEST_PREFIX}:16x16:40:classic`;
    const malformed = "{not-json";
    const source = legacyPersonalBestStorage({
      [sourceKey]: malformed,
      [conflictedSourceKey]: JSON.stringify({ elapsedMs: 10_000 }),
    });
    const corruptMetadata = {
      schemaVersion: 99,
      metadataId: "wrong-id-for-existing-source",
      source: { key: conflictedSourceKey },
      raw: "keep",
    };
    const store = createMemorySoloHistoryStore([], [corruptMetadata]);
    const migration = await store.migrateLegacyPersonalBests(source.storage);
    expect(migration.migrated).toBe(0);
    expect(migration.skippedExisting).toBe(1);
    expect(migration.invalidSources).toEqual([
      {
        sourceKey,
        rawValue: malformed,
        issues: expect.arrayContaining([
          "旧版 PB 值不是有效 JSON",
          "旧版 PB elapsedMs 无效",
        ]),
      },
    ]);
    expect(migration.invalidMetadataCount).toBe(1);
    expect(source.values.get(sourceKey)).toBe(malformed);

    const recovery = createSoloLegacyPersonalBestRecoveryExport(
      migration,
      new Date("2026-07-30T00:00:00.000Z"),
    );
    expect(recovery).toMatchObject({
      format: "h-minesweeper-solo-legacy-personal-best-recovery",
      schemaVersion: 1,
      invalidSourceCount: 1,
      invalidMetadataCount: 1,
      invalidSources: [{ sourceKey, rawValue: malformed }],
      rawMetadata: [corruptMetadata],
    });
  });

  it("buckets trends by full config and both rules versions", () => {
    const comparable = record("comparable", 300, 1_100, {
      speed: 2,
      ioe: 0.9,
    });
    const differentMetricRules = record("metric-v2", 400, 700, {
      metricRulesVersion: 2,
      speed: 9,
    });
    const differentGameRules = record("game-v2", 500, 600, {
      gameRulesVersion: 2,
      speed: 10,
    });
    const classic = record("classic", 600, 500, {
      mode: "classic",
      speed: 11,
    });
    expect(
      sameSoloConfigurationAndRules(
        comparable,
        CONFIG,
        "beginner",
        SOLO_METRIC_RULES_VERSION,
        SOLO_GAME_RULES_VERSION,
      ),
    ).toBe(true);

    const trend = calculateSoloTrend(
      [classic, differentGameRules, differentMetricRules, comparable],
      CONFIG,
      "beginner",
      SOLO_METRIC_RULES_VERSION,
      SOLO_GAME_RULES_VERSION,
    );
    expect(trend.runCount).toBe(1);
    expect(trend.bestThreeBvPerSecond).toBe(2);
  });

  it("keeps one trainingSessionId stable in session storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const first = getOrCreateTrainingSessionId(storage);
    const second = getOrCreateTrainingSessionId(storage);
    expect(second).toBe(first);
  });

  it("rotates trainingSessionId after 30 minutes idle and touches each new run", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const first = touchTrainingSession(storage, 1_000);
    const refreshed = touchTrainingSession(
      storage,
      1_000 + SOLO_TRAINING_SESSION_IDLE_MS - 1,
    );
    const rotated = touchTrainingSession(
      storage,
      1_000 + SOLO_TRAINING_SESSION_IDLE_MS * 2,
    );
    expect(refreshed).toBe(first);
    expect(rotated).not.toBe(first);
  });

  it("keeps qualified-session progress across solo component remounts", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const sessionId = touchTrainingSession(storage, 1_000);
    expect(
      recordTrainingSessionTerminal(sessionId, 120_000, storage, 2_000),
    ).toMatchObject({
      sessionId,
      terminalBoardCount: 1,
      effectiveInteractionMs: 120_000,
    });
    expect(touchTrainingSession(storage, 3_000)).toBe(sessionId);
    expect(
      recordTrainingSessionTerminal(sessionId, 180_000, storage, 4_000),
    ).toMatchObject({
      sessionId,
      terminalBoardCount: 2,
      effectiveInteractionMs: 300_000,
    });

    const rotated = touchTrainingSession(
      storage,
      4_000 + SOLO_TRAINING_SESSION_IDLE_MS,
    );
    expect(rotated).not.toBe(sessionId);
    expect(
      recordTrainingSessionTerminal(rotated, 60_000, storage, 5_000_000),
    ).toMatchObject({
      sessionId: rotated,
      terminalBoardCount: 1,
      effectiveInteractionMs: 60_000,
    });
  });
});
