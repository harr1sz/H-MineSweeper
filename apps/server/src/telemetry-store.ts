import { createHash, createHmac, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// v4 is the unreleased v0.2 Alpha RC baseline. Initialization normalizes the
// deletion-tombstone and operational-counter columns before this schema ships.
export const SERVER_SCHEMA_VERSION = 4 as const;
export const TELEMETRY_PREFERENCE_MAX_FUTURE_SKEW_MS =
  5 * 60 * 1_000;

// Fixed operational dimensions for open public traffic. They do not identify
// a participant roster or gate product access.
export const PUBLIC_TELEMETRY_BATCH_ID = "public" as const;
export const PUBLIC_TELEMETRY_COHORT_SEGMENT = "unsegmented" as const;

export const TELEMETRY_EVENT_NAMES = [
  "app_ready",
  "mode_selected",
  "solo_run_started",
  "solo_run_terminal",
  "solo_history_opened",
  "solo_history_filtered",
  "solo_exported",
  "no_guess_generation_finished",
  "duel_invite_created",
  "duel_invite_opened",
  "duel_joined",
  "duel_started",
  "duel_completed",
  "duel_dnf",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
export type TelemetryProperty = string | number | boolean | null;

export interface TelemetryEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly pseudonymousInstallId: string;
  readonly sessionId: string;
  readonly eventName: TelemetryEventName;
  readonly occurredAt: string;
  readonly consentVersion: string;
  readonly appVersion: string;
  readonly properties: Readonly<Record<string, TelemetryProperty>>;
}

export interface TelemetrySession {
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly batchId: typeof PUBLIC_TELEMETRY_BATCH_ID;
  readonly cohortSegment: typeof PUBLIC_TELEMETRY_COHORT_SEGMENT;
}

export type CreateTelemetrySessionResult =
  | {
      readonly ok: true;
      readonly telemetrySessionToken: string;
      readonly session: TelemetrySession;
    }
  | {
      readonly ok: false;
      readonly reason: "TELEMETRY_SESSION_CAPACITY_REACHED";
    };

export type TelemetryIngestResult =
  | {
      readonly ok: true;
      readonly accepted: number;
      readonly duplicates: number;
      readonly discarded: number;
      readonly deletionEpoch: number;
      readonly deletedBefore: string | null;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "INVALID_DELETION_TOKEN"
        | "INVALID_DELETION_EPOCH"
        | "TELEMETRY_NOT_ENABLED"
        | "TELEMETRY_CONSENT_MISMATCH"
        | "TELEMETRY_CAPACITY_REACHED";
    };

export interface DeleteTelemetryResult {
  readonly deleted: number;
  readonly deletionEpoch: number;
  readonly deletedBefore: string;
}

export class TelemetryAggregateCapacityError extends Error {
  constructor() {
    super("Telemetry aggregate bucket capacity has been reached");
    this.name = "TelemetryAggregateCapacityError";
  }
}

export interface TelemetryStoreStatus {
  readonly ready: boolean;
  readonly writable: boolean;
  readonly persistent: boolean;
  readonly sessions: number;
  readonly acceptingNewSessions: boolean;
  readonly rawTelemetryEvents: number;
  readonly rawTelemetryBytes: number;
  readonly acceptingTelemetry: boolean;
  readonly aggregateBuckets: number;
  readonly acceptingAggregates: boolean;
  readonly discardedAggregateRows: number;
}

export interface TelemetryStore {
  initialize(): Promise<void>;
  createSession(now?: number): Promise<CreateTelemetrySessionResult>;
  getSession(token: string, now?: number): Promise<TelemetrySession | undefined>;
  ingestTelemetry(
    events: readonly TelemetryEventV1[],
    deletionToken: string,
    telemetrySession: TelemetrySession,
    deletionEpoch?: number,
    now?: number,
  ): Promise<TelemetryIngestResult>;
  recordTelemetryPreference(
    telemetrySession: TelemetrySession,
    enabled: boolean,
    consentVersion: string,
    appVersion: string,
    decisionAt: number,
    now?: number,
  ): Promise<boolean>;
  deleteTelemetry(
    pseudonymousInstallId: string,
    deletionToken: string,
    now?: number,
  ): Promise<DeleteTelemetryResult | undefined>;
  sweep(now?: number): Promise<void>;
  status(): TelemetryStoreStatus;
  close(): Promise<void>;
}

export interface SqliteTelemetryStoreOptions {
  readonly databasePath: string;
  readonly sessionTtlMs: number;
  readonly maxSessions: number;
  readonly telemetrySecret: string;
  readonly rawTelemetryTtlMs: number;
  readonly aggregateTtlMs: number;
  readonly maxRawTelemetryEvents: number;
  readonly maxRawTelemetryBytes: number;
  readonly maxAggregateBuckets?: number;
  readonly now?: () => number;
}

interface CountRow {
  readonly count: number;
}

interface AggregateBucketKey {
  readonly day: string;
  readonly eventName: string;
  readonly appVersion: string;
  readonly batchId: string;
  readonly cohortSegment: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function opaqueToken(): string {
  return createHash("sha256")
    .update(`${randomUUID()}:${randomUUID()}`)
    .digest("base64url");
}

export function isValidTelemetryPreferenceDecisionAt(
  decisionAt: number,
  now: number,
): boolean {
  return (
    Number.isSafeInteger(decisionAt) &&
    Number.isSafeInteger(now) &&
    decisionAt <= now + TELEMETRY_PREFERENCE_MAX_FUTURE_SKEW_MS
  );
}

export class SqliteTelemetryStore implements TelemetryStore {
  readonly #database: DatabaseSync;
  readonly #persistent: boolean;
  readonly #sessionTtlMs: number;
  readonly #maxSessions: number;
  readonly #telemetrySecret: string;
  readonly #rawTelemetryTtlMs: number;
  readonly #aggregateTtlMs: number;
  readonly #maxRawTelemetryEvents: number;
  readonly #maxRawTelemetryBytes: number;
  readonly #maxAggregateBuckets: number;
  readonly #now: () => number;
  #initialized = false;

  constructor(options: SqliteTelemetryStoreOptions) {
    this.#database = new DatabaseSync(options.databasePath);
    this.#persistent = options.databasePath !== ":memory:";
    this.#sessionTtlMs = options.sessionTtlMs;
    this.#maxSessions = options.maxSessions;
    this.#telemetrySecret = options.telemetrySecret;
    this.#rawTelemetryTtlMs = options.rawTelemetryTtlMs;
    this.#aggregateTtlMs = options.aggregateTtlMs;
    this.#maxRawTelemetryEvents = options.maxRawTelemetryEvents;
    this.#maxRawTelemetryBytes = options.maxRawTelemetryBytes;
    this.#maxAggregateBuckets = options.maxAggregateBuckets ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
    const existingTables = (
      this.#database
        .prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        `)
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    const freshDatabase = existingTables.length === 0;
    if (
      !freshDatabase &&
      !existingTables.includes("schema_meta")
    ) {
      throw new Error(
        "Unversioned server database detected; use a supported telemetry database",
      );
    }
    if (freshDatabase) this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        version INTEGER NOT NULL,
        discarded_aggregate_rows INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
      const metadataRows = this.#database
        .prepare("SELECT version FROM schema_meta")
        .all() as Array<{ version: number }>;
      if (!freshDatabase && metadataRows.length !== 1) {
        throw new Error(
          "Invalid telemetry schema metadata: expected exactly one version row",
        );
      }
      const meta = metadataRows[0];
      if (
        meta?.version !== undefined &&
        meta.version !== 3 &&
        meta.version !== SERVER_SCHEMA_VERSION
      ) {
        throw new Error(
          `Unsupported telemetry server schema version ${meta.version}`,
        );
      }
      if (meta?.version === SERVER_SCHEMA_VERSION) {
        this.assertRequiredTablesExist();
        this.transaction(() => {
          this.ensureSchemaMetaColumns();
          this.ensureDeletionTombstoneColumns();
          this.validateSchema();
        });
        this.#initialized = true;
        await this.sweep();
        return;
      }
      if (meta?.version === 3) {
        this.transaction(() => {
          this.ensureSchemaMetaColumns();
          const preferenceColumns = (
            this.#database
              .prepare("PRAGMA table_info(telemetry_preferences)")
              .all() as Array<{ name: string }>
          ).map(({ name }) => name);
          if (!preferenceColumns.includes("decision_at")) {
            this.#database.exec(`
            ALTER TABLE telemetry_preferences
              ADD COLUMN decision_at INTEGER NOT NULL DEFAULT 0;
            UPDATE telemetry_preferences
              SET decision_at = updated_at;
          `);
          }
          if (!preferenceColumns.includes("first_opt_out_at")) {
            this.#database.exec(`
            ALTER TABLE telemetry_preferences
              ADD COLUMN first_opt_out_at INTEGER;
            UPDATE telemetry_preferences
              SET first_opt_out_at = updated_at
              WHERE ever_opted_out = 1;
          `);
          }
          this.#database
            .prepare("UPDATE schema_meta SET version = ?")
            .run(SERVER_SCHEMA_VERSION);
        });
      }

      this.#database.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_sessions (
        session_id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        batch_id TEXT NOT NULL CHECK(batch_id = 'public'),
        cohort_segment TEXT NOT NULL CHECK(cohort_segment = 'unsegmented'),
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS telemetry_sessions_expiry
        ON telemetry_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS telemetry_deletions (
        pseudonymous_install_id TEXT PRIMARY KEY,
        deletion_token_hash TEXT NOT NULL,
        deletion_epoch INTEGER NOT NULL DEFAULT 0,
        deleted_before INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS telemetry_preferences (
        telemetry_session_id TEXT PRIMARY KEY
          REFERENCES telemetry_sessions(session_id),
        batch_id TEXT NOT NULL CHECK(batch_id = 'public'),
        cohort_segment TEXT NOT NULL CHECK(cohort_segment = 'unsegmented'),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        ever_opted_out INTEGER NOT NULL CHECK(ever_opted_out IN (0, 1)),
        consent_version TEXT NOT NULL,
        app_version TEXT NOT NULL,
        decision_at INTEGER NOT NULL,
        first_opt_out_at INTEGER,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS telemetry_preferences_expiry
        ON telemetry_preferences(expires_at);
      CREATE TABLE IF NOT EXISTS telemetry_raw (
        event_id TEXT NOT NULL,
        pseudonymous_install_id TEXT NOT NULL,
        visit_session_id TEXT NOT NULL,
        telemetry_session_id TEXT NOT NULL
          REFERENCES telemetry_sessions(session_id),
        batch_id TEXT NOT NULL CHECK(batch_id = 'public'),
        cohort_segment TEXT NOT NULL CHECK(cohort_segment = 'unsegmented'),
        event_name TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        consent_version TEXT NOT NULL,
        app_version TEXT NOT NULL,
        properties_json TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        payload_bytes INTEGER NOT NULL,
        PRIMARY KEY (pseudonymous_install_id, event_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS telemetry_raw_expiry
        ON telemetry_raw(expires_at);
      CREATE TABLE IF NOT EXISTS telemetry_aggregates (
        day TEXT NOT NULL,
        event_name TEXT NOT NULL,
        app_version TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        cohort_segment TEXT NOT NULL,
        count INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (
          day, event_name, app_version, batch_id, cohort_segment
        )
      ) STRICT;
    `);
      this.ensureDeletionTombstoneColumns();
      this.ensureSchemaMetaColumns();
      if (meta?.version === undefined) {
        this.#database
          .prepare("INSERT INTO schema_meta(version) VALUES (?)")
          .run(SERVER_SCHEMA_VERSION);
      }
      this.validateSchema();
      if (freshDatabase) this.#database.exec("COMMIT");
    } catch (error) {
      if (freshDatabase) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // Preserve the initialization failure that triggered the rollback.
        }
      }
      throw error;
    }
    this.#initialized = true;
    await this.sweep();
  }

  async createSession(
    now = this.#now(),
  ): Promise<CreateTelemetrySessionResult> {
    this.assertInitialized();
    let result: CreateTelemetrySessionResult = {
      ok: false,
      reason: "TELEMETRY_SESSION_CAPACITY_REACHED",
    };
    this.transaction(() => {
      const active = this.#database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM telemetry_sessions
          WHERE expires_at > ?
        `)
        .get(now) as unknown as CountRow;
      if (active.count >= this.#maxSessions) return;

      const telemetrySessionToken = opaqueToken();
      const session: TelemetrySession = {
        sessionId: randomUUID(),
        expiresAt: now + this.#sessionTtlMs,
        batchId: PUBLIC_TELEMETRY_BATCH_ID,
        cohortSegment: PUBLIC_TELEMETRY_COHORT_SEGMENT,
      };
      this.#database
        .prepare(`
          INSERT INTO telemetry_sessions(
            session_id, token_hash, batch_id, cohort_segment, expires_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          session.sessionId,
          sha256(telemetrySessionToken),
          session.batchId,
          session.cohortSegment,
          session.expiresAt,
        );
      result = { ok: true, telemetrySessionToken, session };
    });
    return result;
  }

  async getSession(
    token: string,
    now = this.#now(),
  ): Promise<TelemetrySession | undefined> {
    this.assertInitialized();
    return this.#database
      .prepare(`
        SELECT session_id AS sessionId, expires_at AS expiresAt,
               batch_id AS batchId, cohort_segment AS cohortSegment
        FROM telemetry_sessions
        WHERE token_hash = ? AND expires_at > ?
      `)
      .get(sha256(token), now) as TelemetrySession | undefined;
  }

  async ingestTelemetry(
    events: readonly TelemetryEventV1[],
    deletionToken: string,
    telemetrySession: TelemetrySession,
    deletionEpoch = 0,
    now = this.#now(),
  ): Promise<TelemetryIngestResult> {
    this.assertInitialized();
    const preference = this.#database
      .prepare(`
        SELECT enabled, consent_version AS consentVersion,
               app_version AS appVersion, decision_at AS decisionAt
        FROM telemetry_preferences
        WHERE telemetry_session_id = ? AND expires_at > ?
      `)
      .get(telemetrySession.sessionId, now) as
      | {
          enabled: number;
          consentVersion: string;
          appVersion: string;
          decisionAt: number;
        }
      | undefined;
    if (preference?.enabled !== 1) {
      return { ok: false, reason: "TELEMETRY_NOT_ENABLED" };
    }
    if (
      events.some(
        (event) =>
          event.consentVersion !== preference.consentVersion ||
          event.appVersion !== preference.appVersion ||
          Date.parse(event.occurredAt) < preference.decisionAt,
      )
    ) {
      return { ok: false, reason: "TELEMETRY_CONSENT_MISMATCH" };
    }
    if (
      !Number.isSafeInteger(deletionEpoch) ||
      deletionEpoch < 0
    ) {
      return { ok: false, reason: "INVALID_DELETION_EPOCH" };
    }
    const pseudonyms = new Map(
      events.map((event) => [
        event.pseudonymousInstallId,
        this.pseudonymize(event.pseudonymousInstallId),
      ]),
    );
    const deletionHash = sha256(deletionToken);
    const deletionStates = new Map<
      string,
      {
        readonly deletionTokenHash: string;
        readonly deletionEpoch: number;
        readonly deletedBefore: number;
      }
    >();
    for (const pseudonym of pseudonyms.values()) {
      const existing = this.#database
        .prepare(`
          SELECT deletion_token_hash AS deletionTokenHash,
                 deletion_epoch AS deletionEpoch,
                 deleted_before AS deletedBefore
          FROM telemetry_deletions
          WHERE pseudonymous_install_id = ?
        `)
        .get(pseudonym) as
        | {
            deletionTokenHash: string;
            deletionEpoch: number;
            deletedBefore: number;
          }
        | undefined;
      if (existing && existing.deletionTokenHash !== deletionHash) {
        return { ok: false, reason: "INVALID_DELETION_TOKEN" };
      }
      if (!existing && deletionEpoch !== 0) {
        return { ok: false, reason: "INVALID_DELETION_EPOCH" };
      }
      if (existing && deletionEpoch > existing.deletionEpoch) {
        return { ok: false, reason: "INVALID_DELETION_EPOCH" };
      }
      if (existing) deletionStates.set(pseudonym, existing);
    }
    const newestDeletionState = [...deletionStates.values()].reduce<
      { deletionEpoch: number; deletedBefore: number } | undefined
    >(
      (latest, state) =>
        !latest || state.deletionEpoch > latest.deletionEpoch
          ? state
          : latest,
      undefined,
    );
    const capacity = this.#database
      .prepare(`
        SELECT COUNT(*) AS eventCount,
               COALESCE(SUM(payload_bytes), 0) AS payloadBytes
        FROM telemetry_raw
      `)
      .get() as { eventCount: number; payloadBytes: number };
    const newEventKeys = new Set<string>();
    let incomingEventCount = 0;
    let incomingBytes = 0;
    const shouldDiscard = (event: TelemetryEventV1): boolean => {
      const pseudonym = pseudonyms.get(event.pseudonymousInstallId);
      if (!pseudonym) throw new Error("Missing telemetry pseudonym");
      const state = deletionStates.get(pseudonym);
      return (
        state !== undefined &&
        state.deletedBefore > 0 &&
        Date.parse(event.occurredAt) <= state.deletedBefore
      );
    };
    try {
      this.assertAggregateCapacity(
        events.filter((event) => !shouldDiscard(event)).map((event) => ({
          day: event.occurredAt.slice(0, 10),
          eventName: event.eventName,
          appVersion: event.appVersion,
          batchId: telemetrySession.batchId,
          cohortSegment: telemetrySession.cohortSegment,
        })),
        now,
      );
    } catch (error) {
      if (error instanceof TelemetryAggregateCapacityError) {
        return { ok: false, reason: "TELEMETRY_CAPACITY_REACHED" };
      }
      throw error;
    }
    const existingEvent = this.#database.prepare(`
      SELECT 1 AS present
      FROM telemetry_raw
      WHERE pseudonymous_install_id = ? AND event_id = ?
    `);
    for (const event of events) {
      if (shouldDiscard(event)) continue;
      const pseudonym = pseudonyms.get(event.pseudonymousInstallId);
      if (!pseudonym) throw new Error("Missing telemetry pseudonym");
      const key = `${pseudonym}:${event.eventId}`;
      if (newEventKeys.has(key)) continue;
      newEventKeys.add(key);
      if (existingEvent.get(pseudonym, event.eventId)) continue;
      incomingEventCount += 1;
      incomingBytes += Buffer.byteLength(JSON.stringify(event));
    }
    if (
      capacity.eventCount + incomingEventCount > this.#maxRawTelemetryEvents ||
      capacity.payloadBytes + incomingBytes > this.#maxRawTelemetryBytes
    ) {
      return { ok: false, reason: "TELEMETRY_CAPACITY_REACHED" };
    }

    let accepted = 0;
    let duplicates = 0;
    let discarded = 0;
    const registerDeletion = this.#database.prepare(`
      INSERT INTO telemetry_deletions(
        pseudonymous_install_id, deletion_token_hash, deletion_epoch,
        deleted_before, expires_at
      ) VALUES (?, ?, 0, 0, ?)
      ON CONFLICT(pseudonymous_install_id) DO UPDATE SET
        expires_at = MAX(telemetry_deletions.expires_at, excluded.expires_at)
    `);
    const insert = this.#database.prepare(`
      INSERT INTO telemetry_raw(
        event_id, pseudonymous_install_id, visit_session_id,
        telemetry_session_id, batch_id, cohort_segment, event_name,
        occurred_at, consent_version, app_version, properties_json,
        received_at, expires_at, payload_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pseudonymous_install_id, event_id) DO NOTHING
    `);
    this.transaction(() => {
      for (const pseudonym of pseudonyms.values()) {
        registerDeletion.run(
          pseudonym,
          deletionHash,
          now + this.#rawTelemetryTtlMs,
        );
      }
      for (const event of events) {
        if (shouldDiscard(event)) {
          discarded += 1;
          continue;
        }
        const payloadBytes = Buffer.byteLength(JSON.stringify(event));
        const pseudonym = pseudonyms.get(event.pseudonymousInstallId);
        if (!pseudonym) throw new Error("Missing telemetry pseudonym");
        const result = insert.run(
          event.eventId,
          pseudonym,
          event.sessionId,
          telemetrySession.sessionId,
          telemetrySession.batchId,
          telemetrySession.cohortSegment,
          event.eventName,
          event.occurredAt,
          event.consentVersion,
          event.appVersion,
          JSON.stringify(event.properties),
          now,
          Date.parse(event.occurredAt) + this.#rawTelemetryTtlMs,
          payloadBytes,
        );
        if (Number(result.changes) === 1) accepted += 1;
        else duplicates += 1;
      }
    });
    const currentDeletionState = newestDeletionState;
    return {
      ok: true,
      accepted,
      duplicates,
      discarded,
      deletionEpoch: currentDeletionState?.deletionEpoch ?? deletionEpoch,
      deletedBefore:
        currentDeletionState && currentDeletionState.deletedBefore > 0
          ? new Date(currentDeletionState.deletedBefore).toISOString()
          : null,
    };
  }

  async deleteTelemetry(
    pseudonymousInstallId: string,
    deletionToken: string,
    now = this.#now(),
  ): Promise<DeleteTelemetryResult | undefined> {
    this.assertInitialized();
    const pseudonym = this.pseudonymize(pseudonymousInstallId);
    const proof = this.#database
      .prepare(`
        SELECT deletion_token_hash AS deletionTokenHash,
               deletion_epoch AS deletionEpoch
        FROM telemetry_deletions
        WHERE pseudonymous_install_id = ?
      `)
      .get(pseudonym) as
      | { deletionTokenHash: string; deletionEpoch: number }
      | undefined;
    const deletionTokenHash = sha256(deletionToken);
    if (proof && proof.deletionTokenHash !== deletionTokenHash) {
      return undefined;
    }
    let deleted = 0;
    const deletionEpoch = (proof?.deletionEpoch ?? 0) + 1;
    this.transaction(() => {
      deleted = Number(
        this.#database
          .prepare(`
            DELETE FROM telemetry_raw WHERE pseudonymous_install_id = ?
          `)
          .run(pseudonym).changes,
      );
      this.#database
        .prepare(`
          INSERT INTO telemetry_deletions(
            pseudonymous_install_id, deletion_token_hash, deletion_epoch,
            deleted_before, expires_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(pseudonymous_install_id) DO UPDATE SET
            deletion_epoch = excluded.deletion_epoch,
            deleted_before = MAX(
              telemetry_deletions.deleted_before,
              excluded.deleted_before
            ),
            expires_at = MAX(
              telemetry_deletions.expires_at,
              excluded.expires_at
            )
        `)
        .run(
          pseudonym,
          deletionTokenHash,
          deletionEpoch,
          now,
          now + this.#rawTelemetryTtlMs,
        );
    });
    return {
      deleted,
      deletionEpoch,
      deletedBefore: new Date(now).toISOString(),
    };
  }

  async recordTelemetryPreference(
    telemetrySession: TelemetrySession,
    enabled: boolean,
    consentVersion: string,
    appVersion: string,
    decisionAt: number,
    now = this.#now(),
  ): Promise<boolean> {
    this.assertInitialized();
    if (!isValidTelemetryPreferenceDecisionAt(decisionAt, now)) {
      throw new RangeError(
        "Telemetry preference decision timestamp is invalid or too far in the future",
      );
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const aggregateExpiresAt = now + this.#aggregateTtlMs;
    const selectExisting = this.#database.prepare(`
      SELECT enabled, ever_opted_out AS everOptedOut,
             decision_at AS decisionAt
      FROM telemetry_preferences
      WHERE telemetry_session_id = ?
    `);
    const aggregate = this.#database.prepare(`
      INSERT INTO telemetry_aggregates(
        day, event_name, app_version, batch_id, cohort_segment,
        count, expires_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(
        day, event_name, app_version, batch_id, cohort_segment
      ) DO UPDATE SET
        count = count + 1,
        expires_at = MAX(expires_at, excluded.expires_at)
    `);
    const upsert = this.#database.prepare(`
      INSERT INTO telemetry_preferences(
        telemetry_session_id, batch_id, cohort_segment, enabled,
        ever_opted_out, consent_version, app_version, decision_at,
        first_opt_out_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telemetry_session_id) DO UPDATE SET
        enabled = excluded.enabled,
        ever_opted_out = MAX(
          telemetry_preferences.ever_opted_out,
          excluded.ever_opted_out
        ),
        consent_version = excluded.consent_version,
        app_version = excluded.app_version,
        decision_at = excluded.decision_at,
        first_opt_out_at = CASE
          WHEN telemetry_preferences.first_opt_out_at IS NULL
            THEN excluded.first_opt_out_at
          WHEN excluded.first_opt_out_at IS NULL
            THEN telemetry_preferences.first_opt_out_at
          ELSE MIN(
            telemetry_preferences.first_opt_out_at,
            excluded.first_opt_out_at
          )
        END,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `);
    const recordOptOutAudit = this.#database.prepare(`
      UPDATE telemetry_preferences
      SET ever_opted_out = 1,
          first_opt_out_at = CASE
            WHEN first_opt_out_at IS NULL THEN ?
            ELSE MIN(first_opt_out_at, ?)
          END
      WHERE telemetry_session_id = ?
    `);
    const refreshIdempotentPreference = this.#database.prepare(`
      UPDATE telemetry_preferences
      SET consent_version = ?, app_version = ?, updated_at = ?,
          expires_at = ?
      WHERE telemetry_session_id = ?
    `);
    let applied = false;
    this.transaction(() => {
      const existing = selectExisting.get(telemetrySession.sessionId) as
        | { enabled: number; everOptedOut: number; decisionAt: number }
        | undefined;
      const isLaterDecision =
        existing === undefined || decisionAt > existing.decisionAt;
      const isSameTimeOptOut =
        existing !== undefined &&
        decisionAt === existing.decisionAt &&
        !enabled &&
        existing.enabled === 1;
      const isIdempotentDecision =
        existing !== undefined &&
        decisionAt === existing.decisionAt &&
        enabled === (existing.enabled === 1);
      const firstAcknowledgement = existing === undefined;
      const firstOptOut = !enabled && existing?.everOptedOut !== 1;
      const aggregateKeys: AggregateBucketKey[] = [];
      if (firstAcknowledgement && (isLaterDecision || isSameTimeOptOut)) {
        aggregateKeys.push({
          day,
          eventName: "telemetry_preference_acknowledged",
          appVersion,
          batchId: telemetrySession.batchId,
          cohortSegment: telemetrySession.cohortSegment,
        });
      }
      if (firstOptOut) {
        aggregateKeys.push({
          day,
          eventName: "telemetry_preference_opted_out",
          appVersion,
          batchId: telemetrySession.batchId,
          cohortSegment: telemetrySession.cohortSegment,
        });
      }
      this.assertAggregateCapacity(aggregateKeys, now);
      if (isLaterDecision || isSameTimeOptOut) {
        upsert.run(
          telemetrySession.sessionId,
          telemetrySession.batchId,
          telemetrySession.cohortSegment,
          enabled ? 1 : 0,
          enabled ? 0 : 1,
          consentVersion,
          appVersion,
          decisionAt,
          enabled ? null : decisionAt,
          now,
          now + this.#rawTelemetryTtlMs,
        );
        applied = true;
      } else if (isIdempotentDecision) {
        refreshIdempotentPreference.run(
          consentVersion,
          appVersion,
          now,
          now + this.#rawTelemetryTtlMs,
          telemetrySession.sessionId,
        );
        applied = true;
      } else if (!enabled) {
        recordOptOutAudit.run(
          decisionAt,
          decisionAt,
          telemetrySession.sessionId,
        );
      }
      if (firstAcknowledgement && applied) {
        aggregate.run(
          day,
          "telemetry_preference_acknowledged",
          appVersion,
          telemetrySession.batchId,
          telemetrySession.cohortSegment,
          aggregateExpiresAt,
        );
      }
      if (firstOptOut) {
        aggregate.run(
          day,
          "telemetry_preference_opted_out",
          appVersion,
          telemetrySession.batchId,
          telemetrySession.cohortSegment,
          aggregateExpiresAt,
        );
      }
    });
    return applied;
  }

  async sweep(now = this.#now()): Promise<void> {
    this.assertInitialized();
    const expired = this.#database
      .prepare(`
        SELECT substr(occurred_at, 1, 10) AS day,
               MAX(occurred_at) AS latestOccurredAt,
               event_name AS eventName,
               app_version AS appVersion,
               batch_id AS batchId,
               cohort_segment AS cohortSegment,
               COUNT(*) AS count
        FROM telemetry_raw
        WHERE expires_at <= ?
        GROUP BY day, event_name, app_version, batch_id, cohort_segment
        ORDER BY day, event_name, app_version, batch_id, cohort_segment
      `)
      .all(now) as Array<{
      day: string;
      latestOccurredAt: string;
      eventName: string;
      appVersion: string;
      batchId: string;
      cohortSegment: string;
      count: number;
    }>;
    const aggregate = this.#database.prepare(`
      INSERT INTO telemetry_aggregates(
        day, event_name, app_version, batch_id, cohort_segment,
        count, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        day, event_name, app_version, batch_id, cohort_segment
      ) DO UPDATE SET
        count = count + excluded.count,
        expires_at = MAX(expires_at, excluded.expires_at)
    `);
    let availableAggregateBuckets = Math.max(
      0,
      this.#maxAggregateBuckets -
        (
          this.#database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM telemetry_aggregates
              WHERE expires_at > ?
            `)
            .get(now) as unknown as CountRow
        ).count,
    );
    const aggregateExists = this.#database.prepare(`
      SELECT 1 AS present
      FROM telemetry_aggregates
      WHERE day = ? AND event_name = ? AND app_version = ?
        AND batch_id = ? AND cohort_segment = ? AND expires_at > ?
    `);
    const aggregatable: typeof expired = [];
    let discardedAggregateRows = 0;
    for (const row of expired) {
      const exists = aggregateExists.get(
        row.day,
        row.eventName,
        row.appVersion,
        row.batchId,
        row.cohortSegment,
        now,
      );
      if (exists || availableAggregateBuckets > 0) {
        aggregatable.push(row);
        if (!exists) availableAggregateBuckets -= 1;
      } else {
        discardedAggregateRows += row.count;
      }
    }
    this.transaction(() => {
      this.#database
        .prepare("DELETE FROM telemetry_aggregates WHERE expires_at <= ?")
        .run(now);
      for (const row of aggregatable) {
        const aggregateExpiresAt =
          Date.parse(row.latestOccurredAt) + this.#aggregateTtlMs;
        aggregate.run(
          row.day,
          row.eventName,
          row.appVersion,
          row.batchId,
          row.cohortSegment,
          row.count,
          aggregateExpiresAt,
        );
      }
      this.#database
        .prepare("DELETE FROM telemetry_raw WHERE expires_at <= ?")
        .run(now);
      this.#database
        .prepare("DELETE FROM telemetry_preferences WHERE expires_at <= ?")
        .run(now);
      this.#database
        .prepare(`
          DELETE FROM telemetry_sessions
          WHERE expires_at <= ?
            AND session_id NOT IN (
              SELECT telemetry_session_id FROM telemetry_preferences
            )
            AND session_id NOT IN (
              SELECT telemetry_session_id FROM telemetry_raw
            )
        `)
        .run(now);
      this.#database
        .prepare(`
        DELETE FROM telemetry_deletions
        WHERE expires_at <= ?
          AND pseudonymous_install_id NOT IN (
            SELECT DISTINCT pseudonymous_install_id FROM telemetry_raw
          )
      `)
        .run(now);
      this.#database
        .prepare(`
          UPDATE schema_meta
          SET discarded_aggregate_rows =
            discarded_aggregate_rows + ?
        `)
        .run(discardedAggregateRows);
    });
    // Raw retention is a privacy boundary. If the anonymous aggregate cap is
    // exhausted, drop the derived aggregate rather than retain attributable
    // raw events beyond their TTL.
  }

  status(): TelemetryStoreStatus {
    const count = (table: string): number =>
      (
        this.#database
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as unknown as CountRow
      ).count;
    let writable = false;
    if (this.#initialized) {
      try {
        this.#database.exec("SAVEPOINT telemetry_readiness");
        this.#database
          .prepare("UPDATE schema_meta SET version = version")
          .run();
        this.#database.exec("ROLLBACK TO telemetry_readiness");
        this.#database.exec("RELEASE telemetry_readiness");
        writable = true;
      } catch {
        try {
          this.#database.exec("ROLLBACK TO telemetry_readiness");
          this.#database.exec("RELEASE telemetry_readiness");
        } catch {
          // The original writable probe is the readiness signal.
        }
      }
    }
    const rawCapacity = this.#initialized
      ? (this.#database
          .prepare(`
            SELECT COUNT(*) AS eventCount,
                   COALESCE(SUM(payload_bytes), 0) AS payloadBytes
            FROM telemetry_raw
          `)
          .get() as { eventCount: number; payloadBytes: number })
      : { eventCount: 0, payloadBytes: 0 };
    const activeSessions = this.#initialized
      ? (
          this.#database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM telemetry_sessions
              WHERE expires_at > ?
            `)
            .get(this.#now()) as unknown as CountRow
        ).count
      : 0;
    const aggregateBuckets = this.#initialized
      ? count("telemetry_aggregates")
      : 0;
    const discardedAggregateRows = this.#initialized
      ? (
          this.#database
            .prepare(`
              SELECT discarded_aggregate_rows AS count
              FROM schema_meta
            `)
            .get() as unknown as CountRow
        ).count
      : 0;
    return {
      ready: this.#initialized,
      writable,
      persistent: this.#persistent,
      sessions: activeSessions,
      acceptingNewSessions: writable && activeSessions < this.#maxSessions,
      rawTelemetryEvents: rawCapacity.eventCount,
      rawTelemetryBytes: rawCapacity.payloadBytes,
      acceptingTelemetry:
        writable &&
        rawCapacity.eventCount < this.#maxRawTelemetryEvents &&
        rawCapacity.payloadBytes < this.#maxRawTelemetryBytes &&
        aggregateBuckets < this.#maxAggregateBuckets,
      aggregateBuckets,
      acceptingAggregates:
        writable && aggregateBuckets < this.#maxAggregateBuckets,
      discardedAggregateRows,
    };
  }

  async close(): Promise<void> {
    this.#database.close();
  }

  private assertAggregateCapacity(
    keys: readonly AggregateBucketKey[],
    now = this.#now(),
  ): void {
    if (keys.length === 0) return;
    this.#database
      .prepare("DELETE FROM telemetry_aggregates WHERE expires_at <= ?")
      .run(now);
    const uniqueKeys = new Map(
      keys.map((key) => [
        [
          key.day,
          key.eventName,
          key.appVersion,
          key.batchId,
          key.cohortSegment,
        ].join("\u0000"),
        key,
      ]),
    );
    const exists = this.#database.prepare(`
      SELECT 1 AS present
      FROM telemetry_aggregates
      WHERE day = ? AND event_name = ? AND app_version = ?
        AND batch_id = ? AND cohort_segment = ?
    `);
    let newBuckets = 0;
    for (const key of uniqueKeys.values()) {
      if (
        !exists.get(
          key.day,
          key.eventName,
          key.appVersion,
          key.batchId,
          key.cohortSegment,
        )
      ) {
        newBuckets += 1;
      }
    }
    const current = (
      this.#database
        .prepare("SELECT COUNT(*) AS count FROM telemetry_aggregates")
        .get() as unknown as CountRow
    ).count;
    if (current + newBuckets > this.#maxAggregateBuckets) {
      throw new TelemetryAggregateCapacityError();
    }
  }

  private ensureSchemaMetaColumns(): void {
    const columns = (
      this.#database.prepare("PRAGMA table_info(schema_meta)").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name);
    if (!columns.includes("discarded_aggregate_rows")) {
      this.#database.exec(`
        ALTER TABLE schema_meta
          ADD COLUMN discarded_aggregate_rows INTEGER NOT NULL DEFAULT 0;
      `);
    }
  }

  private ensureDeletionTombstoneColumns(): void {
    const columns = (
      this.#database
        .prepare("PRAGMA table_info(telemetry_deletions)")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    if (!columns.includes("deletion_epoch")) {
      this.#database.exec(`
        ALTER TABLE telemetry_deletions
          ADD COLUMN deletion_epoch INTEGER NOT NULL DEFAULT 0;
      `);
    }
    if (!columns.includes("deleted_before")) {
      this.#database.exec(`
        ALTER TABLE telemetry_deletions
          ADD COLUMN deleted_before INTEGER NOT NULL DEFAULT 0;
      `);
    }
    if (!columns.includes("expires_at")) {
      this.#database.exec(`
        ALTER TABLE telemetry_deletions
          ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
      `);
    }
    this.#database
      .prepare(`
        UPDATE telemetry_deletions
        SET expires_at = MAX(
          expires_at,
          COALESCE(
            (
              SELECT MAX(telemetry_raw.expires_at)
              FROM telemetry_raw
              WHERE telemetry_raw.pseudonymous_install_id =
                telemetry_deletions.pseudonymous_install_id
            ),
            ?
          )
        )
      `)
      .run(this.#now() + this.#rawTelemetryTtlMs);
  }

  private assertRequiredTablesExist(): void {
    const existing = new Set(
      (
        this.#database
          .prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          `)
          .all() as Array<{ name: string }>
      ).map(({ name }) => name),
    );
    for (const table of [
      "schema_meta",
      "telemetry_sessions",
      "telemetry_deletions",
      "telemetry_preferences",
      "telemetry_raw",
      "telemetry_aggregates",
    ]) {
      if (!existing.has(table)) {
        throw new Error(
          `Invalid telemetry schema: required table ${table} is missing`,
        );
      }
    }
  }

  private validateSchema(): void {
    const metadata = this.#database
      .prepare("SELECT version FROM schema_meta")
      .all() as Array<{ version: number }>;
    if (
      metadata.length !== 1 ||
      metadata[0]?.version !== SERVER_SCHEMA_VERSION
    ) {
      throw new Error(
        "Invalid telemetry schema metadata: expected the current schema version",
      );
    }
    const requiredColumns: Readonly<Record<string, readonly string[]>> = {
      schema_meta: ["version", "discarded_aggregate_rows"],
      telemetry_sessions: [
        "session_id",
        "token_hash",
        "batch_id",
        "cohort_segment",
        "expires_at",
      ],
      telemetry_deletions: [
        "pseudonymous_install_id",
        "deletion_token_hash",
        "deletion_epoch",
        "deleted_before",
        "expires_at",
      ],
      telemetry_preferences: [
        "telemetry_session_id",
        "batch_id",
        "cohort_segment",
        "enabled",
        "ever_opted_out",
        "consent_version",
        "app_version",
        "decision_at",
        "first_opt_out_at",
        "updated_at",
        "expires_at",
      ],
      telemetry_raw: [
        "event_id",
        "pseudonymous_install_id",
        "visit_session_id",
        "telemetry_session_id",
        "batch_id",
        "cohort_segment",
        "event_name",
        "occurred_at",
        "consent_version",
        "app_version",
        "properties_json",
        "received_at",
        "expires_at",
        "payload_bytes",
      ],
      telemetry_aggregates: [
        "day",
        "event_name",
        "app_version",
        "batch_id",
        "cohort_segment",
        "count",
        "expires_at",
      ],
    };
    for (const [table, required] of Object.entries(requiredColumns)) {
      const columns = (
        this.#database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
      const missing = required.filter((column) => !columns.includes(column));
      if (missing.length > 0) {
        throw new Error(
          `Invalid telemetry schema: ${table} is missing ${missing.join(", ")}`,
        );
      }
    }
  }

  private pseudonymize(value: string): string {
    return createHmac("sha256", this.#telemetrySecret)
      .update(value)
      .digest("hex");
  }

  private transaction(operation: () => void): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  private assertInitialized(): void {
    if (!this.#initialized) {
      throw new Error("Telemetry store is not initialized");
    }
  }
}

const ENUM_PROPERTIES: Readonly<Record<string, ReadonlySet<string>>> = {
  browserFamily: new Set(["chrome", "safari", "firefox", "edge", "other"]),
  deviceClass: new Set(["desktop", "tablet", "mobile"]),
  viewportBucket: new Set([
    "lt_360",
    "360_389",
    "390_767",
    "768_1279",
    "gte_1280",
  ]),
  mode: new Set(["solo", "academy", "duel", "history"]),
  source: new Set(["home", "navigation", "result", "invite", "direct"]),
  preset: new Set(["beginner", "intermediate", "expert", "custom"]),
  generationMode: new Set(["classic", "no_guess"]),
  outcome: new Set([
    "WON",
    "LOST",
    "ABANDONED",
    "WIN",
    "LOSS",
    "DRAW",
    "DNF",
  ]),
  scope: new Set(["all", "current_preset", "current_configuration"]),
  format: new Set(["csv", "json"]),
  historyFailureReason: new Set(["QUOTA", "SERIALIZATION", "STORAGE"]),
  failureReason: new Set([
    "ATTEMPT_LIMIT",
    "TIME_LIMIT",
    "GENERATION_ERROR",
  ]),
  reason: new Set(["TIMEOUT", "DISCONNECTED", "STATE_DIVERGED", "ABANDONED"]),
};

const ALLOWED_PROPERTIES: Readonly<
  Record<TelemetryEventName, ReadonlySet<string>>
> = {
  app_ready: new Set([
    "browserFamily",
    "deviceClass",
    "viewportBucket",
    "stageDurationMs",
  ]),
  mode_selected: new Set(["mode", "source", "stageDurationMs"]),
  solo_run_started: new Set([
    "trainingSessionId",
    "preset",
    "generationMode",
    "width",
    "height",
    "mines",
    "stageDurationMs",
  ]),
  solo_run_terminal: new Set([
    "trainingSessionId",
    "preset",
    "generationMode",
    "outcome",
    "elapsedMs",
    "terminalBoardCount",
    "effectiveInteractionMs",
    "runEffectiveInteractionMs",
    "historySaved",
    "historyFailureReason",
    "inputSampleCount",
    "inputP95Ms",
    "stageDurationMs",
  ]),
  solo_history_opened: new Set([
    "scope",
    "recordCount",
    "stageDurationMs",
  ]),
  solo_history_filtered: new Set([
    "scope",
    "preset",
    "generationMode",
    "stageDurationMs",
  ]),
  solo_exported: new Set(["format", "recordCount", "stageDurationMs"]),
  no_guess_generation_finished: new Set([
    "preset",
    "success",
    "attempts",
    "elapsedMs",
    "failureReason",
  ]),
  duel_invite_created: new Set(["source", "stageDurationMs"]),
  duel_invite_opened: new Set(["source", "stageDurationMs"]),
  duel_joined: new Set(["stageDurationMs"]),
  duel_started: new Set(["round", "stageDurationMs"]),
  duel_completed: new Set(["outcome", "rounds", "stageDurationMs"]),
  duel_dnf: new Set(["reason", "round", "stageDurationMs"]),
};

export function sanitizeTelemetryProperties(
  eventName: TelemetryEventName,
  properties: Readonly<Record<string, TelemetryProperty>>,
): Readonly<Record<string, TelemetryProperty>> | undefined {
  const allowed = ALLOWED_PROPERTIES[eventName];
  const sanitized: Record<string, TelemetryProperty> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.has(key)) return undefined;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return undefined;
      sanitized[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      sanitized[key] = value;
      continue;
    }
    if (value === null) {
      sanitized[key] = null;
      continue;
    }
    if (value.length > 64) return undefined;
    const enumValues = ENUM_PROPERTIES[key];
    if (enumValues && !enumValues.has(value)) return undefined;
    if (
      key === "trainingSessionId" &&
      !/^[A-Za-z0-9_-]{8,64}$/.test(value)
    ) {
      return undefined;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
