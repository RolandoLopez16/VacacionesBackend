import { BusinessRuleError, ConflictError, NotFoundError } from "../../../domain/shared/errors.js";
import type { LocalDate } from "../../../domain/shared/localDate.js";
import type { Employment } from "../../../domain/workers/models.js";
import type {
  VacationPeriod,
  VacationSchedule,
  VacationSettlement,
  VacationSettlementImportBatch,
} from "../../../domain/vacations/models.js";
import {
  groupSettlementLines,
  normalizeSettlementRows,
  type SettlementGroup,
  type SettlementRawRow,
} from "../settlementImport.js";
import { AccrualReadService } from "./accrualReadService.js";
import { readClosureFromDate } from "./closurePolicy.js";
import type { VacationServiceContext } from "./context.js";
import { SettlementService } from "./settlementService.js";
import type { SettlementInput } from "./types.js";

export class SettlementImportService {
  constructor(
    private readonly context: VacationServiceContext,
    private readonly readService: AccrualReadService,
    private readonly settlementService: SettlementService,
  ) {}

  private async importGroups(
    groups: SettlementGroup[],
    asOf: LocalDate,
    cutoff: LocalDate,
    persistPeriods = false,
  ) {
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
    const periodsByEmployment = new Map<string, VacationPeriod[]>();
    const settlementsByEmployment = new Map<string, VacationSettlement[]>();
    const plans: {
      group: SettlementGroup;
      settlement?: VacationSettlement | undefined;
      existing?: VacationSettlement | undefined;
      employment?: Employment | undefined;
      periods: VacationPeriod[];
      status: "NEW" | "UNCHANGED" | "MODIFIED" | "CONFLICT";
      reason?: string;
      affectedPeriods: string[];
      warnings: string[];
      before?: unknown;
      after: unknown;
    }[] = [];
    for (const group of groups) {
      const warnings = [...group.warnings];
      const worker = workersByDocument.get(group.normalizedDocument);
      if (!worker) {
        plans.push({
          group,
          status: "CONFLICT",
          reason: "No existe un empleado con esa cédula",
          periods: [],
          affectedPeriods: [],
          warnings,
          after: {},
        });
        continue;
      }
      const matches = (employmentsByWorker.get(worker.id) ?? []).filter(
        (employment) =>
          employment.startDate <= group.rangeEnd &&
          (!employment.endDate || employment.endDate >= group.rangeStart),
      );
      const exact = matches.filter(
        (employment) =>
          employment.startDate <= group.rangeStart &&
          (!employment.endDate || employment.endDate >= group.rangeEnd),
      );
      const employment =
        exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
      if (!employment) {
        plans.push({
          group,
          status: "CONFLICT",
          reason: matches.length
            ? "Hay varios contratos compatibles con el rango"
            : "No existe un contrato compatible con el rango de la liquidación",
          periods: [],
          affectedPeriods: [],
          warnings,
          after: {},
        });
        continue;
      }
      let periods = periodsByEmployment.get(employment.id);
      if (!periods) {
        periods = await this.readService.ensure(employment, asOf, persistPeriods);
        periodsByEmployment.set(employment.id, periods);
      }
      let activeSettlements = settlementsByEmployment.get(employment.id);
      if (!activeSettlements) {
        activeSettlements = await this.context.store.findSettlementsByEmploymentIds([
          employment.id,
        ]);
        settlementsByEmployment.set(employment.id, activeSettlements);
      }
      const sourceKey = `${employment.id}|${group.normalizedDocument}|${group.accountingDocument.toUpperCase()}`;
      const existingResult = await this.context.store.findSettlementBySourceKey(sourceKey);
      const existing = existingResult ?? undefined;
      if (existing?.status === "ANULADA") {
        plans.push({
          group,
          existing,
          status: "CONFLICT",
          reason: "La liquidación existe pero está anulada; requiere reactivación manual",
          employment,
          periods,
          affectedPeriods: existing.allocations.map((allocation) => allocation.periodId),
          warnings,
          before: { status: existing.status, version: existing.version },
          after: {},
        });
        continue;
      }
      const same = existing ? this.sameImportedSettlement(existing, group) : false;
      const affected = periods
        .filter(
          (period) =>
            period.accrualStartDate <= group.rangeEnd && period.accrualEndDate >= group.rangeStart,
        )
        .sort((left, right) => left.sequence - right.sequence);
      const allocations = this.allocateGroup(group, affected, activeSettlements, existing?.id);
      if (!allocations.ok) {
        plans.push({
          group,
          existing,
          status: "CONFLICT",
          reason: allocations.reason,
          employment,
          periods,
          affectedPeriods: affected.map((period) => period.id),
          warnings,
          before: existing ? this.settlementSnapshot(existing) : undefined,
          after: {
            ...this.groupSnapshot(group),
            affectedPeriods: affected.map((period) => ({
              id: period.id,
              startDate: period.accrualStartDate,
              endDate: period.accrualEndDate,
            })),
          },
        });
        continue;
      }
      const sourceLines = group.lines.map(({ normalizedDocument: _, ...line }) => line);
      const input: SettlementInput = {
        employmentId: employment.id,
        source: "MASS_IMPORT",
        sourceKey,
        enjoymentStartDate: group.enjoymentStartDate,
        enjoymentEndDate: group.enjoymentEndDate,
        periodEndDate: group.periodEndDate,
        sourceLines,
        enjoyedDays: group.enjoyedDays,
        compensatedDays: group.compensatedDays,
        calendarDays: group.calendarDays,
        amountCOP: group.amountCOP,
        accountingDocument: group.accountingDocument,
        allocations: allocations.allocations,
        observation: group.periodEndDate < cutoff ? "Liquidación masiva por migración" : undefined,
      };
      const settlement = this.settlementService.buildSettlement(
        input,
        existing,
        employment,
        new Date().toISOString(),
      );
      const status = same ? "UNCHANGED" : existing ? "MODIFIED" : "NEW";
      plans.push({
        group,
        settlement,
        existing,
        employment,
        periods,
        status,
        affectedPeriods: affected.map((period) => period.id),
        warnings,
        before: existing ? this.settlementSnapshot(existing) : undefined,
        after: this.settlementSnapshot(settlement),
      });
    }
    return plans;
  }

  private sameImportedSettlement(existing: VacationSettlement, group: SettlementGroup) {
    const sourceHashes = (existing.sourceLines ?? []).map((line) => line.lineHash).join(",");
    const currentHashes = group.lines.map((line) => line.lineHash).join(",");
    return (
      existing.source === "MASS_IMPORT" &&
      existing.status === "ACTIVE" &&
      sourceHashes === currentHashes &&
      existing.enjoyedDays === group.enjoyedDays &&
      existing.compensatedDays === group.compensatedDays &&
      existing.calendarDays === group.calendarDays &&
      existing.amountCOP === group.amountCOP &&
      existing.periodEndDate === group.periodEndDate &&
      existing.enjoymentStartDate === group.enjoymentStartDate &&
      existing.enjoymentEndDate === group.enjoymentEndDate
    );
  }

  private groupSnapshot(group: SettlementGroup) {
    return {
      accountingDocument: group.accountingDocument,
      periodEndDate: group.periodEndDate,
      enjoymentStartDate: group.enjoymentStartDate,
      enjoymentEndDate: group.enjoymentEndDate,
      enjoyedDays: group.enjoyedDays,
      compensatedDays: group.compensatedDays,
      calendarDays: group.calendarDays,
      amountCOP: group.amountCOP,
      lines: group.lines.map((line) => ({
        lineNumber: line.lineNumber,
        lineHash: line.lineHash,
        periodStartDate: line.periodStartDate,
        periodFinishDate: line.periodFinishDate,
        takenDays: line.takenDays,
        compensatedDays: line.compensatedDays,
        amountCOP: line.amountCOP,
      })),
    };
  }

  private settlementSnapshot(settlement: VacationSettlement) {
    return {
      accountingDocument: settlement.accountingDocument,
      periodEndDate: settlement.periodEndDate,
      enjoymentStartDate: settlement.enjoymentStartDate,
      enjoymentEndDate: settlement.enjoymentEndDate,
      enjoyedDays: settlement.enjoyedDays,
      compensatedDays: settlement.compensatedDays,
      calendarDays: settlement.calendarDays,
      amountCOP: settlement.amountCOP,
      allocations: settlement.allocations,
      sourceLines: (settlement.sourceLines ?? []).map((line) => ({
        lineNumber: line.lineNumber,
        lineHash: line.lineHash,
        periodStartDate: line.periodStartDate,
        periodFinishDate: line.periodFinishDate,
        takenDays: line.takenDays,
        compensatedDays: line.compensatedDays,
        amountCOP: line.amountCOP,
      })),
    };
  }

  private allocateGroup(
    group: SettlementGroup,
    periods: VacationPeriod[],
    settlements: VacationSettlement[],
    ignoreSettlementId?: string,
  ) {
    if (!periods.length)
      return {
        ok: false as const,
        reason: "No hay períodos del sistema que cubran el rango de la liquidación",
      };
    const used = new Map(
      periods.map((period) => [
        period.id,
        settlements
          .filter((settlement) => settlement.id !== ignoreSettlementId)
          .reduce(
            (total, settlement) =>
              total +
              settlement.allocations
                .filter((allocation) => allocation.periodId === period.id)
                .reduce(
                  (sum, allocation) => sum + allocation.enjoyedDays + allocation.compensatedDays,
                  0,
                ),
            0,
          ),
      ]),
    );
    const allocationMap = new Map<
      string,
      { periodId: string; enjoyedDays: number; compensatedDays: number }
    >();
    const ensureAllocation = (periodId: string) => {
      let value = allocationMap.get(periodId);
      if (!value) {
        value = { periodId, enjoyedDays: 0, compensatedDays: 0 };
        allocationMap.set(periodId, value);
      }
      return value;
    };
    for (const line of group.lines) {
      const targets = periods.filter(
        (period) =>
          period.accrualStartDate <= line.periodFinishDate &&
          period.accrualEndDate >= line.periodStartDate,
      );
      if (!targets.length)
        return {
          ok: false as const,
          reason: `La línea ${line.lineNumber} no coincide con ningún período anual`,
        };
      let remainingComp = line.compensatedDays;
      let remainingTaken = line.takenDays;
      for (const period of targets) {
        const already = used.get(period.id) ?? 0;
        const current = allocationMap.get(period.id);
        const capacity = Math.max(
          0,
          period.entitledDays -
            already -
            (current ? current.enjoyedDays + current.compensatedDays : 0),
        );
        const target = ensureAllocation(period.id);
        const compensated = Math.min(remainingComp, capacity);
        target.compensatedDays += compensated;
        remainingComp -= compensated;
        const taken = Math.min(remainingTaken, Math.max(0, capacity - compensated));
        target.enjoyedDays += taken;
        remainingTaken -= taken;
      }
      if (remainingComp || remainingTaken)
        return {
          ok: false as const,
          reason: `La línea ${line.lineNumber} supera el saldo disponible de los períodos afectados`,
        };
    }
    return { ok: true as const, allocations: [...allocationMap.values()] };
  }

  async previewSettlementImport(
    fileName: string,
    fileHash: string,
    rows: SettlementRawRow[],
    actor = "system",
    asOf: LocalDate = this.context.clock(),
  ) {
    const cutoff = await readClosureFromDate(this.context.store);
    const already = await this.context.store.findVacationSettlementImportByFileHash(fileHash);
    if (already && already.status === "APPLIED")
      return { alreadyProcessed: true, batch: already, groups: [] };
    const normalized = normalizeSettlementRows(rows);
    const groups = groupSettlementLines(normalized.lines);
    const plans = await this.importGroups(groups, asOf, cutoff, false);
    const batch: VacationSettlementImportBatch = {
      id: crypto.randomUUID(),
      fileName,
      fileHash,
      actorId: actor,
      status: "PREVIEW",
      totalRows: rows.length,
      totalSettlements: groups.length,
      newSettlements: plans.filter((plan) => plan.status === "NEW").length,
      unchangedSettlements: plans.filter((plan) => plan.status === "UNCHANGED").length,
      modifiedSettlements: plans.filter((plan) => plan.status === "MODIFIED").length,
      conflicts: plans.filter((plan) => plan.status === "CONFLICT").length,
      invalidRows: normalized.errors.length,
      migrationPeriods: new Set(
        plans.flatMap((plan) =>
          plan.periods
            .filter((period) => period.accrualEndDate < cutoff)
            .map((period) => period.id),
        ),
      ).size,
      closedByMigration: 0,
      closedEnjoyedPeriods: 0,
      partiallyEnjoyedWarnings: [],
      warnings: plans.flatMap((plan) => plan.warnings),
      errors: normalized.errors,
      previewToken: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.context.store.saveVacationSettlementImportBatch(batch);
    return {
      alreadyProcessed: false,
      batch,
      groups: plans.map((plan) => ({
        sourceKey:
          plan.settlement?.sourceKey ??
          `${plan.group.normalizedDocument}|${plan.group.accountingDocument}`,
        employee: plan.group.lines[0]?.name ?? "",
        document: plan.group.normalizedDocument,
        accountingDocument: plan.group.accountingDocument,
        status: plan.status,
        reason: plan.reason,
        before: plan.before,
        after: plan.after,
        lines: plan.group.lines,
        affectedPeriods: plan.affectedPeriods,
        warnings: plan.warnings,
      })),
    };
  }

  async applySettlementImport(
    batchId: string,
    fileName: string,
    fileHash: string,
    previewToken: string,
    rows: SettlementRawRow[],
    actor = "system",
    asOf: LocalDate = this.context.clock(),
  ) {
    const batch = await this.context.store.findVacationSettlementImportBatch(batchId);
    if (!batch) throw new NotFoundError("Import preview not found");
    if (
      batch.fileHash !== fileHash ||
      batch.fileName !== fileName ||
      batch.previewToken !== previewToken
    )
      throw new ConflictError("The import preview is stale or does not match the selected file");
    const replayed = batch.status === "APPLIED";
    const cutoff = await readClosureFromDate(this.context.store);
    const normalized = normalizeSettlementRows(rows);
    const plans = await this.importGroups(
      groupSettlementLines(normalized.lines),
      asOf,
      cutoff,
      false,
    );
    const conflicts = plans.filter((plan) => plan.status === "CONFLICT");
    if (conflicts.length || normalized.errors.length)
      throw new BusinessRuleError(
        "The import contains conflicts or invalid rows; resolve the preview before applying",
      );
    const settlements = plans
      .filter((plan) => plan.settlement && plan.status !== "UNCHANGED")
      .map((plan) => plan.settlement!);
    const periodMap = new Map<string, VacationPeriod>();
    for (const plan of plans) for (const period of plan.periods) periodMap.set(period.id, period);

    const employments = await this.context.store.listEmployments();
    const allPeriods = await this.context.store.findByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const existingSettlements = await this.context.store.findSettlementsByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const settlementById = new Map<string, VacationSettlement>();
    for (const settlement of existingSettlements) settlementById.set(settlement.id, settlement);
    for (const settlement of settlements) settlementById.set(settlement.id, settlement);
    const allSettlements = [...settlementById.values()].filter(
      (settlement) => settlement.status === "ACTIVE",
    );
    const sweepAudits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[] = [];
    const partiallyEnjoyed: string[] = [];
    let closedByMigration = 0;
    let closedEnjoyedPeriods = 0;
    for (const period of allPeriods) {
      if (period.lifecycleStatus === "CLOSED") continue;
      if (period.accrualEndDate >= cutoff) continue;
      if (period.pendingImportProtected) continue;
      const related = allSettlements.filter((settlement) =>
        settlement.allocations.some((allocation) => allocation.periodId === period.id),
      );
      const consumed = related.reduce(
        (total, settlement) =>
          total +
          settlement.allocations
            .filter((allocation) => allocation.periodId === period.id)
            .reduce(
              (sum, allocation) => sum + allocation.enjoyedDays + allocation.compensatedDays,
              0,
            ),
        0,
      );
      const pending = Math.max(0, period.entitledDays - consumed);
      const closedAt = new Date().toISOString();
      if (pending > 0 && related.length) {
        partiallyEnjoyed.push(
          `${period.employmentId} (${period.accrualStartDate} — ${period.accrualEndDate}): queda abierto con ${pending} día(s) tras una liquidación parcial`,
        );
        continue;
      }
      const enjoyed = related.length > 0;
      const closed: VacationPeriod = {
        ...period,
        lifecycleStatus: "CLOSED",
        closureType: enjoyed ? "ACCOUNTING_LIQUIDATION" : "MASS_MIGRATION",
        closureObservation: enjoyed
          ? "Disfrutado (liquidación registrada)"
          : "Cerrado por migración",
        closedAt,
        closedBy: actor,
        version: period.version + 1,
        updatedAt: closedAt,
      };
      periodMap.set(closed.id, closed);
      sweepAudits.push({
        id: crypto.randomUUID(),
        actorId: actor,
        action: "VACATION_PERIOD_CLOSED_BY_SETTLEMENT_IMPORT",
        entityType: "VacationPeriod",
        entityId: closed.id,
        metadata: {
          batchId,
          employmentId: closed.employmentId,
          closureType: closed.closureType,
          observation: closed.closureObservation,
          cutoff,
        },
        createdAt: closedAt,
      });
      if (enjoyed) closedEnjoyedPeriods++;
      else closedByMigration++;
    }
    const periods = [...periodMap.values()];
    const appliedBatch = {
      ...batch,
      status: "APPLIED" as const,
      authorizedAt: batch.authorizedAt ?? new Date().toISOString(),
      appliedAt: new Date().toISOString(),
      actorId: actor,
      closedByMigration,
      closedEnjoyedPeriods,
      partiallyEnjoyedWarnings: partiallyEnjoyed,
    };
    const importedScheduleIds = plans.flatMap((plan) =>
      plan.settlement ? [`imported-settlement:${plan.settlement.id}`] : [],
    );
    const existingSchedules = new Map(
      (await this.context.store.findSchedulesByIds(importedScheduleIds)).map((schedule) => [
        schedule.id,
        schedule,
      ]),
    );
    const schedules: VacationSchedule[] = [];
    const scheduleAudits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[] = [];
    for (const plan of plans) {
      const settlement = plan.settlement;
      const scheduledDays = settlement ? settlement.enjoyedDays + settlement.compensatedDays : 0;
      if (!settlement || scheduledDays <= 0) continue;
      const allocations = settlement.allocations
        .map((allocation) => {
          const period = plan.periods.find((item) => item.id === allocation.periodId);
          if (!period)
            throw new BusinessRuleError(
              `No se encontró el período ${allocation.periodId} para crear la programación importada`,
            );
          return {
            periodId: allocation.periodId,
            periodType: "CAUSED" as const,
            periodStartDate: period.accrualStartDate,
            periodEndDate: period.accrualEndDate,
            days: allocation.enjoyedDays + allocation.compensatedDays,
          };
        })
        .filter((allocation) => allocation.days > 0);
      if (!allocations.length) continue;
      const scheduleId = `imported-settlement:${settlement.id}`;
      const existing = existingSchedules.get(scheduleId);
      const schedule: VacationSchedule = {
        id: scheduleId,
        employmentId: settlement.employmentId,
        sourceSettlementId: settlement.id,
        startDate: settlement.enjoymentStartDate,
        endDate: settlement.enjoymentEndDate,
        scheduledDays,
        allocations,
        status: "COMPLETED",
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? appliedBatch.appliedAt!,
        updatedAt: appliedBatch.appliedAt!,
      };
      const unchanged =
        existing &&
        existing.employmentId === schedule.employmentId &&
        existing.sourceSettlementId === schedule.sourceSettlementId &&
        existing.startDate === schedule.startDate &&
        existing.endDate === schedule.endDate &&
        existing.scheduledDays === schedule.scheduledDays &&
        existing.status === schedule.status &&
        JSON.stringify(existing.allocations) === JSON.stringify(schedule.allocations);
      if (unchanged) continue;
      schedules.push(schedule);
      scheduleAudits.push({
        id: crypto.randomUUID(),
        actorId: actor,
        action: existing ? "VACATION_SCHEDULE_IMPORTED_UPDATED" : "VACATION_SCHEDULE_IMPORTED",
        entityType: "VacationSchedule",
        entityId: schedule.id,
        metadata: {
          settlementId: settlement.id,
          sourceKey: settlement.sourceKey,
          status: schedule.status,
          scheduledDays: schedule.scheduledDays,
        },
        createdAt: schedule.updatedAt,
      });
    }
    const audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[] = [
      ...sweepAudits,
      ...settlements.map((settlement) => ({
        id: crypto.randomUUID(),
        actorId: actor,
        action:
          settlement.version === 1 ? "VACATION_SETTLEMENT_IMPORTED" : "VACATION_SETTLEMENT_UPDATED",
        entityType: "VacationSettlement",
        entityId: settlement.id,
        metadata: {
          batchId,
          sourceKey: settlement.sourceKey,
          enjoyedDays: settlement.enjoyedDays,
          compensatedDays: settlement.compensatedDays,
          amountCOP: settlement.amountCOP,
        },
        createdAt: appliedBatch.appliedAt!,
      })),
    ];
    audits.push(...scheduleAudits);
    audits.push({
      id: crypto.randomUUID(),
      actorId: actor,
      action: "VACATION_SETTLEMENT_IMPORT_APPLIED",
      entityType: "VacationSettlementImportBatch",
      entityId: batchId,
      metadata: {
        totalRows: batch.totalRows,
        newSettlements: batch.newSettlements,
        modifiedSettlements: batch.modifiedSettlements,
        closedByMigration,
        closedEnjoyedPeriods,
        partiallyEnjoyedPeriods: partiallyEnjoyed.length,
        importedSchedules: schedules.length,
      },
      createdAt: appliedBatch.appliedAt!,
    });
    await this.context.store.applyVacationSettlementImport(
      appliedBatch,
      settlements,
      periods,
      audits,
      schedules,
    );
    return {
      replayed,
      batch: appliedBatch,
      created: settlements.filter((item) => item.version === 1).length,
      updated: settlements.filter((item) => item.version > 1).length,
      closedPeriods: closedByMigration + closedEnjoyedPeriods,
      closedByMigration,
      closedEnjoyedPeriods,
      partiallyEnjoyedWarnings: partiallyEnjoyed,
      createdSchedules: schedules.filter((item) => item.version === 1).length,
      updatedSchedules: schedules.filter((item) => item.version > 1).length,
    };
  }
}
