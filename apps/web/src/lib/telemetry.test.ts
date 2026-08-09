import { describe, expect, it, vi } from "vitest";
import {
  TELEMETRY_CONSENT_VERSION,
  TelemetryClient,
  sanitizeTelemetryProperties,
  type TelemetryEventV1,
} from "./telemetry";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

const PUBLIC_SESSION = {
  sessionId: "public-session-1234567890",
  expiresAt: Date.UTC(2100, 0, 1),
  batchId: "public",
  cohortSegment: "unsegmented",
} as const;

function response(
  body: unknown,
  ok = true,
  status = ok ? 200 : 500,
): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

describe("TelemetryClient", () => {
  it("does not collect before disclosure is acknowledged", () => {
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    });

    expect(client.snapshot()).toMatchObject({
      acknowledged: false,
      enabled: false,
      queuedEvents: 0,
    });
    expect(client.track("app_ready", { deviceClass: "desktop" })).toBe(false);
  });

  it("queues only allowlisted fields and flushes a bounded same-origin batch", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(path);
      requests.push({ path: requestPath, ...(init ? { init } : {}) });
      if (requestPath === "/api/v1/telemetry/session") {
        return response(PUBLIC_SESSION, true, 201);
      }
      if (requestPath === "/api/v1/telemetry/preference") {
        return response({ accepted: true, applied: true });
      }
      return response({ accepted: 1, duplicates: 0 });
    });
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      fetch: fetch as typeof globalThis.fetch,
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
    });

    expect(client.acknowledge(true)).toMatchObject({
      acknowledged: true,
      enabled: true,
    });
    expect(
      client.track("app_ready", {
        deviceClass: "desktop",
        browserFamily: "chrome",
      }),
    ).toBe(true);
    expect(client.snapshot().queuedEvents).toBe(1);
    expect(await client.flush()).toBe(true);
    expect(client.snapshot().queuedEvents).toBe(0);
    expect(requests.map(({ path }) => path)).toEqual([
      "/api/v1/telemetry/session",
      "/api/v1/telemetry/preference",
      "/api/v1/telemetry/batch",
    ]);
    expect(requests[0]?.init?.credentials).toBe("same-origin");
    expect(requests[0]?.init?.body).toBeUndefined();
    expect(requests[2]?.init?.credentials).toBe("same-origin");
    const payload = JSON.parse(String(requests[2]?.init?.body)) as {
      deletionToken: string;
      deletionEpoch: number;
      events: TelemetryEventV1[];
    };
    expect(payload.deletionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.deletionEpoch).toBe(0);
    expect(payload.events[0]).toMatchObject({
      schemaVersion: 1,
      consentVersion: TELEMETRY_CONSENT_VERSION,
      eventName: "app_ready",
      properties: {
        deviceClass: "desktop",
        browserFamily: "chrome",
      },
    });
    expect(new TextEncoder().encode(String(requests[2]?.init?.body)).byteLength)
      .toBeLessThanOrEqual(64 * 1024);
  });

  it("keeps queued events when a 2xx batch acknowledgement is partial or malformed", async () => {
    let validAcknowledgement = false;
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      fetch: (async (path: string | URL | Request) => {
        const requestPath = String(path);
        if (requestPath === "/api/v1/telemetry/session") {
          return response(PUBLIC_SESSION, true, 201);
        }
        if (requestPath === "/api/v1/telemetry/preference") {
          return response({ accepted: true, applied: true }, true, 202);
        }
        return validAcknowledgement
          ? response({ accepted: 1, duplicates: 0 }, true, 202)
          : response({ accepted: 0, duplicates: 0 }, true, 202);
      }) as typeof globalThis.fetch,
    });
    client.acknowledge(true);
    client.track("app_ready", { deviceClass: "desktop" });

    await expect(client.flush()).resolves.toBe(false);
    expect(client.snapshot()).toMatchObject({
      queuedEvents: 1,
      error: expect.stringMatching(/没有完整确认/),
    });

    validAcknowledgement = true;
    await expect(client.flush()).resolves.toBe(true);
    expect(client.snapshot()).toMatchObject({
      queuedEvents: 0,
      error: null,
    });
  });

  it("requires an explicit applied=true preference acknowledgement", async () => {
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      fetch: (async (path: string | URL | Request) =>
        String(path) === "/api/v1/telemetry/session"
          ? response(PUBLIC_SESSION, true, 201)
          : response({ accepted: true }, true, 202)) as
        typeof globalThis.fetch,
    });
    client.acknowledge(true);
    await expect(client.recordPreference(true)).resolves.toBe(false);
  });

  it("keeps each tab queue isolated so one tab cannot overwrite another", async () => {
    const storage = new MemoryStorage();
    const tabAStorage = new MemoryStorage();
    const tabBStorage = new MemoryStorage();
    const batches: TelemetryEventV1[][] = [];
    const fetch = (async (
      path: string | URL | Request,
      init?: RequestInit,
    ) => {
      const requestPath = String(path);
      if (requestPath === "/api/v1/telemetry/session") {
        return response(PUBLIC_SESSION, true, 201);
      }
      if (requestPath === "/api/v1/telemetry/preference") {
        return response({ accepted: true, applied: true }, true, 202);
      }
      const body = JSON.parse(String(init?.body)) as {
        events: TelemetryEventV1[];
      };
      batches.push(body.events);
      return response(
        { accepted: body.events.length, duplicates: 0 },
        true,
        202,
      );
    }) as typeof globalThis.fetch;

    const tabA = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: tabAStorage,
      fetch,
    });
    tabA.acknowledge(true);
    expect(tabA.track("app_ready", { deviceClass: "desktop" })).toBe(true);
    const tabB = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: tabBStorage,
      fetch,
    });
    expect(tabB.track("mode_selected", { mode: "solo" })).toBe(true);

    const reloadedA = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: tabAStorage,
      fetch,
    });
    const reloadedB = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: tabBStorage,
      fetch,
    });
    expect(reloadedA.snapshot().queuedEvents).toBe(1);
    expect(reloadedB.snapshot().queuedEvents).toBe(1);

    await expect(reloadedA.flush()).resolves.toBe(true);
    expect(
      new TelemetryClient({
        enabledByDeployment: true,
        appVersion: "0.2.0-alpha.1",
        storage,
        sessionStorage: tabBStorage,
        fetch,
      }).snapshot().queuedEvents,
    ).toBe(1);
    await expect(reloadedB.flush()).resolves.toBe(true);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
    expect(batches[0]?.[0]?.eventId).not.toBe(batches[1]?.[0]?.eventId);
  });

  it("drops an incompatible persisted queue on app upgrade instead of blocking new events", async () => {
    const storage = new MemoryStorage();
    const tabStorage = new MemoryStorage();
    const oldClient = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.0",
      storage,
      sessionStorage: tabStorage,
    });
    oldClient.acknowledge(true);
    oldClient.track("app_ready", { deviceClass: "desktop" });
    expect(oldClient.snapshot().queuedEvents).toBe(1);

    const newClient = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: tabStorage,
    });
    expect(newClient.snapshot()).toMatchObject({
      queuedEvents: 0,
      error: expect.stringMatching(/旧版本留下的待发送数据/),
    });
    expect(
      newClient.track("mode_selected", { mode: "solo" }),
    ).toBe(true);
    expect(newClient.snapshot().queuedEvents).toBe(1);
  });

  it("reconciles a losing first-tab identity before upload", async () => {
    const storage = new MemoryStorage();
    let batchBody: {
      deletionToken: string;
      events: TelemetryEventV1[];
    } | null = null;
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      fetch: (async (
        path: string | URL | Request,
        init?: RequestInit,
      ) => {
        const requestPath = String(path);
        if (requestPath === "/api/v1/telemetry/session") {
          return response(PUBLIC_SESSION, true, 201);
        }
        if (requestPath === "/api/v1/telemetry/preference") {
          return response({ accepted: true, applied: true }, true, 202);
        }
        batchBody = JSON.parse(String(init?.body));
        return response({ accepted: 1, duplicates: 0 }, true, 202);
      }) as typeof globalThis.fetch,
    });
    client.acknowledge(true);
    client.track("app_ready", { deviceClass: "desktop" });

    const winningInstallId = "b".repeat(32);
    const winningDeletionToken = "c".repeat(64);
    storage.setItem(
      "hms-telemetry-identity-v1",
      JSON.stringify({
        schemaVersion: 1,
        pseudonymousInstallId: winningInstallId,
        deletionToken: winningDeletionToken,
      }),
    );
    await expect(client.flush()).resolves.toBe(true);
    expect(batchBody).toMatchObject({
      deletionToken: winningDeletionToken,
      events: [
        {
          pseudonymousInstallId: winningInstallId,
        },
      ],
    });
  });

  it("rejects seed-like, unknown, oversized, and non-finite properties", () => {
    expect(
      sanitizeTelemetryProperties("solo_run_started", {
        preset: "beginner",
        seed: "must-not-leave-device",
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryProperties("app_ready", {
        unknownField: true,
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryProperties("duel_dnf", {
        reason: "x".repeat(65),
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryProperties("solo_run_terminal", {
        elapsedMs: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryProperties("practice_run_started", {
        preset: "beginner",
        seed: "must-not-leave-device",
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryProperties("practice_hint_shown", {
        trigger: "REQUEST",
        status: "READY",
        action: "FLAG",
        proof: "must-stay-local",
      }),
    ).toBeNull();
  });

  it("allows bounded practice metadata without replay or board truth", () => {
    expect(
      sanitizeTelemetryProperties("practice_hint_shown", {
        trigger: "REQUEST",
        status: "READY",
        action: "FLAG",
      }),
    ).toEqual({
      trigger: "REQUEST",
      status: "READY",
      action: "FLAG",
    });
    expect(
      sanitizeTelemetryProperties("practice_hint_shown", {
        trigger: "REQUEST",
        status: "READY",
        action: "FLAG",
        rule: "SINGLE_MINE",
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryProperties("practice_hint_shown", {
        trigger: "AUTO_MARK",
        status: "READY",
        action: "FLAG",
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryProperties("practice_assist_applied", {
        trigger: "REQUEST",
        action: "FLAG",
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryProperties("practice_run_terminal", {
        outcome: "ABANDONED",
        historyFailureReason: "UNKNOWN",
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryProperties("practice_no_guess_generation_finished", {
        preset: "beginner",
        success: true,
        attempts: 3,
        elapsedMs: 42,
      }),
    ).toEqual({
      preset: "beginner",
      success: true,
      attempts: 3,
      elapsedMs: 42,
    });
  });

  it("clears the pending queue immediately when the user opts out", () => {
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    });
    client.acknowledge(true);
    expect(client.track("mode_selected", { mode: "solo" })).toBe(true);
    expect(client.snapshot().queuedEvents).toBe(1);

    expect(client.acknowledge(false)).toMatchObject({
      acknowledged: true,
      enabled: false,
      queuedEvents: 0,
    });
    expect(client.track("mode_selected", { mode: "academy" })).toBe(false);
  });

  it("records the consent switch separately without creating an install ID", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const storage = new MemoryStorage();
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      fetch: (async (
        path: string | URL | Request,
        init?: RequestInit,
      ) => {
        const requestPath = String(path);
        requests.push({
          path: requestPath,
          ...(init?.body
            ? { body: JSON.parse(String(init.body)) as unknown }
            : {}),
        });
        if (requestPath === "/api/v1/telemetry/session") {
          return response(PUBLIC_SESSION, true, 201);
        }
        return response({ accepted: true, applied: true });
      }) as typeof globalThis.fetch,
    });

    client.acknowledge(false);
    await expect(client.recordPreference(false)).resolves.toBe(true);
    expect(requests).toEqual([
      { path: "/api/v1/telemetry/session" },
      {
        path: "/api/v1/telemetry/preference",
        body: {
          enabled: false,
          consentVersion: TELEMETRY_CONSENT_VERSION,
          appVersion: "0.2.0-alpha.1",
          preferenceChangedAt: expect.stringMatching(
            /^\d{4}-\d{2}-\d{2}T/,
          ),
        },
      },
    ]);
    expect(storage.getItem("hms-telemetry-identity-v1")).toBeNull();
  });

  it("recreates an expired public telemetry session before retrying preference", async () => {
    let sessionRequests = 0;
    let preferenceRequests = 0;
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      fetch: (async (path: string | URL | Request) => {
        if (String(path) === "/api/v1/telemetry/session") {
          sessionRequests += 1;
          return response(PUBLIC_SESSION, true, sessionRequests === 1 ? 200 : 201);
        }
        preferenceRequests += 1;
        return preferenceRequests === 1
          ? response({ error: "INVALID_TELEMETRY_SESSION" }, false, 401)
          : response({ accepted: true, applied: true });
      }) as typeof globalThis.fetch,
    });

    client.acknowledge(false);
    await expect(client.recordPreference(false)).resolves.toBe(true);
    expect(sessionRequests).toBe(2);
    expect(preferenceRequests).toBe(2);
  });

  it("does not retry stale enable after another tab opts out during session renewal", async () => {
    const storage = new MemoryStorage();
    const renewalResponse = deferred<Response>();
    const renewalRequested = deferred<void>();
    let sessionRequests = 0;
    const preferenceBodies: boolean[] = [];
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      fetch: (async (
        path: string | URL | Request,
        init?: RequestInit,
      ) => {
        if (String(path) === "/api/v1/telemetry/session") {
          sessionRequests += 1;
          if (sessionRequests === 2) {
            renewalRequested.resolve();
            return await renewalResponse.promise;
          }
          return response(PUBLIC_SESSION, true, 201);
        }
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        preferenceBodies.push(body.enabled);
        return response({ error: "INVALID_TELEMETRY_SESSION" }, false, 401);
      }) as typeof globalThis.fetch,
    });
    client.acknowledge(true);
    const staleEnable = client.recordPreference(true);
    await renewalRequested.promise;

    const otherTab = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      fetch: (async () => response(PUBLIC_SESSION, true, 201)) as
        typeof globalThis.fetch,
    });
    otherTab.acknowledge(false);
    renewalResponse.resolve(response(PUBLIC_SESSION, true, 201));

    await expect(staleEnable).resolves.toBe(false);
    expect(sessionRequests).toBe(2);
    expect(preferenceBodies).toEqual([true]);
    expect(client.synchronizeConsentFromStorage()).toMatchObject({
      enabled: false,
      queuedEvents: 0,
    });
  });

  it("serializes preference changes so an older enable cannot overwrite opt-out", async () => {
    const firstEnableResponse = deferred<Response>();
    const firstEnableRequested = deferred<void>();
    const preferenceBodies: boolean[] = [];
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      fetch: (async (
        path: string | URL | Request,
        init?: RequestInit,
      ) => {
        const requestPath = String(path);
        if (requestPath === "/api/v1/telemetry/session") {
          return response(PUBLIC_SESSION, true, 201);
        }
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        preferenceBodies.push(body.enabled);
        if (body.enabled) {
          firstEnableRequested.resolve();
          return await firstEnableResponse.promise;
        }
        return response({ accepted: true, applied: true });
      }) as typeof globalThis.fetch,
    });

    client.acknowledge(true);
    const enableWrite = client.recordPreference(true);
    await firstEnableRequested.promise;
    client.acknowledge(false);
    const disableWrite = client.recordPreference(false);
    firstEnableResponse.resolve(
      response({ accepted: true, applied: true }),
    );

    await expect(enableWrite).resolves.toBe(false);
    await expect(disableWrite).resolves.toBe(true);
    expect(preferenceBodies).toEqual([true, false]);
    await expect(client.recordPreference(true)).resolves.toBe(false);
    expect(preferenceBodies).toEqual([true, false]);
  });

  it("honors an opt-out written by another tab and cannot re-enable from stale memory", async () => {
    const storage = new MemoryStorage();
    const preferenceBodies: boolean[] = [];
    const sharedFetch = (async (
      path: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(path) === "/api/v1/telemetry/session") {
        return response(PUBLIC_SESSION, true, 201);
      }
      if (String(path) === "/api/v1/telemetry/preference") {
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        preferenceBodies.push(body.enabled);
        return response({ accepted: true, applied: true });
      }
      return response({ accepted: 1, duplicates: 0 }, true, 202);
    }) as typeof globalThis.fetch;
    const tabA = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      fetch: sharedFetch,
    });
    tabA.acknowledge(true);
    expect(tabA.track("app_ready", { deviceClass: "desktop" })).toBe(true);
    await expect(tabA.recordPreference(true)).resolves.toBe(true);

    const tabB = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      fetch: sharedFetch,
    });
    tabB.acknowledge(false);
    await expect(tabB.recordPreference(false)).resolves.toBe(true);

    expect(tabA.track("mode_selected", { mode: "solo" })).toBe(false);
    expect(tabA.snapshot()).toMatchObject({
      acknowledged: true,
      enabled: false,
      queuedEvents: 0,
    });
    await expect(tabA.flush()).resolves.toBe(false);
    await expect(tabA.recordPreference(true)).resolves.toBe(false);
    expect(preferenceBodies).toEqual([true, false]);
  });

  it("rotates the visit session after 30 minutes of inactivity", async () => {
    let now = Date.UTC(2026, 6, 30);
    let uuidSequence = 0;
    let sentEvents: TelemetryEventV1[] = [];
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      now: () => now,
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
      fetch: (async (path: string | URL | Request, init?: RequestInit) => {
        const requestPath = String(path);
        if (requestPath === "/api/v1/telemetry/session") {
          return response(PUBLIC_SESSION, true, 201);
        }
        if (requestPath === "/api/v1/telemetry/preference") {
          return response({ accepted: true, applied: true });
        }
        sentEvents = (
          JSON.parse(String(init?.body)) as { events: TelemetryEventV1[] }
        ).events;
        return response({ accepted: sentEvents.length, duplicates: 0 });
      }) as typeof globalThis.fetch,
    });
    client.acknowledge(true);
    client.track("app_ready", { deviceClass: "desktop" });
    now += 30 * 60 * 1_000 + 1;
    client.track("mode_selected", { mode: "solo" });

    await client.flush();
    expect(sentEvents).toHaveLength(1);
    const firstSessionId = sentEvents[0]?.sessionId;
    await client.flush();
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]?.sessionId).not.toBe(firstSessionId);
  });

  it("uses the local deletion proof without changing local history state", async () => {
    let requestBody: unknown;
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      fetch: (async (path: string | URL | Request, init?: RequestInit) => {
        if (String(path) === "/api/v1/telemetry/session") {
          return response(PUBLIC_SESSION, true, 201);
        }
        requestBody = JSON.parse(String(init?.body));
        return response({
          accepted: true,
          deletionEpoch: 1,
          deletedBefore: new Date().toISOString(),
        });
      }) as typeof globalThis.fetch,
    });
    client.acknowledge(true);
    client.track("app_ready", { deviceClass: "desktop" });

    await expect(client.deleteRemoteRawTelemetry()).resolves.toMatchObject({
      accepted: true,
      deletionEpoch: 1,
    });
    expect(requestBody).toMatchObject({
      pseudonymousInstallId: expect.stringMatching(/^[a-f0-9]{32}$/),
      deletionToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(client.snapshot()).toMatchObject({
      enabled: true,
      queuedEvents: 0,
    });
  });

  it("propagates a persisted deletion epoch so another tab drops its old queue", async () => {
    const now = Date.UTC(2026, 6, 30, 12, 0, 0);
    const storage = new MemoryStorage();
    let batchRequests = 0;
    const fetch = (async (
      path: string | URL | Request,
    ) => {
      const requestPath = String(path);
      if (requestPath === "/api/v1/telemetry/session") {
        return response(PUBLIC_SESSION, true, 201);
      }
      if (requestPath === "/api/v1/telemetry/preference") {
        return response({ accepted: true, applied: true }, true, 202);
      }
      if (requestPath === "/api/v1/telemetry/delete") {
        return response({
          accepted: true,
          deletionEpoch: 1,
          deletedBefore: new Date(now).toISOString(),
        });
      }
      batchRequests += 1;
      return response({ accepted: 1, duplicates: 0 }, true, 202);
    }) as typeof globalThis.fetch;
    const tabA = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      fetch,
      now: () => now,
    });
    tabA.acknowledge(true);
    tabA.track("app_ready", { deviceClass: "desktop" });
    const tabB = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      fetch,
      now: () => now,
    });
    tabB.track("mode_selected", { mode: "solo" });
    expect(tabB.snapshot().queuedEvents).toBe(1);

    await expect(tabA.deleteRemoteRawTelemetry()).resolves.toMatchObject({
      accepted: true,
      deletionEpoch: 1,
    });
    await expect(tabB.flush()).resolves.toBe(false);
    expect(tabB.snapshot().queuedEvents).toBe(0);
    expect(batchRequests).toBe(0);
  });

  it("preserves post-cutoff events created while another tab deletion response is in flight", async () => {
    const cutoff = Date.UTC(2026, 6, 30, 12, 30, 0);
    let tabBNow = cutoff;
    const storage = new MemoryStorage();
    const deleteResponse = deferred<Response>();
    const deleteRequested = deferred<void>();
    let uploaded: {
      deletionEpoch: number;
      events: TelemetryEventV1[];
    } | null = null;
    const tabAFetch = (async (path: string | URL | Request) => {
      if (String(path) === "/api/v1/telemetry/session") {
        return response(PUBLIC_SESSION, true, 201);
      }
      deleteRequested.resolve();
      return await deleteResponse.promise;
    }) as typeof globalThis.fetch;
    const tabA = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      fetch: tabAFetch,
      now: () => cutoff,
    });
    tabA.acknowledge(true);
    tabA.track("app_ready", { deviceClass: "desktop" });
    const tabB = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      now: () => tabBNow,
      fetch: (async (
        path: string | URL | Request,
        init?: RequestInit,
      ) => {
        const requestPath = String(path);
        if (requestPath === "/api/v1/telemetry/session") {
          return response(PUBLIC_SESSION, true, 201);
        }
        if (requestPath === "/api/v1/telemetry/preference") {
          return response({ accepted: true, applied: true }, true, 202);
        }
        uploaded = JSON.parse(String(init?.body));
        return response({ accepted: 1, duplicates: 0 }, true, 202);
      }) as typeof globalThis.fetch,
    });

    const deletion = tabA.deleteRemoteRawTelemetry();
    await deleteRequested.promise;
    tabBNow = cutoff + 1;
    tabB.track("mode_selected", { mode: "solo" });
    deleteResponse.resolve(
      response({
        accepted: true,
        deletionEpoch: 1,
        deletedBefore: new Date(cutoff).toISOString(),
      }),
    );
    await deletion;

    await expect(tabB.flush()).resolves.toBe(true);
    expect(uploaded).toMatchObject({
      deletionEpoch: 1,
      events: [
        {
          eventName: "mode_selected",
          occurredAt: new Date(cutoff + 1).toISOString(),
        },
      ],
    });
  });

  it("keeps the highest deletion epoch when concurrent responses arrive out of order", async () => {
    const storage = new MemoryStorage();
    const identitySeeder = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
    });
    identitySeeder.acknowledge(true);
    identitySeeder.track("app_ready", { deviceClass: "desktop" });
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const makeClient = (pending: Promise<Response>) =>
      new TelemetryClient({
        enabledByDeployment: true,
        appVersion: "0.2.0-alpha.1",
        storage,
        sessionStorage: new MemoryStorage(),
        fetch: (async (path: string | URL | Request) =>
          String(path) === "/api/v1/telemetry/session"
            ? response(PUBLIC_SESSION, true, 201)
            : await pending) as typeof globalThis.fetch,
      });
    const first = makeClient(firstResponse.promise);
    const second = makeClient(secondResponse.promise);
    const firstDelete = first.deleteRemoteRawTelemetry();
    const secondDelete = second.deleteRemoteRawTelemetry();

    secondResponse.resolve(
      response({
        accepted: true,
        deletionEpoch: 2,
        deletedBefore: "2026-07-30T13:00:02.000Z",
      }),
    );
    await secondDelete;
    firstResponse.resolve(
      response({
        accepted: true,
        deletionEpoch: 1,
        deletedBefore: "2026-07-30T13:00:01.000Z",
      }),
    );
    await expect(firstDelete).resolves.toMatchObject({
      deletionEpoch: 2,
      deletedBefore: "2026-07-30T13:00:02.000Z",
    });
    expect(
      JSON.parse(
        String(storage.getItem("hms-telemetry-deletion-state-v1")),
      ),
    ).toMatchObject({
      deletionEpoch: 2,
      deletedBefore: "2026-07-30T13:00:02.000Z",
    });
  });

  it("accepts a server tombstone acknowledgement and removes an in-flight stale queue", async () => {
    const deletedBefore = new Date(Date.UTC(2026, 6, 30, 12, 0, 0)).toISOString();
    const storage = new MemoryStorage();
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      now: () => Date.parse(deletedBefore),
      fetch: (async (path: string | URL | Request) => {
        const requestPath = String(path);
        if (requestPath === "/api/v1/telemetry/session") {
          return response(PUBLIC_SESSION, true, 201);
        }
        if (requestPath === "/api/v1/telemetry/preference") {
          return response({ accepted: true, applied: true }, true, 202);
        }
        return response(
          {
            accepted: 0,
            duplicates: 0,
            discarded: 1,
            deletionEpoch: 1,
            deletedBefore,
          },
          true,
          202,
        );
      }) as typeof globalThis.fetch,
    });
    client.acknowledge(true);
    client.track("app_ready", { deviceClass: "desktop" });

    await expect(client.flush()).resolves.toBe(true);
    expect(client.snapshot().queuedEvents).toBe(0);
    expect(
      JSON.parse(
        String(
          storage.getItem("hms-telemetry-deletion-state-v1"),
        ),
      ),
    ).toMatchObject({
      deletionEpoch: 1,
      deletedBefore,
    });
  });

  it("retains post-cutoff data when an in-flight server response over-discards an old epoch", async () => {
    const cutoff = Date.UTC(2026, 6, 30, 12, 15, 0);
    let now = cutoff - 1;
    const storage = new MemoryStorage();
    const firstBatchResponse = deferred<Response>();
    const firstBatchRequested = deferred<void>();
    const batchBodies: Array<{
      deletionEpoch: number;
      events: TelemetryEventV1[];
    }> = [];
    let batchRequests = 0;
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage,
      sessionStorage: new MemoryStorage(),
      now: () => now,
      fetch: (async (
        path: string | URL | Request,
        init?: RequestInit,
      ) => {
        const requestPath = String(path);
        if (requestPath === "/api/v1/telemetry/session") {
          return response(PUBLIC_SESSION, true, 201);
        }
        if (requestPath === "/api/v1/telemetry/preference") {
          return response({ accepted: true, applied: true }, true, 202);
        }
        const body = JSON.parse(String(init?.body)) as {
          deletionEpoch: number;
          events: TelemetryEventV1[];
        };
        batchBodies.push(body);
        batchRequests += 1;
        if (batchRequests === 1) {
          firstBatchRequested.resolve();
          return await firstBatchResponse.promise;
        }
        return response(
          {
            accepted: 1,
            duplicates: 0,
            discarded: 0,
            deletionEpoch: 1,
            deletedBefore: new Date(cutoff).toISOString(),
          },
          true,
          202,
        );
      }) as typeof globalThis.fetch,
    });
    client.acknowledge(true);
    client.track("app_ready", { deviceClass: "desktop" });
    now = cutoff + 1;
    client.track("mode_selected", { mode: "solo" });

    const firstFlush = client.flush();
    await firstBatchRequested.promise;
    const identity = JSON.parse(
      String(storage.getItem("hms-telemetry-identity-v1")),
    ) as { pseudonymousInstallId: string };
    storage.setItem(
      "hms-telemetry-deletion-state-v1",
      JSON.stringify({
        schemaVersion: 1,
        pseudonymousInstallId: identity.pseudonymousInstallId,
        deletionEpoch: 1,
        deletedBefore: new Date(cutoff).toISOString(),
      }),
    );
    firstBatchResponse.resolve(
      response(
        {
          accepted: 0,
          duplicates: 0,
          discarded: 2,
          deletionEpoch: 1,
          deletedBefore: new Date(cutoff).toISOString(),
        },
        true,
        202,
      ),
    );
    await expect(firstFlush).resolves.toBe(false);
    expect(client.snapshot().queuedEvents).toBe(2);

    await expect(client.flush()).resolves.toBe(true);
    expect(batchBodies).toHaveLength(2);
    expect(batchBodies[1]).toMatchObject({
      deletionEpoch: 1,
      events: [
        {
          eventName: "mode_selected",
          occurredAt: new Date(cutoff + 1).toISOString(),
        },
      ],
    });
    expect(client.snapshot().queuedEvents).toBe(0);
  });

  it("renews an expired telemetry session once before retrying deletion", async () => {
    let sessionRequests = 0;
    let deleteRequests = 0;
    const client = new TelemetryClient({
      enabledByDeployment: true,
      appVersion: "0.2.0-alpha.1",
      storage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      fetch: (async (
        path: string | URL | Request,
        init?: RequestInit,
      ) => {
        const requestPath = String(path);
        if (requestPath === "/api/v1/telemetry/session") {
          sessionRequests += 1;
          return response(PUBLIC_SESSION, true, sessionRequests === 1 ? 201 : 200);
        }
        if (requestPath === "/api/v1/telemetry/preference") {
          return response({ accepted: true, applied: true });
        }
        if (requestPath === "/api/v1/telemetry/batch") {
          return response({ accepted: 1, duplicates: 0 }, true, 202);
        }
        expect(requestPath).toBe("/api/v1/telemetry/delete");
        expect(init?.credentials).toBe("same-origin");
        deleteRequests += 1;
        return deleteRequests === 1
          ? response({ error: "INVALID_TELEMETRY_SESSION" }, false, 401)
          : response({
              accepted: true,
              deletionEpoch: 1,
              deletedBefore: new Date().toISOString(),
            });
      }) as typeof globalThis.fetch,
    });
    client.acknowledge(true);
    client.track("app_ready", { deviceClass: "desktop" });
    await expect(client.flush()).resolves.toBe(true);
    client.acknowledge(false);

    await expect(client.deleteRemoteRawTelemetry()).resolves.toMatchObject({
      accepted: true,
      deletionEpoch: 1,
    });
    expect(sessionRequests).toBe(2);
    expect(deleteRequests).toBe(2);
  });
});
