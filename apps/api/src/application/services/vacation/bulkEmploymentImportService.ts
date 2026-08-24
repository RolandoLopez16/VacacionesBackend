import { createHash } from "node:crypto";
import { ConflictError, DomainError, NotFoundError } from "../../../domain/shared/errors.js";
import { addDays, parseLocalDate } from "../../../domain/shared/localDate.js";
import {
  assertEmploymentDateRange,
  normalizeDocumentNumber,
} from "../../../domain/shared/valueObjects.js";
import { closePeriodsAtRetirement, ensurePeriods } from "../../../domain/vacations/calculations.js";
import type { ImportBatch, VacationPeriod } from "../../../domain/vacations/models.js";
import type { Employment, Worker } from "../../../domain/workers/models.js";
import type { VacationServiceContext } from "./context.js";
import type { EmploymentInput } from "./types.js";

const BULK_CHUNK_SIZE = 500;

type ImportError = { row: number; message: string };
type ImportMode = "IMPORT" | "CONFIRM" | "RETRY";
type AuditEvent = Parameters<VacationServiceContext["store"]["append"]>[0];

interface ValidatedRow {
  row: number;
  normalizedDocumentNumber: string;
  input: EmploymentInput;
}

interface ImportPlan {
  batch: ImportBatch;
  workers: Worker[];
  employments: Employment[];
  periods: VacationPeriod[];
  audits: AuditEvent[];
}

export interface BulkEmploymentImportMetrics {
  durationMs: number;
  processedRows: number;
  databaseOperations: number;
  chunks: number;
}

export interface BulkEmploymentImportResult {
  replayed: boolean;
  batch: ImportBatch;
  created: number;
  updated: number;
  invalidRows: number;
  errors: ImportError[];
  metrics: BulkEmploymentImportMetrics;
}

function requiredString(
  source: Record<string, unknown>,
  field: string,
  label: string,
  minimum: number,
  errors: string[],
): string {
  const value = source[field];
  if (typeof value !== "string" || value.trim().length < minimum) {
    errors.push(`${label} debe tener al menos ${minimum} caracteres`);
    return "";
  }
  return value.trim();
}

export function validateEmploymentImportRow(
  raw: unknown,
):
  | { success: true; data: EmploymentInput; normalizedDocumentNumber: string }
  | { success: false; message: string } {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const errors: string[] = [];
  const documentNumber = requiredString(source, "documentNumber", "Cédula", 3, errors);
  const fullName = requiredString(source, "fullName", "Nombre", 2, errors);
  const contractTypeName = requiredString(
    source,
    "contractTypeName",
    "Tipo de contrato",
    2,
    errors,
  );
  const processName = requiredString(source, "processName", "Proceso", 2, errors);
  const positionName = requiredString(source, "positionName", "Cargo", 2, errors);
  let startDate: EmploymentInput["startDate"] | undefined;
  let endDate: EmploymentInput["endDate"];
  try {
    if (typeof source.startDate !== "string") throw new Error("Fecha de contrato inválida");
    startDate = parseLocalDate(source.startDate.trim());
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Fecha de contrato inválida");
  }
  if (source.endDate !== undefined && source.endDate !== "") {
    try {
      if (typeof source.endDate !== "string") throw new Error("Fecha de retiro inválida");
      endDate = parseLocalDate(source.endDate.trim());
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Fecha de retiro inválida");
    }
  }
  let normalizedDocumentNumber = "";
  if (documentNumber) {
    try {
      normalizedDocumentNumber = normalizeDocumentNumber(documentNumber);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Cédula inválida");
    }
  }
  if (startDate) {
    try {
      assertEmploymentDateRange(startDate, endDate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Rango de fechas inválido");
    }
  }
  if (errors.length || !startDate || !normalizedDocumentNumber)
    return { success: false, message: errors.join("; ") };
  const supervisorName =
    typeof source.supervisorName === "string" && source.supervisorName.trim()
      ? source.supervisorName.trim()
      : undefined;
  return {
    success: true,
    normalizedDocumentNumber,
    data: {
      documentNumber,
      fullName,
      startDate,
      ...(endDate ? { endDate } : {}),
      contractTypeName,
      processName,
      positionName,
      ...(supervisorName ? { supervisorName } : {}),
    },
  };
}

function chunkCount(length: number): number {
  return length ? Math.ceil(length / BULK_CHUNK_SIZE) : 0;
}

function employmentKey(workerId: string, startDate: string): string {
  return `${workerId}\u0000${startDate}`;
}

function metricsFrom(batch: ImportBatch): BulkEmploymentImportMetrics {
  return {
    durationMs: batch.durationMs ?? 0,
    processedRows: batch.processedRows ?? batch.totalRows,
    databaseOperations: batch.databaseOperations ?? 0,
    chunks: batch.chunks ?? 0,
  };
}

function resultFrom(batch: ImportBatch, replayed: boolean): BulkEmploymentImportResult {
  return {
    replayed,
    batch,
    created: batch.createdRows,
    updated: batch.updatedRows,
    invalidRows: batch.invalidRows,
    errors: batch.errorSummary,
    metrics: metricsFrom(batch),
  };
}

function slug(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
}

export class BulkEmploymentImportService {
  constructor(private readonly context: VacationServiceContext) {}

  import(idempotencyKey: string, rows: unknown[], actorId = "system", payloadHash?: string) {
    return this.execute("IMPORT", idempotencyKey, rows, actorId, payloadHash);
  }

  confirm(batchReference: string, rows: unknown[], actorId = "system", payloadHash?: string) {
    return this.execute("CONFIRM", batchReference, rows, actorId, payloadHash);
  }

  retry(batchReference: string, rows: unknown[], actorId = "system", payloadHash?: string) {
    return this.execute("RETRY", batchReference, rows, actorId, payloadHash);
  }

  private async findBatch(reference: string) {
    return (
      (await this.context.store.findImportBatchByIdempotencyKey(reference)) ??
      (await this.context.store.findImportBatchById(reference))
    );
  }

  private async execute(
    mode: ImportMode,
    reference: string,
    rows: unknown[],
    actorId: string,
    suppliedPayloadHash?: string,
  ): Promise<BulkEmploymentImportResult> {
    const startedAtMs = Date.now();
    const payloadHash =
      suppliedPayloadHash ?? createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    const existing =
      mode === "IMPORT"
        ? await this.context.store.findImportBatchByIdempotencyKey(reference)
        : await this.findBatch(reference);
    if (existing?.payloadHash && existing.payloadHash !== payloadHash)
      throw new ConflictError("The idempotency key belongs to different import rows");
    if (existing?.status === "COMPLETED" || existing?.status === "COMPLETED_WITH_ERRORS")
      return resultFrom(existing, true);
    if (mode === "IMPORT" && existing) return resultFrom(existing, true);
    if (mode === "RETRY" && !existing) throw new NotFoundError("Import batch not found");
    if (mode === "RETRY" && existing?.status !== "FAILED")
      throw new ConflictError("Only a failed import batch can be retried");
    if (mode === "CONFIRM" && existing && !["PROCESSING", "FAILED"].includes(existing.status))
      throw new ConflictError("The import batch cannot be confirmed in its current status");

    const now = new Date().toISOString();
    const idempotencyKey = existing?.idempotencyKey ?? reference;
    const attempt = (existing?.attempt ?? 0) + 1;
    const processing: ImportBatch = {
      id: existing?.id ?? crypto.randomUUID(),
      idempotencyKey,
      payloadHash,
      entityType: "EMPLOYMENT",
      status: "PROCESSING",
      attempt,
      totalRows: rows.length,
      createdRows: 0,
      updatedRows: 0,
      invalidRows: 0,
      duplicateRows: 0,
      processedRows: rows.length,
      databaseOperations: 0,
      chunks: 0,
      errorSummary: [],
      createdAt: existing?.createdAt ?? now,
    };
    const claimed = await this.context.store.claimImportBatch(
      processing,
      existing ? { status: existing.status, attempt: existing.attempt ?? 0 } : undefined,
    );
    if (!claimed) {
      const latest = await this.findBatch(idempotencyKey);
      if (
        latest &&
        (!latest.payloadHash || latest.payloadHash === payloadHash) &&
        (latest.status === "COMPLETED" || latest.status === "COMPLETED_WITH_ERRORS")
      )
        return resultFrom(latest, true);
      throw new ConflictError("The import batch is already being processed");
    }

    let plannedBatch = processing;
    try {
      const plan = await this.plan(processing, rows, actorId, now);
      plannedBatch = plan.batch;
      const completed = await this.context.store.applyEmploymentImport(
        plan.batch,
        plan.workers,
        plan.employments,
        plan.periods,
        plan.audits,
        startedAtMs,
      );
      console.info(
        JSON.stringify({
          event: "employment_import_completed",
          batchId: completed.id,
          status: completed.status,
          durationMs: completed.durationMs,
          processedRows: completed.processedRows,
          databaseOperations: completed.databaseOperations,
          chunks: completed.chunks,
        }),
      );
      return resultFrom(completed, false);
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      const failedAt = new Date().toISOString();
      const failure: ImportError = {
        row: 0,
        message: "No fue posible confirmar la persistencia transaccional del lote",
      };
      const failed: ImportBatch = {
        ...plannedBatch,
        status: "FAILED",
        durationMs: Math.max(0, Date.now() - startedAtMs),
        errorSummary: [...plannedBatch.errorSummary, failure],
        completedAt: failedAt,
        failedAt,
      };
      const marked = await this.context.store.markImportBatchFailed(failed, attempt);
      console.error(
        JSON.stringify({
          event: "employment_import_failed",
          batchId: failed.id,
          status: marked ? "FAILED" : "SUPERSEDED",
          durationMs: failed.durationMs,
          processedRows: failed.processedRows,
          databaseOperations: failed.databaseOperations,
          chunks: failed.chunks,
        }),
      );
      if (!marked) throw new ConflictError("The import batch attempt was superseded");
      throw new DomainError(
        "No fue posible completar la importación; el lote quedó en estado FAILED",
        500,
        "INTERNAL_ERROR",
        { batchId: failed.id },
      );
    }
  }

  private async plan(
    processing: ImportBatch,
    rows: unknown[],
    actorId: string,
    now: string,
  ): Promise<ImportPlan> {
    const validRows: ValidatedRow[] = [];
    const errors: ImportError[] = [];
    rows.forEach((raw, index) => {
      const validated = validateEmploymentImportRow(raw);
      if (!validated.success) {
        errors.push({ row: index + 1, message: validated.message });
        return;
      }
      validRows.push({
        row: index + 1,
        normalizedDocumentNumber: validated.normalizedDocumentNumber,
        input: validated.data,
      });
    });

    const normalizedDocuments = [...new Set(validRows.map((row) => row.normalizedDocumentNumber))];
    const existingWorkers =
      await this.context.store.findWorkersByNormalizedDocuments(normalizedDocuments);
    const existingWorkersByDocument = new Map(
      existingWorkers.map((worker) => [worker.normalizedDocumentNumber, worker]),
    );
    const rowsByDocument = new Map<string, ValidatedRow[]>();
    for (const row of validRows) {
      const documentRows = rowsByDocument.get(row.normalizedDocumentNumber) ?? [];
      documentRows.push(row);
      rowsByDocument.set(row.normalizedDocumentNumber, documentRows);
    }

    const workersByDocument = new Map<string, Worker>();
    const workers: Worker[] = [];
    for (const [normalizedDocumentNumber, documentRows] of rowsByDocument) {
      const existingWorker = existingWorkersByDocument.get(normalizedDocumentNumber);
      const last = documentRows[documentRows.length - 1]!;
      const changed =
        !existingWorker ||
        documentRows.some(
          (row) =>
            row.input.documentNumber !== existingWorker.documentNumber ||
            row.input.fullName !== existingWorker.fullName,
        );
      const worker: Worker = existingWorker
        ? {
            ...existingWorker,
            documentNumber: last.input.documentNumber,
            fullName: last.input.fullName,
            ...(changed ? { updatedAt: now } : {}),
          }
        : {
            id: crypto.randomUUID(),
            documentNumber: last.input.documentNumber,
            normalizedDocumentNumber,
            fullName: last.input.fullName,
            workerType: "EMPLOYEE",
            createdAt: now,
            updatedAt: now,
          };
      workersByDocument.set(normalizedDocumentNumber, worker);
      if (changed) workers.push(worker);
    }

    const existingEmployments = await this.context.store.findEmploymentsByWorkerIds(
      [...workersByDocument.values()].map((worker) => worker.id),
    );
    const existingEmploymentsByKey = new Map(
      existingEmployments.map((employment) => [
        employmentKey(employment.workerId, employment.startDate),
        employment,
      ]),
    );
    const groupedRows = new Map<string, { worker: Worker; rows: ValidatedRow[] }>();
    for (const row of validRows) {
      const worker = workersByDocument.get(row.normalizedDocumentNumber)!;
      const key = employmentKey(worker.id, row.input.startDate);
      const group = groupedRows.get(key) ?? { worker, rows: [] };
      group.rows.push(row);
      groupedRows.set(key, group);
    }

    const employments: Employment[] = [];
    const employmentAudits: AuditEvent[] = [];
    let createdRows = 0;
    let updatedRows = 0;
    for (const [key, group] of groupedRows) {
      const last = group.rows[group.rows.length - 1]!;
      const existingEmployment = existingEmploymentsByKey.get(key);
      if (existingEmployment) updatedRows += group.rows.length;
      else {
        createdRows++;
        updatedRows += group.rows.length - 1;
      }
      const status = last.input.endDate ? "RETIRED" : "ACTIVE";
      const employment: Employment = existingEmployment
        ? {
            ...existingEmployment,
            startDate: last.input.startDate,
            ...(last.input.endDate ? { endDate: last.input.endDate } : { endDate: undefined }),
            contractTypeId: slug(last.input.contractTypeName),
            contractTypeName: last.input.contractTypeName,
            processId: slug(last.input.processName),
            processName: last.input.processName,
            positionId: slug(last.input.positionName),
            positionName: last.input.positionName,
            ...(last.input.supervisorName
              ? { supervisorName: last.input.supervisorName }
              : { supervisorName: undefined }),
            status,
            version: existingEmployment.version + group.rows.length,
            updatedAt: now,
          }
        : {
            id: crypto.randomUUID(),
            workerId: group.worker.id,
            startDate: last.input.startDate,
            ...(last.input.endDate ? { endDate: last.input.endDate } : {}),
            contractTypeId: slug(last.input.contractTypeName),
            contractTypeName: last.input.contractTypeName,
            processId: slug(last.input.processName),
            processName: last.input.processName,
            positionId: slug(last.input.positionName),
            positionName: last.input.positionName,
            ...(last.input.supervisorName ? { supervisorName: last.input.supervisorName } : {}),
            status,
            version: group.rows.length,
            createdAt: now,
            updatedAt: now,
          };
      employments.push(employment);
      employmentAudits.push({
        id: crypto.randomUUID(),
        actorId,
        action: existingEmployment ? "EMPLOYMENT_UPDATED" : "EMPLOYMENT_CREATED",
        entityType: "Employment",
        entityId: employment.id,
        metadata: {
          documentNumber: last.input.documentNumber,
          startDate: employment.startDate,
          sourceRows: group.rows.map((row) => row.row),
        },
        createdAt: now,
      });
    }

    const plannedKeys = new Set(
      employments.map((employment) => employmentKey(employment.workerId, employment.startDate)),
    );
    const contractsByWorker = new Map<string, Employment[]>();
    const ensureList = (workerId: string) => {
      let list = contractsByWorker.get(workerId);
      if (!list) {
        list = [];
        contractsByWorker.set(workerId, list);
      }
      return list;
    };
    for (const employment of existingEmployments) ensureList(employment.workerId).push(employment);
    for (const employment of employments) {
      const list = ensureList(employment.workerId);
      const index = list.findIndex((item) => item.startDate === employment.startDate);
      if (index >= 0) list[index] = employment;
      else list.push(employment);
    }
    const retiredByImport: Employment[] = [];
    for (const list of contractsByWorker.values()) {
      list.sort((left, right) => left.startDate.localeCompare(right.startDate));
      const newest = list[list.length - 1]!;
      const activeId = newest.endDate ? undefined : newest.id;
      for (const employment of list) {
        if (employment.status === "RETIRED" || employment.id === activeId) continue;
        const nextStart = list
          .filter((item) => item.id !== employment.id && item.startDate > employment.startDate)
          .map((item) => item.startDate)
          .sort()[0];
        if (!nextStart) continue;
        retiredByImport.push({
          ...employment,
          status: "RETIRED",
          endDate: employment.endDate ?? addDays(nextStart, -1),
          version: employment.version + 1,
          updatedAt: now,
        });
      }
    }
    const retirementById = new Map(
      retiredByImport.map((employment) => [employment.id, employment]),
    );
    const finalEmployments = [
      ...employments.map((employment) => retirementById.get(employment.id) ?? employment),
      ...retiredByImport.filter(
        (employment) => !plannedKeys.has(employmentKey(employment.workerId, employment.startDate)),
      ),
    ];
    for (const employment of retiredByImport) {
      const worker = [...workersByDocument.values()].find(
        (item) => item.id === employment.workerId,
      );
      employmentAudits.push({
        id: crypto.randomUUID(),
        actorId,
        action: "EMPLOYMENT_RETIRED_BY_IMPORT",
        entityType: "Employment",
        entityId: employment.id,
        metadata: {
          documentNumber: worker?.documentNumber ?? "",
          startDate: employment.startDate,
          endDate: employment.endDate,
          reason: "Contrato anterior cerrado al registrar un contrato más reciente",
        },
        createdAt: now,
      });
    }

    const employmentIds = finalEmployments.map((employment) => employment.id);
    const asOf = this.context.clock();
    const [policy, existingPeriods, settlements, schedules] = await Promise.all([
      this.context.store.current(asOf),
      this.context.store.findByEmploymentIds(employmentIds),
      this.context.store.findSettlementsByEmploymentIds(employmentIds),
      this.context.store.findSchedulesByEmploymentIds(employmentIds),
    ]);
    const periodsByEmployment = new Map<string, VacationPeriod[]>(
      employmentIds.map((id) => [id, []]),
    );
    for (const period of existingPeriods)
      (periodsByEmployment.get(period.employmentId) ?? []).push(period);
    const periods: VacationPeriod[] = [];
    const periodAudits: AuditEvent[] = [];
    for (const employment of finalEmployments) {
      const before = periodsByEmployment.get(employment.id) ?? [];
      const beforeById = new Map(before.map((period) => [period.id, period]));
      const planned = closePeriodsAtRetirement(
        employment,
        ensurePeriods(employment, before, policy, asOf),
        now,
      );
      periods.push(...planned);
      for (const period of planned) {
        if (
          period.lifecycleStatus !== "CLOSED" ||
          beforeById.get(period.id)?.lifecycleStatus === "CLOSED"
        )
          continue;
        periodAudits.push({
          id: crypto.randomUUID(),
          actorId: "system-retirement-closure",
          action: "VACATION_PERIOD_CLOSED_ON_RETIREMENT",
          entityType: "VacationPeriod",
          entityId: period.id,
          metadata: {
            employmentId: employment.id,
            endDate: employment.endDate,
            observation: period.closureObservation,
          },
          createdAt: now,
        });
      }
    }

    const duplicateRows = validRows.length - groupedRows.size;
    const auditCount = employmentAudits.length + periodAudits.length + 1;
    const databaseOperations =
      workers.length + finalEmployments.length + periods.length + auditCount + 1;
    const chunks =
      chunkCount(workers.length) +
      chunkCount(finalEmployments.length) +
      chunkCount(periods.length) +
      chunkCount(auditCount) +
      1;
    const status = errors.length ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
    const completedAt = new Date().toISOString();
    const batch: ImportBatch = {
      ...processing,
      status,
      createdRows,
      updatedRows,
      invalidRows: errors.length,
      duplicateRows,
      processedRows: rows.length,
      databaseOperations,
      chunks,
      errorSummary: errors,
      completedAt,
    };
    const batchAudit: AuditEvent = {
      id: crypto.randomUUID(),
      actorId,
      action: "EMPLOYMENT_IMPORT_COMPLETED",
      entityType: "ImportBatch",
      entityId: batch.id,
      metadata: {
        status,
        totalRows: rows.length,
        createdRows,
        updatedRows,
        invalidRows: errors.length,
        duplicateRows,
        relatedSettlements: settlements.length,
        relatedSchedules: schedules.length,
        databaseOperations,
        chunks,
      },
      createdAt: completedAt,
    };
    return {
      batch,
      workers,
      employments: finalEmployments,
      periods,
      audits: [...employmentAudits, ...periodAudits, batchAudit],
    };
  }
}
