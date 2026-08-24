import type {
  EmploymentDetailDto,
  EmploymentSummaryDto,
  VacationPeriodDto,
} from "@vaca-efa/contracts";
import { daysBetween, type LocalDate } from "../../../domain/shared/localDate.js";
import { NotFoundError } from "../../../domain/shared/errors.js";
import type { Employment } from "../../../domain/workers/models.js";
import {
  alertFor,
  closePeriodsAtRetirement,
  createPeriod,
  ensurePeriods,
  overdue,
  pendingDays,
  progress,
  scheduledDays,
} from "../../../domain/vacations/calculations.js";
import type {
  PeriodLifecycle,
  VacationSchedule,
  VacationSettlement,
} from "../../../domain/vacations/models.js";
import type { EmploymentPageQuery, VacationStore } from "../../ports/repositories.js";
import type { VacationServiceContext } from "./context.js";
import type { EmploymentListFilters } from "./types.js";

export class AccrualReadService {
  constructor(private readonly context: VacationServiceContext) {}

  async ensure(employment: Employment, asOf: LocalDate = this.context.clock(), persist = true) {
    const policy = await this.context.store.current(asOf);
    const existing = await this.context.store.findByEmploymentId(employment.id);
    const periods = closePeriodsAtRetirement(
      employment,
      ensurePeriods(employment, existing, policy, asOf),
    );
    if (persist) {
      const newlyClosed = periods.filter((period) => {
        const previous = existing.find((item) => item.id === period.id);
        return period.lifecycleStatus === "CLOSED" && previous?.lifecycleStatus !== "CLOSED";
      });
      if (employment.status === "RETIRED" && employment.endDate && newlyClosed.length) {
        const createdAt = new Date().toISOString();
        await this.context.store.closeRetiredEmploymentTransaction(
          employment,
          periods,
          newlyClosed.map((period) => ({
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
            createdAt,
          })),
        );
      } else {
        await this.context.store.saveMany(periods);
      }
    }
    return periods;
  }

  private summaryFromData(
    employment: Employment,
    worker: NonNullable<Awaited<ReturnType<VacationStore["findWorkerById"]>>>,
    periods: Awaited<ReturnType<VacationStore["findByEmploymentId"]>>,
    settlements: VacationSettlement[],
    schedules: VacationSchedule[],
    policy: Awaited<ReturnType<VacationStore["current"]>>,
    asOf: LocalDate,
  ): EmploymentSummaryDto {
    const generated = closePeriodsAtRetirement(
      employment,
      periods.length ? periods : ensurePeriods(employment, [], policy, asOf),
    );
    const usablePeriods = generated.map((period) => {
      const lifecycleStatus: PeriodLifecycle =
        period.lifecycleStatus === "CLOSED"
          ? "CLOSED"
          : period.causedAt <= asOf
            ? "CAUSED"
            : "FORMING";
      return { ...period, lifecycleStatus };
    });
    const caused = usablePeriods.filter(
      (period) => period.lifecycleStatus !== "FORMING" && period.causedAt <= asOf,
    );
    const lastCausedAt =
      caused.length > 0
        ? caused.reduce(
            (latest, period) => (period.causedAt > latest ? period.causedAt : latest),
            caused[0]!.causedAt,
          )
        : undefined;
    const forming =
      usablePeriods.find((period) => period.lifecycleStatus === "FORMING") ??
      usablePeriods[usablePeriods.length - 1] ??
      createPeriod(employment, 1, employment.startDate, policy, asOf);
    const usedByPeriod = new Map<string, number>();
    for (const settlement of settlements)
      for (const allocation of settlement.allocations)
        usedByPeriod.set(
          allocation.periodId,
          (usedByPeriod.get(allocation.periodId) ?? 0) +
            allocation.enjoyedDays +
            allocation.compensatedDays,
        );
    const scheduledByPeriod = new Map<string, number>();
    for (const schedule of schedules)
      if (schedule.status === "SCHEDULED")
        for (const allocation of schedule.allocations)
          if (allocation.periodId)
            scheduledByPeriod.set(
              allocation.periodId,
              (scheduledByPeriod.get(allocation.periodId) ?? 0) + allocation.days,
            );
    const pends = caused.map((period) =>
      period.lifecycleStatus === "CLOSED" || period.pendingImportReleased
        ? 0
        : Math.max(0, period.entitledDays - (usedByPeriod.get(period.id) ?? 0)),
    );
    const scheduled = caused.map((period) =>
      period.lifecycleStatus === "CLOSED" ? 0 : (scheduledByPeriod.get(period.id) ?? 0),
    );
    const totalPendingDays = pends.reduce((total, value) => total + value, 0);
    const totalScheduledDays = scheduled.reduce((total, value) => total + value, 0);
    const pendingPeriods = pends.filter((value) => value > 0).length;
    const overduePeriods = caused.filter((period, index) =>
      overdue(period, pends[index]!, policy, asOf),
    ).length;
    const vacationStatus =
      overduePeriods > 0
        ? "OVERDUE"
        : totalPendingDays - totalScheduledDays > 0
          ? "PENDING"
          : totalScheduledDays > 0
            ? "SCHEDULED"
            : "CLEAR";
    const next =
      employment.status === "RETIRED" ? (employment.endDate ?? forming.causedAt) : forming.causedAt;
    const days = employment.status === "RETIRED" ? 0 : Math.max(0, daysBetween(asOf, next));
    return {
      id: employment.id,
      workerId: worker.id,
      fullName: worker.fullName,
      documentNumber: worker.documentNumber,
      processName: employment.processName,
      positionName: employment.positionName,
      contractTypeName: employment.contractTypeName,
      ...(employment.endDate ? { endDate: employment.endDate } : {}),
      ...(employment.supervisorName ? { supervisorName: employment.supervisorName } : {}),
      startDate: employment.startDate,
      status: employment.status,
      causedPeriods: caused.length,
      pendingPeriods,
      generatedDays: caused.reduce((total, period) => total + period.entitledDays, 0),
      enjoyedDays: settlements.reduce((total, settlement) => total + settlement.enjoyedDays, 0),
      compensatedDays: settlements.reduce(
        (total, settlement) => total + settlement.compensatedDays,
        0,
      ),
      pendingDays: totalPendingDays,
      scheduledDays: totalScheduledDays,
      availableForScheduling: Math.max(0, totalPendingDays - totalScheduledDays),
      nextAccrualDate: next,
      ...(lastCausedAt ? { lastCausedAt } : {}),
      formingStartDate: forming.accrualStartDate,
      formingEndDate: forming.accrualEndDate,
      daysUntilAccrual: days,
      accrualProgressPercent: progress(forming, asOf),
      overduePeriods,
      vacationStatus,
      alert: employment.status === "RETIRED" ? "NORMAL" : alertFor(days),
    };
  }

  async summariesFor(employments: Employment[], asOf: LocalDate) {
    if (!employments.length) return [];
    const ids = employments.map((item) => item.id);
    const [workers, periods, settlements, schedules, policy] = await Promise.all([
      this.context.store.listWorkersByIds(employments.map((item) => item.workerId)),
      this.context.store.findByEmploymentIds(ids),
      this.context.store.findSettlementsByEmploymentIds(ids),
      this.context.store.findSchedulesByEmploymentIds(ids),
      this.context.store.current(asOf),
    ]);
    const workersById = new Map(workers.map((item) => [item.id, item]));
    const periodsById = new Map<string, Awaited<ReturnType<VacationStore["findByEmploymentId"]>>>(
      ids.map((id) => [id, []]),
    );
    const settlementsById = new Map<string, VacationSettlement[]>(ids.map((id) => [id, []]));
    const schedulesById = new Map<string, VacationSchedule[]>(ids.map((id) => [id, []]));
    for (const item of periods) (periodsById.get(item.employmentId) ?? []).push(item);
    for (const item of settlements) (settlementsById.get(item.employmentId) ?? []).push(item);
    for (const item of schedules) (schedulesById.get(item.employmentId) ?? []).push(item);
    return employments
      .map((employment) => {
        const worker = workersById.get(employment.workerId);
        if (!worker) throw new NotFoundError("Worker not found");
        return this.summaryFromData(
          employment,
          worker,
          periodsById.get(employment.id) ?? [],
          settlementsById.get(employment.id) ?? [],
          schedulesById.get(employment.id) ?? [],
          policy,
          asOf,
        );
      })
      .sort((left, right) => left.fullName.localeCompare(right.fullName, "es"));
  }

  async summary(
    employment: Employment,
    asOf: LocalDate = this.context.clock(),
  ): Promise<EmploymentSummaryDto> {
    const periods = await this.ensure(employment, asOf);
    const [worker, settlements, schedules, policy] = await Promise.all([
      this.context.store.findWorkerById(employment.workerId),
      this.context.store.findSettlementsByEmploymentIds([employment.id]),
      this.context.store.findSchedulesByEmploymentIds([employment.id]),
      this.context.store.current(asOf),
    ]);
    if (!worker) throw new NotFoundError("Worker not found");
    return this.summaryFromData(employment, worker, periods, settlements, schedules, policy, asOf);
  }

  async detail(id: string, asOf: LocalDate = this.context.clock()): Promise<EmploymentDetailDto> {
    const employment = await this.context.store.findEmploymentById(id);
    if (!employment) throw new NotFoundError("Employment not found");
    const periods = await this.ensure(employment, asOf);
    const [worker, settlements, schedules, policy] = await Promise.all([
      this.context.store.findWorkerById(employment.workerId),
      this.context.store.findSettlementsByEmploymentIds([id]),
      this.context.store.findSchedulesByEmploymentIds([id]),
      this.context.store.current(asOf),
    ]);
    if (!worker) throw new NotFoundError("Worker not found");
    const summary = this.summaryFromData(
      employment,
      worker,
      periods,
      settlements,
      schedules,
      policy,
      asOf,
    );
    const usedByPeriod = new Map<string, number>();
    for (const settlement of settlements)
      for (const allocation of settlement.allocations) {
        const used = allocation.enjoyedDays + allocation.compensatedDays;
        if (used > 0)
          usedByPeriod.set(
            allocation.periodId,
            (usedByPeriod.get(allocation.periodId) ?? 0) + used,
          );
      }
    const periodDtos: VacationPeriodDto[] = periods.map((raw) => {
      const lifecycleStatus: PeriodLifecycle =
        raw.lifecycleStatus === "CLOSED" ? "CLOSED" : raw.causedAt <= asOf ? "CAUSED" : "FORMING";
      const period = { ...raw, lifecycleStatus };
      const pending =
        period.lifecycleStatus === "FORMING" || period.lifecycleStatus === "CLOSED"
          ? 0
          : pendingDays(period, settlements);
      const scheduled = scheduledDays(period, schedules);
      const displayStatus =
        (usedByPeriod.get(period.id) ?? 0) > 0 ? "ENJOYED" : period.lifecycleStatus;
      return {
        id: period.id,
        sequence: period.sequence,
        startDate: period.accrualStartDate,
        endDate: period.accrualEndDate,
        causedAt: period.causedAt,
        entitledDays: period.entitledDays,
        lifecycleStatus: period.lifecycleStatus,
        displayStatus,
        ...(period.closureType ? { closureType: period.closureType } : {}),
        ...(period.closureObservation ? { closureObservation: period.closureObservation } : {}),
        ...(period.closureAccountingDocument
          ? { closureAccountingDocument: period.closureAccountingDocument }
          : {}),
        ...(period.closureAmountCOP !== undefined
          ? { closureAmountCOP: period.closureAmountCOP }
          : {}),
        ...(period.closedAt ? { closedAt: period.closedAt } : {}),
        ...(period.closedBy ? { closedBy: period.closedBy } : {}),
        pendingDays: pending,
        scheduledDays: scheduled,
        availableForScheduling: Math.max(0, pending - scheduled),
        isOverdue: overdue(period, pending, policy, asOf),
      };
    });
    return { ...summary, periods: periodDtos, schedules, settlements };
  }

  async list(
    search = "",
    maxDays?: number,
    asOf: LocalDate = this.context.clock(),
    filters: EmploymentListFilters = {},
  ) {
    const items = await this.summariesFor(await this.context.store.listEmployments(), asOf);
    const normalized = search.toLowerCase();
    return items.filter((item) => {
      const haystack =
        `${item.fullName} ${item.documentNumber} ${item.processName} ${item.positionName} ${item.supervisorName ?? ""}`.toLowerCase();
      if (normalized && !haystack.includes(normalized)) return false;
      if (maxDays !== undefined && item.daysUntilAccrual > maxDays) return false;
      if (filters.status && item.status !== filters.status) return false;
      if (
        filters.processName &&
        !item.processName.toLowerCase().includes(filters.processName.toLowerCase())
      )
        return false;
      if (filters.vacationStatus && item.vacationStatus !== filters.vacationStatus) return false;
      if (filters.alert && item.alert !== filters.alert) return false;
      if (filters.fromDate && item.endDate && item.endDate < filters.fromDate) return false;
      if (filters.toDate && item.startDate > filters.toDate) return false;
      return true;
    });
  }

  async listPage(query: {
    page: number;
    pageSize: number;
    search?: string | undefined;
    maxDays?: number | undefined;
    asOf?: LocalDate | undefined;
    filters?: EmploymentListFilters | undefined;
    sortByPendingDays?: boolean | undefined;
  }) {
    const asOf = query.asOf ?? this.context.clock();
    const filters = query.filters ?? {};
    const repoQuery: EmploymentPageQuery = {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.search ? { search: query.search } : {}),
      ...(filters.status === "ACTIVE" || filters.status === "RETIRED"
        ? { status: filters.status }
        : {}),
      ...(filters.processName ? { processName: filters.processName } : {}),
      ...(filters.fromDate ? { fromDate: filters.fromDate } : {}),
      ...(filters.toDate ? { toDate: filters.toDate } : {}),
    };
    if (
      query.maxDays === undefined &&
      !filters.alert &&
      !filters.vacationStatus &&
      !query.sortByPendingDays
    ) {
      const page = await this.context.store.listEmploymentPage(repoQuery);
      return {
        items: await this.summariesFor(page.items, asOf),
        total: page.total,
      };
    }
    const all = await this.list(query.search ?? "", query.maxDays, asOf, filters);
    const ordered = query.sortByPendingDays
      ? all.sort(
          (left, right) =>
            right.pendingDays - left.pendingDays ||
            right.availableForScheduling - left.availableForScheduling ||
            left.fullName.localeCompare(right.fullName, "es") ||
            right.startDate.localeCompare(left.startDate),
        )
      : all;
    const start = (query.page - 1) * query.pageSize;
    return {
      items: ordered.slice(start, start + query.pageSize),
      total: ordered.length,
    };
  }
}
