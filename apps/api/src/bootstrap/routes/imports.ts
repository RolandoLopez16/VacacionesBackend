import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { EmploymentImportPreviewDto } from "@vaca-efa/contracts";
import type { BulkEmploymentImportResult } from "../../application/services/vacation/bulkEmploymentImportService.js";
import { validateEmploymentImportRow } from "../../application/services/vacation/bulkEmploymentImportService.js";
import { ValidationError } from "../../domain/shared/errors.js";
import { env } from "../../infrastructure/config/env.js";
import { actor, parseBody, pathParam } from "../lib/http.js";
import { csvRows, mapEmploymentCsvRow, readClosureDates, readImportRows } from "../lib/imports.js";
import { authorizeRoute } from "../middleware/auth.js";
import {
  csvContentInputSchema,
  employmentImportConfirmationSchema,
  employmentImportInputSchema,
  previewTokenInputSchema,
} from "../schemas/imports.js";
import type { RouteDependencies } from "./types.js";

function previewEmploymentCsv(req: Request, res: Response, includeData: boolean): void {
  const csv = parseBody(csvContentInputSchema, req).content;
  if (Buffer.byteLength(csv, "utf8") > env.MAX_UPLOAD_MB * 1024 * 1024)
    throw new ValidationError(`El archivo supera el límite de ${env.MAX_UPLOAD_MB} MB`);
  const parsed = csvRows(csv);
  if (parsed.rows.length > env.MAX_IMPORT_ROWS)
    throw new ValidationError(`El archivo supera el límite de ${env.MAX_IMPORT_ROWS} filas`);
  const rows = parsed.rows.map(mapEmploymentCsvRow);
  const validatedRows: EmploymentImportPreviewDto["validatedRows"] = rows.map((row, index) => {
    const result = validateEmploymentImportRow(row);
    return result.success
      ? { row: index + 2, valid: true, data: result.data, errors: [] }
      : { row: index + 2, valid: false, errors: [result.message] };
  });
  const validRows = validatedRows.flatMap((row) => (row.data ? [row.data] : []));
  const errors = validatedRows.flatMap((row) =>
    row.valid ? [] : [{ row: row.row, message: row.errors.join("; ") }],
  );
  const response: EmploymentImportPreviewDto & { data?: Record<string, unknown>[] } = {
    ...(includeData ? { data: rows } : {}),
    headers: parsed.headers,
    rows,
    validatedRows,
    totalRows: rows.length,
    validRows: validRows.length,
    invalidRows: errors.length,
    errors,
    payloadHash: employmentPayloadHash(validRows),
  };
  res.json(response);
}

function mappedEmploymentRows(rows: unknown[]) {
  return rows.map((rawRow) =>
    mapEmploymentCsvRow(
      (rawRow && typeof rawRow === "object" ? rawRow : {}) as Record<string, unknown>,
    ),
  );
}

function employmentPayloadHash(rows: unknown[]) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function sendEmploymentImportResult(
  res: Response,
  result: BulkEmploymentImportResult,
  includeData = false,
) {
  const body = {
    ...(includeData ? { data: result.batch } : {}),
    ...(result.replayed ? { replayed: true } : {}),
    batch: result.batch,
    created: result.created,
    updated: result.updated,
    invalidRows: result.invalidRows,
    errors: result.errors,
    metrics: result.metrics,
  };
  if (result.replayed) return res.status(200).json(body);
  return res.status(result.invalidRows ? 207 : 201).json(body);
}

export function importRoutes(dependencies: RouteDependencies): Router {
  const { store, service } = dependencies;
  const router = Router();

  router.post(
    "/api/v1/admin/vacation-period-closures/preview",
    authorizeRoute("POST", "/api/v1/admin/vacation-period-closures/preview"),
    async (req, res) => {
      const input = readImportRows(req);
      const dates = readClosureDates(req);
      res.json(
        await service.previewVacationPeriodClosure(
          input.fileName,
          input.fileHash,
          input.rows,
          actor(req),
          dates.fromDate,
          dates.asOf,
        ),
      );
    },
  );

  router.post(
    "/api/v1/admin/vacation-period-closures/:batchId/apply",
    authorizeRoute("POST", "/api/v1/admin/vacation-period-closures/:batchId/apply"),
    async (req, res) => {
      const input = readImportRows(req);
      const dates = readClosureDates(req);
      const parsed = parseBody(previewTokenInputSchema, req);
      res.json(
        await service.applyVacationPeriodClosure(
          pathParam(req, "batchId"),
          input.fileName,
          input.fileHash,
          parsed.previewToken,
          input.rows,
          actor(req),
          dates.fromDate,
          dates.asOf,
        ),
      );
    },
  );

  router.get(
    "/api/v1/admin/vacation-period-closures/:batchId",
    authorizeRoute("GET", "/api/v1/admin/vacation-period-closures/:batchId"),
    async (req, res) => {
      const batch = await store.findVacationPeriodClosureBatch(pathParam(req, "batchId"));
      if (!batch) {
        return res.status(404).json({ code: "NOT_FOUND", message: "Cierre masivo no encontrado" });
      }
      return res.json({ data: batch, ...batch });
    },
  );

  router.post(
    "/api/v1/import/preview",
    authorizeRoute("POST", "/api/v1/import/preview"),
    (req, res) => previewEmploymentCsv(req, res, false),
  );

  router.get(
    "/api/v1/worker-imports/template",
    authorizeRoute("GET", "/api/v1/worker-imports/template"),
    (_req, res) => {
      res
        .type("text/csv")
        .set("Content-Disposition", 'attachment; filename="plantilla-empleados.csv"')
        .send(
          "Cédula,Nombre,Fecha contrato,Fecha de retiro,Tipo de contrato,Proceso,Cargo,Supervisor\n",
        );
    },
  );

  router.post(
    "/api/v1/worker-imports/preview",
    authorizeRoute("POST", "/api/v1/worker-imports/preview"),
    (req, res) => previewEmploymentCsv(req, res, true),
  );

  router.post(
    "/api/v1/import/employments",
    authorizeRoute("POST", "/api/v1/import/employments"),
    async (req, res) => {
      const raw = parseBody(employmentImportInputSchema(env.MAX_IMPORT_ROWS), req);
      const payloadHash = employmentPayloadHash(raw.rows);
      const key = req.header("Idempotency-Key") ?? raw.idempotencyKey ?? payloadHash;
      const result = await service.importEmployments(
        key,
        mappedEmploymentRows(raw.rows),
        actor(req),
        payloadHash,
      );
      return sendEmploymentImportResult(res, result);
    },
  );

  router.get(
    "/api/v1/worker-imports/:batchId",
    authorizeRoute("GET", "/api/v1/worker-imports/:batchId"),
    async (req, res) => {
      const reference = pathParam(req, "batchId");
      const batch =
        (await store.findImportBatchByIdempotencyKey(reference)) ??
        (await store.findImportBatchById(reference));
      if (!batch) {
        return res.status(404).json({ code: "NOT_FOUND", message: "Import batch not found" });
      }
      return res.json({ data: batch, ...batch });
    },
  );

  router.post(
    "/api/v1/worker-imports/:batchId/confirm",
    authorizeRoute("POST", "/api/v1/worker-imports/:batchId/confirm"),
    async (req, res) => {
      const raw = parseBody(employmentImportConfirmationSchema(env.MAX_IMPORT_ROWS), req);
      const batchId = pathParam(req, "batchId");
      const result = await service.confirmEmploymentImport(
        batchId,
        mappedEmploymentRows(raw.rows),
        actor(req),
        employmentPayloadHash(raw.rows),
      );
      return sendEmploymentImportResult(res, result, true);
    },
  );

  router.post(
    "/api/v1/worker-imports/:batchId/retry",
    authorizeRoute("POST", "/api/v1/worker-imports/:batchId/retry"),
    async (req, res) => {
      const raw = parseBody(employmentImportConfirmationSchema(env.MAX_IMPORT_ROWS), req);
      const result = await service.retryEmploymentImport(
        pathParam(req, "batchId"),
        mappedEmploymentRows(raw.rows),
        actor(req),
        employmentPayloadHash(raw.rows),
      );
      return sendEmploymentImportResult(res, result, true);
    },
  );

  return router;
}
