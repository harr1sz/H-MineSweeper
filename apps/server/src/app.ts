import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { RealtimeGateway } from "./realtime-gateway.js";
import { RoomManager } from "./room-manager.js";
import { GuestSessionStore, TicketStore } from "./stores.js";

const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error", "message"],
  properties: {
    error: { type: "string" },
    message: { type: "string" },
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

export interface ServerServices {
  readonly config: ServerConfig;
  readonly guests: GuestSessionStore;
  readonly tickets: TicketStore;
  readonly rooms: RoomManager;
}

export interface CreateAppOptions {
  readonly config?: ServerConfig;
  readonly logger?: boolean;
}

const servicesByApp = new WeakMap<FastifyInstance, ServerServices>();

export function getServerServices(app: FastifyInstance): ServerServices {
  const services = servicesByApp.get(app);
  if (!services) throw new Error("Unknown H-MineSweeper Fastify instance");
  return services;
}

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
          },
    bodyLimit: 64 * 1024,
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });
  const guests = new GuestSessionStore(config.guestSessionTtlMs);
  const tickets = new TicketStore(
    config.ticketTtlMs,
    Date.now,
    config.ticketEpochTtlMs,
  );
  const rooms = new RoomManager(config);
  const services: ServerServices = { config, guests, tickets, rooms };
  servicesByApp.set(app, services);

  const gateway = new RealtimeGateway(
    app.server,
    config,
    rooms,
    tickets,
    app.log,
  );

  app.get("/api/v1/health", {
    schema: {
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["status", "protocolVersion", "now"],
          properties: {
            status: { type: "string", const: "ok" },
            protocolVersion: { type: "integer", const: 1 },
            now: { type: "string" },
          },
        },
      },
    },
  }, async () => ({
    status: "ok",
    protocolVersion: 1,
    now: new Date().toISOString(),
  }));

  app.post<{ Body: { displayName: string } }>(
    "/api/v1/guest-session",
    {
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
        throw error;
      }
    },
  );

  app.post<{ Body: { guestToken: string } }>(
    "/api/v1/rooms",
    {
      schema: {
        body: guestTokenBodySchema,
        response: {
          201: roomTicketSchema,
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const guest = guests.get(request.body.guestToken);
      if (!guest) {
        return await reply.code(401).send({
          error: "INVALID_GUEST_TOKEN",
          message: "Guest session is missing or expired",
        });
      }
      const room = rooms.create(guest);
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
      return await reply.code(200).send(replay);
    },
  );

  app.addHook("onClose", async () => {
    await gateway.close();
    rooms.close();
  });

  return app;
}
