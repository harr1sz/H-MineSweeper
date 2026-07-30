export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly logLevel: string;
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
}

const DEFAULT_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
] as const;

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
  };
}
