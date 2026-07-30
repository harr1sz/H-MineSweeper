import {
  baseUrlFromEnvironment,
  checkPublicSoloBrowser,
  checkReady,
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
  const expectedTelemetryValue = requiredStringFromEnvironment(
    "HMS_EXPECTED_TELEMETRY_ENABLED",
  );
  if (!["true", "false"].includes(expectedTelemetryValue)) {
    throw new Error("HMS_EXPECTED_TELEMETRY_ENABLED must be true or false");
  }
  const expectedTelemetryEnabled = expectedTelemetryValue === "true";
  if (["development", "local", "unspecified"].includes(expectedRegion)) {
    throw new Error("HMS_EXPECTED_REGION must identify the release region");
  }
  if (expectedBuildSha === process.env.HMS_REJECT_BUILD_SHA) {
    throw new Error(
      "Expected rollback SHA must differ from HMS_REJECT_BUILD_SHA",
    );
  }

  const baseUrl = baseUrlFromEnvironment("HMS_ROLLBACK_BASE_URL");
  const expectedDuelEnabled =
    process.env.HMS_EXPECTED_DUEL_EXPERIMENT === "true";
  const checks = [];
  checks.push(await timed("web_static_shell", () => checkStatic(baseUrl)));
  checks.push(await timed("web_health", () => checkWebHealth(baseUrl)));
  checks.push(
    await timed("browser_public_solo_entry", () =>
      checkPublicSoloBrowser(baseUrl, {
        expectedAppVersion,
        expectedBuildSha,
        expectedRegion,
        expectedTelemetryEnabled,
        expectedDuelEnabled,
      }),
    ),
  );
  checks.push(await timed("server_ready", () => checkReady(baseUrl)));
  const version = await timed("server_version", () =>
    checkVersion(baseUrl, {
      appVersion: expectedAppVersion,
      commitSha: expectedBuildSha,
      region: expectedRegion,
      protocolVersion: expectedProtocolVersion,
      localSchemaVersion: expectedLocalSchemaVersion,
      serverSchemaVersion: expectedServerSchemaVersion,
      duelExperimentEnabled: expectedDuelEnabled,
    }),
  );
  checks.push(version);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      verification: "rollback",
      accessModel: "public",
      recordedAt: new Date().toISOString(),
      appVersion: version.value.appVersion,
      commitSha: version.value.commitSha,
      region: version.value.region,
      protocolVersion: version.value.protocolVersion,
      localSchemaVersion: version.value.localSchemaVersion,
      serverSchemaVersion: version.value.serverSchemaVersion,
      browserSoloProbed: true,
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
          checks: ["server_ready", "server_version"],
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
      verification: "rollback",
      accessModel: "public",
      recordedAt: new Date().toISOString(),
      error: publicFailure(error),
    })}\n`,
  );
  process.exitCode = 1;
}
