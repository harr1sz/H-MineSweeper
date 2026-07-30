import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { loadConfig, TELEMETRY_RETENTION_MS } from "../src/config.js";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("reverse proxy boundary", () => {
  it("keeps the duel experiment disabled unless explicitly enabled", () => {
    expect(loadConfig({}).duelExperimentEnabled).toBe(false);
    expect(
      loadConfig({ H_MINESWEEPER_DUEL_EXPERIMENT: "true" })
        .duelExperimentEnabled,
    ).toBe(true);
  });

  it("fixes raw and session telemetry retention at seven days", () => {
    const config = loadConfig({
      H_MINESWEEPER_TELEMETRY_SESSION_TTL_MS: "120000",
      H_MINESWEEPER_TELEMETRY_RAW_TTL_MS: "120000",
      H_MINESWEEPER_MAX_TELEMETRY_SESSIONS: "321",
      H_MINESWEEPER_TELEMETRY_SQLITE_FILE: "/data/telemetry.sqlite3",
      H_MINESWEEPER_TELEMETRY_REQUIRE_PERSISTENT_STORE: "true",
    });
    expect(config).toMatchObject({
      telemetrySessionTtlMs: TELEMETRY_RETENTION_MS,
      telemetryRawTtlMs: TELEMETRY_RETENTION_MS,
      maxTelemetrySessions: 321,
      telemetrySqliteFile: "/data/telemetry.sqlite3",
      telemetryRequirePersistentStore: true,
    });
  });

  it("does not trust forwarded addresses by default", () => {
    expect(loadConfig({}).trustProxyHops).toBe(0);
    expect(
      loadConfig({ H_MINESWEEPER_TRUST_PROXY_HOPS: "-1" }).trustProxyHops,
    ).toBe(0);
    expect(
      loadConfig({ H_MINESWEEPER_TRUST_PROXY_HOPS: "unbounded" })
        .trustProxyHops,
    ).toBe(0);
    expect(
      loadConfig({ H_MINESWEEPER_TRUST_PROXY_HOPS: "999" }).trustProxyHops,
    ).toBe(0);
  });

  it("uses exactly the configured proxy-hop boundary for IP rate limits", async () => {
    const app = createApp({
      logger: false,
      config: {
        ...loadConfig({ H_MINESWEEPER_TRUST_PROXY_HOPS: "1" }),
        restRateLimitPerMinute: 1,
        restRateLimitBurst: 1,
      },
    });
    openApps.push(app);

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const repeated = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const different = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { "x-forwarded-for": "203.0.113.20" },
    });

    expect(first.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(429);
    expect(different.statusCode).toBe(200);
  });
});
