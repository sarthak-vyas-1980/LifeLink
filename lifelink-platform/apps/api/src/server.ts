import { createServer, type Server as HttpServer } from "node:http";
import { createApp } from "./app";
import { getRuntimeConfig } from "./config";
import { disconnectDatabase } from "@lifelink/database";
import { registerRealtimeGateway, stopRealtimeGateway } from "./modules/notifications/realtime.gateway";
import { stopOrganCoordinationWorkers } from "./modules/organ-coordination/routes";

let httpServer: HttpServer | undefined;

// Start HTTP and the authenticated realtime gateway after wiring the event relay.
export async function startServer() {
  if (httpServer?.listening) return httpServer;
  const server = createServer(createApp());
  await registerRealtimeGateway(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(getRuntimeConfig().port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  httpServer = server;
  return server;
}

// Drain HTTP, Socket.IO, Redis, and PostgreSQL connections on shutdown.
export async function stopServer() {
	stopOrganCoordinationWorkers();
	await stopRealtimeGateway();
  if (httpServer?.listening) {
    await new Promise<void>((resolve, reject) =>
      httpServer!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  httpServer = undefined;
  await disconnectDatabase();
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/src/server.ts")) {
  void startServer().catch((error: unknown) => {
    console.error(
      "LifeLink API could not start",
      error instanceof Error ? error.message : "UnknownError",
    );
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopServer().finally(() => process.exit(0));
    });
  }
}
