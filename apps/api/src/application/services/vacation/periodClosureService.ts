import { BusinessRuleError, ConflictError, NotFoundError } from "../../../domain/shared/errors.js";
import type { LocalDate } from "../../../domain/shared/localDate.js";
import type { Employment } from "../../../domain/workers/models.js";
import { pendingDays } from "../../../domain/vacations/calculations.js";
import type {
  VacationPeriod,
  VacationPeriodClosureBatch,
  VacationPeriodClosurePlan,
  VacationSettlement,
} from "../../../domain/vacations/models.js";
import {
  groupSettlementLines,
  normalizeSettlementRows,
  type SettlementRawRow,
} from "../settlementImport.js";
import { readClosureFromDate } from "./closurePolicy.js";
import type { VacationServiceContext } from "./context.js";

export class PeriodClosureService {
  constructor(private readonly context: VacationServiceContext) {}

  private async buildVacationPeriodClosurePlan(
    rows: SettlementRawRow[],
    fromDate: LocalDate,
    asOf: LocalDate,
  ) {
    if (fromDate > asOf)
      throw new BusinessRuleError("La fecha inicial no puede ser posterior a la fecha de corte");
    const normalized = normalizeSettlementRows(rows);
    const groups = groupSettlementLines(normalized.lines);
    const employments = await this.context.store.listEmployments();
    const workers = await this.context.store.listWorkers();
    const workersByDocument = new Map(
      workers.map((worker) => [worker.normalizedDocumentNumber, worker]),
    );
    const employmentsByWorker = new Map<string, Employment[]>();
    for (const employment of employments)
      (
        employmentsByWorker.get(employment.workerId) ??
        employmentsByWorker.set(employment.workerId, []).get(employment.workerId)!
      ).push(employment);
    const periods = await this.context.store.findByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const settlements = await this.context.store.findSettlementsByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const schedules = await this.context.store.findSchedulesByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const periodsByEmployment = new Map<string, VacationPeriod[]>();
    for (const period of periods)
      (
        periodsByEmployment.get(period.employmentId) ??
        periodsByEmployment.set(period.employmentId, []).get(period.employmentId)!
      ).push(period);
    const settlementsByEmployment = new Map<string, VacationSettlement[]>();
    const settlementsByPeriod = new Map<string, VacationSettlement[]>();
    for (const settlement of settlements) {
      (
        settlementsByEmployment.get(settlement.employmentId) ??
        settlementsByEmployment.set(settlement.employmentId, []).get(settlement.employmentId)!
      ).push(settlement);
      for (const allocation of settlement.allocations)
        (
          settlementsByPeriod.get(allocation.periodId) ??
          settlementsByPeriod.set(allocation.periodId, []).get(allocation.periodId)!
        ).push(settlement);
    }
    const scheduledPeriodIds = new Set<string>();
    for (const schedule of schedules)
      if (schedule.status === "SCHEDULED")
        for (const allocation of schedule.allocations)
          if (allocation.periodId) scheduledPeriodIds.add(allocation.periodId);

    const protectedEmploymentIds = new Set<string>();
    const protectedPeriodIds = new Set<string>();
    const protectionReasons = new Map<string, string>();
    const matchingErrors: { row?: number; message: string }[] = [];
    const yearEnd = `${fromDate.slice(0, 4)}-12-31` as LocalDate;
    for (const line of normalized.lines) {
      const worker = workersByDocument.get(line.normalizedDocument);
      if (!worker) {
        matchingErrors.push({
          row: line.lineNumber,
          message: `No existe un empleado con la cédula ${line.employee}`,
        });
        continue;
      }
      const matches = (employmentsByWorker.get(worker.id) ?? []).filter(
        (employment) =>
          employment.startDate <= line.periodFinishDate &&
          (!employment.endDate || employment.endDate >= line.periodStartDate),
      );
      const exact = matches.filter((employment) => employment.startDate === line.startDate);
      const employment =
        exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
      if (!employment) {
        matchingErrors.push({
          row: line.lineNumber,
          message: matches.length
            ? `Hay varios contratos compatibles para ${line.employee}`
            : `No existe un contrato compatible para ${line.employee}`,
        });
        continue;
      }
      const affected = (periodsByEmployment.get(employment.id) ?? []).filter(
        (period) =>
          period.accrualStartDate <= line.periodFinishDate &&
          period.accrualEndDate >= line.periodStartDate,
      );
      if (!affected.length) {
        matchingErrors.push({
          row: line.lineNumber,
          message: `La línea ${line.lineNumber} no coincide con ningún período de ${line.employee}`,
        });
        continue;
      }
      const isHistoricalEnjoyment =
        line.enjoymentStartDate <= yearEnd &&
        line.enjoymentEndDate >= fromDate &&
        line.periodStartDate < fromDate;
      if (isHistoricalEnjoyment) {
        protectedEmploymentIds.add(employment.id);
        protectionReasons.set(
          employment.id,
          "Disfrute registrado en el año de inicio sobre un período iniciado antes de la fecha de corte",
        );
      }
      for (const period of affected) protectedPeriodIds.add(period.id);
    }

    const employmentById = new Map(employments.map((employment) => [employment.id, employment]));
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const plans: VacationPeriodClosurePlan[] = periods
      .map((period) => {
        const employment = employmentById.get(period.employmentId);
        const worker = employment ? workerById.get(employment.workerId) : undefined;
        const relatedSettlements = settlementsByPeriod.get(period.id) ?? [];
        const pending = pendingDays(period, relatedSettlements);
        const hasScheduled = scheduledPeriodIds.has(period.id);
        let decision: VacationPeriodClosurePlan["decision"] = "REVIEW";
        let reason = "No fue posible identificar el contrato del período";
        const oldProtected =
          period.causedAt < fromDate &&
          (protectedPeriodIds.has(period.id) ||
            (employment ? protectedEmploymentIds.has(employment.id) : false));
        if (!employment || !worker) {
          decision = "REVIEW";
        } else if (period.lifecycleStatus === "CLOSED") {
          decision = "ALREADY_CLOSED";
          reason = "El período ya estaba cerrado y no se modifica";
        } else if (period.causedAt > asOf) {
          decision = "FUTURE";
          reason = "El período todavía no está causado a la fecha de corte";
        } else if (period.causedAt >= fromDate) {
          decision = "KEEP";
          reason = "Período causado dentro del rango autorizado";
        } else if (pending <= 0) {
          decision = "CLOSE";
          reason = "Sin saldo pendiente; cierre por migración";
        } else if (oldProtected) {
          decision = "PROTECTED";
          reason =
            protectionReasons.get(employment.id) ??
            "Período histórico relacionado con una liquidación del archivo de disfrutes";
        } else if (period.pendingImportProtected) {
          decision = "PROTECTED";
          reason = "Período protegido por la carga de períodos pendientes";
        } else if (period.accrualStartDate <= "2015-12-31") {
          decision = "PROTECTED";
          reason = "Período de 2015 o anterior con saldo pendiente de disfrute";
        } else if (hasScheduled) {
          decision = "REVIEW";
          reason = "Tiene un cronograma activo y requiere revisión";
        } else if (relatedSettlements.length) {
          decision = "REVIEW";
          reason = "Tiene una liquidación activa y saldo pendiente";
        } else {
          decision = "CLOSE";
          reason = "Período causado antes del rango y con saldo pendiente";
        }
        return {
          periodId: period.id,
          employmentId: period.employmentId,
          documentNumber: worker?.documentNumber ?? "—",
          employeeName: worker?.fullName ?? "Contrato no identificado",
          periodStartDate: period.accrualStartDate,
          periodEndDate: period.accrualEndDate,
          causedAt: period.causedAt,
          lifecycleStatus: period.lifecycleStatus,
          periodVersion: period.version,
          pendingDays: pending,
          decision,
          reason,
          settlementIds: relatedSettlements.map((settlement) => settlement.id),
          accountingDocuments: relatedSettlements.map(
            (settlement) => settlement.accountingDocument,
          ),
        };
      })
      .sort(
        (left, right) =>
          left.employeeName.localeCompare(right.employeeName, "es") ||
          left.periodStartDate.localeCompare(right.periodStartDate),
      );
    return {
      plans,
      warnings: groups.flatMap((group) => group.warnings),
      errors: [...normalized.errors, ...matchingErrors],
    };
  }

  async previewVacationPeriodClosure(
    fileName: string,
    fileHash: string,
    rows: SettlementRawRow[],
    actor = "system",
    fromDate: LocalDate | undefined = undefined,
    asOf: LocalDate = this.context.clock(),
  ) {
    const cutoff = fromDate ?? (await readClosureFromDate(this.context.store));
    if (cutoff > asOf)
      throw new BusinessRuleError("La fecha inicial no puede ser posterior a la fecha de corte");
    const existing = await this.context.store.findVacationPeriodClosureByFileHash(fileHash);
    if (existing?.status === "APPLIED")
      return {
        alreadyProcessed: existing.status === "APPLIED",
        batch: existing,
        plans: existing.plans,
      };
    const built = await this.buildVacationPeriodClosurePlan(rows, cutoff, asOf);
    const counts = (decision: VacationPeriodClosurePlan["decision"]) =>
      built.plans.filter((plan) => plan.decision === decision).length;
    const batch: VacationPeriodClosureBatch = {
      id: existing?.id ?? crypto.randomUUID(),
      fileName,
      fileHash,
      actorId: actor,
      fromDate: cutoff,
      asOf,
      observation: "Liquidación en sistema contable",
      status: "PREVIEW",
      totalPeriods: built.plans.length,
      closedPeriods: counts("CLOSE"),
      keptPeriods: counts("KEEP"),
      protectedPeriods: counts("PROTECTED"),
      futurePeriods: counts("FUTURE"),
      reviewPeriods: counts("REVIEW"),
      alreadyClosedPeriods: counts("ALREADY_CLOSED"),
      warnings: built.warnings,
      errors: built.errors,
      plans: built.plans,
      previewToken: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.context.store.saveVacationPeriodClosureBatch(batch);
    return { alreadyProcessed: false, batch, plans: batch.plans };
  }

  async applyVacationPeriodClosure(
    batchId: string,
    fileName: string,
    fileHash: string,
    previewToken: string,
    rows: SettlementRawRow[],
    actor = "system",
    fromDate: LocalDate | undefined = undefined,
    asOf: LocalDate = this.context.clock(),
  ) {
    const cutoff = fromDate ?? (await readClosureFromDate(this.context.store));
    const batch = await this.context.store.findVacationPeriodClosureBatch(batchId);
    if (!batch) throw new NotFoundError("No existe la vista previa del cierre masivo");
    if (
      batch.fileName !== fileName ||
      batch.fileHash !== fileHash ||
      batch.previewToken !== previewToken ||
      batch.fromDate !== cutoff ||
      batch.asOf !== asOf
    )
      throw new ConflictError("La vista previa está vencida o no coincide con el archivo");
    if (batch.errors.length)
      throw new ConflictError(
        "El cierre masivo tiene errores; genera una nueva vista previa antes de aplicar",
      );
    const current = await this.buildVacationPeriodClosurePlan(rows, cutoff, asOf);
    if (current.errors.length)
      throw new ConflictError(
        "Los datos cambiaron desde la vista previa; genera una nueva vista previa",
      );
    const currentById = new Map(current.plans.map((plan) => [plan.periodId, plan]));
    const storedPeriods = await this.context.store.findByEmploymentIds([
      ...new Set(batch.plans.map((plan) => plan.employmentId)),
    ]);
    const periodsById = new Map(storedPeriods.map((period) => [period.id, period]));
    const toClose: VacationPeriod[] = [];
    for (const plan of batch.plans.filter((item) => item.decision === "CLOSE")) {
      const period = periodsById.get(plan.periodId);
      const fresh = currentById.get(plan.periodId);
      if (!period || !fresh || period.version !== plan.periodVersion || fresh.decision !== "CLOSE")
        throw new ConflictError(
          "Los períodos cambiaron desde la vista previa; genera una nueva vista previa",
        );
      toClose.push({
        ...period,
        lifecycleStatus: "CLOSED",
        closureType: "MASS_MIGRATION",
        closureObservation: batch.observation,
        closedAt: new Date().toISOString(),
        closedBy: actor,
        version: period.version + 1,
        updatedAt: new Date().toISOString(),
      });
    }
    const appliedAt = new Date().toISOString();
    const appliedBatch: VacationPeriodClosureBatch = {
      ...batch,
      actorId: actor,
      status: "APPLIED",
      authorizedAt: batch.authorizedAt ?? appliedAt,
      appliedAt,
      closedPeriods: toClose.length,
      reviewPeriods: current.plans.filter((plan) => plan.decision === "REVIEW").length,
    };
    const audits = [
      ...toClose.map((period) => ({
        id: crypto.randomUUID(),
        actorId: actor,
        action: "VACATION_PERIOD_CLOSED_MASSIVELY",
        entityType: "VacationPeriod",
        entityId: period.id,
        metadata: {
          batchId,
          employmentId: period.employmentId,
          observation: batch.observation,
          fromDate: cutoff,
          asOf,
        },
        createdAt: appliedAt,
      })),
      {
        id: crypto.randomUUID(),
        actorId: actor,
        action: "VACATION_PERIOD_CLOSURE_BATCH_APPLIED",
        entityType: "VacationPeriodClosureBatch",
        entityId: batch.id,
        metadata: {
          totalPeriods: batch.totalPeriods,
          closedPeriods: toClose.length,
          protectedPeriods: batch.protectedPeriods,
          reviewPeriods: appliedBatch.reviewPeriods,
          observation: batch.observation,
        },
        createdAt: appliedAt,
      },
    ];
    await this.context.store.applyVacationPeriodClosure(appliedBatch, toClose, audits);
    return {
      replayed: false,
      batch: appliedBatch,
      closedPeriods: toClose.length,
      pendingReviewPeriods: appliedBatch.reviewPeriods,
    };
  }
}
