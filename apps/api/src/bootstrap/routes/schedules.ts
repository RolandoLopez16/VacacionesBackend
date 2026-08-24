import { Router, type Request, type RequestHandler } from "express";
import type { ScheduleInput } from "../../application/services/vacationService.js";
import { addDays } from "../../domain/shared/localDate.js";
import { env } from "../../infrastructure/config/env.js";
import { actor, expectedVersion, parseBody, parseQuery, pathParam } from "../lib/http.js";
import { authorizeRoute } from "../middleware/auth.js";
import { scheduleInputSchema, scheduleListQuerySchema } from "../schemas/schedules.js";
import { settlementInputSchema } from "../schemas/settlements.js";
import type { SettlementInput } from "../../application/services/vacationService.js";
import type { RouteDependencies } from "./types.js";

function isCompatibilityMount(req: Request): boolean {
  return req.baseUrl.endsWith("/vacation-schedules");
}

function onlyMount(compatibility: boolean): RequestHandler {
  return (req, _res, next) =>
    isCompatibilityMount(req) === compatibility ? next() : next("route");
}

function scheduleBody(req: Request): ScheduleInput {
  const input = parseBody(scheduleInputSchema, req);
  return {
    ...input,
    endDate: input.endDate ?? addDays(input.startDate, input.scheduledDays - 1),
  } as ScheduleInput;
}

function settlementBody(req: Request): SettlementInput {
  const input = parseBody(settlementInputSchema, req);
  const total = Math.max(1, input.enjoyedDays + input.compensatedDays);
  return {
    ...input,
    enjoymentEndDate: input.enjoymentEndDate ?? addDays(input.enjoymentStartDate, total - 1),
  } as SettlementInput;
}

export function scheduleRoutes({ store, service }: RouteDependencies): Router {
  const router = Router();

  router.get("/", authorizeRoute("GET", "/api/v1/schedules"), async (req, res) => {
    const query = parseQuery(scheduleListQuerySchema(env.MAX_PAGE_SIZE), req);
    const result = await service.schedulePage({
      page: query.page,
      pageSize: query.pageSize,
      ...(query.employmentId ? { employmentId: query.employmentId } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from ? { fromDate: query.from } : {}),
      ...(query.to ? { toDate: query.to } : {}),
    });
    res.json({
      ...(isCompatibilityMount(req) ? { data: result.items } : {}),
      items: result.items,
      page: query.page,
      pageSize: query.pageSize,
      total: result.total,
      hasNext: query.page * query.pageSize < result.total,
    });
  });

  router.post("/", authorizeRoute("POST", "/api/v1/schedules"), async (req, res) => {
    res.status(201).json(await service.createSchedule(scheduleBody(req), actor(req)));
  });

  router.patch(
    "/:id",
    authorizeRoute("PATCH", "/api/v1/schedules/:id"),
    onlyMount(false),
    async (req, res) => {
      res.json(
        await service.updateSchedule(
          pathParam(req, "id"),
          scheduleBody(req),
          expectedVersion(req),
          actor(req),
        ),
      );
    },
  );

  router.post(
    "/:id/cancel",
    authorizeRoute("POST", "/api/v1/schedules/:id/cancel"),
    async (req, res) => {
      res.json(
        await service.cancelSchedule(pathParam(req, "id"), expectedVersion(req), actor(req)),
      );
    },
  );

  router.post(
    "/:id/complete",
    authorizeRoute("POST", "/api/v1/schedules/:id/complete"),
    onlyMount(false),
    async (req, res) => {
      res.json(
        await service.completeSchedule(
          pathParam(req, "id"),
          settlementBody(req),
          expectedVersion(req),
          actor(req),
        ),
      );
    },
  );

  router.get(
    "/:id",
    authorizeRoute("GET", "/api/v1/vacation-schedules/:id"),
    onlyMount(true),
    async (req, res) => {
      const schedule = await store.findScheduleById(pathParam(req, "id"));
      if (!schedule) {
        return res.status(404).json({ code: "NOT_FOUND", message: "Schedule not found" });
      }
      return res.json({ data: schedule, ...schedule });
    },
  );

  router.post(
    "/:id/reschedule",
    authorizeRoute("POST", "/api/v1/vacation-schedules/:id/reschedule"),
    onlyMount(true),
    async (req, res) => {
      res.json(
        await service.updateSchedule(
          pathParam(req, "id"),
          scheduleBody(req),
          expectedVersion(req),
          actor(req),
        ),
      );
    },
  );

  router.post(
    "/:id/register-settlement",
    authorizeRoute("POST", "/api/v1/vacation-schedules/:id/register-settlement"),
    onlyMount(true),
    async (req, res) => {
      res.json(
        await service.completeSchedule(
          pathParam(req, "id"),
          settlementBody(req),
          expectedVersion(req),
          actor(req),
        ),
      );
    },
  );

  return router;
}
