import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "../infrastructure/config/env.js";
import { MongoStore } from "../adapters/outbound/mongodb/mongoStore.js";
import { MemoryStore } from "../adapters/outbound/memory/memoryRepositories.js";
import {
  AuthService,
  refreshSecretFrom,
} from "../application/services/authService.js";
import { VacationAccrualScheduler } from "../application/services/vacationScheduler.js";
const store =
  env.STORAGE_MODE === "mongo"
    ? await MongoStore.connect(env.MONGODB_URI, env.MONGODB_DATABASE)
    : new MemoryStore();
const auth = new AuthService(
  store,
  {
    jwtSecret: env.JWT_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET ?? refreshSecretFrom(env.JWT_SECRET),
    accessExpiresIn: env.JWT_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  },
  store,
);
await auth.ensureAdmin(
  env.BOOTSTRAP_ADMIN_USERNAME,
  env.BOOTSTRAP_ADMIN_PASSWORD,
);
const app = await createApp(store, env.SEED_DEMO_DATA, auth);
const server = createServer(app);
server.once("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `El puerto ${env.PORT} ya está en uso. Detén el proceso anterior o cambia PORT en .env.`,
    );
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
server.listen(env.PORT, () =>
  console.log(
    `Vaca EFA API listening on http://localhost:${env.PORT} (${env.STORAGE_MODE})`,
  ),
);
const scheduler = new VacationAccrualScheduler(store);
if (env.SCHEDULER_ENABLED) scheduler.start(env.SCHEDULER_INTERVAL_MS);
const shutdown = async (signal: string) => {
  console.log(`Received ${signal}; shutting down gracefully`);
  server.close(async () => {
    if ("close" in store && typeof store.close === "function")
      await store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
const originalShutdown = shutdown;
const gracefulShutdown = async (signal: string) => {
  scheduler.stop();
  await originalShutdown(signal);
};
process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
