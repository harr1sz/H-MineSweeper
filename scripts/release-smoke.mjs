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
  requiredBuildShaFromEnvironment,
  requiredIntegerFromEnvironment,
  requiredStringFromEnvironment,
  timed,
} from "./release-probe-lib.mjs";

try {
  const baseUrl = baseUrlFromEnvironment("HMS_SMOKE_BASE_URL");
  const realtimeEnabled = process.env.HMS_SMOKE_REALTIME === "true";
  const expectedAppVersion = requiredStringFromEnvironment(
    "HMS_EXPECTED_APP_VERSION",
  );
  const expectedBuildSha = requiredBuildShaFromEnvironment(
    "HMS_EXPECTED_BUILD_SHA",
  );
  const expectedRegion = requiredStringFromEnvironment("HMS_EXPECTED_REGION");
  const expectedProtocolVersion = requiredIntegerFromEnvironment(
    "HMS_EXPECTED_PROTOCOL_VERSION",
  );
  const expectedLocalSchemaVersion = requiredStringFromEnvironment(
    "HMS_EXPECTED_LOCAL_SCHEMA_VERSION",
  );
  const expectedServerSchemaVersion = requiredIntegerFromEnvironment(
    "HMS_EXPECTED_SERVER_SCHEMA_VERSION",
  );
  if (["development", "local", "unspecified"].includes(expectedRegion)) {
    throw new Error("HMS_EXPECTED_REGION must identify the release region");
  }
  const checks = [];
  checks.push(await timed("web_static_shell", () => checkStatic(baseUrl)));
  checks.push(await timed("web_health", () => checkWebHealth(baseUrl)));
  checks.push(
    await timed("browser_public_solo_entry", () =>
      checkPublicSoloBrowser(baseUrl, {
        expectedAppVersion,
        expectedBuildSha,
        expectedRegion,
        expectedTelemetryEnabled: true,
        expectedDuelEnabled: realtimeEnabled,
      }),
    ),
  );
  checks.push(await timed("server_live", () => checkLive(baseUrl)));
  checks.push(
    await timed("server_ready", () =>
      checkReady(baseUrl, { requireDuelCapacity: realtimeEnabled }),
    ),
  );
  const version = await timed("server_version", () =>
    checkVersion(baseUrl, {
      appVersion: expectedAppVersion,
      commitSha: expectedBuildSha,
      region: expectedRegion,
      protocolVersion: expectedProtocolVersion,
      localSchemaVersion: expectedLocalSchemaVersion,
      serverSchemaVersion: expectedServerSchemaVersion,
    }),
  );
  checks.push(version);
  if (version.value.duelExperimentEnabled !== realtimeEnabled) {
    throw new Error(
      `server duel feature flag is ${String(version.value.duelExperimentEnabled)}; expected ${realtimeEnabled}`,
    );
  }
  checks.push(
    await timed("telemetry_public_session_lifecycle", () =>
      checkPublicTelemetrySession(baseUrl, version.value.appVersion),
    ),
  );

  if (realtimeEnabled) {
    checks.push(
      await timed("realtime_transport_hello_ping", () =>
        checkRealtimeTransportHelloPing(
          baseUrl,
          version.value.protocolVersion,
        ),
      ),
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      smoke: "h-minesweeper-public-alpha",
      accessModel: "public",
      recordedAt: new Date().toISOString(),
      appVersion: version.value.appVersion,
      commitSha: version.value.commitSha,
      region: version.value.region,
      protocolVersion: version.value.protocolVersion,
      localSchemaVersion: version.value.localSchemaVersion,
      serverSchemaVersion: version.value.serverSchemaVersion,
      browserSoloProbed: true,
      telemetrySessionProbed: true,
      realtimeTransportProbed: realtimeEnabled,
      duelIntegrityProbed: false,
      surfaces: {
        web: {
          ok: true,
          checks: [
            "web_static_shell",
            "web_health",
            "browser_public_solo_entry",
          ],
        },
        server: {
          ok: true,
          checks: ["server_live", "server_ready", "server_version"],
        },
        telemetry: {
          ok: true,
          checks: ["telemetry_public_session_lifecycle"],
        },
        realtime: {
          probed: realtimeEnabled,
          ...(realtimeEnabled ? { ok: true } : {}),
        },
      },
      checks: checks.map(({ name, durationMs }) => ({
        name,
        durationMs,
      })),
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      smoke: "h-minesweeper-public-alpha",
      accessModel: "public",
      recordedAt: new Date().toISOString(),
      error: publicFailure(error),
    })}\n`,
  );
  process.exitCode = 1;
}
