import { Router } from "express";
import type { EmploymentInput } from "../../application/services/vacationService.js";
import { env } from "../../infrastructure/config/env.js";
import { actor, expectedVersion, parseBody, parseQuery, pathParam } from "../lib/http.js";
import { authorizeRoute } from "../middleware/auth.js";
import {
  employmentFilters,
  employmentInputSchema,
  employmentListQuerySchema,
  retirementInputSchema,
  workerInputSchema,
} from "../schemas/workers.js";
import type { RouteDependencies } from "./types.js";

export function workerRoutes({ store, service }: RouteDependencies): Router {
  const router = Router();

  router.get("/api/v1/workers", authorizeRoute("GET", "/api/v1/workers"), async (_req, res) => {
    const data = await store.listWorkers();
    res.json({ data, items: data });
  });

  router.post("/api/v1/workers", authorizeRoute("POST", "/api/v1/workers"), async (req, res) => {
    const input = parseBody(workerInputSchema, req);
    const normalized =
      input.documentNumber.replace(/\D/g, "") || input.documentNumber.toUpperCase();
    if (
      (await store.listWorkers()).some((worker) => worker.normalizedDocumentNumber === normalized)
    ) {
      throw new Error("The document number already exists");
    }
    const now = new Date().toISOString();
    const worker = {
      id: crypto.randomUUID(),
      documentNumber: input.documentNumber,
      normalizedDocumentNumber: normalized,
      fullName: input.fullName,
      workerType: "EMPLOYEE" as const,
      createdAt: now,
      updatedAt: now,
    };
    await store.saveWorker(worker);
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: "WORKER_CREATED",
      entityType: "Worker",
      entityId: worker.id,
      metadata: {},
      createdAt: now,
    });
    res.status(201).json({ data: worker, ...worker });
  });

  router.get(
    "/api/v1/workers/:workerId",
    authorizeRoute("GET", "/api/v1/workers/:workerId"),
    async (req, res) => {
      const worker = await store.findWorkerById(pathParam(req, "workerId"));
      if (!worker) return res.status(404).json({ code: "NOT_FOUND", message: "Worker not found" });
      return res.json({ data: worker, ...worker });
    },
  );

  router.patch(
    "/api/v1/workers/:workerId",
    authorizeRoute("PATCH", "/api/v1/workers/:workerId"),
    async (req, res) => {
      const worker = await store.findWorkerById(pathParam(req, "workerId"));
      if (!worker) return res.status(404).json({ code: "NOT_FOUND", message: "Worker not found" });
      const input = parseBody(workerInputSchema.partial(), req);
      const normalized = input.documentNumber
        ? input.documentNumber.replace(/\D/g, "") || input.documentNumber.toUpperCase()
        : worker.normalizedDocumentNumber;
      const duplicate = (await store.listWorkers()).some(
        (item) => item.id !== worker.id && item.normalizedDocumentNumber === normalized,
      );
      if (duplicate) throw new Error("The document number already exists");
      const updated = {
        ...worker,
        ...input,
        documentNumber: input.documentNumber ?? worker.documentNumber,
        fullName: input.fullName ?? worker.fullName,
        normalizedDocumentNumber: normalized,
        updatedAt: new Date().toISOString(),
      };
      await store.saveWorker(updated);
      return res.json({ data: updated, ...updated });
    },
  );

  router.get(
    "/api/v1/workers/:workerId/employments",
    authorizeRoute("GET", "/api/v1/workers/:workerId/employments"),
    async (req, res) => {
      const data = (await store.listEmployments()).filter(
        (item) => item.workerId === pathParam(req, "workerId"),
      );
      res.json({ data, items: data });
    },
  );

  router.post(
    "/api/v1/workers/:workerId/employments",
    authorizeRoute("POST", "/api/v1/workers/:workerId/employments"),
    async (req, res) => {
      const worker = await store.findWorkerById(pathParam(req, "workerId"));
      if (!worker) return res.status(404).json({ code: "NOT_FOUND", message: "Worker not found" });
      const input = parseBody(employmentInputSchema, req);
      const result = await service.upsertEmployment(
        { ...input, documentNumber: worker.documentNumber },
        actor(req),
      );
      return res.status(result.created ? 201 : 200).json(await result.summary);
    },
  );

  router.get(
    "/api/v1/employments",
    authorizeRoute("GET", "/api/v1/employments"),
    async (req, res) => {
      const query = parseQuery(employmentListQuerySchema(env.MAX_PAGE_SIZE), req);
      const result = await service.listPage({
        page: query.page,
        pageSize: query.pageSize,
        search: query.search ?? "",
        maxDays: query.accrualWithin,
        asOf: query.asOf,
        filters: employmentFilters(query),
        sortByPendingDays: query.sort === "pendingDays",
      });
      res.json({
        items: result.items,
        page: query.page,
        pageSize: query.pageSize,
        total: result.total,
        hasNext: query.page * query.pageSize < result.total,
      });
    },
  );

  router.get(
    "/api/v1/employments/:id",
    authorizeRoute("GET", "/api/v1/employments/:id"),
    async (req, res) => {
      const query = parseQuery(
        employmentListQuerySchema(env.MAX_PAGE_SIZE).pick({ asOf: true }),
        req,
      );
      res.json(await service.detail(pathParam(req, "id"), query.asOf));
    },
  );

  router.get(
    "/api/v1/employments/:id/periods",
    authorizeRoute("GET", "/api/v1/employments/:id/periods"),
    async (req, res) => {
      const query = parseQuery(
        employmentListQuerySchema(env.MAX_PAGE_SIZE).pick({ asOf: true }),
        req,
      );
      const detail = await service.detail(pathParam(req, "id"), query.asOf);
      res.json({ items: detail.periods });
    },
  );

  router.get(
    "/api/v1/employments/:id/vacation-summary",
    authorizeRoute("GET", "/api/v1/employments/:id/vacation-summary"),
    async (req, res) => {
      const query = parseQuery(
        employmentListQuerySchema(env.MAX_PAGE_SIZE).pick({ asOf: true }),
        req,
      );
      const detail = await service.detail(pathParam(req, "id"), query.asOf);
      res.json({ data: detail, ...detail });
    },
  );

  router.get(
    "/api/v1/employments/:id/vacation-periods",
    authorizeRoute("GET", "/api/v1/employments/:id/vacation-periods"),
    async (req, res) => {
      const query = parseQuery(
        employmentListQuerySchema(env.MAX_PAGE_SIZE).pick({ asOf: true }),
        req,
      );
      const detail = await service.detail(pathParam(req, "id"), query.asOf);
      res.json({ data: detail.periods, items: detail.periods });
    },
  );

  router.post(
    "/api/v1/employments",
    authorizeRoute("POST", "/api/v1/employments"),
    async (req, res) => {
      const result = await service.upsertEmployment(
        parseBody(employmentInputSchema, req) as EmploymentInput,
        actor(req),
      );
      return res.status(result.created ? 201 : 200).json(await result.summary);
    },
  );

  router.patch(
    "/api/v1/employments/:id",
    authorizeRoute("PATCH", "/api/v1/employments/:id"),
    async (req, res) => {
      res.json(
        await service.updateEmployment(
          pathParam(req, "id"),
          parseBody(employmentInputSchema, req) as EmploymentInput,
          expectedVersion(req),
          actor(req),
        ),
      );
    },
  );

  router.post(
    "/api/v1/employments/:id/retire",
    authorizeRoute("POST", "/api/v1/employments/:id/retire"),
    async (req, res) => {
      res.json(
        await service.retireEmployment(
          pathParam(req, "id"),
          parseBody(retirementInputSchema, req).endDate,
          expectedVersion(req),
          actor(req),
        ),
      );
    },
  );

  return router;
}
