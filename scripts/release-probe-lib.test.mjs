import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import test from "node:test";
import {
  checkPublicSoloBrowser,
  checkPublicTelemetrySession,
  checkStatic,
} from "./release-probe-lib.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../", import.meta.url);
const syntheticProbePath = new URL(
  "./synthetic-probe.mjs",
  import.meta.url,
);
const releaseSmokePath = new URL("./release-smoke.mjs", import.meta.url);
const rollbackProbePath = new URL("./verify-rollback.mjs", import.meta.url);
const BUILD_SHA = "0123456789012345678901234567890123456789";

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

async function fixtureServer({
  interactive = true,
  autoTelemetry = false,
  secureTelemetryCookie = true,
  telemetryCookieMaxAge = 604_800,
  telemetryEnabled = true,
  renderTelemetryPrompt = true,
  duelExperimentEnabled = false,
} = {}) {
  const requests = [];
  let telemetryPreferenceEnabled = false;
  let deletionEpoch = 0;
  let deletedBefore = null;
  const telemetryEventIds = new Set();
  const server = createServer((request, response) => {
    const recordedRequest = {
      method: request.method,
      path: request.url,
      cookie: request.headers.cookie ?? null,
    };
    requests.push(recordedRequest);

    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<meta name="hms-build-app-version" content="0.2.0-alpha.1">
         <meta name="hms-build-sha" content="${BUILD_SHA}">
         <meta name="hms-build-region" content="test">
         <meta name="hms-build-telemetry-enabled" content="${telemetryEnabled}">
         <meta name="hms-build-duel-experiment" content="${duelExperimentEnabled}">
         ${
           interactive
             ? '<div id="root"></div><script src="/assets/app.js"></script>'
             : '<div id="root"></div>'
         }`,
      );
      return;
    }
    if (request.url === "/assets/app.js" && interactive) {
      response.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
      });
      response.end(`
        const root = document.querySelector("#root");
        ${autoTelemetry ? 'void fetch("/api/v1/telemetry/session", { method: "POST" });' : ""}
        ${
          telemetryEnabled && renderTelemetryPrompt
            ? `
        const privacyDialog = document.createElement("section");
        const privacyHeading = document.createElement("h2");
        privacyHeading.textContent = "选择是否分享假名化使用数据";
        privacyDialog.append(privacyHeading);
        root.append(privacyDialog);
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape") privacyDialog.remove();
        });
        `
            : ""
        }
        const button = document.createElement("button");
        button.textContent = "单人游戏 · 立即开局";
        button.addEventListener("click", () => {
          root.innerHTML = "<h1>经典扫雷</h1>";
        });
        root.append(button);
        ${
          duelExperimentEnabled
            ? `
        const duelButton = document.createElement("button");
        duelButton.textContent = "1v1 实验";
        root.append(duelButton);
        `
            : ""
        }
      `);
      return;
    }
    if (request.url === "/web-healthz") {
      json(response, 200, { status: "ok", surface: "web" });
      return;
    }
    if (request.url === "/live") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (request.url === "/ready") {
      json(response, 200, {
        status: "ready",
        telemetry: { available: true },
        capacity: {
          acceptingNewGuestSessions: false,
          acceptingNewRooms: false,
        },
      });
      return;
    }
    if (request.url === "/version") {
      json(response, 200, {
        appVersion: "0.2.0-alpha.1",
        commitSha: BUILD_SHA,
        region: "test",
        protocolVersion: 2,
        localSchemaVersion: "HMS-local-history-v1",
        serverSchemaVersion: 4,
        duelExperimentEnabled,
      });
      return;
    }
    if (request.url === "/api/v1/telemetry/session") {
      const restored = request.headers.cookie?.includes(
        "hms_telemetry_session=",
      );
      json(
        response,
        restored ? 200 : 201,
        {
          sessionId: "synthetic-telemetry-session",
          expiresAt: Date.now() + 604_800_000,
          batchId: "public",
          cohortSegment: "unsegmented",
        },
        restored
          ? {}
          : {
              "set-cookie":
                `hms_telemetry_session=opaque; Path=/api/v1/telemetry; Max-Age=${telemetryCookieMaxAge}; HttpOnly;${secureTelemetryCookie ? " Secure;" : ""} SameSite=Lax`,
            },
      );
      return;
    }
    if (request.url === "/api/v1/telemetry/preference") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        recordedRequest.body = parsed;
        telemetryPreferenceEnabled = parsed.enabled === true;
        json(response, 202, { accepted: true, applied: true });
      });
      return;
    }
    if (request.url === "/api/v1/telemetry/batch") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        recordedRequest.body = parsed;
        if (!telemetryPreferenceEnabled) {
          json(response, 403, { error: "TELEMETRY_NOT_ENABLED" });
          return;
        }
        let accepted = 0;
        let duplicates = 0;
        let discarded = 0;
        for (const event of parsed.events) {
          if (
            deletedBefore !== null &&
            Date.parse(event.occurredAt) <= deletedBefore
          ) {
            discarded += 1;
          } else if (telemetryEventIds.has(event.eventId)) {
            duplicates += 1;
          } else {
            telemetryEventIds.add(event.eventId);
            accepted += 1;
          }
        }
        json(response, 202, {
          accepted,
          duplicates,
          discarded,
          deletionEpoch,
          deletedBefore:
            deletedBefore === null
              ? null
              : new Date(deletedBefore).toISOString(),
        });
      });
      return;
    }
    if (request.url === "/api/v1/telemetry/delete") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        recordedRequest.body = JSON.parse(body);
        telemetryEventIds.clear();
        deletionEpoch += 1;
        deletedBefore = Date.now();
        json(response, 200, {
          accepted: true,
          deletionEpoch,
          deletedBefore: new Date(deletedBefore).toISOString(),
        });
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not expose a TCP port");
  }
  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}/`),
    requests,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function runProbe(scriptPath, baseUrl, arguments_ = [], environment = {}) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [scriptPath.pathname, ...arguments_],
    {
      cwd: repositoryRoot.pathname,
      env: {
        ...process.env,
        HMS_ALLOW_INSECURE_LOCAL: "true",
        HMS_PROBE_TIMEOUT_MS: "5000",
        ...environment,
      },
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(stderr, "");
  return JSON.parse(stdout);
}

function runSynthetic(baseUrl, arguments_ = [], environment = {}) {
  return runProbe(syntheticProbePath, baseUrl, arguments_, {
    HMS_PROBE_BASE_URL: baseUrl.href,
    HMS_PROBE_REGION: "test-observer",
    ...environment,
  });
}

test("default synthetic probe exercises browser solo without telemetry writes", async () => {
  const fixture = await fixtureServer();
  try {
    const result = await runSynthetic(fixture.baseUrl);

    assert.equal(result.ok, true);
    assert.equal(result.probeMode, "stateless");
    assert.equal(result.browserSoloProbed, true);
    assert.equal(result.telemetrySessionProbed, false);
    assert.equal(result.realtimeTransportProbed, false);
    assert.equal(result.duelIntegrityProbed, false);
    assert.equal(result.expectedPersistentTelemetrySessionsPerRun, 0);
    assert.equal(result.surfaces.web.ok, true);
    assert.equal(result.surfaces.server.ok, true);
    assert.equal(result.surfaces.telemetry.probed, false);
    assert.equal("ok" in result.surfaces.telemetry, false);
    assert.deepEqual(
      result.checks.map((check) => check.name),
      [
        "web_static_shell",
        "web_health",
        "browser_public_solo_entry",
        "server_live",
        "server_ready",
        "server_version",
      ],
    );
    assert.equal(
      fixture.requests.some((request) =>
        request.path?.startsWith("/api/v1/telemetry/"),
      ),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("telemetry mode is explicit, low-frequency, and creates one durable session", async () => {
  const fixture = await fixtureServer();
  try {
    const result = await runSynthetic(fixture.baseUrl, [
      "--mode=telemetry",
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.probeMode, "telemetry");
    assert.equal(result.recommendedIntervalSeconds, 900);
    assert.equal(result.browserSoloProbed, false);
    assert.equal(result.telemetrySessionProbed, true);
    assert.equal(result.realtimeTransportProbed, false);
    assert.equal(result.duelIntegrityProbed, false);
    assert.equal(result.expectedPersistentTelemetrySessionsPerRun, 1);
    assert.equal(result.surfaces.web.probed, false);
    assert.equal(result.surfaces.telemetry.ok, true);
    assert.equal(
      fixture.requests.filter(
        (request) => request.path === "/api/v1/telemetry/session",
      ).length,
      2,
    );
    assert.equal(
      fixture.requests.filter(
        (request) => request.path === "/api/v1/telemetry/preference",
      ).length,
      2,
    );
    assert.equal(
      fixture.requests
        .filter(
          (request) => request.path === "/api/v1/telemetry/preference",
        )
        .every(
          (request) => request.body?.appVersion === "synthetic-probe-v1",
        ),
      true,
    );
    assert.equal(
      fixture.requests.filter(
        (request) => request.path === "/api/v1/telemetry/batch",
      ).length,
      4,
    );
    assert.equal(
      fixture.requests.filter(
        (request) => request.path === "/api/v1/telemetry/delete",
      ).length,
      1,
    );
    assert.equal(
      fixture.requests.some((request) => request.path === "/"),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("telemetry lifecycle rejects a cookie without required security attributes", async () => {
  const fixture = await fixtureServer({ secureTelemetryCookie: false });
  try {
    await assert.rejects(
      () =>
        checkPublicTelemetrySession(
          fixture.baseUrl,
          "0.2.0-alpha.1",
        ),
      /missing required attribute secure/,
    );
  } finally {
    await fixture.close();
  }
});

test("telemetry lifecycle rejects a cookie whose Max-Age disagrees with expiry", async () => {
  const fixture = await fixtureServer({ telemetryCookieMaxAge: 1 });
  try {
    await assert.rejects(
      () =>
        checkPublicTelemetrySession(
          fixture.baseUrl,
          "0.2.0-alpha.1",
        ),
      /Max-Age does not match the returned expiry/,
    );
  } finally {
    await fixture.close();
  }
});

test("stateless synthetic probe supports an explicitly enabled duel entry", async () => {
  const fixture = await fixtureServer({ duelExperimentEnabled: true });
  try {
    const result = await runSynthetic(fixture.baseUrl, [], {
      HMS_PROBE_EXPECTED_DUEL: "true",
    });
    assert.equal(result.ok, true);
    assert.equal(result.probeMode, "stateless");
    assert.equal(result.browserSoloProbed, true);
  } finally {
    await fixture.close();
  }
});

test("an HTML root is not accepted as a working solo entry", async () => {
  const fixture = await fixtureServer({ interactive: false });
  const previousTimeout = process.env.HMS_PROBE_TIMEOUT_MS;
  process.env.HMS_PROBE_TIMEOUT_MS = "700";
  try {
    await assert.doesNotReject(() => checkStatic(fixture.baseUrl));
    await assert.rejects(
      () => checkPublicSoloBrowser(fixture.baseUrl),
      /单人游戏 · 立即开局|waiting for getByRole/,
    );
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.HMS_PROBE_TIMEOUT_MS;
    } else {
      process.env.HMS_PROBE_TIMEOUT_MS = previousTimeout;
    }
    await fixture.close();
  }
});

test("stateless browser solo fails if the page touches a stateful surface", async () => {
  const fixture = await fixtureServer({ autoTelemetry: true });
  try {
    await assert.rejects(
      () => checkPublicSoloBrowser(fixture.baseUrl),
      /stateful network surface: \/api\/v1\/telemetry\/session/,
    );
  } finally {
    await fixture.close();
  }
});

test("missing Chromium is reported as an unavailable browser layer", async () => {
  const fixture = await fixtureServer();
  try {
    await assert.rejects(
      () =>
        checkPublicSoloBrowser(fixture.baseUrl, {
          executablePath: "/definitely/missing/hms-probe-chromium",
        }),
      /browser probe unavailable: Chromium could not start/,
    );
  } finally {
    await fixture.close();
  }
});

test("release smoke rejects a telemetry build without its disclosure", async () => {
  const fixture = await fixtureServer({ renderTelemetryPrompt: false });
  try {
    await assert.rejects(
      () =>
        runProbe(releaseSmokePath, fixture.baseUrl, [], {
          HMS_SMOKE_BASE_URL: fixture.baseUrl.href,
          HMS_EXPECTED_APP_VERSION: "0.2.0-alpha.1",
          HMS_EXPECTED_BUILD_SHA: BUILD_SHA,
          HMS_EXPECTED_REGION: "test",
          HMS_EXPECTED_PROTOCOL_VERSION: "2",
          HMS_EXPECTED_LOCAL_SCHEMA_VERSION: "HMS-local-history-v1",
          HMS_EXPECTED_SERVER_SCHEMA_VERSION: "4",
        }),
      /Command failed/,
    );
  } finally {
    await fixture.close();
  }
});

test("release smoke includes browser solo and the one-off telemetry lifecycle", async () => {
  const fixture = await fixtureServer();
  try {
    const result = await runProbe(releaseSmokePath, fixture.baseUrl, [], {
      HMS_SMOKE_BASE_URL: fixture.baseUrl.href,
      HMS_EXPECTED_APP_VERSION: "0.2.0-alpha.1",
      HMS_EXPECTED_BUILD_SHA: BUILD_SHA,
      HMS_EXPECTED_REGION: "test",
      HMS_EXPECTED_PROTOCOL_VERSION: "2",
      HMS_EXPECTED_LOCAL_SCHEMA_VERSION: "HMS-local-history-v1",
      HMS_EXPECTED_SERVER_SCHEMA_VERSION: "4",
    });

    assert.equal(result.ok, true);
    assert.equal(result.browserSoloProbed, true);
    assert.equal(result.telemetrySessionProbed, true);
    assert.equal(result.duelIntegrityProbed, false);
    assert.equal(result.surfaces.web.ok, true);
    assert.equal(result.surfaces.server.ok, true);
    assert.equal(result.surfaces.telemetry.ok, true);
    assert.equal(
      result.checks.some(
        (check) => check.name === "browser_public_solo_entry",
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("rollback verification uses browser solo without creating telemetry state", async () => {
  const fixture = await fixtureServer();
  try {
    const result = await runProbe(rollbackProbePath, fixture.baseUrl, [], {
      HMS_ROLLBACK_BASE_URL: fixture.baseUrl.href,
      HMS_EXPECTED_APP_VERSION: "0.2.0-alpha.1",
      HMS_EXPECTED_BUILD_SHA: BUILD_SHA,
      HMS_REJECT_BUILD_SHA: "fedcba9876543210",
      HMS_EXPECTED_REGION: "test",
      HMS_EXPECTED_PROTOCOL_VERSION: "2",
      HMS_EXPECTED_LOCAL_SCHEMA_VERSION: "HMS-local-history-v1",
      HMS_EXPECTED_SERVER_SCHEMA_VERSION: "4",
      HMS_EXPECTED_TELEMETRY_ENABLED: "true",
    });

    assert.equal(result.ok, true);
    assert.equal(result.browserSoloProbed, true);
    assert.equal(result.surfaces.web.ok, true);
    assert.equal(result.surfaces.server.ok, true);
    assert.equal(
      fixture.requests.some((request) =>
        request.path?.startsWith("/api/v1/telemetry/"),
      ),
      false,
    );
  } finally {
    await fixture.close();
  }
});
