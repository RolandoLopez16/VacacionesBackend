import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { MemoryStore } from "../adapters/outbound/memory/memoryRepositories.js";
import type { VacationStore } from "../application/ports/repositories.js";
import { AuthService, refreshSecretFrom } from "../application/services/authService.js";
import { VacationService } from "../application/services/vacationService.js";
import { env } from "../infrastructure/config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { requireSession } from "./middleware/auth.js";
import { requestId } from "./middleware/requestId.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { healthRoutes } from "./routes/health.js";
import { importRoutes } from "./routes/imports.js";
import { periodRoutes } from "./routes/periods.js";
import { reportRoutes } from "./routes/reports.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { settlementRoutes } from "./routes/settlements.js";
import type { RouteDependencies } from "./routes/types.js";
import { workerRoutes } from "./routes/workers.js";

export async function createApp(
  store: VacationStore = new MemoryStore(),
  seedDemo = false,
  auth?: AuthService,
) {
  const service = new VacationService(store);
  const authService =
    auth ??
    new AuthService(
      store,
      {
        jwtSecret: env.JWT_SECRET,
        refreshSecret: env.JWT_REFRESH_SECRET ?? refreshSecretFrom(env.JWT_SECRET),
        accessExpiresIn: env.JWT_EXPIRES_IN,
        refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
      },
      store,
    );
  await authService.ensureAdmin(env.BOOTSTRAP_ADMIN_USERNAME, env.BOOTSTRAP_ADMIN_PASSWORD);
  if (seedDemo) await service.seed();

  const app = express();
  app.disable("x-powered-by");
  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim()),
      credentials: true,
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.use(express.json({ limit: `${Math.ceil(env.MAX_UPLOAD_MB * 1.4)}mb` }));
  app.use(requireSession(authService));

  const dependencies: RouteDependencies = { store, service, auth: authService };
  app.use(healthRoutes(store));
  app.use(authRoutes(dependencies));
  app.use(dashboardRoutes(dependencies));
  app.use(workerRoutes(dependencies));
  app.use(periodRoutes(dependencies));

  const schedules = scheduleRoutes(dependencies);
  app.use("/api/v1/schedules", schedules);
  app.use("/api/v1/vacation-schedules", schedules);

  const settlements = settlementRoutes(dependencies);
  app.use("/api/v1/settlements", settlements);
  app.use("/api/v1/vacation-settlements", settlements);

  app.use(importRoutes(dependencies));
  app.use(reportRoutes(dependencies));
  app.use(adminRoutes(dependencies));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
