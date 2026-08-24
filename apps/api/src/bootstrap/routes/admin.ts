import { Router } from "express";
import type { LocalDate } from "../../domain/shared/localDate.js";
import { env } from "../../infrastructure/config/env.js";
import { actor, compactQuery, parseBody, parseQuery, pathParam } from "../lib/http.js";
import { authorizeRoute } from "../middleware/auth.js";
import {
  adminAsOfQuerySchema,
  alertPageQuerySchema,
  alertsQuerySchema,
  auditPageQuerySchema,
  catalogInputSchema,
  catalogPageQuerySchema,
  holidayInputSchema,
  holidayPageQuerySchema,
  holidayPatchInputSchema,
  holidayYearQuerySchema,
  importBatchPageQuerySchema,
  policyInputSchema,
  reconciliationPageQuerySchema,
  retiredAccountingClosureInputSchema,
  closureFromDateSettingInputSchema,
  schedulerRunPageQuerySchema,
  systemSettingInputSchema,
  userInputSchema,
  userPageQuerySchema,
  userPatchInputSchema,
} from "../schemas/admin.js";
import type { RouteDependencies } from "./types.js";

export function adminRoutes({ store, service, auth }: RouteDependencies): Router {
  const router = Router();

  router.get(
    "/api/v1/admin/vacation-policy",
    authorizeRoute("GET", "/api/v1/admin/vacation-policy"),
    async (req, res) => {
      const query = parseQuery(adminAsOfQuerySchema, req);
      const data = await store.current(
        query.asOf ?? (new Date().toISOString().slice(0, 10) as LocalDate),
      );
      res.json({ data, ...data });
    },
  );

  router.post(
    "/api/v1/admin/vacation-policy",
    authorizeRoute("POST", "/api/v1/admin/vacation-policy"),
    async (req, res) => {
      const input = parseBody(policyInputSchema, req);
      const policy = { id: "default", ...input };
      await store.savePolicy(policy);
      await store.append({
        id: crypto.randomUUID(),
        actorId: actor(req),
        action: "VACATION_POLICY_UPDATED",
        entityType: "VacationPolicy",
        entityId: policy.id,
        metadata: {
          daysPerCompletedYear: policy.daysPerCompletedYear,
          overdueAfterMonths: policy.overdueAfterMonths,
        },
        createdAt: new Date().toISOString(),
      });
      res.json({ data: policy, ...policy });
    },
  );

  router.get("/api/v1/holidays", authorizeRoute("GET", "/api/v1/holidays"), async (req, res) => {
    const query = parseQuery(holidayYearQuerySchema, req);
    const data = await store.listHolidays(query.year);
    res.json({ data, items: data });
  });

  router.get(
    "/api/v1/admin/holidays",
    authorizeRoute("GET", "/api/v1/admin/holidays"),
    async (req, res) => {
      const query = parseQuery(holidayYearQuerySchema, req);
      const data = await store.listHolidays(query.year);
      res.json({ data, items: data });
    },
  );

  router.post(
    "/api/v1/admin/holidays",
    authorizeRoute("POST", "/api/v1/admin/holidays"),
    async (req, res) => {
      const input = parseBody(holidayInputSchema, req);
      const now = new Date().toISOString();
      const holiday = {
        id: crypto.randomUUID(),
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      await store.saveHoliday(holiday);
      await store.append({
        id: crypto.randomUUID(),
        actorId: actor(req),
        action: "HOLIDAY_CREATED",
        entityType: "Holiday",
        entityId: holiday.id,
        metadata: { date: holiday.date },
        createdAt: now,
      });
      res.status(201).json({ data: holiday, ...holiday });
    },
  );

  router.get(
    "/api/v1/admin/holidays/:id",
    authorizeRoute("GET", "/api/v1/admin/holidays/:id"),
    async (req, res) => {
      const holiday = (await store.listHolidays()).find((item) => item.id === pathParam(req, "id"));
      if (!holiday) {
        return res.status(404).json({ code: "NOT_FOUND", message: "Holiday not found" });
      }
      return res.json({ data: holiday, ...holiday });
    },
  );

  router.patch(
    "/api/v1/admin/holidays/:id",
    authorizeRoute("PATCH", "/api/v1/admin/holidays/:id"),
    async (req, res) => {
      const holiday = (await store.listHolidays()).find((item) => item.id === pathParam(req, "id"));
      if (!holiday) {
        return res.status(404).json({ code: "NOT_FOUND", message: "Holiday not found" });
      }
      const input = parseBody(holidayPatchInputSchema, req);
      const updated = {
        ...holiday,
        ...(input.date === undefined ? {} : { date: input.date }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.country === undefined ? {} : { country: input.country }),
        ...(input.active === undefined ? {} : { active: input.active }),
        updatedAt: new Date().toISOString(),
      };
      await store.saveHoliday(updated);
      await store.append({
        id: crypto.randomUUID(),
        actorId: actor(req),
        action: "HOLIDAY_UPDATED",
        entityType: "Holiday",
        entityId: holiday.id,
        metadata: { date: updated.date, active: updated.active },
        createdAt: updated.updatedAt,
      });
      return res.json({ data: updated, ...updated });
    },
  );

  router.delete(
    "/api/v1/admin/holidays/:id",
    authorizeRoute("DELETE", "/api/v1/admin/holidays/:id"),
    async (req, res) => {
      const holiday = (await store.listHolidays()).find((item) => item.id === pathParam(req, "id"));
      if (!holiday) {
        return res.status(404).json({ code: "NOT_FOUND", message: "Holiday not found" });
      }
      const updated = {
        ...holiday,
        active: false,
        updatedAt: new Date().toISOString(),
      };
      await store.saveHoliday(updated);
      await store.append({
        id: crypto.randomUUID(),
        actorId: actor(req),
        action: "HOLIDAY_DEACTIVATED",
        entityType: "Holiday",
        entityId: holiday.id,
        metadata: { date: holiday.date },
        createdAt: updated.updatedAt,
      });
      return res.json({ data: updated, ...updated });
    },
  );

  router.get("/api/v1/alerts", authorizeRoute("GET", "/api/v1/alerts"), async (req, res) => {
    const query = parseQuery(alertsQuerySchema, req);
    const data = await store.listAlerts({
      ...(query.employmentId ? { employmentId: query.employmentId } : {}),
      ...(query.active === undefined ? {} : { active: query.active }),
    });
    res.json({ data, items: data });
  });

  router.get(
    "/api/v1/admin/scheduler-runs",
    authorizeRoute("GET", "/api/v1/admin/scheduler-runs"),
    async (_req, res) => {
      const data = await store.listSchedulerRuns();
      res.json({ data, items: data });
    },
  );

  router.get(
    "/api/v1/admin/scheduler-status",
    authorizeRoute("GET", "/api/v1/admin/scheduler-status"),
    async (_req, res) => {
      const runs = await store.listSchedulerRuns();
      const lastRun = [...runs].sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      )[0];
      res.json({
        data: {
          enabled: env.SCHEDULER_ENABLED,
          intervalMs: env.SCHEDULER_INTERVAL_MS,
          lastRun,
        },
      });
    },
  );

  router.post(
    "/api/v1/admin/retired-employments/close-pending",
    authorizeRoute("POST", "/api/v1/admin/retired-employments/close-pending"),
    async (req, res) => {
      const query = parseQuery(adminAsOfQuerySchema, req);
      const result = await service.closeRetiredEmployments(actor(req), query.asOf);
      res.json({ data: result, ...result });
    },
  );

  router.get(
    "/api/v1/admin/retired-employments/reconciliation",
    authorizeRoute("GET", "/api/v1/admin/retired-employments/reconciliation"),
    async (req, res) => {
      const query = parseQuery(adminAsOfQuerySchema, req);
      const result = await service.retiredVacationReconciliation(query.asOf);
      res.json({ data: result, ...result });
    },
  );

  router.post(
    "/api/v1/admin/retired-employments/close-accounting",
    authorizeRoute("POST", "/api/v1/admin/retired-employments/close-accounting"),
    async (req, res) => {
      const input = parseBody(retiredAccountingClosureInputSchema, req);
      const query = parseQuery(adminAsOfQuerySchema, req);
      const result = await service.closeRetiredEmploymentsWithAccounting(
        input,
        actor(req),
        query.asOf,
      );
      res.json({ data: result, ...result });
    },
  );

  router.get(
    "/api/v1/admin/settings/:key",
    authorizeRoute("GET", "/api/v1/admin/settings/:key"),
    async (req, res) => {
      const key = pathParam(req, "key").trim().toUpperCase();
      if (key !== "GERENTE" && key !== "VACATION_CLOSURE_FROM_DATE") {
        return res.status(404).json({ code: "NOT_FOUND", message: "Setting not found" });
      }
      const setting = await store.findSystemSettingByKey(key);
      const data = setting ?? { key, value: "" };
      return res.json({ data, ...data });
    },
  );

  router.patch(
    "/api/v1/admin/settings/:key",
    authorizeRoute("PATCH", "/api/v1/admin/settings/:key"),
    async (req, res) => {
      const key = pathParam(req, "key").trim().toUpperCase();
      if (key !== "GERENTE" && key !== "VACATION_CLOSURE_FROM_DATE") {
        return res.status(404).json({ code: "NOT_FOUND", message: "Setting not found" });
      }
      const schema =
        key === "VACATION_CLOSURE_FROM_DATE"
          ? closureFromDateSettingInputSchema
          : systemSettingInputSchema;
      const input = parseBody(schema, req);
      const setting = {
        key,
        value: input.value,
        updatedBy: actor(req),
        updatedAt: new Date().toISOString(),
      };
      await store.saveSystemSetting(setting);
      await store.append({
        id: crypto.randomUUID(),
        actorId: actor(req),
        action: "SYSTEM_SETTING_UPDATED",
        entityType: "SystemSetting",
        entityId: key,
        metadata: { key, value: input.value },
        createdAt: setting.updatedAt,
      });
      return res.json({ data: setting, ...setting });
    },
  );

  router.get(
    "/api/v1/admin/catalogs/:type",
    authorizeRoute("GET", "/api/v1/admin/catalogs/:type"),
    async (req, res) => {
      const type = pathParam(req, "type");
      let data = await store.listCatalog(type);
      if (!data.length) {
        const employments = await store.listEmployments();
        const workers = await store.listWorkers();
        const names =
          type === "contract-types"
            ? [...new Set(employments.map((item) => item.contractTypeName))]
            : type === "processes"
              ? [...new Set(employments.map((item) => item.processName))]
              : type === "positions"
                ? [...new Set(employments.map((item) => item.positionName))]
                : [];
        for (const name of names) {
          const now = new Date().toISOString();
          const item = {
            id: crypto.randomUUID(),
            type,
            name,
            active: true,
            createdAt: now,
            updatedAt: now,
          };
          await store.saveCatalog(item);
          data.push(item);
        }
        if (type === "supervisors") {
          data = workers.map((worker) => ({
            id: worker.id,
            type,
            name: worker.fullName,
            active: true,
            createdAt: worker.createdAt,
            updatedAt: worker.updatedAt,
          }));
        }
      }
      res.json({ data, items: data });
    },
  );

  router.post(
    "/api/v1/admin/catalogs/:type",
    authorizeRoute("POST", "/api/v1/admin/catalogs/:type"),
    async (req, res) => {
      const input = parseBody(catalogInputSchema, req);
      const now = new Date().toISOString();
      const item = {
        id: crypto.randomUUID(),
        type: pathParam(req, "type"),
        name: input.name,
        active: input.active ?? true,
        createdAt: now,
        updatedAt: now,
      };
      await store.saveCatalog(item);
      res.status(201).json({ data: item, ...item });
    },
  );

  router.patch(
    "/api/v1/admin/catalogs/:type/:id",
    authorizeRoute("PATCH", "/api/v1/admin/catalogs/:type/:id"),
    async (req, res) => {
      const input = parseBody(catalogInputSchema.partial(), req);
      const existing = (await store.listCatalog(pathParam(req, "type"))).find(
        (item) => item.id === pathParam(req, "id"),
      );
      if (!existing) {
        return res.status(404).json({ code: "NOT_FOUND", message: "Catalog item not found" });
      }
      const item = {
        ...existing,
        ...(input.name ? { name: input.name } : {}),
        ...(input.active === undefined ? {} : { active: input.active }),
        updatedAt: new Date().toISOString(),
      };
      await store.saveCatalog(item);
      return res.json({ data: item, ...item });
    },
  );

  router.get(
    "/api/v1/admin/users",
    authorizeRoute("GET", "/api/v1/admin/users"),
    async (_req, res) => {
      const data = await auth.listUsers();
      res.json({ data, items: data });
    },
  );

  router.post(
    "/api/v1/admin/users",
    authorizeRoute("POST", "/api/v1/admin/users"),
    async (req, res) => {
      const input = parseBody(userInputSchema, req);
      const user = await auth.createUser(
        input.username,
        input.password,
        input.role,
        input.displayName,
        input.jobTitle,
      );
      await store.append({
        id: crypto.randomUUID(),
        actorId: actor(req),
        action: "USER_CREATED",
        entityType: "USER",
        entityId: user.id,
        metadata: {
          username: user.username,
          displayName: user.displayName,
          jobTitle: user.jobTitle,
          role: user.role,
          active: user.active,
        },
        createdAt: new Date().toISOString(),
      });
      res.status(201).json({ data: user, ...user });
    },
  );

  router.patch(
    "/api/v1/admin/users/:id",
    authorizeRoute("PATCH", "/api/v1/admin/users/:id"),
    async (req, res) => {
      const input = parseBody(userPatchInputSchema, req);
      const user = await auth.updateUser(pathParam(req, "id"), input, actor(req));
      await store.append({
        id: crypto.randomUUID(),
        actorId: actor(req),
        action:
          input.active === undefined
            ? "USER_UPDATED"
            : input.active
              ? "USER_ACTIVATED"
              : "USER_DEACTIVATED",
        entityType: "USER",
        entityId: user.id,
        metadata: {
          username: user.username,
          displayName: user.displayName,
          jobTitle: user.jobTitle,
          role: user.role,
          active: user.active,
        },
        createdAt: new Date().toISOString(),
      });
      res.json({ data: user, ...user });
    },
  );

  router.get(
    "/api/v1/admin/audit-events",
    authorizeRoute("GET", "/api/v1/admin/audit-events"),
    async (_req, res) => {
      const data = await store.listAudits();
      res.json({ data, items: data });
    },
  );

  router.get("/api/v1/audit", authorizeRoute("GET", "/api/v1/audit"), async (_req, res) =>
    res.json({ items: await store.listAudits() }),
  );

  router.get(
    "/api/v1/audit/page",
    authorizeRoute("GET", "/api/v1/audit/page"),
    async (req, res) => {
      const query = parseQuery(auditPageQuerySchema, req);
      const page = await service.listAuditsPage(compactQuery(query));
      res.json(page);
    },
  );

  router.get(
    "/api/v1/admin/audit-events/page",
    authorizeRoute("GET", "/api/v1/admin/audit-events/page"),
    async (req, res) => {
      const query = parseQuery(auditPageQuerySchema, req);
      const page = await service.listAuditsPage(compactQuery(query));
      res.json(page);
    },
  );

  router.get(
    "/api/v1/admin/users/page",
    authorizeRoute("GET", "/api/v1/admin/users/page"),
    async (req, res) => {
      const query = parseQuery(userPageQuerySchema, req);
      const page = await service.listUsersPage(compactQuery(query));
      res.json(page);
    },
  );

  router.get(
    "/api/v1/admin/holidays/page",
    authorizeRoute("GET", "/api/v1/admin/holidays/page"),
    async (req, res) => {
      const query = parseQuery(holidayPageQuerySchema, req);
      const page = await service.listHolidaysPage(compactQuery(query));
      res.json(page);
    },
  );

  router.get(
    "/api/v1/holidays/page",
    authorizeRoute("GET", "/api/v1/holidays/page"),
    async (req, res) => {
      const query = parseQuery(holidayPageQuerySchema, req);
      const page = await service.listHolidaysPage(compactQuery(query));
      res.json(page);
    },
  );

  router.get(
    "/api/v1/admin/catalogs/:type/page",
    authorizeRoute("GET", "/api/v1/admin/catalogs/:type/page"),
    async (req, res) => {
      const query = parseQuery(catalogPageQuerySchema, req);
      const page = await service.listCatalogPage({
        ...compactQuery(query),
        type: pathParam(req, "type"),
      });
      res.json(page);
    },
  );

  router.get(
    "/api/v1/alerts/page",
    authorizeRoute("GET", "/api/v1/alerts/page"),
    async (req, res) => {
      const query = parseQuery(alertPageQuerySchema, req);
      const page = await service.listAlertsPage(compactQuery(query));
      res.json(page);
    },
  );

  router.get(
    "/api/v1/admin/scheduler-runs/page",
    authorizeRoute("GET", "/api/v1/admin/scheduler-runs/page"),
    async (req, res) => {
      const query = parseQuery(schedulerRunPageQuerySchema, req);
      const page = await service.listSchedulerRunsPage(compactQuery(query));
      res.json(page);
    },
  );

  router.get(
    "/api/v1/admin/import-batches/page",
    authorizeRoute("GET", "/api/v1/admin/import-batches/page"),
    async (req, res) => {
      const query = parseQuery(importBatchPageQuerySchema, req);
      const { items, total } = await store.listImportBatchesPage(compactQuery(query));
      const summary = items.map((batch) => ({
        id: batch.id,
        actorId: batch.idempotencyKey.split(":")[0],
        status: batch.status,
        attempt: batch.attempt ?? 0,
        totalRows: batch.totalRows,
        createdRows: batch.createdRows,
        updatedRows: batch.updatedRows,
        invalidRows: batch.invalidRows,
        durationMs: batch.durationMs,
        processedRows: batch.processedRows,
        databaseOperations: batch.databaseOperations,
        chunks: batch.chunks,
        errorSummary: batch.errorSummary,
        createdAt: batch.createdAt,
        completedAt: batch.completedAt,
        failedAt: batch.failedAt,
      }));
      res.json({
        items: summary,
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasNext: query.page * query.pageSize < total,
      });
    },
  );

  router.get(
    "/api/v1/admin/retired-employments/reconciliation/page",
    authorizeRoute("GET", "/api/v1/admin/retired-employments/reconciliation/page"),
    async (req, res) => {
      const query = parseQuery(reconciliationPageQuerySchema, req);
      const baseQuery = parseQuery(adminAsOfQuerySchema, req);
      const result = await service.retiredVacationReconciliation(baseQuery.asOf);
      const search = query.search?.trim().toLowerCase();
      const filtered = result.items.filter((item) => {
        if (search) {
          const haystack = `${item.documentNumber} ${item.employeeName}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        if (query.state) {
          const states = new Set(item.periods.map((period) => period.state));
          if (!states.has(query.state)) return false;
        }
        return true;
      });
      const start = (query.page - 1) * query.pageSize;
      const total = filtered.length;
      const items = filtered.slice(start, start + query.pageSize);
      res.json({
        items,
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasNext: query.page * query.pageSize < total,
      });
    },
  );

  return router;
}
