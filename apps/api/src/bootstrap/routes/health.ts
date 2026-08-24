import { Router, type Request, type Response } from "express";
import type { VacationStore } from "../../application/ports/repositories.js";
import { env } from "../../infrastructure/config/env.js";

export function healthRoutes(store: VacationStore): Router {
  const router = Router();
  const live = (_req: Request, res: Response) =>
    res.json({ status: "ok", service: "vaca-efa-api" });
  const ready = async (_req: Request, res: Response) => {
    await store.ping?.();
    res.json({ status: "ready", storage: env.STORAGE_MODE });
  };

  router.get("/api/v1/health", (_req, res) =>
    res.json({ status: "ok", service: "vaca-efa-api", storage: env.STORAGE_MODE }),
  );
  router.get("/api/v1/health/live", live);
  router.get("/api/v1/health/ready", ready);
  router.get("/health/live", live);
  router.get("/health/ready", ready);
  return router;
}
