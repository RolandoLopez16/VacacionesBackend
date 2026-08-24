import { BusinessRuleError, NotFoundError } from "../../../domain/shared/errors.js";
import type { VacationSchedule } from "../../../domain/vacations/models.js";
import type { SchedulePageQuery } from "../../ports/repositories.js";
import { AccrualReadService } from "./accrualReadService.js";
import { checkVersion, type VacationServiceContext } from "./context.js";
import type { ScheduleInput, ScheduleListItem } from "./types.js";

export class ScheduleService {
  constructor(
    private readonly context: VacationServiceContext,
    private readonly readService: AccrualReadService,
  ) {}

  private async scheduleValidation(input: ScheduleInput, ignoreScheduleId?: string) {
    if (input.endDate < input.startDate)
      throw new BusinessRuleError("Schedule end date cannot precede start date");
    const employment = await this.context.store.findEmploymentById(input.employmentId);
    if (!employment) throw new NotFoundError("Employment not found");
    if (employment.status !== "ACTIVE")
      throw new BusinessRuleError("Only active employments can be scheduled");
    if (input.startDate < employment.startDate)
      throw new BusinessRuleError("Schedule cannot start before the employment date");
    if (employment.endDate && input.endDate > employment.endDate)
      throw new BusinessRuleError("Schedule cannot extend beyond the employment end date");
    if (
      input.allocations.reduce((total, allocation) => total + allocation.days, 0) !==
      input.scheduledDays
    )
      throw new BusinessRuleError("Schedule allocations must equal scheduledDays");
    const detail = await this.readService.detail(employment.id);
    const own = ignoreScheduleId
      ? (detail.schedules.find((schedule) => schedule.id === ignoreScheduleId) ?? null)
      : null;
    const periodsById = new Map(detail.periods.map((period) => [period.id, period]));
    const futurePeriods = detail.periods.filter((period) => period.lifecycleStatus === "FORMING");
    const keyFor = (allocation: {
      periodId?: string | undefined;
      periodStartDate: string;
      periodEndDate: string;
    }) => allocation.periodId ?? `${allocation.periodStartDate}|${allocation.periodEndDate}`;
    const availableByKey = new Map<string, number>();
    for (const period of detail.periods) {
      if (period.lifecycleStatus === "CAUSED")
        availableByKey.set(period.id, period.availableForScheduling);
      if (period.lifecycleStatus === "FORMING")
        availableByKey.set(`${period.startDate}|${period.endDate}`, period.entitledDays);
    }
    for (const allocation of own?.allocations ?? []) {
      const key = keyFor(allocation);
      availableByKey.set(key, (availableByKey.get(key) ?? 0) + allocation.days);
    }
    const requestedByKey = new Map<string, number>();
    for (const allocation of input.allocations) {
      const key = keyFor(allocation);
      if (allocation.periodType === "CAUSED") {
        if (!allocation.periodId)
          throw new BusinessRuleError("A caused allocation must identify its period");
        const period = periodsById.get(allocation.periodId);
        if (!period || period.lifecycleStatus !== "CAUSED")
          throw new BusinessRuleError(
            `Period ${allocation.periodId} is not available for scheduling`,
          );
        if (
          period.startDate !== allocation.periodStartDate ||
          period.endDate !== allocation.periodEndDate
        )
          throw new BusinessRuleError(
            `Allocation dates do not match period ${allocation.periodId}`,
          );
      } else {
        if (allocation.periodId)
          throw new BusinessRuleError("A future allocation cannot reference a caused period");
        const period = futurePeriods.find(
          (item) =>
            item.startDate === allocation.periodStartDate &&
            item.endDate === allocation.periodEndDate,
        );
        if (!period)
          throw new BusinessRuleError(
            "The selected future allocation does not match the forming period",
          );
      }
      requestedByKey.set(key, (requestedByKey.get(key) ?? 0) + allocation.days);
    }
    for (const [key, requested] of requestedByKey) {
      const available = availableByKey.get(key);
      if (available === undefined)
        throw new BusinessRuleError("The selected period is not available");
      if (requested > available)
        throw new BusinessRuleError(`Schedule exceeds available balance for period ${key}`);
    }
    const holidayWarnings = (await this.context.store.listHolidays())
      .filter(
        (holiday) =>
          holiday.active && holiday.date >= input.startDate && holiday.date <= input.endDate,
      )
      .map((holiday) => holiday.date);
    return { employment, holidayWarnings };
  }

  async createSchedule(input: ScheduleInput, actor = "system") {
    const validation = await this.scheduleValidation(input);
    const now = new Date().toISOString();
    const schedule: VacationSchedule = {
      id: crypto.randomUUID(),
      employmentId: validation.employment.id,
      startDate: input.startDate,
      endDate: input.endDate,
      scheduledDays: input.scheduledDays,
      allocations: input.allocations,
      ...(validation.holidayWarnings.length ? { holidayWarnings: validation.holidayWarnings } : {}),
      status: "SCHEDULED",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.context.store.saveScheduleAndAudit(schedule, {
      id: crypto.randomUUID(),
      actorId: actor,
      action: "VACATION_SCHEDULED",
      entityType: "VacationSchedule",
      entityId: schedule.id,
      metadata: {
        scheduledDays: schedule.scheduledDays,
        holidayWarnings: validation.holidayWarnings,
      },
      createdAt: now,
    });
    return schedule;
  }

  async updateSchedule(
    id: string,
    input: ScheduleInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    const existing = await this.context.store.findScheduleById(id);
    if (!existing) throw new NotFoundError("Schedule not found");
    checkVersion(existing.version, expectedVersion);
    if (existing.status !== "SCHEDULED")
      throw new BusinessRuleError("Only scheduled vacations can be edited");
    const validation = await this.scheduleValidation(input, id);
    const updated = {
      ...existing,
      ...input,
      holidayWarnings: validation.holidayWarnings,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.context.store.saveScheduleAndAudit(updated, {
      id: crypto.randomUUID(),
      actorId: actor,
      action: "VACATION_RESCHEDULED",
      entityType: "VacationSchedule",
      entityId: id,
      metadata: {
        version: updated.version,
        holidayWarnings: validation.holidayWarnings,
      },
      createdAt: updated.updatedAt,
    });
    return updated;
  }

  async cancelSchedule(id: string, expectedVersion?: number, actor = "system") {
    const existing = await this.context.store.findScheduleById(id);
    if (!existing) throw new NotFoundError("Schedule not found");
    checkVersion(existing.version, expectedVersion);
    if (existing.status !== "SCHEDULED")
      throw new BusinessRuleError("Only scheduled vacations can be cancelled");
    const updated = {
      ...existing,
      status: "CANCELLED" as const,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.context.store.saveScheduleAndAudit(updated, {
      id: crypto.randomUUID(),
      actorId: actor,
      action: "VACATION_SCHEDULE_CANCELLED",
      entityType: "VacationSchedule",
      entityId: id,
      metadata: {},
      createdAt: updated.updatedAt,
    });
    return updated;
  }

  async schedulePage(
    query: SchedulePageQuery,
  ): Promise<{ items: ScheduleListItem[]; total: number }> {
    const page = await this.context.store.listSchedulePage(query);
    if (!page.items.length) return { items: [], total: page.total };
    const employments = await this.context.store.findEmploymentsByIds(
      page.items.map((schedule) => schedule.employmentId),
    );
    const workers = await this.context.store.listWorkersByIds(
      employments.map((employment) => employment.workerId),
    );
    const employmentsById = new Map(employments.map((employment) => [employment.id, employment]));
    const workersById = new Map(workers.map((worker) => [worker.id, worker]));
    const items: ScheduleListItem[] = page.items.map((schedule) => {
      const employment = employmentsById.get(schedule.employmentId);
      const worker = employment ? workersById.get(employment.workerId) : undefined;
      return {
        ...schedule,
        ...(worker?.fullName ? { employeeName: worker.fullName } : {}),
        ...(worker?.documentNumber ? { employeeDocumentNumber: worker.documentNumber } : {}),
        ...(employment?.processName ? { processName: employment.processName } : {}),
        ...(employment?.positionName ? { positionName: employment.positionName } : {}),
      };
    });
    return {
      total: page.total,
      items,
    };
  }
}
