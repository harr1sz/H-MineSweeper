import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";

const TELEMETRY_COOKIE_NAME = "hms_telemetry_session";
const SYNTHETIC_TELEMETRY_APP_VERSION = "synthetic-probe-v1";
const DEFAULT_TIMEOUT_MS = 10_000;

function requiredUrl(value, name) {
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      process.env.HMS_ALLOW_INSECURE_LOCAL === "true" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    )
  ) {
    throw new Error(
      `${name} must use https (set HMS_ALLOW_INSECURE_LOCAL=true only for localhost)`,
    );
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function timeoutMs() {
  const parsed = Number(process.env.HMS_PROBE_TIMEOUT_MS);
  return Number.isSafeInteger(parsed) && parsed >= 500
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

function cookieFromResponse(response, expiresAt) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("Telemetry session response did not set a session cookie");
  }
  const match = setCookie.match(
    new RegExp(`(?:^|,\\s*)${TELEMETRY_COOKIE_NAME}=([^;]+)`),
  );
  if (!match?.[1]) {
    throw new Error(
      "Telemetry session response did not set the expected session cookie",
    );
  }
  const attributes = new Map(
    setCookie
      .split(";")
      .slice(1)
      .map((attribute) => {
        const normalized = attribute.trim().toLowerCase();
        const separator = normalized.indexOf("=");
        return separator === -1
          ? [normalized, true]
          : [
              normalized.slice(0, separator),
              normalized.slice(separator + 1),
            ];
      }),
  );
  for (const [required, expected] of [
    ["path", "/api/v1/telemetry"],
    ["httponly", true],
    ["secure", true],
    ["samesite", "lax"],
  ]) {
    if (attributes.get(required) !== expected) {
      throw new Error(
        `Telemetry session cookie is missing required attribute ${required}${expected === true ? "" : `=${expected}`}`,
      );
    }
  }
  const maxAge = Number(attributes.get("max-age"));
  const remainingSeconds = Math.floor((expiresAt - Date.now()) / 1_000);
  if (
    !Number.isSafeInteger(maxAge) ||
    maxAge < 1 ||
    remainingSeconds < 1 ||
    Math.abs(maxAge - remainingSeconds) > 5
  ) {
    throw new Error(
      "Telemetry session cookie Max-Age does not match the returned expiry",
    );
  }
  return `${TELEMETRY_COOKIE_NAME}=${match[1]}`;
}

function ensureStatus(response, expectedStatus, checkName) {
  const expected = Array.isArray(expectedStatus)
    ? expectedStatus
    : [expectedStatus];
  if (!expected.includes(response.status)) {
    throw new Error(
      `${checkName} returned HTTP ${response.status}; expected ${expected.join("/")}`,
    );
  }
}

async function parseJson(response, checkName) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${checkName} did not return valid JSON`);
  }
}

export function baseUrlFromEnvironment(variable = "HMS_PROBE_BASE_URL") {
  return requiredUrl(process.env[variable], variable);
}

export function optionalIntegerFromEnvironment(variable) {
  const value = process.env[variable];
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${variable} must be a non-negative integer`);
  }
  return parsed;
}

export function requiredStringFromEnvironment(variable) {
  const value = process.env[variable]?.trim();
  if (!value) throw new Error(`${variable} is required`);
  return value;
}

export function requiredIntegerFromEnvironment(variable) {
  const value = optionalIntegerFromEnvironment(variable);
  if (value === undefined) throw new Error(`${variable} is required`);
  return value;
}

export function requiredBuildShaFromEnvironment(variable) {
  const value = requiredStringFromEnvironment(variable);
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${variable} must be a full 40-character commit SHA`);
  }
  return value;
}

export async function timed(checkName, operation) {
  const startedAt = performance.now();
  const value = await operation();
  return {
    name: checkName,
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    value,
  };
}

export async function request(baseUrl, path, options = {}) {
  const url = new URL(path, baseUrl);
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs()),
  });
}

export async function checkStatic(baseUrl) {
  const response = await request(baseUrl, "/");
  ensureStatus(response, 200, "static shell");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error("static shell did not return HTML");
  }
  const body = await response.text();
  if (!body.includes('id="root"')) {
    throw new Error("static shell is missing the application root");
  }
  return { status: response.status };
}

export async function checkWebHealth(baseUrl) {
  const response = await request(baseUrl, "/web-healthz");
  ensureStatus(response, 200, "web gateway health");
  const body = await parseJson(response, "web gateway health");
  if (body.status !== "ok" || body.surface !== "web") {
    throw new Error("web gateway health did not identify the static web surface");
  }
  return { status: body.status, surface: body.surface };
}

function playwrightChromium() {
  try {
    const requireFromWeb = createRequire(
      new URL("../apps/web/package.json", import.meta.url),
    );
    return requireFromWeb("@playwright/test").chromium;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `browser probe unavailable: Playwright Chromium could not be loaded (${detail})`,
    );
  }
}

export async function checkPublicSoloBrowser(
  baseUrl,
  {
    browserType = playwrightChromium(),
    executablePath = process.env.HMS_PROBE_BROWSER_EXECUTABLE_PATH,
    expectedAppVersion,
    expectedBuildSha,
    expectedRegion,
    expectedTelemetryEnabled,
    expectedDuelEnabled = false,
  } = {},
) {
  let browser;
  try {
    browser = await browserType.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `browser probe unavailable: Chromium could not start (${detail})`,
    );
  }

  const pageErrors = [];
  const forbiddenNetwork = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const inspectNetworkTarget = (target) => {
      const url = new URL(target);
      const path = url.pathname;
      if (
        path.startsWith("/api/v1/telemetry/") ||
        path === "/api/v1/guest-session" ||
        path === "/api/v1/rooms" ||
        path.startsWith("/api/v1/rooms/") ||
        path.startsWith("/api/v1/replays/") ||
        path.startsWith("/realtime/")
      ) {
        forbiddenNetwork.push(path);
      }
    };
    page.on("request", (request) => inspectNetworkTarget(request.url()));
    page.on("websocket", (socket) => inspectNetworkTarget(socket.url()));

    const response = await page.goto(baseUrl.href, {
      waitUntil: "networkidle",
      timeout: timeoutMs(),
    });
    if (!response || !response.ok()) {
      throw new Error(
        `browser public entry returned HTTP ${response?.status() ?? "unknown"}`,
      );
    }

    const buildAppVersion = await page
      .locator('meta[name="hms-build-app-version"]')
      .getAttribute("content");
    const buildSha = await page
      .locator('meta[name="hms-build-sha"]')
      .getAttribute("content");
    const buildRegion = await page
      .locator('meta[name="hms-build-region"]')
      .getAttribute("content");
    const telemetryFlag = await page
      .locator('meta[name="hms-build-telemetry-enabled"]')
      .getAttribute("content");
    const duelFlag = await page
      .locator('meta[name="hms-build-duel-experiment"]')
      .getAttribute("content");
    if (
      !buildAppVersion ||
      !/^[0-9a-f]{40}$/i.test(buildSha ?? "") ||
      !buildRegion ||
      ["development", "local", "unspecified", "uninitialized"].includes(
        buildRegion,
      ) ||
      !["true", "false"].includes(telemetryFlag ?? "") ||
      !["true", "false"].includes(duelFlag ?? "")
    ) {
      throw new Error("browser build identity metadata is missing or invalid");
    }
    const telemetryEnabled = telemetryFlag === "true";
    const duelBuildEnabled = duelFlag === "true";
    if (
      expectedAppVersion !== undefined &&
      buildAppVersion !== expectedAppVersion
    ) {
      throw new Error(
        `browser app version is ${buildAppVersion}; expected ${expectedAppVersion}`,
      );
    }
    if (expectedBuildSha !== undefined && buildSha !== expectedBuildSha) {
      throw new Error(
        `browser build SHA is ${buildSha}; expected ${expectedBuildSha}`,
      );
    }
    if (expectedRegion !== undefined && buildRegion !== expectedRegion) {
      throw new Error(
        `browser build region is ${buildRegion}; expected ${expectedRegion}`,
      );
    }
    if (
      expectedTelemetryEnabled !== undefined &&
      telemetryEnabled !== expectedTelemetryEnabled
    ) {
      throw new Error(
        `browser telemetry feature flag is ${telemetryEnabled}; expected ${expectedTelemetryEnabled}`,
      );
    }
    if (duelBuildEnabled !== expectedDuelEnabled) {
      throw new Error(
        `browser duel build flag is ${duelBuildEnabled}; expected ${expectedDuelEnabled}`,
      );
    }

    const privacyPrompt = page.getByRole("heading", {
      name: "选择是否分享假名化使用数据",
    });
    const privacyPromptVisible = await privacyPrompt
      .isVisible({ timeout: Math.min(timeoutMs(), 2_000) })
      .catch(() => false);
    if (expectedTelemetryEnabled === true && !privacyPromptVisible) {
      throw new Error(
        "browser telemetry disclosure is missing from a clean context",
      );
    }
    if (expectedTelemetryEnabled === false && privacyPromptVisible) {
      throw new Error(
        "browser telemetry disclosure is visible while telemetry is disabled",
      );
    }
    if (privacyPromptVisible) {
      await page.keyboard.press("Escape");
      await privacyPrompt.waitFor({
        state: "hidden",
        timeout: timeoutMs(),
      });
    }

    const soloEntry = page.getByRole("button", {
      name: "单人游戏 · 立即开局",
      exact: true,
    });
    await soloEntry.waitFor({ state: "visible", timeout: timeoutMs() });
    const duelEntryCount = await page
      .getByRole("button", { name: "1v1 实验", exact: true })
      .count();
    if ((duelEntryCount > 0) !== expectedDuelEnabled) {
      throw new Error(
        `browser duel feature flag is ${duelEntryCount > 0}; expected ${expectedDuelEnabled}`,
      );
    }
    await soloEntry.click({ timeout: timeoutMs() });
    await page
      .getByRole("heading", { name: "经典扫雷", exact: true })
      .waitFor({ state: "visible", timeout: timeoutMs() });

    if (pageErrors.length > 0) {
      throw new Error(
        `browser public solo entry raised a page error: ${pageErrors[0]}`,
      );
    }
    if (forbiddenNetwork.length > 0) {
      throw new Error(
        `browser public solo entry touched a stateful network surface: ${forbiddenNetwork[0]}`,
      );
    }
    return {
      status: "ok",
      browser: "chromium",
      interaction: "solo_entry_clicked",
      appVersion: buildAppVersion,
      commitSha: buildSha,
      region: buildRegion,
      telemetryEnabled,
      duelExperimentEnabled: duelEntryCount > 0,
    };
  } finally {
    await browser.close();
  }
}

export async function checkLive(baseUrl) {
  const response = await request(baseUrl, "/live");
  ensureStatus(response, 200, "live");
  const body = await parseJson(response, "live");
  if (body.status !== "ok") throw new Error("live status is not ok");
  return { status: body.status };
}

export async function checkReady(
  baseUrl,
  { requireDuelCapacity = false } = {},
) {
  const response = await request(baseUrl, "/ready");
  ensureStatus(response, 200, "ready");
  const body = await parseJson(response, "ready");
  if (body.status !== "ready") throw new Error("ready status is not ready");
  if (
    requireDuelCapacity &&
    (
      body.capacity?.acceptingNewGuestSessions !== true ||
      body.capacity?.acceptingNewRooms !== true
    )
  ) {
    throw new Error("ready duel capacity is not accepting new work");
  }
  return {
    status: body.status,
    telemetry: body.telemetry,
    capacity: body.capacity,
  };
}

export async function checkVersion(baseUrl, expected = {}) {
  const response = await request(baseUrl, "/version");
  ensureStatus(response, 200, "version");
  const body = await parseJson(response, "version");
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && body[field] !== expectedValue) {
      throw new Error(
        `version field ${field} is ${String(body[field])}; expected ${expectedValue}`,
      );
    }
  }
  if (
    typeof body.appVersion !== "string" ||
    typeof body.commitSha !== "string" ||
    typeof body.region !== "string" ||
    !Number.isSafeInteger(body.protocolVersion) ||
    typeof body.localSchemaVersion !== "string" ||
    !Number.isSafeInteger(body.serverSchemaVersion) ||
    typeof body.duelExperimentEnabled !== "boolean"
  ) {
    throw new Error("version response is missing build identity fields");
  }
  return body;
}

export async function checkPublicTelemetrySession(baseUrl, appVersion) {
  if (typeof appVersion !== "string" || appVersion.length === 0) {
    throw new Error("appVersion is required for the telemetry preference probe");
  }
  const created = await request(baseUrl, "/api/v1/telemetry/session", {
    method: "POST",
  });
  ensureStatus(created, [200, 201], "public telemetry session");
  const body = await parseJson(created, "public telemetry session");
  if (
    typeof body.sessionId !== "string" ||
    typeof body.expiresAt !== "number" ||
    body.expiresAt <= Date.now() ||
    body.batchId !== "public" ||
    body.cohortSegment !== "unsegmented"
  ) {
    throw new Error("public telemetry session returned an invalid identity");
  }
  const cookie = cookieFromResponse(created, body.expiresAt);
  const restored = await request(baseUrl, "/api/v1/telemetry/session", {
    method: "POST",
    cookie,
  });
  ensureStatus(restored, 200, "public telemetry session restore");
  const restoredBody = await parseJson(
    restored,
    "public telemetry session restore",
  );
  if (
    restoredBody.sessionId !== body.sessionId ||
    restoredBody.batchId !== "public" ||
    restoredBody.cohortSegment !== "unsegmented"
  ) {
    throw new Error("public telemetry session restore changed identity");
  }
  const consentVersion = "synthetic-probe-consent-v1";
  const enablePreference = await request(
    baseUrl,
    "/api/v1/telemetry/preference",
    {
      method: "POST",
      cookie,
      body: {
        enabled: true,
        consentVersion,
        appVersion: SYNTHETIC_TELEMETRY_APP_VERSION,
        preferenceChangedAt: new Date().toISOString(),
      },
    },
  );
  ensureStatus(enablePreference, 202, "public telemetry enable preference");
  const enableBody = await parseJson(
    enablePreference,
    "public telemetry enable preference",
  );
  if (enableBody.accepted !== true || enableBody.applied !== true) {
    throw new Error("public telemetry enable preference was not accepted");
  }

  const pseudonymousInstallId = `synthetic-install-${randomUUID()}`;
  const deletionToken = createHash("sha256")
    .update(`synthetic-deletion-${randomUUID()}`)
    .digest("hex");
  const event = {
    schemaVersion: 1,
    eventId: `synthetic-event-${randomUUID()}`,
    pseudonymousInstallId,
    sessionId: `synthetic-visit-${randomUUID()}`,
    eventName: "app_ready",
    occurredAt: new Date().toISOString(),
    consentVersion,
    appVersion: SYNTHETIC_TELEMETRY_APP_VERSION,
    properties: {
      browserFamily: "other",
      deviceClass: "desktop",
      viewportBucket: "768_1279",
    },
  };
  const batchBody = {
    deletionToken,
    deletionEpoch: 0,
    events: [event],
  };
  const firstBatch = await request(baseUrl, "/api/v1/telemetry/batch", {
    method: "POST",
    cookie,
    body: batchBody,
  });
  ensureStatus(firstBatch, 202, "public telemetry first batch");
  const firstBatchBody = await parseJson(
    firstBatch,
    "public telemetry first batch",
  );
  if (
    firstBatchBody.accepted !== 1 ||
    firstBatchBody.duplicates !== 0 ||
    firstBatchBody.discarded !== 0 ||
    firstBatchBody.deletionEpoch !== 0
  ) {
    throw new Error("public telemetry first batch returned an invalid ACK");
  }

  const duplicateBatch = await request(baseUrl, "/api/v1/telemetry/batch", {
    method: "POST",
    cookie,
    body: batchBody,
  });
  ensureStatus(duplicateBatch, 202, "public telemetry duplicate batch");
  const duplicateBody = await parseJson(
    duplicateBatch,
    "public telemetry duplicate batch",
  );
  if (
    duplicateBody.accepted !== 0 ||
    duplicateBody.duplicates !== 1 ||
    duplicateBody.discarded !== 0
  ) {
    throw new Error("public telemetry duplicate batch was not idempotent");
  }

  const deletion = await request(baseUrl, "/api/v1/telemetry/delete", {
    method: "POST",
    cookie,
    body: {
      pseudonymousInstallId,
      deletionToken,
    },
  });
  ensureStatus(deletion, 200, "public telemetry deletion");
  const deletionBody = await parseJson(
    deletion,
    "public telemetry deletion",
  );
  if (
    deletionBody.accepted !== true ||
    !Number.isSafeInteger(deletionBody.deletionEpoch) ||
    deletionBody.deletionEpoch < 1 ||
    !Number.isFinite(Date.parse(deletionBody.deletedBefore))
  ) {
    throw new Error("public telemetry deletion returned an invalid proof");
  }

  const staleReplay = await request(baseUrl, "/api/v1/telemetry/batch", {
    method: "POST",
    cookie,
    body: batchBody,
  });
  ensureStatus(staleReplay, 202, "public telemetry stale replay");
  const staleReplayBody = await parseJson(
    staleReplay,
    "public telemetry stale replay",
  );
  if (
    staleReplayBody.accepted !== 0 ||
    staleReplayBody.duplicates !== 0 ||
    staleReplayBody.discarded !== 1 ||
    staleReplayBody.deletionEpoch !== deletionBody.deletionEpoch
  ) {
    throw new Error("public telemetry deletion allowed stale data to return");
  }

  const disablePreference = await request(
    baseUrl,
    "/api/v1/telemetry/preference",
    {
      method: "POST",
      cookie,
      body: {
        enabled: false,
        consentVersion,
        appVersion: SYNTHETIC_TELEMETRY_APP_VERSION,
        preferenceChangedAt: new Date(Date.now() + 1).toISOString(),
      },
    },
  );
  ensureStatus(disablePreference, 202, "public telemetry opt-out preference");
  const disableBody = await parseJson(
    disablePreference,
    "public telemetry opt-out preference",
  );
  if (disableBody.accepted !== true || disableBody.applied !== true) {
    throw new Error("public telemetry opt-out preference was not accepted");
  }

  const blockedBatch = await request(baseUrl, "/api/v1/telemetry/batch", {
    method: "POST",
    cookie,
    body: {
      deletionToken,
      deletionEpoch: deletionBody.deletionEpoch,
      events: [
        {
          ...event,
          eventId: `synthetic-event-${randomUUID()}`,
          occurredAt: new Date(Date.now() + 2).toISOString(),
        },
      ],
    },
  });
  ensureStatus(blockedBatch, 403, "public telemetry post-opt-out batch");
  const blockedBody = await parseJson(
    blockedBatch,
    "public telemetry post-opt-out batch",
  );
  if (blockedBody.error !== "TELEMETRY_NOT_ENABLED") {
    throw new Error("public telemetry accepted data after opt-out");
  }

  return {
    sessionId: body.sessionId,
    expiresAt: body.expiresAt,
    created: created.status === 201,
    preferenceAppVersion: SYNTHETIC_TELEMETRY_APP_VERSION,
    lifecycle: {
      firstBatchAccepted: true,
      duplicateWasIdempotent: true,
      deletionBlockedReplay: true,
      optOutBlockedNewBatch: true,
    },
  };
}

function waitForSocketMessage(socket, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WebSocket timed out waiting for ${label}`));
    }, timeoutMs());
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = (code) => {
      cleanup();
      reject(new Error(`WebSocket closed with code ${code} before ${label}`));
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket failed before ${label}`));
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

function waitForSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket connection timed out"));
    }, timeoutMs());
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = (code) => {
      cleanup();
      reject(new Error(`WebSocket closed during handshake with code ${code}`));
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket handshake failed"));
    };
    socket.on("open", onOpen);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

export async function checkRealtimeTransportHelloPing(
  baseUrl,
  protocolVersion,
) {
  const guestResponse = await request(baseUrl, "/api/v1/guest-session", {
    method: "POST",
    body: { displayName: "Synthetic" },
  });
  ensureStatus(guestResponse, 201, "synthetic guest");
  const guest = await parseJson(guestResponse, "synthetic guest");

  const roomResponse = await request(baseUrl, "/api/v1/rooms", {
    method: "POST",
    body: { guestToken: guest.guestToken },
  });
  ensureStatus(roomResponse, 201, "synthetic room");
  const room = await parseJson(roomResponse, "synthetic room");

  const requireFromServer = createRequire(
    new URL("../apps/server/package.json", import.meta.url),
  );
  const { WebSocket } = requireFromServer("ws");
  const socketUrl = new URL("/realtime/v2", baseUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(socketUrl, {
    origin: baseUrl.origin,
    handshakeTimeout: timeoutMs(),
  });

  try {
    await waitForSocketOpen(socket);
    const welcome = waitForSocketMessage(
      socket,
      (message) =>
        message?.type === "WELCOME" &&
        message?.v === protocolVersion,
      "WELCOME",
    );
    socket.send(
      JSON.stringify({
        type: "HELLO",
        v: protocolVersion,
        ticket: room.ticket,
      }),
    );
    await welcome;

    const at = Date.now();
    const pong = waitForSocketMessage(
      socket,
      (message) =>
        message?.type === "PONG" &&
        message?.v === protocolVersion &&
        message?.at === at,
      "PONG",
    );
    socket.send(JSON.stringify({ type: "PING", at }));
    const reply = await pong;
    return {
      protocolVersion,
      roundTripMs: Math.max(0, Date.now() - at),
      serverTime: reply.serverTime,
    };
  } finally {
    socket.close(1000, "Synthetic probe complete");
  }
}

export function publicFailure(error) {
  return error instanceof Error ? error.message : "Unknown probe failure";
}
