import { BusinessRuleError, NotFoundError } from "../../../domain/shared/errors.js";
import type { LocalDate } from "../../../domain/shared/localDate.js";
import { assertEmploymentDateRange } from "../../../domain/shared/valueObjects.js";
import type { Employment } from "../../../domain/workers/models.js";
import { closePeriodsAtRetirement, ensurePeriods } from "../../../domain/vacations/calculations.js";
import type { VacationPeriod, VacationSettlement } from "../../../domain/vacations/models.js";
import type { VacationStore } from "../../ports/repositories.js";
import { AccrualReadService } from "./accrualReadService.js";
import { checkVersion, type VacationServiceContext } from "./context.js";

export class RetirementService {
  constructor(
    private readonly context: VacationServiceContext,
    private readonly readService: AccrualReadService,
  ) {}

  async retireEmployment(
    id: string,
    endDate: LocalDate,
    expectedVersion?: number,
    actor = "system",
  ) {
    const existing = await this.context.store.findEmploymentById(id);
    if (!existing) throw new NotFoundError("Employment not found");
    checkVersion(existing.version, expectedVersion);
    assertEmploymentDateRange(existing.startDate, endDate);
    const updated = {
      ...existing,
      endDate,
      status: "RETIRED" as const,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.context.store.saveEmployment(updated);
    await this.readService.ensure(updated);
    await this.context.store.append({
      id: crypto.randomUUID(),
      actorId: actor,
      action: "EMPLOYMENT_RETIRED",
      entityType: "Employment",
      entityId: id,
      metadata: { endDate },
      createdAt: updated.updatedAt,
    });
    return this.readService.summary(updated);
  }

  async closeRetiredEmployments(
    actor = "system-retirement-closure",
    asOf: LocalDate = this.context.clock(),
  ) {
    const policy = await this.context.store.current(asOf);
    const employments = (await this.context.store.listEmployments()).filter(
      (employment) =>
        employment.status === "RETIRED" &&
        Boolean(employment.endDate) &&
        employment.endDate! <= asOf,
    );
    const storedPeriods = await this.context.store.findByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const periodsByEmployment = new Map<string, VacationPeriod[]>();
    for (const period of storedPeriods) {
      const items = periodsByEmployment.get(period.employmentId) ?? [];
      items.push(period);
      periodsByEmployment.set(period.employmentId, items);
    }
    type RetirementPlan = {
      employment: Employment;
      periods: VacationPeriod[];
      periodsClosed: number;
      audits: Parameters<VacationStore["closeRetiredEmploymentsTransaction"]>[2];
    };
    const plans: RetirementPlan[] = [];
    for (const employment of employments) {
      const existing = periodsByEmployment.get(employment.id) ?? [];
      const periods = closePeriodsAtRetirement(
        employment,
        ensurePeriods(employment, existing, policy, asOf),
      );
      const changed = periods.filter((period) => {
        const previous = existing.find((item) => item.id === period.id);
        return (
          !previous ||
          (previous.lifecycleStatus !== "CLOSED" && period.lifecycleStatus === "CLOSED")
        );
      });
      if (!changed.length) continue;
      const createdAt = new Date().toISOString();
      const audits: RetirementPlan["audits"] = [
        ...changed.map((period) => ({
          id: crypto.randomUUID(),
          actorId: actor,
          action: "VACATION_PERIOD_CLOSED_ON_RETIREMENT",
          entityType: "VacationPeriod",
          entityId: period.id,
          metadata: {
            employmentId: employment.id,
            endDate: employment.endDate,
            observation: period.closureObservation,
          },
          createdAt,
        })),
        {
          id: crypto.randomUUID(),
          actorId: actor,
          action: "RETIRED_EMPLOYMENT_VACATION_CYCLE_CLOSED",
          entityType: "Employment",
          entityId: employment.id,
          metadata: {
            endDate: employment.endDate,
            periodsClosed: changed.length,
            rule: "Los períodos pendientes se cierran con la liquidación del contrato",
          },
          createdAt,
        },
      ];
      plans.push({
        employment,
        periods,
        periodsClosed: changed.length,
        audits,
      });
    }
    let periodsClosed = 0;
    let employmentsChanged = 0;
    const batchSize = 25;
    for (let index = 0; index < plans.length; index += batchSize) {
      const batch = plans.slice(index, index + batchSize);
      await this.context.store.closeRetiredEmploymentsTransaction(
        batch.map((plan) => plan.employment),
        batch.flatMap((plan) => plan.periods),
        batch.flatMap((plan) => plan.audits),
      );
      periodsClosed += batch.reduce((total, plan) => total + plan.periodsClosed, 0);
      employmentsChanged += batch.length;
    }
    return {
      asOf,
      employmentsScanned: employments.length,
      employmentsChanged,
      periodsClosed,
      batchesApplied: Math.ceil(plans.length / batchSize),
    };
  }

  async retiredVacationReconciliation(asOf: LocalDate = this.context.clock()) {
    const policy = await this.context.store.current(asOf);
    const employments = (await this.context.store.listEmployments()).filter(
      (employment) =>
        employment.status === "RETIRED" &&
        Boolean(employment.endDate) &&
        employment.endDate! <= asOf,
    );
    const workers = await this.context.store.listWorkersByIds(
      employments.map((employment) => employment.workerId),
    );
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const storedPeriods = await this.context.store.findByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const periodsByEmployment = new Map<string, VacationPeriod[]>();
    for (const period of storedPeriods)
      (
        periodsByEmployment.get(period.employmentId) ??
        periodsByEmployment.set(period.employmentId, []).get(period.employmentId)!
      ).push(period);
    const settlements = await this.context.store.findSettlementsByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const settlementsByPeriod = new Map<string, VacationSettlement[]>();
    for (const settlement of settlements) {
      if (settlement.status !== "ACTIVE") continue;
      for (const allocation of settlement.allocations)
        (
          settlementsByPeriod.get(allocation.periodId) ??
          settlementsByPeriod.set(allocation.periodId, []).get(allocation.periodId)!
        ).push(settlement);
    }
    const items = employments
      .map((employment) => {
        const periods = ensurePeriods(
          employment,
          periodsByEmployment.get(employment.id) ?? [],
          policy,
          asOf,
        );
        const worker = workerById.get(employment.workerId);
        const periodItems = periods.map((period) => {
          const related = settlementsByPeriod.get(period.id) ?? [];
          const enjoyed = related.reduce(
            (total, settlement) =>
              total +
              settlement.allocations
                .filter((allocation) => allocation.periodId === period.id)
                .reduce((sum, allocation) => sum + allocation.enjoyedDays, 0),
            0,
          );
          const compensated = related.reduce(
            (total, settlement) =>
              total +
              settlement.allocations
                .filter((allocation) => allocation.periodId === period.id)
                .reduce((sum, allocation) => sum + allocation.compensatedDays, 0),
            0,
          );
          const state =
            enjoyed + compensated > 0
              ? "ENJOYED"
              : period.closureType === "ACCOUNTING_LIQUIDATION"
                ? "LIQUIDATED"
                : "PENDING_LIQUIDATION";
          return {
            periodId: period.id,
            periodStartDate: period.accrualStartDate,
            periodEndDate: period.accrualEndDate,
            lifecycleStatus: period.lifecycleStatus,
            closureType: period.closureType,
            closureObservation: period.closureObservation,
            closureAccountingDocument: period.closureAccountingDocument,
            pendingDays:
              state === "PENDING_LIQUIDATION"
                ? Math.max(0, period.entitledDays - enjoyed - compensated)
                : 0,
            enjoyedDays: enjoyed,
            compensatedDays: compensated,
            state,
          };
        });
        return {
          employmentId: employment.id,
          workerId: employment.workerId,
          employeeName: worker?.fullName ?? "Empleado no identificado",
          documentNumber: worker?.documentNumber ?? "—",
          endDate: employment.endDate,
          pendingPeriods: periodItems.filter((period) => period.state === "PENDING_LIQUIDATION")
            .length,
          enjoyedPeriods: periodItems.filter((period) => period.state === "ENJOYED").length,
          liquidatedPeriods: periodItems.filter((period) => period.state === "LIQUIDATED").length,
          closedPeriods: periodItems.filter((period) => period.lifecycleStatus === "CLOSED").length,
          periods: periodItems,
        };
      })
      .sort((left, right) => left.employeeName.localeCompare(right.employeeName, "es"));
    return {
      asOf,
      totalEmployments: items.length,
      employmentsWithPending: items.filter((item) => item.pendingPeriods > 0).length,
      pendingPeriods: items.reduce((total, item) => total + item.pendingPeriods, 0),
      items,
    };
  }

  async closeRetiredEmploymentsWithAccounting(
    input: {
      accountingDocument: string;
      observation: string;
      amountCOP?: number | undefined;
    },
    actor = "system",
    asOf: LocalDate = this.context.clock(),
  ) {
    if (!input.accountingDocument.trim())
      throw new BusinessRuleError("El documento contable es obligatorio");
    if (input.observation.trim().length < 3)
      throw new BusinessRuleError("La observación debe tener al menos 3 caracteres");
    if (input.amountCOP !== undefined && input.amountCOP < 0)
      throw new BusinessRuleError("El valor contable no puede ser negativo");
    const policy = await this.context.store.current(asOf);
    const employments = (await this.context.store.listEmployments()).filter(
      (employment) =>
        employment.status === "RETIRED" &&
        Boolean(employment.endDate) &&
        employment.endDate! <= asOf,
    );
    const storedPeriods = await this.context.store.findByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const periodsByEmployment = new Map<string, VacationPeriod[]>();
    for (const period of storedPeriods)
      (
        periodsByEmployment.get(period.employmentId) ??
        periodsByEmployment.set(period.employmentId, []).get(period.employmentId)!
      ).push(period);
    const settlements = await this.context.store.findSettlementsByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const usedByPeriod = new Map<string, number>();
    for (const settlement of settlements) {
      if (settlement.status !== "ACTIVE") continue;
      for (const allocation of settlement.allocations)
        usedByPeriod.set(
          allocation.periodId,
          (usedByPeriod.get(allocation.periodId) ?? 0) +
            allocation.enjoyedDays +
            allocation.compensatedDays,
        );
    }
    type Plan = {
      employment: Employment;
      periods: VacationPeriod[];
      changed: VacationPeriod[];
      audits: Parameters<VacationStore["closeRetiredEmploymentsTransaction"]>[2];
    };
    const now = new Date().toISOString();
    const plans: Plan[] = [];
    for (const employment of employments) {
      const existing = periodsByEmployment.get(employment.id) ?? [];
      const periods = ensurePeriods(employment, existing, policy, asOf);
      const changed = periods
        .filter(
          (period) =>
            period.closureType !== "ACCOUNTING_LIQUIDATION" &&
            (usedByPeriod.get(period.id) ?? 0) <= 0,
        )
        .map((period) => ({
          ...period,
          lifecycleStatus: "CLOSED" as const,
          closureType: "ACCOUNTING_LIQUIDATION" as const,
          closureObservation: input.observation.trim(),
          closureAccountingDocument: input.accountingDocument.trim(),
          ...(input.amountCOP !== undefined ? { closureAmountCOP: input.amountCOP } : {}),
          pendingImportProtected: false,
          closedAt: now,
          closedBy: actor,
          version: period.version + 1,
          updatedAt: now,
        }));
      if (!changed.length) continue;
      const changedById = new Map(changed.map((period) => [period.id, period]));
      const persistedPeriods = periods.map((period) => changedById.get(period.id) ?? period);
      const audits: Plan["audits"] = [
        ...changed.map((period) => ({
          id: crypto.randomUUID(),
          actorId: actor,
          action: "VACATION_PERIOD_CLOSED_BY_ACCOUNTING_LIQUIDATION",
          entityType: "VacationPeriod",
          entityId: period.id,
          metadata: {
            employmentId: employment.id,
            endDate: employment.endDate,
            accountingDocument: input.accountingDocument.trim(),
            amountCOP: input.amountCOP,
            observation: input.observation.trim(),
          },
          createdAt: now,
        })),
        {
          id: crypto.randomUUID(),
          actorId: actor,
          action: "RETIRED_EMPLOYMENT_ACCOUNTING_LIQUIDATION_APPLIED",
          entityType: "Employment",
          entityId: employment.id,
          metadata: {
            endDate: employment.endDate,
            periodsClosed: changed.length,
            accountingDocument: input.accountingDocument.trim(),
          },
          createdAt: now,
        },
      ];
      plans.push({ employment, periods: persistedPeriods, changed, audits });
    }
    const batchSize = 25;
    for (let index = 0; index < plans.length; index += batchSize) {
      const batch = plans.slice(index, index + batchSize);
      await this.context.store.closeRetiredEmploymentsTransaction(
        batch.map((plan) => plan.employment),
        batch.flatMap((plan) => plan.periods),
        batch.flatMap((plan) => plan.audits),
      );
    }
    return {
      asOf,
      employmentsScanned: employments.length,
      employmentsChanged: plans.length,
      periodsClosed: plans.reduce((total, plan) => total + plan.changed.length, 0),
      accountingDocument: input.accountingDocument.trim(),
    };
  }
}
