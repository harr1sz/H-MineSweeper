import Fastify, { LogController } from "fastify";
import { createHash } from "node:crypto";
import { PROTOCOL_VERSION } from "@h-minesweeper/game-core";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  SERVER_SCHEMA_VERSION,
  SqliteTelemetryStore,
  TelemetryAggregateCapacityError,
  TELEMETRY_EVENT_NAMES,
  isValidTelemetryPreferenceDecisionAt,
  sanitizeTelemetryProperties,
} from "./telemetry-store.js";
import type {
  TelemetryEventV1,
  TelemetrySession,
  TelemetryStore,
} from "./telemetry-store.js";
import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { RealtimeGateway } from "./realtime-gateway.js";
import { RestRateLimiter } from "./rest-rate-limiter.js";
import { RoomManager } from "./room-manager.js";
import {
  CapacityError,
  GuestSessionStore,
  TicketStore,
} from "./stores.js";

const TELEMETRY_BATCH_LIMIT = 50;
const TELEMETRY_COOKIE_NAME = "hms_telemetry_session";

const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error", "message"],
  properties: {
    error: { type: "string" },
    message: { type: "string" },
    retryable: { type: "boolean" },
    retryAfterMs: { type: "integer", minimum: 0 },
    requestId: { type: "string" },
  },
} as const;

const guestSessionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["guestId", "guestToken", "displayName"],
  properties: {
    guestId: { type: "string" },
    guestToken: { type: "string" },
    displayName: { type: "string" },
  },
} as const;

const roomTicketSchema = {
  type: "object",
  additionalProperties: false,
  required: ["roomId", "roomCode", "ticket"],
  properties: {
    roomId: { type: "string" },
    roomCode: { type: "string", pattern: "^[A-Z0-9]{6}$" },
    ticket: { type: "string" },
  },
} as const;

const guestTokenBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["guestToken"],
  properties: {
    guestToken: {
      type: "string",
      minLength: 20,
      maxLength: 256,
      pattern: "^[A-Za-z0-9_-]+$",
    },
  },
} as const;

const telemetrySessionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "expiresAt", "batchId", "cohortSegment"],
  properties: {
    sessionId: { type: "string" },
    expiresAt: { type: "integer" },
    batchId: { type: "string", const: "public" },
    cohortSegment: { type: "string", const: "unsegmented" },
  },
} as const;

const telemetryPropertySchema = {
  anyOf: [
    { type: "string", maxLength: 64 },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
} as const;

const telemetryBatchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["deletionToken", "events"],
  properties: {
    deletionToken: {
      type: "string",
      minLength: 32,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
    },
    deletionEpoch: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    events: {
      type: "array",
      minItems: 1,
      maxItems: TELEMETRY_BATCH_LIMIT,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "schemaVersion",
          "eventId",
          "pseudonymousInstallId",
          "sessionId",
          "eventName",
          "occurredAt",
          "consentVersion",
          "appVersion",
          "properties",
        ],
        properties: {
          schemaVersion: { type: "integer", const: 1 },
          eventId: {
            type: "string",
            minLength: 8,
            maxLength: 128,
            pattern: "^[A-Za-z0-9_-]+$",
          },
          pseudonymousInstallId: {
            type: "string",
            minLength: 20,
            maxLength: 128,
            pattern: "^[A-Za-z0-9_-]+$",
          },
          sessionId: { type: "string", minLength: 16, maxLength: 128 },
          eventName: { type: "string", enum: TELEMETRY_EVENT_NAMES },
          occurredAt: { type: "string", format: "date-time" },
          consentVersion: { type: "string", minLength: 1, maxLength: 32 },
          appVersion: {
            type: "string",
            minLength: 1,
            maxLength: 32,
            pattern: "^[A-Za-z0-9._-]+$",
          },
          properties: {
            type: "object",
            maxProperties: 16,
            additionalProperties: telemetryPropertySchema,
          },
        },
      },
    },
  },
} as const;

interface TelemetryBatchBody {
  readonly deletionToken: string;
  readonly deletionEpoch?: number;
  readonly events: readonly TelemetryEventV1[];
}

function cookieToken(request: FastifyRequest): string | undefined {
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === TELEMETRY_COOKIE_NAME) {
      const token = value.join("=");
      if (token.length === 0) return undefined;
      try {
        const decoded = decodeURIComponent(token);
        return /^[A-Za-z0-9_-]{43,64}$/.test(decoded)
          ? decoded
          : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface ServerServices {
  readonly config: ServerConfig;
  readonly guests: GuestSessionStore;
  readonly tickets: TicketStore;
  readonly rooms: RoomManager;
  readonly telemetryStore: TelemetryStore;
}

export interface CreateAppOptions {
  readonly config?: ServerConfig;
  readonly logger?: boolean;
  readonly telemetryStore?: TelemetryStore;
}

const servicesByApp = new WeakMap<FastifyInstance, ServerServices>();

export function getServerServices(app: FastifyInstance): ServerServices {
  const services = servicesByApp.get(app);
  if (!services) throw new Error("Unknown H-MineSweeper Fastify instance");
  return services;
}

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const allowedTelemetryAppVersions = new Set([
    config.appVersion,
    "synthetic-probe-v1",
  ]);
  const app = Fastify({
    trustProxy:
      config.trustProxyHops > 0 ? config.trustProxyHops : false,
    logController: new LogController({ disableRequestLogging: true }),
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            serializers: {
              req: (request) => ({
                id: request.id,
                method: request.method,
              }),
              res: (reply) => ({
                statusCode: reply.statusCode,
              }),
            },
          },
    bodyLimit: 64 * 1024,
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });
  const guests = new GuestSessionStore(
    config.guestSessionTtlMs,
    Date.now,
    config.maxGuestSessions,
  );
  const tickets = new TicketStore(
    config.ticketTtlMs,
    Date.now,
    config.ticketEpochTtlMs,
  );
  const rooms = new RoomManager(config);
  const telemetryStore =
    options.telemetryStore ??
    new SqliteTelemetryStore({
      databasePath: config.telemetrySqliteFile ?? ":memory:",
      sessionTtlMs: config.telemetrySessionTtlMs,
      maxSessions: config.maxTelemetrySessions,
      telemetrySecret: config.telemetryPseudonymizationSecret,
      rawTelemetryTtlMs: config.telemetryRawTtlMs,
      aggregateTtlMs: config.telemetryAggregateTtlMs,
      maxRawTelemetryEvents: config.maxRawTelemetryEvents,
      maxRawTelemetryBytes: config.maxRawTelemetryBytes,
      maxAggregateBuckets: config.maxTelemetryAggregateBuckets,
    });
  const rateLimiter = new RestRateLimiter(
    config.restRateLimitPerMinute,
    config.restRateLimitBurst,
    config.restRateLimitMaxBuckets,
  );
  const subjectRateLimiter = new RestRateLimiter(
    config.restRateLimitPerMinute,
    config.restRateLimitBurst,
    config.restRateLimitMaxBuckets,
  );
  const services: ServerServices = {
    config,
    guests,
    tickets,
    rooms,
    telemetryStore,
  };
  servicesByApp.set(app, services);
  let maintenanceTimer: NodeJS.Timeout | undefined;

  const telemetryProblems = (): string[] => {
    const problems: string[] = [];
    const telemetryStatus = telemetryStore.status();
    if (!telemetryStatus.ready || !telemetryStatus.writable) {
      problems.push("telemetry_store");
    }
    if (config.telemetryPseudonymizationSecret.length < 32) {
      problems.push("telemetry_secret");
    }
    if (
      config.telemetryRequirePersistentStore &&
      !telemetryStatus.persistent
    ) {
      problems.push("telemetry_persistence");
    }
    return problems;
  };

  const requireTelemetrySession = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<TelemetrySession | undefined> => {
    const token = cookieToken(request);
    const session = token
      ? await telemetryStore.getSession(token)
      : undefined;
    if (!session) {
      await reply.code(401).send({
        error: "TELEMETRY_SESSION_REQUIRED",
        message: "A valid public telemetry session is required",
      });
      return undefined;
    }
    const decision = subjectRateLimiter.consume(
      `telemetry:${createHash("sha256")
        .update(session.sessionId)
        .digest("hex")}`,
    );
    if (!decision.allowed) {
      await reply.code(429).send({
        error: "RATE_LIMITED",
        message: "Too many requests for this telemetry session",
        retryable: true,
        retryAfterMs: decision.retryAfterMs,
        requestId: request.id,
      });
      return undefined;
    }
    return session;
  };

  const requireDuelAccess = async (
    _request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!config.duelExperimentEnabled) {
      await reply.code(404).send({
        error: "DUEL_EXPERIMENT_DISABLED",
        message: "The 1v1 experiment is not enabled for this release",
        retryable: false,
      });
      return;
    }
  };

  const enforceGuestSubjectRateLimit = async (
    guestToken: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> => {
    const decision = subjectRateLimiter.consume(
      `guest:${createHash("sha256").update(guestToken).digest("hex")}`,
    );
    if (decision.allowed) return true;
    reply.header(
      "retry-after",
      String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))),
    );
    await reply.code(429).send({
      error: "RATE_LIMITED",
      message: "Too many requests for this guest session",
      retryable: true,
      retryAfterMs: decision.retryAfterMs,
      requestId: request.id,
    });
    return false;
  };

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const routeKey = request.routeOptions.url ?? request.url.split("?")[0];
    const decision = rateLimiter.consume(
      `${request.ip}:${request.method}:${routeKey}`,
    );
    if (decision.allowed) return;
    reply.header(
      "retry-after",
      String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))),
    );
    await reply.code(429).send({
      error: "RATE_LIMITED",
      message: "Too many REST requests",
      retryable: true,
      retryAfterMs: decision.retryAfterMs,
      requestId: request.id,
    });
  });

  app.addHook("onReady", async () => {
    await telemetryStore.initialize();
    maintenanceTimer = setInterval(() => {
      guests.sweepExpired();
      tickets.sweepExpired();
      rooms.sweepIdleRooms();
      rateLimiter.sweep();
      subjectRateLimiter.sweep();
      void telemetryStore.sweep().catch(() => {
        app.log.error("Telemetry store maintenance failed");
      });
    }, config.maintenanceIntervalMs);
    maintenanceTimer.unref();
  });

  const gateway = new RealtimeGateway(
    app.server,
    config,
    rooms,
    tickets,
    app.log,
  );

  app.get("/live", async () => ({
    status: "ok",
    now: new Date().toISOString(),
  }));

  app.get("/ready", async (_request, reply) => {
    const telemetryStatus = telemetryStore.status();
    const capacity = {
      acceptingNewGuestSessions:
        config.duelExperimentEnabled &&
        guests.size < config.maxGuestSessions,
      acceptingNewRooms:
        config.duelExperimentEnabled && rooms.size < config.maxRooms,
      acceptingNewTelemetrySessions:
        telemetryStatus.acceptingNewSessions,
      acceptingTelemetry: telemetryStatus.acceptingTelemetry,
      acceptingTelemetryAggregates: telemetryStatus.acceptingAggregates,
    };
    const problems = telemetryProblems();
    return reply.code(problems.length === 0 ? 200 : 503).send({
      status: problems.length === 0 ? "ready" : "not_ready",
      telemetry: {
        available: problems.length === 0,
        checks: problems,
        storage: {
          ready: telemetryStatus.ready,
          writable: telemetryStatus.writable,
          persistent: telemetryStatus.persistent,
        },
      },
      capacity,
    });
  });

  app.get("/version", async () => ({
    appVersion: config.appVersion,
    protocolVersion: PROTOCOL_VERSION,
    localSchemaVersion: config.localSchemaVersion,
    serverSchemaVersion: SERVER_SCHEMA_VERSION,
    duelExperimentEnabled: config.duelExperimentEnabled,
    region: config.region,
    commitSha: config.buildSha,
  }));

  const healthOptions = {
    schema: {
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["status", "protocolVersion", "now"],
          properties: {
            status: { type: "string", const: "ok" },
            protocolVersion: { type: "integer", const: PROTOCOL_VERSION },
            now: { type: "string" },
          },
        },
      },
    },
  } as const;
  const health = async () => ({
    status: "ok",
    protocolVersion: PROTOCOL_VERSION,
    now: new Date().toISOString(),
  });
  app.get("/api/v1/health", healthOptions, health);
  app.get("/health", healthOptions, health);

  app.post(
    "/api/v1/telemetry/session",
    {
      schema: {
        response: {
          200: telemetrySessionSchema,
          201: telemetrySessionSchema,
          400: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.body !== undefined) {
        return await reply.code(400).send({
          error: "TELEMETRY_SESSION_BODY_NOT_ALLOWED",
          message: "Telemetry session creation does not accept a request body",
        });
      }
      if (telemetryProblems().length > 0) {
        return await reply.code(503).send({
          error: "TELEMETRY_STORE_UNAVAILABLE",
          message: "Telemetry session service is not ready",
          retryable: true,
        });
      }
      const token = cookieToken(request);
      const restored = token
        ? await telemetryStore.getSession(token)
        : undefined;
      if (restored) {
        return await reply.code(200).send(restored);
      }
      const created = await telemetryStore.createSession();
      if (!created.ok) {
        return await reply.code(503).send({
          error: created.reason,
          message: "Telemetry session capacity has been reached",
          retryable: true,
        });
      }
      const maxAge = Math.max(
        1,
        Math.floor((created.session.expiresAt - Date.now()) / 1_000),
      );
      reply.header(
        "set-cookie",
        `${TELEMETRY_COOKIE_NAME}=${encodeURIComponent(created.telemetrySessionToken)}; Path=/api/v1/telemetry; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
      );
      return await reply.code(201).send(created.session);
    },
  );

  app.post<{ Body: { displayName: string } }>(
    "/api/v1/guest-session",
    {
      preHandler: requireDuelAccess,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["displayName"],
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
        response: {
          201: guestSessionSchema,
          400: errorSchema,
          401: errorSchema,
          404: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const session = guests.create(request.body.displayName);
        return await reply.code(201).send(session);
      } catch (error) {
        if (error instanceof RangeError) {
          return await reply.code(400).send({
            error: "INVALID_DISPLAY_NAME",
            message: error.message,
          });
        }
        if (error instanceof CapacityError) {
          return await reply.code(503).send({
            error: "CAPACITY_REACHED",
            message: "Guest session capacity has been reached",
            retryable: true,
          });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: TelemetryBatchBody }>(
    "/api/v1/telemetry/batch",
    {
      schema: {
        body: telemetryBatchSchema,
        response: {
          202: {
            type: "object",
            additionalProperties: false,
            required: [
              "accepted",
              "duplicates",
              "discarded",
              "deletionEpoch",
              "deletedBefore",
            ],
            properties: {
              accepted: { type: "integer", minimum: 0 },
              duplicates: { type: "integer", minimum: 0 },
              discarded: { type: "integer", minimum: 0 },
              deletionEpoch: { type: "integer", minimum: 0 },
              deletedBefore: {
                anyOf: [
                  { type: "string", format: "date-time" },
                  { type: "null" },
                ],
              },
            },
          },
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (telemetryProblems().length > 0) {
        return await reply.code(503).send({
          error: "TELEMETRY_STORE_UNAVAILABLE",
          message: "Telemetry service is not ready",
          retryable: true,
        });
      }
      const now = Date.now();
      const oldestAcceptedAt = now - config.telemetryRawTtlMs;
      const newestAcceptedAt = now + 5 * 60 * 1_000;
      const telemetrySession = await requireTelemetrySession(request, reply);
      if (!telemetrySession) return;
      const events: TelemetryEventV1[] = [];
      const firstEvent = request.body.events[0];
      if (!firstEvent) {
        return await reply.code(400).send({
          error: "EMPTY_TELEMETRY_BATCH",
          message: "Telemetry batch must contain at least one event",
        });
      }
      for (const event of request.body.events) {
        const occurredAt = Date.parse(event.occurredAt);
        if (
          !Number.isFinite(occurredAt) ||
          occurredAt < oldestAcceptedAt ||
          occurredAt > newestAcceptedAt
        ) {
          return await reply.code(400).send({
            error: "INVALID_TELEMETRY_TIME",
            message: "Telemetry event timestamp is outside the accepted window",
          });
        }
        if (!allowedTelemetryAppVersions.has(event.appVersion)) {
          return await reply.code(409).send({
            error: "APP_VERSION_MISMATCH",
            message: "Telemetry app version does not match this deployment",
            retryable: false,
          });
        }
        if (
          event.pseudonymousInstallId !==
            firstEvent.pseudonymousInstallId ||
          event.sessionId !== firstEvent.sessionId ||
          event.consentVersion !== firstEvent.consentVersion ||
          event.appVersion !== firstEvent.appVersion
        ) {
          return await reply.code(400).send({
            error: "INCONSISTENT_TELEMETRY_BATCH",
            message:
              "Telemetry batch identity, visit session, consent, and app version must be consistent",
          });
        }
        const properties = sanitizeTelemetryProperties(
          event.eventName,
          event.properties,
        );
        if (!properties) {
          return await reply.code(400).send({
            error: "INVALID_TELEMETRY_PROPERTIES",
            message: "Telemetry properties are not allowlisted",
          });
        }
        events.push({
          ...event,
          properties,
        });
      }
      const result = await telemetryStore.ingestTelemetry(
        events,
        request.body.deletionToken,
        telemetrySession,
        request.body.deletionEpoch ?? 0,
        now,
      );
      if (!result.ok) {
        const status =
          result.reason === "INVALID_DELETION_TOKEN" ||
          result.reason === "INVALID_DELETION_EPOCH"
            ? 409
            : result.reason === "TELEMETRY_NOT_ENABLED" ||
                result.reason === "TELEMETRY_CONSENT_MISMATCH"
              ? 403
              : 503;
        return await reply.code(status).send({
          error: result.reason,
          message:
            result.reason === "INVALID_DELETION_TOKEN"
              ? "Deletion token does not match this installation"
              : result.reason === "INVALID_DELETION_EPOCH"
                ? "Deletion epoch is not current for this installation"
                : result.reason === "TELEMETRY_NOT_ENABLED"
                  ? "Telemetry is not enabled for this session"
                  : result.reason === "TELEMETRY_CONSENT_MISMATCH"
                    ? "Telemetry event consent metadata does not match the current preference"
                    : "Telemetry capacity has been reached",
          retryable: result.reason === "TELEMETRY_CAPACITY_REACHED",
        });
      }
      return await reply.code(202).send(result);
    },
  );

  app.post<{
    Body: {
      enabled: boolean;
      consentVersion: string;
      appVersion: string;
      preferenceChangedAt: string;
    };
  }>(
    "/api/v1/telemetry/preference",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "enabled",
            "consentVersion",
            "appVersion",
            "preferenceChangedAt",
          ],
          properties: {
            enabled: { type: "boolean" },
            consentVersion: { type: "string", minLength: 1, maxLength: 32 },
            appVersion: {
              type: "string",
              minLength: 1,
              maxLength: 32,
              pattern: "^[A-Za-z0-9._-]+$",
            },
            preferenceChangedAt: {
              type: "string",
              format: "date-time",
            },
          },
        },
        response: {
          202: {
            type: "object",
            additionalProperties: false,
            required: ["accepted", "applied"],
            properties: {
              accepted: { type: "boolean", const: true },
              applied: { type: "boolean" },
            },
          },
          400: errorSchema,
          401: errorSchema,
          409: errorSchema,
          429: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (telemetryProblems().length > 0) {
        return await reply.code(503).send({
          error: "TELEMETRY_STORE_UNAVAILABLE",
          message: "Telemetry preference service is not ready",
          retryable: true,
        });
      }
      const telemetrySession = await requireTelemetrySession(request, reply);
      if (!telemetrySession) return;
      if (!allowedTelemetryAppVersions.has(request.body.appVersion)) {
        return await reply.code(409).send({
          error: "APP_VERSION_MISMATCH",
          message: "Telemetry app version does not match this deployment",
          retryable: false,
        });
      }
      const now = Date.now();
      const decisionAt = Date.parse(request.body.preferenceChangedAt);
      if (!isValidTelemetryPreferenceDecisionAt(decisionAt, now)) {
        return await reply.code(400).send({
          error: "INVALID_PREFERENCE_TIMESTAMP",
          message:
            "Preference decision timestamp must be valid and no more than five minutes in the future",
          retryable: false,
        });
      }
      let applied: boolean;
      try {
        applied = await telemetryStore.recordTelemetryPreference(
          telemetrySession,
          request.body.enabled,
          request.body.consentVersion,
          request.body.appVersion,
          decisionAt,
          now,
        );
      } catch (error) {
        if (error instanceof TelemetryAggregateCapacityError) {
          return await reply.code(503).send({
            error: "TELEMETRY_AGGREGATE_CAPACITY_REACHED",
            message: "Telemetry aggregate capacity has been reached",
            retryable: true,
          });
        }
        throw error;
      }
      return await reply.code(202).send({ accepted: true, applied });
    },
  );

  app.post<{
    Body: {
      pseudonymousInstallId: string;
      deletionToken: string;
    };
  }>(
    "/api/v1/telemetry/delete",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["pseudonymousInstallId", "deletionToken"],
          properties: {
            pseudonymousInstallId: {
              type: "string",
              minLength: 20,
              maxLength: 128,
              pattern: "^[A-Za-z0-9_-]+$",
            },
            deletionToken: {
              type: "string",
              minLength: 32,
              maxLength: 128,
              pattern: "^[A-Za-z0-9_-]+$",
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["accepted", "deletionEpoch", "deletedBefore"],
            properties: {
              accepted: { type: "boolean", const: true },
              deletionEpoch: { type: "integer", minimum: 1 },
              deletedBefore: { type: "string", format: "date-time" },
            },
          },
          401: errorSchema,
          409: errorSchema,
          429: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (telemetryProblems().length > 0) {
        return await reply.code(503).send({
          error: "TELEMETRY_STORE_UNAVAILABLE",
          message: "Telemetry service is not ready",
          retryable: true,
        });
      }
      const telemetrySession = await requireTelemetrySession(request, reply);
      if (!telemetrySession) return;
      const decision = subjectRateLimiter.consume(
        `deletion:${createHash("sha256")
          .update(request.body.deletionToken)
          .digest("hex")}`,
      );
      if (!decision.allowed) {
        return await reply.code(429).send({
          error: "RATE_LIMITED",
          message: "Too many deletion requests",
          retryable: true,
          retryAfterMs: decision.retryAfterMs,
          requestId: request.id,
        });
      }
      const result = await telemetryStore.deleteTelemetry(
        request.body.pseudonymousInstallId,
        request.body.deletionToken,
      );
      if (!result) {
        return await reply.code(409).send({
          error: "INVALID_DELETION_TOKEN",
          message: "Deletion token does not match this installation",
          retryable: false,
        });
      }
      return await reply.code(200).send({
        accepted: true,
        deletionEpoch: result.deletionEpoch,
        deletedBefore: result.deletedBefore,
      });
    },
  );

  app.post<{ Body: { guestToken: string } }>(
    "/api/v1/rooms",
    {
      preHandler: requireDuelAccess,
      schema: {
        body: guestTokenBodySchema,
        response: {
          201: roomTicketSchema,
          401: errorSchema,
          404: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        !(await enforceGuestSubjectRateLimit(
          request.body.guestToken,
          request,
          reply,
        ))
      ) {
        return;
      }
      const guest = guests.get(request.body.guestToken);
      if (!guest) {
        return await reply.code(401).send({
          error: "INVALID_GUEST_TOKEN",
          message: "Guest session is missing or expired",
        });
      }
      let room: ReturnType<RoomManager["create"]>;
      try {
        room = rooms.create(guest);
      } catch (error) {
        if (error instanceof CapacityError) {
          return await reply.code(503).send({
            error: "CAPACITY_REACHED",
            message: "Room capacity has been reached",
            retryable: true,
          });
        }
        throw error;
      }
      const ticket = tickets.issue(room.roomId, guest.guestId);
      return await reply.code(201).send({
        roomId: room.roomId,
        roomCode: room.roomCode,
        ticket: ticket.ticket,
      });
    },
  );

  app.post<{
    Params: { code: string };
    Body: { guestToken: string };
  }>(
    "/api/v1/rooms/:code/join",
    {
      preHandler: requireDuelAccess,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          properties: {
            code: {
              type: "string",
              minLength: 6,
              maxLength: 6,
              pattern: "^[A-Za-z0-9]{6}$",
            },
          },
        },
        body: guestTokenBodySchema,
        response: {
          200: roomTicketSchema,
          401: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        !(await enforceGuestSubjectRateLimit(
          request.body.guestToken,
          request,
          reply,
        ))
      ) {
        return;
      }
      const guest = guests.get(request.body.guestToken);
      if (!guest) {
        return await reply.code(401).send({
          error: "INVALID_GUEST_TOKEN",
          message: "Guest session is missing or expired",
        });
      }
      const joined = rooms.join(request.params.code, guest);
      if (!joined.ok) {
        const status = joined.reason === "ROOM_NOT_FOUND" ? 404 : 409;
        return await reply.code(status).send({
          error: joined.reason,
          message:
            joined.reason === "ROOM_NOT_FOUND"
              ? "Room does not exist"
              : joined.reason === "ROOM_FULL"
                ? "Room already has two players"
                : "Guest is already in this room",
        });
      }
      const ticket = tickets.issue(joined.room.roomId, guest.guestId);
      return await reply.code(200).send({
        roomId: joined.room.roomId,
        roomCode: joined.room.roomCode,
        ticket: ticket.ticket,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/replays/:id",
    {
      preHandler: requireDuelAccess,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: [
              "v",
              "replayId",
              "roomId",
              "matchId",
              "roomCode",
              "createdAt",
              "finishedAt",
              "status",
              "result",
              "players",
              "events",
            ],
            properties: {
              v: { type: "integer", const: 1 },
              replayId: { type: "string" },
              roomId: { type: "string" },
              matchId: { type: "string" },
              roomCode: { type: "string" },
              createdAt: { type: "integer" },
              finishedAt: { type: "integer" },
              status: { type: "string", const: "COMPLETED" },
              result: {},
              players: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["guestId", "displayName"],
                  properties: {
                    guestId: { type: "string" },
                    displayName: { type: "string" },
                  },
                },
              },
              events: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["seq", "at", "type", "payload"],
                  properties: {
                    seq: { type: "integer" },
                    at: { type: "integer" },
                    type: { type: "string" },
                    actorGuestId: { type: "string" },
                    payload: {},
                  },
                },
              },
            },
          },
          404: errorSchema,
          401: errorSchema,
          413: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const replay = rooms.getReplay(request.params.id);
      if (!replay) {
        return await reply.code(404).send({
          error: "REPLAY_NOT_FOUND",
          message: "Replay does not exist or the match is still active",
        });
      }
      if (
        Buffer.byteLength(JSON.stringify(replay)) >
        config.maxReplayResponseBytes
      ) {
        return await reply.code(413).send({
          error: "REPLAY_TOO_LARGE",
          message: "Replay exceeds the Alpha download budget",
        });
      }
      return await reply.code(200).send(replay);
    },
  );

  app.addHook("onClose", async () => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    await gateway.close();
    rooms.close();
    await telemetryStore.close();
  });

  return app;
}
