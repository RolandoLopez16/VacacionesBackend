import { Router, type Request, type RequestHandler } from "express";
import type { SettlementInput } from "../../application/services/vacationService.js";
import { addDays } from "../../domain/shared/localDate.js";
import { env } from "../../infrastructure/config/env.js";
import { actor, expectedVersion, parseBody, parseQuery, pathParam } from "../lib/http.js";
import { readImportRows } from "../lib/imports.js";
import { authorizeRoute } from "../middleware/auth.js";
import { previewTokenInputSchema } from "../schemas/imports.js";
import {
  annulSettlementInputSchema,
  settlementInputSchema,
  settlementListQuerySchema,
} from "../schemas/settlements.js";
import type { RouteDependencies } from "./types.js";

function isCompatibilityMount(req: Request): boolean {
  return req.baseUrl.endsWith("/vacation-settlements");
}

const onlyCompatibility: RequestHandler = (req, _res, next) =>
  isCompatibilityMount(req) ? next() : next("route");

function settlementBody(req: Request): SettlementInput {
  const input = parseBody(settlementInputSchema, req);
  const total = Math.max(1, input.enjoyedDays + input.compensatedDays);
  return {
    ...input,
    enjoymentEndDate: input.enjoymentEndDate ?? addDays(input.enjoymentStartDate, total - 1),
  } as SettlementInput;
}

export function settlementRoutes({ store, service }: RouteDependencies): Router {
  const router = Router();

  router.get("/", authorizeRoute("GET", "/api/v1/settlements"), async (req, res) => {
    const query = parseQuery(settlementListQuerySchema(env.MAX_PAGE_SIZE), req);
    const compatibility = isCompatibilityMount(req);
    const result = await service.settlementPage({
      page: query.page,
      pageSize: query.pageSize,
      ...(query.employmentId ? { employmentId: query.employmentId } : {}),
      ...(query.search?.trim() ? { search: query.search.trim() } : {}),
      ...(!compatibility && query.from ? { fromDate: query.from } : {}),
      ...(!compatibility && query.to ? { toDate: query.to } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
    res.json({
      ...(compatibility ? { data: result.items } : {}),
      items: result.items,
      page: query.page,
      pageSize: query.pageSize,
      total: result.total,
      hasNext: query.page * query.pageSize < result.total,
    });
  });

  router.post("/", authorizeRoute("POST", "/api/v1/settlements"), async (req, res) => {
    res.status(201).json(await service.createSettlement(settlementBody(req), actor(req)));
  });

  router.patch("/:id", authorizeRoute("PATCH", "/api/v1/settlements/:id"), async (req, res) => {
    res.json(
      await service.updateSettlement(
        pathParam(req, "id"),
        settlementBody(req),
        expectedVersion(req),
        actor(req),
      ),
    );
  });

  router.get(
    "/:id",
    authorizeRoute("GET", "/api/v1/vacation-settlements/:id"),
    onlyCompatibility,
    async (req, res) => {
      const item = await store.findSettlementById(pathParam(req, "id"));
      if (!item) {
        return res.status(404).json({ code: "NOT_FOUND", message: "Settlement not found" });
      }
      return res.json({ data: item, ...item });
    },
  );

  router.post(
    "/:id/annul",
    authorizeRoute("POST", "/api/v1/vacation-settlements/:id/annul"),
    onlyCompatibility,
    async (req, res) => {
      const input = parseBody(annulSettlementInputSchema, req);
      res.json({
        data: await service.annulSettlement(
          pathParam(req, "id"),
          input.reason,
          expectedVersion(req),
          actor(req),
        ),
      });
    },
  );

  router.post(
    "/import/preview",
    authorizeRoute("POST", "/api/v1/vacation-settlements/import/preview"),
    onlyCompatibility,
    async (req, res) => {
      const input = readImportRows(req);
      res.json(
        await service.previewSettlementImport(
          input.fileName,
          input.fileHash,
          input.rows,
          actor(req),
        ),
      );
    },
  );

  router.post(
    "/import/:batchId/apply",
    authorizeRoute("POST", "/api/v1/vacation-settlements/import/:batchId/apply"),
    onlyCompatibility,
    async (req, res) => {
      const input = readImportRows(req);
      const parsed = parseBody(previewTokenInputSchema, req);
      res.json(
        await service.applySettlementImport(
          pathParam(req, "batchId"),
          input.fileName,
          input.fileHash,
          parsed.previewToken,
          input.rows,
          actor(req),
        ),
      );
    },
  );

  router.get(
    "/import/:batchId",
    authorizeRoute("GET", "/api/v1/vacation-settlements/import/:batchId"),
    onlyCompatibility,
    async (req, res) => {
      const batch = await store.findVacationSettlementImportBatch(pathParam(req, "batchId"));
      if (!batch) {
        return res.status(404).json({ code: "NOT_FOUND", message: "Import batch not found" });
      }
      return res.json({ data: batch, ...batch });
    },
  );

  return router;
}
