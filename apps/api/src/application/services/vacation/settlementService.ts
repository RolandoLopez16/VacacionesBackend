import { BusinessRuleError, NotFoundError } from "../../../domain/shared/errors.js";
import type { LocalDate } from "../../../domain/shared/localDate.js";
import type { Employment } from "../../../domain/workers/models.js";
import type { VacationSettlement } from "../../../domain/vacations/models.js";
import { AccrualReadService } from "./accrualReadService.js";
import { checkVersion, type VacationServiceContext } from "./context.js";
import type { SettlementInput } from "./types.js";

export class SettlementService {
  constructor(
    private readonly context: VacationServiceContext,
    private readonly readService: AccrualReadService,
  ) {}

  private async settlementValidation(input: SettlementInput, ignoreSettlementId?: string) {
    if (input.enjoymentEndDate < input.enjoymentStartDate)
      throw new BusinessRuleError("Settlement end date cannot precede start date");
    if (
      input.allocations.reduce((total, allocation) => total + allocation.enjoyedDays, 0) !==
        input.enjoyedDays ||
      input.allocations.reduce((total, allocation) => total + allocation.compensatedDays, 0) !==
        input.compensatedDays
    )
      throw new BusinessRuleError("Settlement allocations do not match totals");
    const employment = await this.context.store.findEmploymentById(input.employmentId);
    if (!employment) throw new NotFoundError("Employment not found");
    const detail = await this.readService.detail(employment.id);
    const ignored = ignoreSettlementId
      ? detail.settlements.find((settlement) => settlement.id === ignoreSettlementId)
      : undefined;
    for (const allocation of input.allocations) {
      const period = detail.periods.find((item) => item.id === allocation.periodId);
      if (!period || period.lifecycleStatus === "FORMING")
        throw new BusinessRuleError(`Period ${allocation.periodId} is not available`);
      const otherUsed = detail.settlements
        .filter((settlement) => settlement.id !== ignoreSettlementId)
        .flatMap((settlement) =>
          settlement.allocations.filter((item) => item.periodId === period.id),
        )
        .reduce((total, item) => total + item.enjoyedDays + item.compensatedDays, 0);
      const restored =
        ignored?.allocations
          .filter((item) => item.periodId === period.id)
          .reduce((total, item) => total + item.enjoyedDays + item.compensatedDays, 0) ?? 0;
      if (
        allocation.enjoyedDays + allocation.compensatedDays >
        period.entitledDays - otherUsed + restored
      )
        throw new BusinessRuleError(`Settlement exceeds period balance for ${period.id}`);
    }
    return employment;
  }

  buildSettlement(
    input: SettlementInput,
    existing: VacationSettlement | undefined,
    employment: Employment,
    now: string,
  ): VacationSettlement {
    const periodEndDate = input.periodEndDate ?? existing?.periodEndDate ?? input.enjoymentEndDate;
    return {
      id: existing?.id ?? crypto.randomUUID(),
      employmentId: employment.id,
      ...(input.sourceScheduleId
        ? { sourceScheduleId: input.sourceScheduleId }
        : existing?.sourceScheduleId
          ? { sourceScheduleId: existing.sourceScheduleId }
          : {}),
      ...(input.sourceBatchId
        ? { sourceBatchId: input.sourceBatchId }
        : existing?.sourceBatchId
          ? { sourceBatchId: existing.sourceBatchId }
          : {}),
      ...(input.sourceKey
        ? { sourceKey: input.sourceKey }
        : existing?.sourceKey
          ? { sourceKey: existing.sourceKey }
          : {}),
      source: input.source ?? existing?.source ?? "MANUAL",
      status: existing?.status ?? "ACTIVE",
      enjoymentStartDate: input.enjoymentStartDate,
      enjoymentEndDate: input.enjoymentEndDate,
      periodEndDate,
      enjoyedDays: input.enjoyedDays,
      compensatedDays: input.compensatedDays,
      calendarDays: input.calendarDays ?? existing?.calendarDays ?? input.enjoyedDays,
      amountCOP: input.amountCOP,
      accountingDocument: input.accountingDocument,
      ...(input.observation !== undefined
        ? { observation: input.observation }
        : existing?.observation
          ? { observation: existing.observation }
          : {}),
      ...(input.sourceLines
        ? { sourceLines: input.sourceLines }
        : existing?.sourceLines
          ? { sourceLines: existing.sourceLines }
          : {}),
      allocations: input.allocations,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private async saveSettlement(
    input: SettlementInput,
    existing: VacationSettlement | undefined,
    actor: string,
  ) {
    const employment = await this.settlementValidation(input, existing?.id);
    const now = new Date().toISOString();
    const settlement = this.buildSettlement(input, existing, employment, now);
    await this.context.store.saveSettlement(settlement);
    await this.context.store.append({
      id: crypto.randomUUID(),
      actorId: actor,
      action: existing ? "VACATION_SETTLEMENT_UPDATED" : "VACATION_SETTLEMENT_REGISTERED",
      entityType: "VacationSettlement",
      entityId: settlement.id,
      metadata: {
        enjoyedDays: settlement.enjoyedDays,
        compensatedDays: settlement.compensatedDays,
      },
      createdAt: now,
    });
    return settlement;
  }

  async createSettlement(input: SettlementInput, actor = "system") {
    return this.saveSettlement(input, undefined, actor);
  }

  async settlementPage(query: {
    page: number;
    pageSize: number;
    employmentId?: string | undefined;
    search?: string | undefined;
    status?: VacationSettlement["status"] | undefined;
    fromDate?: LocalDate | undefined;
    toDate?: LocalDate | undefined;
  }) {
    return this.context.store.listSettlementPage(query);
  }

  async updateSettlement(
    id: string,
    input: SettlementInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    const existing = await this.context.store.findSettlementById(id);
    if (!existing) throw new NotFoundError("Settlement not found");
    if (existing.status === "ANULADA")
      throw new BusinessRuleError("An annulled settlement cannot be edited");
    checkVersion(existing.version, expectedVersion);
    return this.saveSettlement(input, existing, actor);
  }

  async annulSettlement(id: string, reason: string, expectedVersion?: number, actor = "system") {
    const existing = await this.context.store.findSettlementById(id);
    if (!existing) throw new NotFoundError("Settlement not found");
    if (existing.status === "ANULADA") return existing;
    checkVersion(existing.version, expectedVersion);
    if (!reason.trim()) throw new BusinessRuleError("A reason is required to annul a settlement");
    const now = new Date().toISOString();
    const updated: VacationSettlement = {
      ...existing,
      status: "ANULADA",
      version: existing.version + 1,
      cancelledAt: now,
      cancelledBy: actor,
      cancellationReason: reason.trim(),
      updatedAt: now,
    };
    await this.context.store.saveSettlementAndAudit(updated, {
      id: crypto.randomUUID(),
      actorId: actor,
      action: "VACATION_SETTLEMENT_ANNULLED",
      entityType: "VacationSettlement",
      entityId: id,
      metadata: {
        reason: reason.trim(),
        version: updated.version,
        sourceBatchId: existing.sourceBatchId,
      },
      createdAt: now,
    });
    return updated;
  }

  async completeSchedule(
    id: string,
    input: SettlementInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    const schedule = await this.context.store.findScheduleById(id);
    if (!schedule) throw new NotFoundError("Schedule not found");
    checkVersion(schedule.version, expectedVersion);
    if (schedule.status !== "SCHEDULED")
      throw new BusinessRuleError("Only scheduled vacations can be converted");
    if (input.enjoyedDays + input.compensatedDays !== schedule.scheduledDays)
      throw new BusinessRuleError(
        "The enjoyment and compensation totals must match the scheduled days",
      );
    const settlementInput = {
      ...input,
      employmentId: schedule.employmentId,
      sourceScheduleId: id,
    };
    const employment = await this.settlementValidation(settlementInput);
    const now = new Date().toISOString();
    const settlement = this.buildSettlement(settlementInput, undefined, employment, now);
    const updated = {
      ...schedule,
      status: "COMPLETED" as const,
      version: schedule.version + 1,
      updatedAt: now,
    };
    await this.context.store.completeScheduleTransaction(updated, settlement, [
      {
        id: crypto.randomUUID(),
        actorId: actor,
        action: "VACATION_SETTLEMENT_REGISTERED",
        entityType: "VacationSettlement",
        entityId: settlement.id,
        metadata: {
          enjoyedDays: settlement.enjoyedDays,
          compensatedDays: settlement.compensatedDays,
          sourceScheduleId: id,
        },
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        actorId: actor,
        action: "VACATION_SCHEDULE_COMPLETED",
        entityType: "VacationSchedule",
        entityId: id,
        metadata: { settlementId: settlement.id },
        createdAt: now,
      },
    ]);
    return { schedule: updated, settlement };
  }
}
