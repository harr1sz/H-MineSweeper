import {
  baseUrlFromEnvironment,
  checkLive,
  checkPublicSoloBrowser,
  checkPublicTelemetrySession,
  checkReady,
  checkRealtimeTransportHelloPing,
  checkStatic,
  checkVersion,
  checkWebHealth,
  publicFailure,
  timed,
} from "./release-probe-lib.mjs";

const recordedAt = new Date().toISOString();
const observerRegion = process.env.HMS_PROBE_REGION ?? "unspecified";

function modeFromArguments(arguments_) {
  if (
    arguments_.length === 0 ||
    (arguments_.length === 1 && arguments_[0] === "--mode=stateless")
  ) {
    return "stateless";
  }
  if (arguments_.length === 1 && arguments_[0] === "--mode=telemetry") {
    return "telemetry";
  }
  throw new Error(
    "Use no mode flag for the stateless probe, or pass exactly --mode=telemetry for the low-frequency stateful probe",
  );
}

async function capture(checks, name, surface, operation) {
  try {
    const result = await timed(name, operation);
    checks.push({
      name,
      surface,
      ok: true,
      durationMs: result.durationMs,
      value: result.value,
    });
    return result.value;
  } catch (error) {
    checks.push({
      name,
      surface,
      ok: false,
      error: publicFailure(error),
    });
    return undefined;
  }
}

function surfaceResults(checks) {
  return Object.fromEntries(
    ["web", "server", "telemetry", "realtime"].map((surface) => {
      const surfaceChecks = checks.filter((check) => check.surface === surface);
      return [
        surface,
        {
          probed: surfaceChecks.length > 0,
          ...(surfaceChecks.length > 0
            ? { ok: surfaceChecks.every((check) => check.ok) }
            : {}),
          checks: surfaceChecks.map((check) => check.name),
        },
      ];
    }),
  );
}

function publicChecks(checks) {
  return checks.map(({ name, surface, ok, durationMs, error, value }) => ({
    name,
    surface,
    ok,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(error === undefined ? {} : { error }),
    ...(name === "realtime_transport_hello_ping" && value
      ? { roundTripMs: value.roundTripMs }
      : {}),
  }));
}

try {
  const mode = modeFromArguments(process.argv.slice(2));
  const baseUrl = baseUrlFromEnvironment();
  const realtimeEnabled = process.env.HMS_PROBE_REALTIME === "true";
  const expectedDuelEnabled =
    process.env.HMS_PROBE_EXPECTED_DUEL === "true" || realtimeEnabled;
  if (mode === "stateless" && realtimeEnabled) {
    throw new Error(
      "HMS_PROBE_REALTIME=true is stateful and may only run with --mode=telemetry",
    );
  }

  const checks = [];
  let version;

  if (mode === "stateless") {
    await capture(checks, "web_static_shell", "web", () =>
      checkStatic(baseUrl),
    );
    await capture(checks, "web_health", "web", () =>
      checkWebHealth(baseUrl),
    );
    await capture(checks, "browser_public_solo_entry", "web", () =>
      checkPublicSoloBrowser(baseUrl, { expectedDuelEnabled }),
    );
    await capture(checks, "server_live", "server", () =>
      checkLive(baseUrl),
    );
    await capture(checks, "server_ready", "server", () =>
      checkReady(baseUrl),
    );
    version = await capture(checks, "server_version", "server", () =>
      checkVersion(baseUrl, {
        duelExperimentEnabled: expectedDuelEnabled,
      }),
    );
  } else {
    await capture(checks, "server_live", "server", () =>
      checkLive(baseUrl),
    );
    await capture(checks, "server_ready", "server", () =>
      checkReady(baseUrl, { requireDuelCapacity: realtimeEnabled }),
    );
    version = await capture(checks, "server_version", "server", () =>
      checkVersion(baseUrl, {
        duelExperimentEnabled: expectedDuelEnabled,
      }),
    );

    if (version) {
      await capture(
        checks,
        "telemetry_public_session_lifecycle",
        "telemetry",
        () => checkPublicTelemetrySession(baseUrl, version.appVersion),
      );
      if (realtimeEnabled) {
        await capture(
          checks,
          "realtime_transport_hello_ping",
          "realtime",
          () =>
            checkRealtimeTransportHelloPing(
              baseUrl,
              version.protocolVersion,
            ),
        );
      }
    } else {
      checks.push({
        name: "telemetry_public_session_lifecycle",
        surface: "telemetry",
        ok: false,
        error: "blocked because server_version failed",
      });
    }
  }

  const ok = checks.every((check) => check.ok);
  const result = {
    ok,
    probe: "h-minesweeper-public-alpha",
    probeMode: mode,
    accessModel: "public",
    recordedAt,
    observerRegion,
    recommendedIntervalSeconds: mode === "stateless" ? 60 : 900,
    expectedPersistentTelemetrySessionsPerRun:
      mode === "telemetry" ? 1 : 0,
    targetRegion: version?.region ?? "unavailable",
    appVersion: version?.appVersion ?? "unavailable",
    commitSha: version?.commitSha ?? "unavailable",
    protocolVersion: version?.protocolVersion ?? null,
    localSchemaVersion: version?.localSchemaVersion ?? "unavailable",
    serverSchemaVersion: version?.serverSchemaVersion ?? null,
    browserSoloProbed: mode === "stateless",
    telemetrySessionProbed: mode === "telemetry",
    realtimeTransportProbed:
      mode === "telemetry" && realtimeEnabled && Boolean(version),
    duelIntegrityProbed: false,
    surfaces: surfaceResults(checks),
    checks: publicChecks(checks),
  };
  const output = `${JSON.stringify(result)}\n`;
  if (ok) {
    process.stdout.write(output);
  } else {
    process.stderr.write(output);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      probe: "h-minesweeper-public-alpha",
      accessModel: "public",
      recordedAt,
      observerRegion,
      error: publicFailure(error),
    })}\n`,
  );
  process.exitCode = 1;
}
