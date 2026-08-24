import { ConflictError, NotFoundError } from "../../../domain/shared/errors.js";
import type { LocalDate } from "../../../domain/shared/localDate.js";
import type { Employment } from "../../../domain/workers/models.js";
import { ensurePeriods } from "../../../domain/vacations/calculations.js";
import type {
  VacationPendingPeriodImportBatch,
  VacationPendingPeriodPlan,
  VacationPeriod,
  VacationSettlement,
} from "../../../domain/vacations/models.js";
import { normalizePendingPeriodRows, type PendingPeriodRawRow } from "../pendingPeriodImport.js";
import type { VacationServiceContext } from "./context.js";

export class PendingPeriodImportService {
  constructor(private readonly context: VacationServiceContext) {}

  private async buildPendingPeriodImportPlan(
    rows: PendingPeriodRawRow[],
    batchId: string,
    asOf: LocalDate,
  ) {
    const policy = await this.context.store.current(asOf);
    if (policy.daysPerCompletedYear !== 15)
      throw new ConflictError(
        "La carga de períodos pendientes exige una política de 15 días por período",
      );
    const normalized = normalizePendingPeriodRows(rows);
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
    const settlementsByPeriod = new Map<string, VacationSettlement[]>();
    for (const settlement of settlements) {
      if (settlement.status !== "ACTIVE") continue;
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

    const plans: VacationPendingPeriodPlan[] = [];
    const periodsToPersist = new Map<string, VacationPeriod>();
    const errors: { row?: number; message: string }[] = [...normalized.errors];
    const warnings: string[] = [...normalized.warnings];
    const processedEmploymentIds = new Set<string>();
    const matchedEmploymentIds = new Set<string>();
    const missingEmployeeDocuments = new Set<string>();
    const now = new Date().toISOString();

    const protect = (period: VacationPeriod) =>
      period.pendingImportProtected && period.pendingImportBatchId === batchId
        ? period
        : {
            ...period,
            pendingImportProtected: true,
            pendingImportBatchId: batchId,
            version: period.version + 1,
            updatedAt: now,
          };

    for (const line of normalized.lines) {
      const worker = workersByDocument.get(line.normalizedDocument);
      if (!worker) {
        missingEmployeeDocuments.add(line.normalizedDocument);
        errors.push({
          row: line.lineNumber,
          message: `No existe un empleado con la cédula ${line.employee}`,
        });
        continue;
      }
      const workerEmployments = employmentsByWorker.get(worker.id) ?? [];
      const openEmployments = workerEmployments.filter((employment) => !employment.endDate);
      const exact = openEmployments.filter((employment) => employment.startDate === line.hireDate);
      const compatible = openEmployments.filter(
        (employment) => employment.startDate <= line.hireDate,
      );
      const employment =
        exact.length === 1
          ? exact[0]
          : exact.length > 1
            ? undefined
            : compatible.length === 1
              ? compatible[0]
              : undefined;
      if (!employment) {
        const matchesRetiredContract = workerEmployments.some(
          (item) =>
            item.endDate && item.startDate <= line.hireDate && item.endDate >= line.hireDate,
        );
        if (matchesRetiredContract && !exact.length && !compatible.length) {
          warnings.push(
            `El contrato de ${line.employee} con fecha ${line.hireDate} está retirado; sus períodos los cierra la carga de disfrutadas`,
          );
          continue;
        }
        errors.push({
          row: line.lineNumber,
          message: workerEmployments.length
            ? `No fue posible determinar un contrato abierto único para ${line.employee}; valide Fecha Ing.`
            : `No existe un contrato para ${line.employee}`,
        });
        continue;
      }
      if (processedEmploymentIds.has(employment.id)) {
        errors.push({
          row: line.lineNumber,
          message: `El empleado ${line.employee} aparece más de una vez en el archivo; debe existir una sola fila por contrato`,
        });
        continue;
      }
      processedEmploymentIds.add(employment.id);
      matchedEmploymentIds.add(employment.id);
      const existing = periodsByEmployment.get(employment.id) ?? [];
      const existingById = new Map(existing.map((period) => [period.id, period]));
      const generated = ensurePeriods(employment, existing, policy, asOf);
      const causedOpen = generated
        .filter((period) => period.causedAt <= asOf && period.lifecycleStatus !== "CLOSED")
        .sort((left, right) => right.sequence - left.sequence);
      if (line.pendingPeriods > causedOpen.length)
        errors.push({
          row: line.lineNumber,
          message: `El empleado ${line.employee} reporta ${line.pendingPeriods} períodos pendientes, pero solo hay ${causedOpen.length} períodos causados abiertos para conservar`,
        });
      const keepIds = new Set(causedOpen.slice(0, line.pendingPeriods).map((period) => period.id));
      for (const period of generated) {
        const relatedSettlements = settlementsByPeriod.get(period.id) ?? [];
        const settledDays = relatedSettlements
          .flatMap((settlement) =>
            settlement.allocations.filter((allocation) => allocation.periodId === period.id),
          )
          .reduce(
            (total, allocation) => total + allocation.enjoyedDays + allocation.compensatedDays,
            0,
          );
        const created = !existingById.has(period.id);
        let decision: VacationPendingPeriodPlan["decision"];
        let reason: string;
        let updated = period;
        if (period.lifecycleStatus === "CLOSED") {
          decision = "ALREADY_CLOSED";
          reason = "El período ya estaba cerrado y no se reabre";
        } else if (period.causedAt > asOf) {
          decision = "FORMING";
          reason = "El período todavía está en formación a la fecha de corte";
        } else if (keepIds.has(period.id)) {
          decision = "KEEP";
          reason = "Se conserva por Periodo Pendiente × 15 días";
          updated = protect({
            ...period,
            lifecycleStatus: "CAUSED",
          });
        } else if (relatedSettlements.length && settledDays < period.entitledDays) {
          decision = "REVIEW";
          reason =
            "Tiene una liquidación parcial activa y requiere revisión antes de liberar el saldo restante";
        } else if (scheduledPeriodIds.has(period.id)) {
          decision = "REVIEW";
          reason = "Tiene una programación activa y requiere revisión";
        } else {
          decision = "RELEASED";
          reason = relatedSettlements.length
            ? "Período consumido totalmente y no incluido entre los pendientes reportados; queda abierto hasta confirmar el disfrute"
            : "Período causado no incluido dentro de los períodos pendientes reportados; queda abierto hasta registrar su disfrute";
          updated = {
            ...period,
            lifecycleStatus: "CAUSED",
            pendingImportReleased: true,
            pendingImportBatchId: batchId,
            version: period.version + 1,
            updatedAt: now,
          };
          delete updated.pendingImportProtected;
        }
        periodsToPersist.set(updated.id, updated);
        plans.push({
          periodId: period.id,
          employmentId: employment.id,
          documentNumber: worker.documentNumber,
          employeeName: worker.fullName,
          periodStartDate: period.accrualStartDate,
          periodEndDate: period.accrualEndDate,
          causedAt: period.causedAt,
          lifecycleStatus: period.lifecycleStatus,
          periodVersion: period.version,
          sourceLineNumber: line.lineNumber,
          sourcePendingPeriods: line.pendingPeriods,
          sourcePendingDays: line.pendingDays,
          daysToKeep: line.pendingPeriods * 15,
          created,
          decision,
          reason,
        });
      }
    }
    return {
      sourceLines: normalized.lines.map(({ normalizedDocument: _, ...line }) => line),
      plans: plans.sort(
        (left, right) =>
          left.employeeName.localeCompare(right.employeeName, "es") ||
          left.periodStartDate.localeCompare(right.periodStartDate),
      ),
      periods: [...periodsToPersist.values()],
      warnings,
      errors,
      matchedEmployees: matchedEmploymentIds.size,
      missingEmployees: missingEmployeeDocuments.size,
    };
  }

  async previewPendingPeriodImport(
    fileName: string,
    fileHash: string,
    rows: PendingPeriodRawRow[],
    actor = "system",
    asOf: LocalDate = this.context.clock(),
  ) {
    const existing = await this.context.store.findVacationPendingPeriodImportByFileHash(fileHash);
    if (existing?.status === "APPLIED")
      return { alreadyProcessed: true, batch: existing, plans: existing.plans };
    const built = await this.buildPendingPeriodImportPlan(
      rows,
      existing?.id ?? crypto.randomUUID(),
      asOf,
    );
    const count = (decision: VacationPendingPeriodPlan["decision"]) =>
      built.plans.filter((plan) => plan.decision === decision).length;
    const batch: VacationPendingPeriodImportBatch = {
      id: existing?.id ?? crypto.randomUUID(),
      fileName,
      fileHash,
      actorId: actor,
      asOf,
      observation: "Liquidación en sistema contable",
      status: "PREVIEW",
      totalRows: rows.length,
      validRows: built.sourceLines.length,
      matchedEmployees: built.matchedEmployees,
      missingEmployees: built.missingEmployees,
      createdPeriods: built.plans.filter((plan) => plan.created).length,
      keptPeriods: count("KEEP"),
      releasedPeriods: count("RELEASED"),
      protectedPeriods: count("PROTECTED"),
      formingPeriods: count("FORMING"),
      reviewPeriods: count("REVIEW"),
      alreadyClosedPeriods: count("ALREADY_CLOSED"),
      warnings: built.warnings,
      errors: built.errors,
      sourceLines: built.sourceLines,
      plans: built.plans,
      previewToken: crypto.randomUUID(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await this.context.store.saveVacationPendingPeriodImportBatch(batch);
    return { alreadyProcessed: false, batch, plans: batch.plans };
  }

  async applyPendingPeriodImport(
    batchId: string,
    fileName: string,
    fileHash: string,
    previewToken: string,
    rows: PendingPeriodRawRow[],
    actor = "system",
    asOf: LocalDate = this.context.clock(),
  ) {
    const batch = await this.context.store.findVacationPendingPeriodImportBatch(batchId);
    if (!batch) throw new NotFoundError("No existe la vista previa de períodos pendientes");
    if (batch.status === "APPLIED" && batch.fileName === fileName && batch.fileHash === fileHash)
      return { replayed: true, batch, createdPeriods: batch.createdPeriods };
    if (
      batch.fileName !== fileName ||
      batch.fileHash !== fileHash ||
      batch.previewToken !== previewToken ||
      batch.asOf !== asOf
    )
      throw new ConflictError("La vista previa está vencida o no coincide con el archivo");
    if (batch.errors.length || batch.reviewPeriods > 0)
      throw new ConflictError(
        "La carga tiene errores o períodos en revisión; resuélvelos antes de aplicar",
      );
    const built = await this.buildPendingPeriodImportPlan(rows, batch.id, asOf);
    if (built.errors.length || built.plans.some((plan) => plan.decision === "REVIEW"))
      throw new ConflictError(
        "Los datos cambiaron desde la vista previa; genera una nueva vista previa",
      );
    const currentPeriods = await this.context.store.findByEmploymentIds([
      ...new Set(batch.plans.map((plan) => plan.employmentId)),
    ]);
    const currentById = new Map(currentPeriods.map((period) => [period.id, period]));
    for (const plan of batch.plans) {
      const current = currentById.get(plan.periodId);
      if (
        (plan.created && current) ||
        (!plan.created && (!current || current.version !== plan.periodVersion))
      )
        throw new ConflictError(
          "Los períodos cambiaron desde la vista previa; genera una nueva vista previa",
        );
    }
    const appliedAt = new Date().toISOString();
    const appliedBatch: VacationPendingPeriodImportBatch = {
      ...batch,
      actorId: actor,
      status: "APPLIED",
      authorizedAt: batch.authorizedAt ?? appliedAt,
      appliedAt,
      createdPeriods: built.plans.filter((plan) => plan.created).length,
      keptPeriods: built.plans.filter((plan) => plan.decision === "KEEP").length,
      releasedPeriods: built.plans.filter((plan) => plan.decision === "RELEASED").length,
      protectedPeriods: built.plans.filter((plan) => plan.decision === "PROTECTED").length,
      formingPeriods: built.plans.filter((plan) => plan.decision === "FORMING").length,
      reviewPeriods: built.plans.filter((plan) => plan.decision === "REVIEW").length,
      alreadyClosedPeriods: built.plans.filter((plan) => plan.decision === "ALREADY_CLOSED").length,
    };
    const appliedPeriods = built.periods;
    const audits = [
      ...built.plans
        .filter(
          (plan) =>
            plan.decision === "RELEASED" ||
            plan.decision === "PROTECTED" ||
            plan.decision === "KEEP",
        )
        .map((plan) => ({
          id: crypto.randomUUID(),
          actorId: actor,
          action:
            plan.decision === "RELEASED"
              ? "VACATION_PERIOD_RELEASED_BY_PENDING_IMPORT"
              : "VACATION_PERIOD_PROTECTED_BY_PENDING_IMPORT",
          entityType: "VacationPeriod",
          entityId: plan.periodId,
          metadata: {
            batchId,
            employmentId: plan.employmentId,
            decision: plan.decision,
            sourceLineNumber: plan.sourceLineNumber,
            sourcePendingPeriods: plan.sourcePendingPeriods,
            daysToKeep: plan.daysToKeep,
            observation: batch.observation,
          },
          createdAt: appliedAt,
        })),
      {
        id: crypto.randomUUID(),
        actorId: actor,
        action: "VACATION_PENDING_PERIOD_IMPORT_APPLIED",
        entityType: "VacationPendingPeriodImportBatch",
        entityId: batch.id,
        metadata: {
          totalRows: batch.totalRows,
          matchedEmployees: batch.matchedEmployees,
          createdPeriods: appliedBatch.createdPeriods,
          keptPeriods: appliedBatch.keptPeriods,
          releasedPeriods: appliedBatch.releasedPeriods,
          protectedPeriods: appliedBatch.protectedPeriods,
          observation: batch.observation,
        },
        createdAt: appliedAt,
      },
    ];
    await this.context.store.applyVacationPendingPeriodImport(appliedBatch, appliedPeriods, audits);
    return {
      replayed: false,
      batch: appliedBatch,
      createdPeriods: appliedBatch.createdPeriods,
      releasedPeriods: appliedBatch.releasedPeriods,
      keptPeriods: appliedBatch.keptPeriods,
      protectedPeriods: appliedBatch.protectedPeriods,
    };
  }
}
