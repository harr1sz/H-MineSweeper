export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly logLevel: string;
  readonly trustProxyHops: number;
  readonly guestSessionTtlMs: number;
  readonly ticketTtlMs: number;
  readonly ticketEpochTtlMs: number;
  readonly roomIdleTtlMs: number;
  readonly helloTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly inactiveTimeoutMs: number;
  readonly countdownMs: number;
  readonly roundDurationMs: number;
  readonly terminalWindowMs: number;
  readonly progressIntervalMs: number;
  readonly duelExperimentEnabled: boolean;
  readonly telemetrySessionTtlMs: number;
  readonly maxTelemetrySessions: number;
  readonly telemetrySqliteFile: string | undefined;
  readonly telemetryRequirePersistentStore: boolean;
  readonly telemetryPseudonymizationSecret: string;
  readonly telemetryRawTtlMs: number;
  readonly telemetryAggregateTtlMs: number;
  readonly maxRawTelemetryEvents: number;
  readonly maxRawTelemetryBytes: number;
  readonly maxTelemetryAggregateBuckets: number;
  readonly restRateLimitPerMinute: number;
  readonly restRateLimitBurst: number;
  readonly restRateLimitMaxBuckets: number;
  readonly maxGuestSessions: number;
  readonly maxRooms: number;
  readonly maxReplayResponseBytes: number;
  readonly maxReplayEvents: number;
  readonly maxReplayBytes: number;
  readonly maintenanceIntervalMs: number;
  readonly buildSha: string;
  readonly region: string;
  readonly appVersion: string;
  readonly localSchemaVersion: string;
}

const DEFAULT_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
] as const;
export const TELEMETRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function integerFromEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return fallback;
  return parsed;
}

function booleanFromEnv(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  return fallback;
}

function proxyHopsFromEnv(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2
    ? parsed
    : 0;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const origins = (env.H_MINESWEEPER_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    host: env.H_MINESWEEPER_HOST ?? "127.0.0.1",
    port: integerFromEnv(env.H_MINESWEEPER_PORT, 3001, 1),
    allowedOrigins: new Set(origins),
    logLevel: env.H_MINESWEEPER_LOG_LEVEL ?? "info",
    trustProxyHops: proxyHopsFromEnv(
      env.H_MINESWEEPER_TRUST_PROXY_HOPS,
    ),
    guestSessionTtlMs: integerFromEnv(
      env.H_MINESWEEPER_GUEST_SESSION_TTL_MS,
      6 * 60 * 60 * 1_000,
      1_000,
    ),
    ticketTtlMs: integerFromEnv(
      env.H_MINESWEEPER_TICKET_TTL_MS,
      30_000,
      1_000,
    ),
    ticketEpochTtlMs: integerFromEnv(
      env.H_MINESWEEPER_TICKET_EPOCH_TTL_MS,
      24 * 60 * 60 * 1_000,
      1_000,
    ),
    roomIdleTtlMs: integerFromEnv(
      env.H_MINESWEEPER_ROOM_IDLE_TTL_MS,
      15 * 60 * 1_000,
      1_000,
    ),
    helloTimeoutMs: integerFromEnv(
      env.H_MINESWEEPER_HELLO_TIMEOUT_MS,
      5_000,
      250,
    ),
    heartbeatIntervalMs: integerFromEnv(
      env.H_MINESWEEPER_HEARTBEAT_INTERVAL_MS,
      15_000,
      250,
    ),
    inactiveTimeoutMs: integerFromEnv(
      env.H_MINESWEEPER_INACTIVE_TIMEOUT_MS,
      45_000,
      1_000,
    ),
    countdownMs: integerFromEnv(
      env.H_MINESWEEPER_COUNTDOWN_MS,
      3_000,
      0,
    ),
    roundDurationMs: integerFromEnv(
      env.H_MINESWEEPER_ROUND_DURATION_MS,
      180_000,
      1,
    ),
    terminalWindowMs: integerFromEnv(
      env.H_MINESWEEPER_TERMINAL_WINDOW_MS,
      50,
      0,
    ),
    progressIntervalMs: integerFromEnv(
      env.H_MINESWEEPER_PROGRESS_INTERVAL_MS,
      100,
      1,
    ),
    duelExperimentEnabled: booleanFromEnv(
      env.H_MINESWEEPER_DUEL_EXPERIMENT,
      false,
    ),
    telemetrySessionTtlMs: TELEMETRY_RETENTION_MS,
    maxTelemetrySessions: integerFromEnv(
      env.H_MINESWEEPER_MAX_TELEMETRY_SESSIONS,
      50_000,
      1,
    ),
    telemetrySqliteFile:
      env.H_MINESWEEPER_TELEMETRY_SQLITE_FILE?.trim() || undefined,
    telemetryRequirePersistentStore: booleanFromEnv(
      env.H_MINESWEEPER_TELEMETRY_REQUIRE_PERSISTENT_STORE,
      false,
    ),
    telemetryPseudonymizationSecret:
      env.H_MINESWEEPER_TELEMETRY_SECRET?.trim() ?? "",
    telemetryRawTtlMs: TELEMETRY_RETENTION_MS,
    telemetryAggregateTtlMs: integerFromEnv(
      env.H_MINESWEEPER_TELEMETRY_AGGREGATE_TTL_MS,
      30 * 24 * 60 * 60 * 1_000,
      60_000,
    ),
    maxRawTelemetryEvents: integerFromEnv(
      env.H_MINESWEEPER_MAX_RAW_TELEMETRY_EVENTS,
      250_000,
      1,
    ),
    maxRawTelemetryBytes: integerFromEnv(
      env.H_MINESWEEPER_MAX_RAW_TELEMETRY_BYTES,
      256 * 1024 * 1024,
      1_024,
    ),
    maxTelemetryAggregateBuckets: integerFromEnv(
      env.H_MINESWEEPER_MAX_TELEMETRY_AGGREGATE_BUCKETS,
      10_000,
      1,
    ),
    restRateLimitPerMinute: integerFromEnv(
      env.H_MINESWEEPER_REST_RATE_LIMIT_PER_MINUTE,
      120,
      1,
    ),
    restRateLimitBurst: integerFromEnv(
      env.H_MINESWEEPER_REST_RATE_LIMIT_BURST,
      30,
      1,
    ),
    restRateLimitMaxBuckets: integerFromEnv(
      env.H_MINESWEEPER_REST_RATE_LIMIT_MAX_BUCKETS,
      50_000,
      100,
    ),
    maxGuestSessions: integerFromEnv(
      env.H_MINESWEEPER_MAX_GUEST_SESSIONS,
      10_000,
      1,
    ),
    maxRooms: integerFromEnv(
      env.H_MINESWEEPER_MAX_ROOMS,
      2_000,
      1,
    ),
    maxReplayResponseBytes: integerFromEnv(
      env.H_MINESWEEPER_MAX_REPLAY_RESPONSE_BYTES,
      5 * 1024 * 1024,
      1_024,
    ),
    maxReplayEvents: integerFromEnv(
      env.H_MINESWEEPER_MAX_REPLAY_EVENTS,
      10_000,
      100,
    ),
    maxReplayBytes: integerFromEnv(
      env.H_MINESWEEPER_MAX_REPLAY_BYTES,
      5 * 1024 * 1024,
      1_024,
    ),
    maintenanceIntervalMs: integerFromEnv(
      env.H_MINESWEEPER_MAINTENANCE_INTERVAL_MS,
      30_000,
      250,
    ),
    buildSha: env.H_MINESWEEPER_BUILD_SHA?.trim() || "development",
    region: env.H_MINESWEEPER_REGION?.trim() || "local",
    appVersion:
      env.H_MINESWEEPER_APP_VERSION?.trim() || "0.2.0-alpha.1",
    localSchemaVersion:
      env.H_MINESWEEPER_LOCAL_SCHEMA_VERSION?.trim() ||
      "HMS-local-history-v1",
  };
}
