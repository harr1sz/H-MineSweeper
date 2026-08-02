import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, getServerServices } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { ServerConfig } from "../src/config.js";

const TEST_SECRET = "test-secret-that-is-long-enough-for-hmac";
const DELETION_TOKEN = "local-deletion-token-123456789012";
const openApps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];
let nextPreferenceDecisionAt = Date.UTC(2026, 6, 30);

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function telemetryApp(
  overrides: Partial<ServerConfig> = {},
): FastifyInstance {
  const app = createApp({
    logger: false,
    config: {
      ...loadConfig({}),
      telemetryPseudonymizationSecret: TEST_SECRET,
      duelExperimentEnabled: true,
      ...overrides,
    },
  });
  openApps.push(app);
  return app;
}

async function persistentDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hms-telemetry-app-"));
  temporaryDirectories.push(directory);
  return join(directory, "telemetry.sqlite");
}

async function createTelemetrySession(app: FastifyInstance): Promise<{
  cookie: string;
  sessionId: string;
}> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/telemetry/session",
  });
  expect(response.statusCode).toBe(201);
  const setCookie = response.headers["set-cookie"];
  expect(setCookie).toBeDefined();
  return {
    cookie: String(setCookie).split(";")[0] ?? "",
    sessionId: response.json<{ sessionId: string }>().sessionId,
  };
}

function event(
  eventId = "event_telemetry_1",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId,
    pseudonymousInstallId: "anonymous-install-id-123",
    sessionId: "visit-session-1234567890",
    eventName: "app_ready",
    occurredAt: new Date().toISOString(),
    consentVersion: "telemetry-v1",
    appVersion: "0.2.0-alpha.1",
    properties: {
      browserFamily: "chrome",
      deviceClass: "desktop",
    },
  };
}

async function setPreference(
  app: FastifyInstance,
  cookie: string,
  enabled: boolean,
  preferenceChangedAt = new Date(nextPreferenceDecisionAt++).toISOString(),
) {
  return await app.inject({
    method: "POST",
    url: "/api/v1/telemetry/preference",
    headers: { cookie },
    payload: {
      enabled,
      consentVersion: "telemetry-v1",
      appVersion: "0.2.0-alpha.1",
      preferenceChangedAt,
    },
  });
}

async function sendBatch(
  app: FastifyInstance,
  cookie: string | undefined,
  eventId = "event_telemetry_1",
) {
  const request = {
    method: "POST",
    url: "/api/v1/telemetry/batch",
    payload: {
      deletionToken: DELETION_TOKEN,
      events: [event(eventId)],
    },
  } as const;
  if (cookie) {
    return await app.inject({
      ...request,
      headers: { cookie },
    });
  }
  return await app.inject(request);
}

describe("public telemetry API", () => {
  it("creates a public HttpOnly cookie session and restores it with 200", async () => {
    const app = telemetryApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/session",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      batchId: "public",
      cohortSegment: "unsegmented",
    });
    const setCookie = String(created.headers["set-cookie"]);
    expect(setCookie).toMatch(
      /^hms_telemetry_session=[^;]+; Path=\/api\/v1\/telemetry; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/,
    );
    const cookie = setCookie.split(";")[0] ?? "";
    const restored = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/session",
      headers: { cookie },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual(created.json());

    const bodyRejected = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/session",
      payload: {},
    });
    expect(bodyRejected.statusCode).toBe(400);
  });

  it("keeps valid restoration available after new-session capacity is full", async () => {
    const app = telemetryApp({ maxTelemetrySessions: 1 });
    const first = await createTelemetrySession(app);
    const full = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/session",
    });
    expect(full.statusCode).toBe(503);
    expect(full.json()).toMatchObject({
      error: "TELEMETRY_SESSION_CAPACITY_REACHED",
      retryable: true,
    });

    const restored = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/session",
      headers: { cookie: first.cookie },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ sessionId: first.sessionId });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ready",
      capacity: {
        acceptingNewTelemetrySessions: false,
      },
    });
  });

  it("restores a public telemetry session after a SQLite-backed restart", async () => {
    const path = await persistentDatabasePath();
    const first = telemetryApp({ telemetrySqliteFile: path });
    const session = await createTelemetrySession(first);
    openApps.splice(openApps.indexOf(first), 1);
    await first.close();

    const second = telemetryApp({ telemetrySqliteFile: path });
    const restored = await second.inject({
      method: "POST",
      url: "/api/v1/telemetry/session",
      headers: { cookie: session.cookie },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      sessionId: session.sessionId,
      batchId: "public",
      cohortSegment: "unsegmented",
    });
  });

  it("accepts the same persisted consent decision after an app-version upgrade", async () => {
    const path = await persistentDatabasePath();
    const decisionAt = new Date(Date.now() - 1_000).toISOString();
    const first = telemetryApp({
      telemetrySqliteFile: path,
      appVersion: "0.2.0-alpha.0",
    });
    const session = await createTelemetrySession(first);
    const initial = await first.inject({
      method: "POST",
      url: "/api/v1/telemetry/preference",
      headers: { cookie: session.cookie },
      payload: {
        enabled: true,
        consentVersion: "telemetry-v1",
        appVersion: "0.2.0-alpha.0",
        preferenceChangedAt: decisionAt,
      },
    });
    expect(initial.statusCode).toBe(202);
    expect(initial.json()).toEqual({ accepted: true, applied: true });
    openApps.splice(openApps.indexOf(first), 1);
    await first.close();

    const second = telemetryApp({
      telemetrySqliteFile: path,
      appVersion: "0.2.0-alpha.1",
    });
    const repeated = await second.inject({
      method: "POST",
      url: "/api/v1/telemetry/preference",
      headers: { cookie: session.cookie },
      payload: {
        enabled: true,
        consentVersion: "telemetry-v1",
        appVersion: "0.2.0-alpha.1",
        preferenceChangedAt: decisionAt,
      },
    });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json()).toEqual({ accepted: true, applied: true });
  });

  it("requires the session cookie for preference, batch, and deletion", async () => {
    const app = telemetryApp();
    const preference = await setPreference(app, "", true);
    expect(preference.statusCode).toBe(401);
    expect(preference.json()).toMatchObject({
      error: "TELEMETRY_SESSION_REQUIRED",
    });

    const batch = await sendBatch(app, undefined);
    expect(batch.statusCode).toBe(401);

    const deletion = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/delete",
      payload: {
        pseudonymousInstallId: "anonymous-install-id-123",
        deletionToken: DELETION_TOKEN,
      },
    });
    expect(deletion.statusCode).toBe(401);
  });

  it("requires a valid preference decision timestamp", async () => {
    const app = telemetryApp();
    const { cookie } = await createTelemetrySession(app);
    const preference = {
      enabled: true,
      consentVersion: "telemetry-v1",
      appVersion: "0.2.0-alpha.1",
    };
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/preference",
      headers: { cookie },
      payload: preference,
    });
    expect(missing.statusCode).toBe(400);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/preference",
      headers: { cookie },
      payload: {
        ...preference,
        preferenceChangedAt: "not-an-iso-date",
      },
    });
    expect(invalid.statusCode).toBe(400);

    const future = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/preference",
      headers: { cookie },
      payload: {
        ...preference,
        preferenceChangedAt: new Date(
          Date.now() + 6 * 60 * 1_000,
        ).toISOString(),
      },
    });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toMatchObject({
      error: "INVALID_PREFERENCE_TIMESTAMP",
      retryable: false,
    });
  });

  it("accepts raw events only while the server-side preference is enabled", async () => {
    const app = telemetryApp();
    const { cookie } = await createTelemetrySession(app);

    const beforePreference = await sendBatch(app, cookie);
    expect(beforePreference.statusCode).toBe(403);
    expect(beforePreference.json()).toMatchObject({
      error: "TELEMETRY_NOT_ENABLED",
    });

    expect((await setPreference(app, cookie, false)).statusCode).toBe(202);
    expect(
      (await sendBatch(app, cookie, "event_after_false")).statusCode,
    ).toBe(403);

    expect((await setPreference(app, cookie, true)).statusCode).toBe(202);
    const accepted = await sendBatch(app, cookie);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({
      accepted: 1,
      duplicates: 0,
      discarded: 0,
      deletionEpoch: 0,
      deletedBefore: null,
    });
    expect(
      getServerServices(app).telemetryStore.status().rawTelemetryEvents,
    ).toBe(1);

    expect((await setPreference(app, cookie, false)).statusCode).toBe(202);
    expect(
      (await sendBatch(app, cookie, "event_after_opt_out")).statusCode,
    ).toBe(403);
    expect(
      getServerServices(app).telemetryStore.status().rawTelemetryEvents,
    ).toBe(1);

    const deleted = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/delete",
      headers: { cookie },
      payload: {
        pseudonymousInstallId: "anonymous-install-id-123",
        deletionToken: DELETION_TOKEN,
      },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      accepted: true,
      deletionEpoch: 1,
      deletedBefore: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(
      getServerServices(app).telemetryStore.status().rawTelemetryEvents,
    ).toBe(0);
  });

  it("ingests every practice event without blocking a mixed queued batch", async () => {
    const app = telemetryApp();
    const { cookie } = await createTelemetrySession(app);
    expect((await setPreference(app, cookie, true)).statusCode).toBe(202);

    const practiceEvents = [
      {
        ...event("guided_practice_mode_event"),
        eventName: "mode_selected",
        properties: {
          mode: "guided_practice",
          source: "home",
        },
      },
      {
        ...event("practice_started_event"),
        eventName: "practice_run_started",
        properties: {
          trainingSessionId: "practice-session-123456",
          preset: "beginner",
          generationMode: "no_guess",
          width: 9,
          height: 9,
          mines: 10,
          assistMode: "COACH",
        },
      },
      {
        ...event("practice_hint_event"),
        eventName: "practice_hint_shown",
        properties: {
          trigger: "IDLE",
          status: "READY",
          action: "FLAG",
        },
      },
      {
        ...event("practice_assist_event"),
        eventName: "practice_assist_applied",
        properties: {
          trigger: "AUTO_MARK",
          action: "FLAG",
        },
      },
      {
        ...event("practice_terminal_event"),
        eventName: "practice_run_terminal",
        properties: {
          trainingSessionId: "practice-session-123456",
          preset: "beginner",
          generationMode: "no_guess",
          outcome: "WON",
          elapsedMs: 12_345.67,
          playerActions: 8,
          hintsShown: 2,
          hintsRequested: 1,
          autoFlags: 3,
          demonstratedActions: 0,
          historySaved: true,
          historyFailureReason: null,
        },
      },
      {
        ...event("practice_generation_event"),
        eventName: "practice_no_guess_generation_finished",
        properties: {
          preset: "beginner",
          success: false,
          attempts: 0,
          elapsedMs: 5_001.25,
          failureReason: "TIME_LIMIT",
        },
      },
      event("standard_after_practice_event"),
    ];
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/batch",
      headers: { cookie },
      payload: {
        deletionToken: DELETION_TOKEN,
        events: practiceEvents,
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({
      accepted: practiceEvents.length,
      duplicates: 0,
      discarded: 0,
      deletionEpoch: 0,
      deletedBefore: null,
    });
    expect(
      getServerServices(app).telemetryStore.status().rawTelemetryEvents,
    ).toBe(practiceEvents.length);
  });

  it("rejects practice values borrowed from a different event contract", async () => {
    const app = telemetryApp();
    const { cookie } = await createTelemetrySession(app);
    expect((await setPreference(app, cookie, true)).statusCode).toBe(202);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/batch",
      headers: { cookie },
      payload: {
        deletionToken: DELETION_TOKEN,
        events: [
          {
            ...event("invalid_practice_hint_event"),
            eventName: "practice_hint_shown",
            properties: {
              trigger: "AUTO_MARK",
              status: "READY",
              action: "FLAG",
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "INVALID_TELEMETRY_PROPERTIES",
    });
    expect(
      getServerServices(app).telemetryStore.status().rawTelemetryEvents,
    ).toBe(0);
  });

  it("keeps a deletion tombstone so a stale tab cannot resurrect queued raw events", async () => {
    const app = telemetryApp();
    const { cookie } = await createTelemetrySession(app);
    const preferenceChangedAt = new Date(Date.now() - 2_000).toISOString();
    expect(
      (
        await setPreference(
          app,
          cookie,
          true,
          preferenceChangedAt,
        )
      ).statusCode,
    ).toBe(202);
    const queuedBeforeDeletion: Record<string, unknown> = {
      ...event("event_from_stale_tab"),
      occurredAt: new Date(Date.now() - 1_000).toISOString(),
    };

    const deleted = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/delete",
      headers: { cookie },
      payload: {
        pseudonymousInstallId: String(
          queuedBeforeDeletion["pseudonymousInstallId"],
        ),
        deletionToken: DELETION_TOKEN,
      },
    });
    expect(deleted.statusCode).toBe(200);
    const deletion = deleted.json<{
      deletionEpoch: number;
      deletedBefore: string;
    }>();

    const staleUpload = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/batch",
      headers: { cookie },
      payload: {
        deletionToken: DELETION_TOKEN,
        deletionEpoch: 0,
        events: [queuedBeforeDeletion],
      },
    });
    expect(staleUpload.statusCode).toBe(202);
    expect(staleUpload.json()).toEqual({
      accepted: 0,
      duplicates: 0,
      discarded: 1,
      deletionEpoch: deletion.deletionEpoch,
      deletedBefore: deletion.deletedBefore,
    });
    expect(
      getServerServices(app).telemetryStore.status().rawTelemetryEvents,
    ).toBe(0);
  });

  it("rejects mismatched deployed app versions and pre-consent events", async () => {
    const app = telemetryApp();
    const { cookie } = await createTelemetrySession(app);
    const decisionAt = Date.now() - 1_000;
    await setPreference(
      app,
      cookie,
      true,
      new Date(decisionAt).toISOString(),
    );

    const wrongVersion = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/batch",
      headers: { cookie },
      payload: {
        deletionToken: DELETION_TOKEN,
        events: [
          {
            ...event("event_wrong_deployment"),
            appVersion: "0.2.0-alpha.0",
          },
        ],
      },
    });
    expect(wrongVersion.statusCode).toBe(409);
    expect(wrongVersion.json()).toMatchObject({
      error: "APP_VERSION_MISMATCH",
    });

    const preConsent = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/batch",
      headers: { cookie },
      payload: {
        deletionToken: DELETION_TOKEN,
        events: [
          {
            ...event("event_pre_consent"),
            occurredAt: new Date(decisionAt - 1).toISOString(),
          },
        ],
      },
    });
    expect(preConsent.statusCode).toBe(403);
    expect(preConsent.json()).toMatchObject({
      error: "TELEMETRY_CONSENT_MISMATCH",
    });

    const syntheticDecisionAt = decisionAt + 1;
    const syntheticPreference = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/preference",
      headers: { cookie },
      payload: {
        enabled: true,
        consentVersion: "telemetry-v1",
        appVersion: "synthetic-probe-v1",
        preferenceChangedAt: new Date(syntheticDecisionAt).toISOString(),
      },
    });
    expect(syntheticPreference.statusCode).toBe(202);
    const syntheticBatch = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/batch",
      headers: { cookie },
      payload: {
        deletionToken: DELETION_TOKEN,
        events: [
          {
            ...event("event_synthetic_probe"),
            appVersion: "synthetic-probe-v1",
            occurredAt: new Date(syntheticDecisionAt + 1).toISOString(),
          },
        ],
      },
    });
    expect(syntheticBatch.statusCode).toBe(202);
    expect(syntheticBatch.json()).toMatchObject({
      accepted: 1,
      discarded: 0,
    });
  });

  it("returns 503 instead of growing preference aggregate buckets past the cap", async () => {
    const app = telemetryApp({ maxTelemetryAggregateBuckets: 1 });
    const { cookie } = await createTelemetrySession(app);
    expect((await setPreference(app, cookie, true)).statusCode).toBe(202);
    const overCapacity = await setPreference(app, cookie, false);
    expect(overCapacity.statusCode).toBe(503);
    expect(overCapacity.json()).toMatchObject({
      error: "TELEMETRY_AGGREGATE_CAPACITY_REACHED",
      retryable: true,
    });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      capacity: {
        acceptingTelemetry: false,
        acceptingTelemetryAggregates: false,
      },
    });
  });

  it("rejects stale enables, prefers opt-out on ties, and permits a later re-enable", async () => {
    const app = telemetryApp();
    const { cookie } = await createTelemetrySession(app);
    const base = Date.now();
    const t1 = new Date(base - 3_000).toISOString();
    const t2 = new Date(base - 2_000).toISOString();
    const t3 = new Date(base - 1_000).toISOString();

    const optedOut = await setPreference(app, cookie, false, t2);
    expect(optedOut.statusCode).toBe(202);
    expect(optedOut.json()).toEqual({ accepted: true, applied: true });

    const staleEnable = await setPreference(app, cookie, true, t1);
    expect(staleEnable.statusCode).toBe(202);
    expect(staleEnable.json()).toEqual({ accepted: true, applied: false });
    expect(
      (await sendBatch(app, cookie, "event_after_stale_enable")).statusCode,
    ).toBe(403);

    const tiedEnable = await setPreference(app, cookie, true, t2);
    expect(tiedEnable.statusCode).toBe(202);
    expect(tiedEnable.json()).toEqual({ accepted: true, applied: false });
    expect(
      (await sendBatch(app, cookie, "event_after_tied_enable")).statusCode,
    ).toBe(403);

    const reenabled = await setPreference(app, cookie, true, t3);
    expect(reenabled.statusCode).toBe(202);
    expect(reenabled.json()).toEqual({ accepted: true, applied: true });
    expect(
      (await sendBatch(app, cookie, "event_after_later_enable")).statusCode,
    ).toBe(202);
  });

  it("fails readiness when telemetry is unavailable but not when capacity is full", async () => {
    const misconfigured = telemetryApp({
      telemetryPseudonymizationSecret: "",
      telemetryRequirePersistentStore: true,
    });
    const readyWithoutTelemetry = await misconfigured.inject({
      method: "GET",
      url: "/ready",
    });
    expect(readyWithoutTelemetry.statusCode).toBe(503);
    expect(readyWithoutTelemetry.json()).toMatchObject({
      status: "not_ready",
      telemetry: {
        available: false,
        checks: ["telemetry_secret", "telemetry_persistence"],
      },
    });
    const unavailableSession = await misconfigured.inject({
      method: "POST",
      url: "/api/v1/telemetry/session",
    });
    expect(unavailableSession.statusCode).toBe(503);

    const full = telemetryApp({ maxRawTelemetryEvents: 1 });
    const { cookie } = await createTelemetrySession(full);
    await setPreference(full, cookie, true);
    expect((await sendBatch(full, cookie)).statusCode).toBe(202);
    expect(
      (await sendBatch(full, cookie, "event_capacity_2")).statusCode,
    ).toBe(503);
    const readyAtCapacity = await full.inject({
      method: "GET",
      url: "/ready",
    });
    expect(readyAtCapacity.statusCode).toBe(200);
    expect(readyAtCapacity.json()).toMatchObject({
      status: "ready",
      capacity: { acceptingTelemetry: false },
    });
  });

  it("does not retain invitation access routes or gate enabled duel routes", async () => {
    const app = telemetryApp({ duelExperimentEnabled: true });
    for (const request of [
      { method: "POST" as const, url: "/api/v1/alpha/redeem" },
      {
        method: "POST" as const,
        url: "/api/v1/alpha/invitations/redeem",
      },
      { method: "GET" as const, url: "/api/v1/alpha/session" },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
    }
    const guest = await app.inject({
      method: "POST",
      url: "/api/v1/guest-session",
      payload: { displayName: "Public Duel" },
    });
    expect(guest.statusCode).toBe(201);
  });

  it("enforces the 50-event and 64 KiB ingestion boundaries", async () => {
    const app = telemetryApp();
    const { cookie } = await createTelemetrySession(app);
    await setPreference(app, cookie, true);
    const tooMany = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/batch",
      headers: { cookie },
      payload: {
        deletionToken: DELETION_TOKEN,
        events: Array.from({ length: 51 }, (_, index) =>
          event(`event_telemetry_${index}`),
        ),
      },
    });
    expect(tooMany.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/v1/telemetry/batch",
      headers: { cookie },
      payload: {
        deletionToken: DELETION_TOKEN,
        events: [
          {
            ...event("oversized_event"),
            properties: {
              browserFamily: "x".repeat(70 * 1_024),
            },
          },
        ],
      },
    });
    expect(oversized.statusCode).toBe(413);
  });
});
