import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const openApps: FastifyInstance[] = [];

function testApp(): FastifyInstance {
  const base = loadConfig({});
  const app = createApp({
    logger: false,
    config: {
      ...base,
      allowedOrigins: new Set(["http://127.0.0.1:5173"]),
      duelExperimentEnabled: true,
    },
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

async function guest(app: FastifyInstance, displayName: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/guest-session",
    payload: { displayName },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{
    guestId: string;
    guestToken: string;
    displayName: string;
  }>();
}

describe("phase-0 REST API", () => {
  it("keeps every duel transport surface closed when the experiment is off", async () => {
    const app = createApp({
      logger: false,
      config: {
        ...loadConfig({}),
        duelExperimentEnabled: false,
        telemetryPseudonymizationSecret:
          "test-secret-that-is-long-enough-for-hmac",
      },
    });
    openApps.push(app);

    const guestResponse = await app.inject({
      method: "POST",
      url: "/api/v1/guest-session",
      payload: { displayName: "Hidden Duel" },
    });
    expect(guestResponse.statusCode).toBe(404);
    expect(guestResponse.json()).toMatchObject({
      error: "DUEL_EXPERIMENT_DISABLED",
      retryable: false,
    });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ready",
      capacity: {
        acceptingNewGuestSessions: false,
        acceptingNewRooms: false,
        acceptingTelemetry: true,
      },
    });
    const version = await app.inject({ method: "GET", url: "/version" });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({
      duelExperimentEnabled: false,
    });
  });

  it("reports the effective enabled duel flag in version metadata", async () => {
    const app = testApp();
    const version = await app.inject({ method: "GET", url: "/version" });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({
      duelExperimentEnabled: true,
    });
  });

  it("creates a strict two-player room and joins it by code", async () => {
    const app = testApp();
    const host = await guest(app, "Host");
    const challenger = await guest(app, "Challenger");
    const third = await guest(app, "Third");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      payload: { guestToken: host.guestToken },
    });
    expect(created.statusCode).toBe(201);
    const room = created.json<{
      roomId: string;
      roomCode: string;
      ticket: string;
    }>();
    expect(room.roomCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(room.ticket).not.toContain(host.guestToken);

    const joined = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.roomCode.toLowerCase()}/join`,
      payload: { guestToken: challenger.guestToken },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({
      roomId: room.roomId,
      roomCode: room.roomCode,
    });

    const full = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.roomCode}/join`,
      payload: { guestToken: third.guestToken },
    });
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ error: "ROOM_FULL" });
  });

  it("rejects incomplete or additional POST fields through JSON Schema", async () => {
    const app = testApp();
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/guest-session",
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const extra = await app.inject({
      method: "POST",
      url: "/api/v1/guest-session",
      payload: { displayName: "Player", admin: true },
    });
    expect(extra.statusCode).toBe(400);
  });
});
