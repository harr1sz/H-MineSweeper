import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

export { createApp, getServerServices } from "./app.js";
export { loadConfig } from "./config.js";
export { RoomActor } from "./room-actor.js";
export { RoomManager } from "./room-manager.js";
export { GuestSessionStore, TicketStore } from "./stores.js";

export async function start(): Promise<FastifyInstance> {
  const config = loadConfig();
  const app = createApp({ config });
  await app.listen({ host: config.host, port: config.port });
  return app;
}

const entrypoint =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(process.argv[1]).href;

if (entrypoint === import.meta.url) {
  const app = await start();
  let closing = false;
  const close = async (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "Shutting down");
    await app.close();
  };
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));
}
