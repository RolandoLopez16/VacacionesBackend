import { Router } from "express";
import { env } from "../../infrastructure/config/env.js";
import { actor, parseBody, parseQuery, pathParam } from "../lib/http.js";
import { readClosureDates, readImportRows } from "../lib/imports.js";
import { authorizeRoute } from "../middleware/auth.js";
import { previewTokenInputSchema } from "../schemas/imports.js";
import { periodListQuerySchema } from "../schemas/periods.js";
import type { RouteDependencies } from "./types.js";

export function periodRoutes({ store, service }: RouteDependencies): Router {
  const router = Router();

  router.get(
    "/api/v1/vacation-periods",
    authorizeRoute("GET", "/api/v1/vacation-periods"),
    async (req, res) => {
      const query = parseQuery(periodListQuerySchema(env.MAX_PAGE_SIZE), req);
      if (query.employmentId) {
        const detail = await service.detail(query.employmentId, query.asOf);
        const start = (query.page - 1) * query.pageSize;
        const items = detail.periods.slice(start, start + query.pageSize);
        return res.json({
          data: items,
          items,
          page: query.page,
          pageSize: query.pageSize,
          total: detail.periods.length,
          hasNext: query.page * query.pageSize < detail.periods.length,
        });
      }
      const employments = await store.listEmploymentPage({
        page: query.page,
        pageSize: query.pageSize,
      });
      const periods = await store.findByEmploymentIds(employments.items.map((item) => item.id));
      return res.json({
        data: periods,
        items: periods,
        page: query.page,
        pageSize: query.pageSize,
        total: employments.total,
        hasNext: query.page * query.pageSize < employments.total,
      });
    },
  );

  router.get(
    "/api/v1/vacation-periods/:periodId",
    authorizeRoute("GET", "/api/v1/vacation-periods/:periodId"),
    async (req, res) => {
      const period = await store.findPeriodById(pathParam(req, "periodId"));
      if (!period) {
        return res.status(404).json({ code: "NOT_FOUND", message: "Vacation period not found" });
      }
      return res.json({ data: period, ...period });
    },
  );

  router.post(
    "/api/v1/vacation-periods/import-pending/preview",
    authorizeRoute("POST", "/api/v1/vacation-periods/import-pending/preview"),
    async (req, res) => {
      const input = readImportRows(req);
      const dates = readClosureDates(req);
      res.json(
        await service.previewPendingPeriodImport(
          input.fileName,
          input.fileHash,
          input.rows,
          actor(req),
          dates.asOf,
        ),
      );
    },
  );

  router.post(
    "/api/v1/vacation-periods/import-pending/:batchId/apply",
    authorizeRoute("POST", "/api/v1/vacation-periods/import-pending/:batchId/apply"),
    async (req, res) => {
      const input = readImportRows(req);
      const dates = readClosureDates(req);
      const parsed = parseBody(previewTokenInputSchema, req);
      res.json(
        await service.applyPendingPeriodImport(
          pathParam(req, "batchId"),
          input.fileName,
          input.fileHash,
          parsed.previewToken,
          input.rows,
          actor(req),
          dates.asOf,
        ),
      );
    },
  );

  router.get(
    "/api/v1/vacation-periods/import-pending/:batchId",
    authorizeRoute("GET", "/api/v1/vacation-periods/import-pending/:batchId"),
    async (req, res) => {
      const batch = await store.findVacationPendingPeriodImportBatch(pathParam(req, "batchId"));
      if (!batch) {
        return res.status(404).json({
          code: "NOT_FOUND",
          message: "Carga de períodos pendientes no encontrada",
        });
      }
      return res.json({ data: batch, ...batch });
    },
  );

  return router;
}
