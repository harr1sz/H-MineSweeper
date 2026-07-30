import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  PUBLIC_TELEMETRY_BATCH_ID,
  PUBLIC_TELEMETRY_COHORT_SEGMENT,
  SERVER_SCHEMA_VERSION,
  SqliteTelemetryStore,
  TelemetryAggregateCapacityError,
  TELEMETRY_PREFERENCE_MAX_FUTURE_SKEW_MS,
  sanitizeTelemetryProperties,
  type TelemetryEventV1,
  type TelemetrySession,
} from "../src/telemetry-store.js";

const temporaryDirectories: string[] = [];
const TEST_SECRET = "test-secret-that-is-long-enough-for-hmac";
const DELETION_TOKEN = "local-deletion-token-123456789012";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hms-telemetry-sqlite-"));
  temporaryDirectories.push(directory);
  return join(directory, "telemetry.sqlite");
}

function store(
  path: string,
  now: () => number,
  overrides: {
    maxSessions?: number;
    maxRawTelemetryEvents?: number;
    maxRawTelemetryBytes?: number;
    maxAggregateBuckets?: number;
  } = {},
) {
  return new SqliteTelemetryStore({
    databasePath: path,
    sessionTtlMs: 1_000,
    maxSessions: overrides.maxSessions ?? 10,
    telemetrySecret: TEST_SECRET,
    rawTelemetryTtlMs: 7_000,
    aggregateTtlMs: 30_000,
    maxRawTelemetryEvents: overrides.maxRawTelemetryEvents ?? 10,
    maxRawTelemetryBytes: overrides.maxRawTelemetryBytes ?? 100_000,
    maxAggregateBuckets: overrides.maxAggregateBuckets ?? 10_000,
    now,
  });
}

function telemetryEvent(
  now: number,
  overrides: Partial<TelemetryEventV1> = {},
): TelemetryEventV1 {
  return {
    schemaVersion: 1,
    eventId: "event_telemetry_1",
    pseudonymousInstallId: "anonymous-install-id-123",
    sessionId: "visit-session-1234567890",
    eventName: "solo_run_started",
    occurredAt: new Date(now).toISOString(),
    consentVersion: "telemetry-v1",
    appVersion: "0.2.0-alpha.1",
    properties: {
      preset: "beginner",
      generationMode: "classic",
    },
    ...overrides,
  };
}

async function createSession(
  telemetryStore: SqliteTelemetryStore,
): Promise<{
  token: string;
  session: TelemetrySession;
}> {
  const created = await telemetryStore.createSession();
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("expected telemetry session");
  return {
    token: created.telemetrySessionToken,
    session: created.session,
  };
}

describe("SqliteTelemetryStore", () => {
  it("persists only hashed public session tokens and restores them", async () => {
    let now = 10_000;
    const path = await databasePath();
    const first = store(path, () => now);
    await first.initialize();
    const created = await createSession(first);
    expect(created.session).toMatchObject({
      batchId: PUBLIC_TELEMETRY_BATCH_ID,
      cohortSegment: PUBLIC_TELEMETRY_COHORT_SEGMENT,
    });
    await first.close();

    const bytes = await readFile(path);
    expect(bytes.includes(Buffer.from(created.token))).toBe(false);

    const restored = store(path, () => now);
    await restored.initialize();
    expect(await restored.getSession(created.token)).toEqual(created.session);
    now += 1_000;
    expect(await restored.getSession(created.token)).toBeUndefined();
    await restored.close();
  });

  it("caps new sessions while preserving valid session restoration", async () => {
    let now = 20_000;
    const path = await databasePath();
    const telemetryStore = store(path, () => now, { maxSessions: 1 });
    await telemetryStore.initialize();
    const first = await createSession(telemetryStore);
    expect(await telemetryStore.createSession()).toEqual({
      ok: false,
      reason: "TELEMETRY_SESSION_CAPACITY_REACHED",
    });
    expect(await telemetryStore.getSession(first.token)).toEqual(first.session);

    now += 1_000;
    expect((await telemetryStore.createSession()).ok).toBe(true);
    await telemetryStore.close();
  });

  it("requires an enabled current preference and enforces deletion proof", async () => {
    const now = 30_000;
    const path = await databasePath();
    const telemetryStore = store(path, () => now);
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);
    const event = telemetryEvent(now);

    await expect(
      telemetryStore.ingestTelemetry([event], DELETION_TOKEN, session),
    ).resolves.toEqual({
      ok: false,
      reason: "TELEMETRY_NOT_ENABLED",
    });

    await telemetryStore.recordTelemetryPreference(
      session,
      true,
      "telemetry-v1",
      "0.2.0-alpha.1",
      now,
    );
    await expect(
      telemetryStore.ingestTelemetry([event], DELETION_TOKEN, session),
    ).resolves.toEqual({
      ok: true,
      accepted: 1,
      duplicates: 0,
      discarded: 0,
      deletionEpoch: 0,
      deletedBefore: null,
    });
    await expect(
      telemetryStore.ingestTelemetry([event], DELETION_TOKEN, session),
    ).resolves.toEqual({
      ok: true,
      accepted: 0,
      duplicates: 1,
      discarded: 0,
      deletionEpoch: 0,
      deletedBefore: null,
    });

    await telemetryStore.recordTelemetryPreference(
      session,
      false,
      "telemetry-v1",
      "0.2.0-alpha.1",
      now + 1,
    );
    await expect(
      telemetryStore.ingestTelemetry(
        [telemetryEvent(now, { eventId: "event_after_opt_out" })],
        DELETION_TOKEN,
        session,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "TELEMETRY_NOT_ENABLED",
    });
    expect(
      await telemetryStore.deleteTelemetry(
        event.pseudonymousInstallId,
        "wrong-deletion-token-123456789012",
      ),
    ).toBeUndefined();
    expect(
      await telemetryStore.deleteTelemetry(
        event.pseudonymousInstallId,
        DELETION_TOKEN,
      ),
    ).toEqual({
      deleted: 1,
      deletionEpoch: 1,
      deletedBefore: new Date(now).toISOString(),
    });
    await telemetryStore.close();
  });

  it("persists a deletion epoch and discards stale-tab events after deletion", async () => {
    let now = 31_000;
    const path = await databasePath();
    const telemetryStore = store(path, () => now);
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);
    await telemetryStore.recordTelemetryPreference(
      session,
      true,
      "telemetry-v1",
      "0.2.0-alpha.1",
      now,
    );
    const staleEvent = telemetryEvent(now, {
      eventId: "event_queued_in_stale_tab",
    });

    const deletion = await telemetryStore.deleteTelemetry(
      staleEvent.pseudonymousInstallId,
      DELETION_TOKEN,
    );
    expect(deletion).toEqual({
      deleted: 0,
      deletionEpoch: 1,
      deletedBefore: new Date(now).toISOString(),
    });
    await telemetryStore.close();

    const restored = store(path, () => now);
    await restored.initialize();
    await expect(
      restored.ingestTelemetry(
        [staleEvent],
        DELETION_TOKEN,
        session,
        0,
      ),
    ).resolves.toEqual({
      ok: true,
      accepted: 0,
      duplicates: 0,
      discarded: 1,
      deletionEpoch: 1,
      deletedBefore: new Date(now).toISOString(),
    });
    expect(restored.status().rawTelemetryEvents).toBe(0);

    now += 1;
    await expect(
      restored.ingestTelemetry(
        [
          telemetryEvent(now, {
            eventId: "event_after_deletion_boundary",
          }),
        ],
        DELETION_TOKEN,
        session,
        0,
      ),
    ).resolves.toMatchObject({
      ok: true,
      accepted: 1,
      discarded: 0,
      deletionEpoch: 1,
    });
    await restored.close();
  });

  it("rejects events that predate or mismatch the acknowledged consent", async () => {
    const decisionAt = 32_000;
    const path = await databasePath();
    const telemetryStore = store(path, () => decisionAt);
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);
    await telemetryStore.recordTelemetryPreference(
      session,
      true,
      "telemetry-v1",
      "0.2.0-alpha.1",
      decisionAt,
    );

    for (const mismatched of [
      telemetryEvent(decisionAt - 1, { eventId: "event_pre_consent" }),
      telemetryEvent(decisionAt, {
        eventId: "event_wrong_consent",
        consentVersion: "telemetry-v0",
      }),
      telemetryEvent(decisionAt, {
        eventId: "event_wrong_app",
        appVersion: "0.2.0-alpha.0",
      }),
    ]) {
      await expect(
        telemetryStore.ingestTelemetry(
          [mismatched],
          DELETION_TOKEN,
          session,
        ),
      ).resolves.toEqual({
        ok: false,
        reason: "TELEMETRY_CONSENT_MISMATCH",
      });
    }
    expect(telemetryStore.status().rawTelemetryEvents).toBe(0);
    await telemetryStore.close();
  });

  it("orders preference decisions and gives opt-out priority on timestamp ties", async () => {
    const t1 = Date.UTC(2026, 6, 30, 10, 0, 0);
    const t2 = t1 + 1_000;
    const t3 = t2 + 1_000;
    const now = t3;
    const path = await databasePath();
    const telemetryStore = store(path, () => now);
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);

    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        true,
        "telemetry-v1",
        "0.2.0-alpha.1",
        t2,
      ),
    ).resolves.toBe(true);
    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        false,
        "telemetry-v1",
        "0.2.0-alpha.1",
        t2,
      ),
    ).resolves.toBe(true);
    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        true,
        "telemetry-v1",
        "0.2.0-alpha.1",
        t1,
      ),
    ).resolves.toBe(false);
    await expect(
      telemetryStore.ingestTelemetry(
        [telemetryEvent(now, { eventId: "event_after_stale_enable" })],
        DELETION_TOKEN,
        session,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "TELEMETRY_NOT_ENABLED",
    });

    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        true,
        "telemetry-v1",
        "0.2.0-alpha.1",
        t3,
      ),
    ).resolves.toBe(true);
    await expect(
      telemetryStore.ingestTelemetry(
        [telemetryEvent(now, { eventId: "event_after_explicit_reenable" })],
        DELETION_TOKEN,
        session,
      ),
    ).resolves.toMatchObject({ ok: true, accepted: 1, duplicates: 0 });

    const database = new DatabaseSync(path, { readOnly: true });
    expect(
      database
        .prepare(`
          SELECT enabled, ever_opted_out AS everOptedOut,
                 decision_at AS decisionAt
          FROM telemetry_preferences
          WHERE telemetry_session_id = ?
        `)
        .get(session.sessionId),
    ).toEqual({ enabled: 1, everOptedOut: 1, decisionAt: t3 });
    database.close();
    await telemetryStore.close();
  });

  it("treats an identical persisted preference as idempotent and refreshes its app version", async () => {
    const now = Date.UTC(2026, 6, 30, 11, 0, 0);
    const decisionAt = now - 1_000;
    const path = await databasePath();
    const telemetryStore = store(path, () => now);
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);

    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        true,
        "telemetry-v1",
        "0.2.0-alpha.0",
        decisionAt,
      ),
    ).resolves.toBe(true);
    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        true,
        "telemetry-v1",
        "0.2.0-alpha.1",
        decisionAt,
      ),
    ).resolves.toBe(true);

    const database = new DatabaseSync(path, { readOnly: true });
    expect(
      database
        .prepare(`
          SELECT enabled, decision_at AS decisionAt,
                 app_version AS appVersion
          FROM telemetry_preferences
          WHERE telemetry_session_id = ?
        `)
        .get(session.sessionId),
    ).toEqual({
      enabled: 1,
      decisionAt,
      appVersion: "0.2.0-alpha.1",
    });
    expect(
      database
        .prepare(`
          SELECT count
          FROM telemetry_aggregates
          WHERE event_name = 'telemetry_preference_acknowledged'
        `)
        .get(),
    ).toEqual({ count: 1 });
    database.close();
    await telemetryStore.close();
  });

  it("hard-stops preference aggregate bucket growth at the configured cap", async () => {
    const now = Date.UTC(2026, 6, 30, 11, 30, 0);
    const path = await databasePath();
    const telemetryStore = store(path, () => now, {
      maxAggregateBuckets: 1,
    });
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);
    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        true,
        "telemetry-v1",
        "0.2.0-alpha.1",
        now,
      ),
    ).resolves.toBe(true);
    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        false,
        "telemetry-v1",
        "0.2.0-alpha.1",
        now + 1,
        now + 1,
      ),
    ).rejects.toBeInstanceOf(TelemetryAggregateCapacityError);

    const database = new DatabaseSync(path, { readOnly: true });
    expect(
      database
        .prepare(`
          SELECT enabled, ever_opted_out AS everOptedOut
          FROM telemetry_preferences
          WHERE telemetry_session_id = ?
        `)
        .get(session.sessionId),
    ).toEqual({ enabled: 1, everOptedOut: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM telemetry_aggregates")
        .get(),
    ).toEqual({ count: 1 });
    database.close();
    await telemetryStore.close();
  });

  it("reclaims expired aggregate buckets before applying the hard cap", async () => {
    let now = Date.UTC(2026, 6, 30, 11, 45, 0);
    const path = await databasePath();
    const telemetryStore = store(path, () => now, {
      maxAggregateBuckets: 1,
    });
    await telemetryStore.initialize();
    const first = await createSession(telemetryStore);
    await telemetryStore.recordTelemetryPreference(
      first.session,
      true,
      "telemetry-v1",
      "0.2.0-alpha.1",
      now,
    );

    now += 30_001;
    const second = await createSession(telemetryStore);
    await expect(
      telemetryStore.recordTelemetryPreference(
        second.session,
        true,
        "telemetry-v1",
        "0.2.0-alpha.1",
        now,
      ),
    ).resolves.toBe(true);
    expect(telemetryStore.status()).toMatchObject({
      aggregateBuckets: 1,
      discardedAggregateRows: 0,
    });
    await telemetryStore.close();
  });

  it("retains a stale opt-out as audit history without changing the newer current preference", async () => {
    const now = Date.UTC(2026, 6, 30, 12, 0, 0);
    const path = await databasePath();
    const telemetryStore = store(path, () => now);
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);
    const currentDecisionAt = now - 1_000;
    const firstOptOutAt = now - 3_000;
    const earlierOptOutAt = now - 4_000;

    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        true,
        "telemetry-v1",
        "0.2.0-alpha.1",
        currentDecisionAt,
      ),
    ).resolves.toBe(true);
    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        false,
        "telemetry-v1",
        "0.2.0-alpha.1",
        firstOptOutAt,
      ),
    ).resolves.toBe(false);
    await expect(
      telemetryStore.recordTelemetryPreference(
        session,
        false,
        "telemetry-v1",
        "0.2.0-alpha.1",
        earlierOptOutAt,
      ),
    ).resolves.toBe(false);
    await expect(
      telemetryStore.ingestTelemetry(
        [telemetryEvent(now, { eventId: "event_current_enable_survives" })],
        DELETION_TOKEN,
        session,
      ),
    ).resolves.toMatchObject({ ok: true, accepted: 1, duplicates: 0 });

    const database = new DatabaseSync(path, { readOnly: true });
    expect(
      database
        .prepare(`
          SELECT enabled, ever_opted_out AS everOptedOut,
                 decision_at AS decisionAt,
                 first_opt_out_at AS firstOptOutAt
          FROM telemetry_preferences
          WHERE telemetry_session_id = ?
        `)
        .get(session.sessionId),
    ).toEqual({
      enabled: 1,
      everOptedOut: 1,
      decisionAt: currentDecisionAt,
      firstOptOutAt: earlierOptOutAt,
    });
    expect(
      database
        .prepare(`
          SELECT count
          FROM telemetry_aggregates
          WHERE event_name = 'telemetry_preference_opted_out'
        `)
        .get(),
    ).toEqual({ count: 1 });
    database.close();
    await telemetryStore.close();
  });

  it("rejects unsafe or excessively future preference timestamps", async () => {
    const now = Date.UTC(2026, 6, 30, 12, 0, 0);
    const path = await databasePath();
    const telemetryStore = store(path, () => now);
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);

    for (const decisionAt of [
      Number.MAX_SAFE_INTEGER + 1,
      now + TELEMETRY_PREFERENCE_MAX_FUTURE_SKEW_MS + 1,
    ]) {
      await expect(
        telemetryStore.recordTelemetryPreference(
          session,
          true,
          "telemetry-v1",
          "0.2.0-alpha.1",
          decisionAt,
        ),
      ).rejects.toThrow(RangeError);
    }
    await telemetryStore.close();
  });

  it("aggregates expired raw events without retaining attributable IDs", async () => {
    let now = Date.UTC(2026, 6, 30);
    const path = await databasePath();
    const telemetryStore = store(path, () => now);
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);
    await telemetryStore.recordTelemetryPreference(
      session,
      true,
      "telemetry-v1",
      "0.2.0-alpha.1",
      now,
    );
    await telemetryStore.ingestTelemetry(
      [telemetryEvent(now)],
      DELETION_TOKEN,
      session,
    );

    now += 7_001;
    await telemetryStore.sweep();
    expect(telemetryStore.status()).toMatchObject({
      rawTelemetryEvents: 0,
      aggregateBuckets: 2,
    });
    await telemetryStore.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const aggregate = database
      .prepare(`
        SELECT * FROM telemetry_aggregates
        WHERE event_name = 'solo_run_started'
      `)
      .get() as Record<string, unknown>;
    expect(aggregate).toMatchObject({
      event_name: "solo_run_started",
      batch_id: "public",
      cohort_segment: "unsegmented",
      count: 1,
      expires_at: Date.UTC(2026, 6, 30) + 30_000,
    });
    expect(Object.keys(aggregate)).not.toContain(
      "pseudonymous_install_id",
    );
    database.close();
  });

  it("deletes expired raw events even when the anonymous aggregate cap is full", async () => {
    let now = Date.UTC(2026, 6, 30, 13, 0, 0);
    const path = await databasePath();
    const telemetryStore = store(path, () => now, {
      maxAggregateBuckets: 2,
    });
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);
    await telemetryStore.recordTelemetryPreference(
      session,
      true,
      "telemetry-v1",
      "0.2.0-alpha.1",
      now,
    );
    await expect(
      telemetryStore.ingestTelemetry(
        [telemetryEvent(now)],
        DELETION_TOKEN,
        session,
      ),
    ).resolves.toMatchObject({ ok: true, accepted: 1 });
    await telemetryStore.recordTelemetryPreference(
      session,
      false,
      "telemetry-v1",
      "0.2.0-alpha.1",
      now + 1,
      now + 1,
    );
    expect(telemetryStore.status()).toMatchObject({
      rawTelemetryEvents: 1,
      aggregateBuckets: 2,
      acceptingAggregates: false,
    });

    now += 7_001;
    await telemetryStore.sweep();
    expect(telemetryStore.status()).toMatchObject({
      rawTelemetryEvents: 0,
      aggregateBuckets: 2,
      discardedAggregateRows: 1,
    });
    await telemetryStore.close();

    const restored = store(path, () => now, {
      maxAggregateBuckets: 2,
    });
    await restored.initialize();
    expect(restored.status().discardedAggregateRows).toBe(1);
    await restored.close();
  });

  it("rejects new raw events before exceeding storage capacity", async () => {
    const now = 40_000;
    const path = await databasePath();
    const telemetryStore = store(path, () => now, {
      maxRawTelemetryEvents: 1,
      maxRawTelemetryBytes: 10_000,
    });
    await telemetryStore.initialize();
    const { session } = await createSession(telemetryStore);
    await telemetryStore.recordTelemetryPreference(
      session,
      true,
      "telemetry-v1",
      "0.2.0-alpha.1",
      now,
    );
    expect(
      await telemetryStore.ingestTelemetry(
        [telemetryEvent(now)],
        DELETION_TOKEN,
        session,
      ),
    ).toMatchObject({ ok: true, accepted: 1 });
    expect(
      await telemetryStore.ingestTelemetry(
        [telemetryEvent(now)],
        DELETION_TOKEN,
        session,
      ),
    ).toMatchObject({ ok: true, accepted: 0, duplicates: 1 });
    expect(
      await telemetryStore.ingestTelemetry(
        [telemetryEvent(now, { eventId: "event_telemetry_2" })],
        DELETION_TOKEN,
        session,
      ),
    ).toEqual({
      ok: false,
      reason: "TELEMETRY_CAPACITY_REACHED",
    });
    await telemetryStore.close();
  });

  it("creates only the clean v4 public telemetry schema", async () => {
    const path = await databasePath();
    const telemetryStore = store(path, () => 50_000);
    await telemetryStore.initialize();
    await telemetryStore.close();

    const database = new DatabaseSync(path, { readOnly: true });
    expect(
      database.prepare("SELECT version FROM schema_meta").get(),
    ).toEqual({ version: SERVER_SCHEMA_VERSION });
    const tables = (
      database
        .prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table'
          ORDER BY name
        `)
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(tables).toEqual([
      "schema_meta",
      "telemetry_aggregates",
      "telemetry_deletions",
      "telemetry_preferences",
      "telemetry_raw",
      "telemetry_sessions",
    ]);
    const columns = (table: string) =>
      (
        database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
    expect(columns("telemetry_sessions")).toEqual([
      "session_id",
      "token_hash",
      "batch_id",
      "cohort_segment",
      "expires_at",
    ]);
    expect(columns("telemetry_preferences")).toContain(
      "telemetry_session_id",
    );
    expect(columns("telemetry_preferences")).toContain("decision_at");
    expect(columns("telemetry_preferences")).toContain(
      "first_opt_out_at",
    );
    expect(columns("telemetry_deletions")).toEqual([
      "pseudonymous_install_id",
      "deletion_token_hash",
      "deletion_epoch",
      "deleted_before",
      "expires_at",
    ]);
    expect(columns("telemetry_raw")).toContain("telemetry_session_id");
    database.close();
  });

  it("atomically migrates v3 preference timestamps to v4", async () => {
    const path = await databasePath();
    const updatedAt = Date.UTC(2026, 6, 29, 12, 0, 0);
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_meta(version) VALUES (3);
      CREATE TABLE telemetry_sessions (
        session_id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        batch_id TEXT NOT NULL CHECK(batch_id = 'public'),
        cohort_segment TEXT NOT NULL CHECK(cohort_segment = 'unsegmented'),
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE telemetry_preferences (
        telemetry_session_id TEXT PRIMARY KEY
          REFERENCES telemetry_sessions(session_id),
        batch_id TEXT NOT NULL CHECK(batch_id = 'public'),
        cohort_segment TEXT NOT NULL CHECK(cohort_segment = 'unsegmented'),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        ever_opted_out INTEGER NOT NULL CHECK(ever_opted_out IN (0, 1)),
        consent_version TEXT NOT NULL,
        app_version TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
    `);
    database
      .prepare(`
        INSERT INTO telemetry_sessions(
          session_id, token_hash, batch_id, cohort_segment, expires_at
        ) VALUES (?, ?, 'public', 'unsegmented', ?)
      `)
      .run("session-v3", "token-hash-v3", updatedAt + 100_000);
    database
      .prepare(`
        INSERT INTO telemetry_preferences(
          telemetry_session_id, batch_id, cohort_segment, enabled,
          ever_opted_out, consent_version, app_version, updated_at, expires_at
        ) VALUES (?, 'public', 'unsegmented', 0, 1, ?, ?, ?, ?)
      `)
      .run(
        "session-v3",
        "telemetry-v1",
        "0.2.0-alpha.0",
        updatedAt,
        updatedAt + 100_000,
      );
    database.close();

    const telemetryStore = store(path, () => updatedAt);
    await telemetryStore.initialize();
    await telemetryStore.close();

    const migrated = new DatabaseSync(path, { readOnly: true });
    expect(migrated.prepare("SELECT version FROM schema_meta").get()).toEqual({
      version: SERVER_SCHEMA_VERSION,
    });
    expect(
      migrated
        .prepare(`
          SELECT decision_at AS decisionAt,
                 first_opt_out_at AS firstOptOutAt
          FROM telemetry_preferences
          WHERE telemetry_session_id = 'session-v3'
        `)
        .get(),
    ).toEqual({
      decisionAt: updatedAt,
      firstOptOutAt: updatedAt,
    });
    migrated.close();
  });

  it("refuses an unsupported versioned telemetry schema", async () => {
    const path = await databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_meta(version) VALUES (2);
    `);
    database.close();

    const telemetryStore = store(path, () => 60_000);
    await expect(telemetryStore.initialize()).rejects.toThrow(
      "Unsupported telemetry server schema version 2",
    );
    await telemetryStore.close();
  });

  it("rejects an interrupted initialization with empty schema metadata", async () => {
    const path = await databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL) STRICT;
      CREATE TABLE telemetry_sessions (
        session_id TEXT PRIMARY KEY
      ) STRICT;
    `);
    database.close();

    const telemetryStore = store(path, () => 60_000);
    await expect(telemetryStore.initialize()).rejects.toThrow(
      "expected exactly one version row",
    );
    await telemetryStore.close();
  });

  it("rejects a claimed v4 schema with a missing required column", async () => {
    const path = await databasePath();
    const bootstrap = store(path, () => 61_000);
    await bootstrap.initialize();
    await bootstrap.close();
    const database = new DatabaseSync(path);
    database.exec(`
      ALTER TABLE telemetry_raw RENAME TO telemetry_raw_valid;
      CREATE TABLE telemetry_raw (
        event_id TEXT NOT NULL,
        pseudonymous_install_id TEXT NOT NULL,
        visit_session_id TEXT NOT NULL,
        telemetry_session_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        cohort_segment TEXT NOT NULL,
        event_name TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        consent_version TEXT NOT NULL,
        app_version TEXT NOT NULL,
        properties_json TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (pseudonymous_install_id, event_id)
      ) STRICT;
      DROP TABLE telemetry_raw_valid;
    `);
    database.close();

    const telemetryStore = store(path, () => 61_000);
    await expect(telemetryStore.initialize()).rejects.toThrow(
      "telemetry_raw is missing payload_bytes",
    );
    await telemetryStore.close();
  });

  it("rejects a claimed v4 schema with a missing required table", async () => {
    const path = await databasePath();
    const bootstrap = store(path, () => 62_000);
    await bootstrap.initialize();
    await bootstrap.close();
    const database = new DatabaseSync(path);
    database.exec("DROP TABLE telemetry_aggregates");
    database.close();

    const telemetryStore = store(path, () => 62_000);
    await expect(telemetryStore.initialize()).rejects.toThrow(
      "required table telemetry_aggregates is missing",
    );
    await telemetryStore.close();
  });

  it("accepts explicit nulls but rejects free-form enum values", () => {
    expect(
      sanitizeTelemetryProperties("app_ready", {
        browserFamily: "chrome",
        deviceClass: null,
      }),
    ).toEqual({ browserFamily: "chrome", deviceClass: null });
    expect(
      sanitizeTelemetryProperties("duel_started", {
        source: "attacker-controlled-source",
        round: 1,
      }),
    ).toBeUndefined();
  });
});
