import { Router } from "express";
import { authorizeRoute } from "../middleware/auth.js";
import { parseQuery } from "../lib/http.js";
import {
  dashboardAsOfQuerySchema,
  dashboardDetailQuerySchema,
  dashboardQuerySchema,
  upcomingDashboardQuerySchema,
} from "../schemas/dashboard.js";
import { employmentFilters } from "../schemas/workers.js";
import { env } from "../../infrastructure/config/env.js";
import type { RouteDependencies } from "./types.js";

export function dashboardRoutes({ store, service }: RouteDependencies): Router {
  const router = Router();
  const read = authorizeRoute("GET", "/api/v1/dashboard");

  router.get("/api/v1/public/vacation-stats", async (_req, res) => {
    const data = await service.dashboard();
    res.json({ asOf: data.asOf, upcoming90Days: data.upcoming90Days });
  });

  router.get("/api/v1/dashboard", read, async (req, res) => {
    const query = parseQuery(dashboardQuerySchema, req);
    res.json(await service.dashboard(query.asOf, employmentFilters(query)));
  });

  router.get("/api/v1/dashboard/employments", read, async (req, res) => {
    const query = parseQuery(dashboardDetailQuerySchema(env.MAX_PAGE_SIZE), req);
    res.json(
      await service.dashboardDetail({
        kind: query.kind,
        page: query.page,
        pageSize: query.pageSize,
        ...(query.asOf ? { asOf: query.asOf } : {}),
        ...(query.healthStatus ? { healthStatus: query.healthStatus } : {}),
        ...(query.detailProcess ? { processName: query.detailProcess } : {}),
        filters: employmentFilters(query),
      }),
    );
  });

  router.get("/api/v1/dashboard/summary", read, async (req, res) => {
    const query = parseQuery(dashboardQuerySchema, req);
    const data = await service.dashboard(query.asOf, employmentFilters(query));
    res.json({ data, ...data });
  });

  router.get("/api/v1/dashboard/upcoming-accruals", read, async (req, res) => {
    const query = parseQuery(upcomingDashboardQuerySchema, req);
    const data = await service.list("", query.days, query.asOf);
    res.json({ data, items: data });
  });

  router.get("/api/v1/dashboard/overdue-periods", read, async (req, res) => {
    const query = parseQuery(dashboardAsOfQuerySchema, req);
    const data = (await service.list("", undefined, query.asOf)).filter(
      (item) => item.overduePeriods > 0,
    );
    res.json({ data, items: data });
  });

  router.get("/api/v1/dashboard/upcoming-vacations", read, async (_req, res) => {
    const data = (await store.listSchedules())
      .filter((item) => item.status === "SCHEDULED")
      .sort((left, right) => left.startDate.localeCompare(right.startDate));
    res.json({ data, items: data });
  });

  router.get("/api/v1/dashboard/pending-and-upcoming", read, async (req, res) => {
    const query = parseQuery(dashboardAsOfQuerySchema, req);
    const data = (await service.list("", 90, query.asOf)).filter((item) => item.pendingDays > 0);
    res.json({ data, items: data });
  });

  return router;
}
