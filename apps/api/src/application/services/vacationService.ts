import type {
  DashboardDto,
  EmploymentDetailDto,
  EmploymentSummaryDto,
  VacationPeriodDto,
} from "@vaca-efa/contracts";
import {
  daysBetween,
  parseLocalDate,
  today,
  type LocalDate,
} from "../../domain/shared/localDate.js";
import type { Employment } from "../../domain/workers/models.js";
import {
  alertFor,
  closePeriodsAtRetirement,
  createPeriod,
  ensurePeriods,
  overdue,
  pendingDays,
  progress,
  scheduledDays,
} from "../../domain/vacations/calculations.js";
import type {
  ImportBatch,
  PeriodLifecycle,
  VacationPeriod,
  VacationSchedule,
  VacationSettlement,
  VacationSettlementImportBatch,
  VacationSettlementSourceLine,
  VacationPeriodClosureBatch,
  VacationPeriodClosurePlan,
} from "../../domain/vacations/models.js";
import type { VacationAlert } from "../../domain/vacations/alerts.js";
import type {
  AnnualScheduleReportQuery,
  EmploymentPageQuery,
  SchedulePageQuery,
  ScheduleReportItem,
  VacationStore,
} from "../ports/repositories.js";
import {
  groupSettlementLines,
  normalizeSettlementRows,
  type SettlementGroup,
  type SettlementRawRow,
} from "./settlementImport.js";

export interface EmploymentInput {
  documentNumber: string;
  fullName: string;
  startDate: LocalDate;
  endDate?: LocalDate | undefined;
  contractTypeName: string;
  processName: string;
  positionName: string;
  supervisorName?: string | undefined;
}
export interface ScheduleInput {
  employmentId: string;
  startDate: LocalDate;
  endDate: LocalDate;
  scheduledDays: number;
  allocations: VacationSchedule["allocations"];
}
type ScheduleListItem = VacationSchedule & {
  employeeName?: string | undefined;
  employeeDocumentNumber?: string | undefined;
  processName?: string | undefined;
  positionName?: string | undefined;
};
type SettlementReportItem = VacationSettlement & {
  employeeName?: string | undefined;
  employeeDocumentNumber?: string | undefined;
  processName?: string | undefined;
  positionName?: string | undefined;
  supervisorName?: string | undefined;
};
export interface AnnualScheduleReport {
  year: number;
  generatedAt: string;
  preparedBy: string;
  approvedBy: string;
  totalEmployees: number;
  totalSchedules: number;
  totalDays: number;
  monthly: { month: number; label: string; schedules: number; days: number }[];
  items: ScheduleReportItem[];
}
export interface SettlementInput {
  employmentId: string;
  sourceScheduleId?: string | undefined;
  sourceBatchId?: string | undefined;
  source?: VacationSettlement["source"];
  sourceKey?: string | undefined;
  enjoymentStartDate: LocalDate;
  enjoymentEndDate: LocalDate;
  periodEndDate?: LocalDate | undefined;
  enjoyedDays: number;
  compensatedDays: number;
  calendarDays?: number | undefined;
  amountCOP: number;
  accountingDocument: string;
  observation?: string | undefined;
  sourceLines?: VacationSettlementSourceLine[] | undefined;
  allocations: VacationSettlement["allocations"];
}
export interface EmploymentListFilters {
  status?: string | undefined;
  processName?: string | undefined;
  vacationStatus?: string | undefined;
  alert?: string | undefined;
  fromDate?: LocalDate | undefined;
  toDate?: LocalDate | undefined;
}

function failure(message: string, status = 422): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function percentage(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function percentageBreakdown(values: number[], total: number) {
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const result = exact.map((value) => Math.floor(value));
  let remaining = 100 - result.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder);
  for (let index = 0; index < remaining; index++)
    result[order[index % order.length]!.index]!++;
  return result;
}

export class VacationService {
  constructor(
    private readonly store: VacationStore,
    private readonly clock: () => LocalDate = today,
  ) {}
  async ensure(
    employment: Employment,
    asOf: LocalDate = this.clock(),
    persist = true,
  ) {
    const policy = await this.store.current(asOf);
    const existing = await this.store.findByEmploymentId(employment.id);
    const periods = closePeriodsAtRetirement(
      employment,
      ensurePeriods(employment, existing, policy, asOf),
    );
    if (persist) {
      const newlyClosed = periods.filter((period) => {
        const previous = existing.find((item) => item.id === period.id);
        return (
          period.lifecycleStatus === "CLOSED" &&
          previous?.lifecycleStatus !== "CLOSED"
        );
      });
      if (
        employment.status === "RETIRED" &&
        employment.endDate &&
        newlyClosed.length
      ) {
        const createdAt = new Date().toISOString();
        await this.store.closeRetiredEmploymentTransaction(
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
        await this.store.saveMany(periods);
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
      (p) => p.lifecycleStatus !== "FORMING" && p.causedAt <= asOf,
    );
    const forming =
      usablePeriods.find((p) => p.lifecycleStatus === "FORMING") ??
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
              (scheduledByPeriod.get(allocation.periodId) ?? 0) +
                allocation.days,
            );
    const pends = caused.map((p) =>
      p.lifecycleStatus === "CLOSED"
        ? 0
        : Math.max(0, p.entitledDays - (usedByPeriod.get(p.id) ?? 0)),
    );
    const sched = caused.map((p) =>
      p.lifecycleStatus === "CLOSED" ? 0 : scheduledByPeriod.get(p.id) ?? 0,
    );
    const totalPendingDays = pends.reduce((n, p) => n + p, 0);
    const totalScheduledDays = sched.reduce((n, p) => n + p, 0);
    const pendingPeriods = pends.filter((days) => days > 0).length;
    const overduePeriods = caused.filter((p, i) =>
      overdue(p, pends[i]!, policy, asOf),
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
      employment.status === "RETIRED"
        ? employment.endDate ?? forming.causedAt
        : forming.causedAt;
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
      ...(employment.supervisorName
        ? { supervisorName: employment.supervisorName }
        : {}),
      startDate: employment.startDate,
      status: employment.status,
      causedPeriods: caused.length,
      pendingPeriods,
      generatedDays: caused.reduce((n, p) => n + p.entitledDays, 0),
      enjoyedDays: settlements.reduce((n, s) => n + s.enjoyedDays, 0),
      compensatedDays: settlements.reduce((n, s) => n + s.compensatedDays, 0),
      pendingDays: totalPendingDays,
      scheduledDays: totalScheduledDays,
      availableForScheduling: Math.max(
        0,
        totalPendingDays - totalScheduledDays,
      ),
      nextAccrualDate: next,
      formingStartDate: forming.accrualStartDate,
      formingEndDate: forming.accrualEndDate,
      daysUntilAccrual: days,
      accrualProgressPercent: progress(forming, asOf),
      overduePeriods,
      vacationStatus,
      alert: employment.status === "RETIRED" ? "NORMAL" : alertFor(days),
    };
  }
  private async summariesFor(employments: Employment[], asOf: LocalDate) {
    if (!employments.length) return [];
    const ids = employments.map((item) => item.id);
    const [workers, periods, settlements, schedules, policy] =
      await Promise.all([
        this.store.listWorkersByIds(employments.map((item) => item.workerId)),
        this.store.findByEmploymentIds(ids),
        this.store.findSettlementsByEmploymentIds(ids),
        this.store.findSchedulesByEmploymentIds(ids),
        this.store.current(asOf),
      ]);
    const workersById = new Map(workers.map((item) => [item.id, item]));
    const periodsById = new Map<
      string,
      Awaited<ReturnType<VacationStore["findByEmploymentId"]>>
    >(ids.map((id) => [id, []]));
    const settlementsById = new Map<string, VacationSettlement[]>(
      ids.map((id) => [id, []]),
    );
    const schedulesById = new Map<string, VacationSchedule[]>(
      ids.map((id) => [id, []]),
    );
    for (const item of periods)
      (periodsById.get(item.employmentId) ?? []).push(item);
    for (const item of settlements)
      (settlementsById.get(item.employmentId) ?? []).push(item);
    for (const item of schedules)
      (schedulesById.get(item.employmentId) ?? []).push(item);
    return employments
      .map((employment) => {
        const worker = workersById.get(employment.workerId);
        if (!worker) throw failure("Worker not found", 404);
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
      .sort((a, b) => a.fullName.localeCompare(b.fullName, "es"));
  }
  async summary(
    employment: Employment,
    asOf: LocalDate = this.clock(),
  ): Promise<EmploymentSummaryDto> {
    const periods = await this.ensure(employment, asOf);
    const [worker, settlements, schedules, policy] = await Promise.all([
      this.store.findWorkerById(employment.workerId),
      this.store.findSettlementsByEmploymentIds([employment.id]),
      this.store.findSchedulesByEmploymentIds([employment.id]),
      this.store.current(asOf),
    ]);
    if (!worker) throw failure("Worker not found", 404);
    return this.summaryFromData(
      employment,
      worker,
      periods,
      settlements,
      schedules,
      policy,
      asOf,
    );
  }
  async detail(
    id: string,
    asOf: LocalDate = this.clock(),
  ): Promise<EmploymentDetailDto> {
    const employment = await this.store.findEmploymentById(id);
    if (!employment) throw failure("Employment not found", 404);
    const periods = await this.ensure(employment, asOf);
    const [worker, settlements, schedules, policy] = await Promise.all([
      this.store.findWorkerById(employment.workerId),
      this.store.findSettlementsByEmploymentIds([id]),
      this.store.findSchedulesByEmploymentIds([id]),
      this.store.current(asOf),
    ]);
    if (!worker) throw failure("Worker not found", 404);
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
        raw.lifecycleStatus === "CLOSED"
          ? "CLOSED"
          : raw.causedAt <= asOf
            ? "CAUSED"
            : "FORMING";
      const p = { ...raw, lifecycleStatus };
      const pending =
        p.lifecycleStatus === "FORMING" || p.lifecycleStatus === "CLOSED"
          ? 0
          : pendingDays(p, settlements);
      const scheduled = scheduledDays(p, schedules);
      const displayStatus =
        (usedByPeriod.get(p.id) ?? 0) > 0 ? "ENJOYED" : p.lifecycleStatus;
      return {
        id: p.id,
        sequence: p.sequence,
        startDate: p.accrualStartDate,
        endDate: p.accrualEndDate,
        causedAt: p.causedAt,
        entitledDays: p.entitledDays,
        lifecycleStatus: p.lifecycleStatus,
        displayStatus,
        pendingDays: pending,
        scheduledDays: scheduled,
        availableForScheduling: Math.max(0, pending - scheduled),
        isOverdue: overdue(p, pending, policy, asOf),
      };
    });
    return { ...summary, periods: periodDtos, schedules, settlements };
  }
  async list(
    search = "",
    maxDays?: number,
    asOf: LocalDate = this.clock(),
    filters: EmploymentListFilters = {},
  ) {
    const items = await this.summariesFor(
      await this.store.listEmployments(),
      asOf,
    );
    const normalized = search.toLowerCase();
    return items.filter((item) => {
      const haystack =
        `${item.fullName} ${item.documentNumber} ${item.processName} ${item.positionName} ${item.supervisorName ?? ""}`.toLowerCase();
      if (normalized && !haystack.includes(normalized)) return false;
      if (maxDays !== undefined && item.daysUntilAccrual > maxDays)
        return false;
      if (filters.status && item.status !== filters.status) return false;
      if (
        filters.processName &&
        !item.processName
          .toLowerCase()
          .includes(filters.processName.toLowerCase())
      )
        return false;
      if (filters.vacationStatus && item.vacationStatus !== filters.vacationStatus)
        return false;
      if (filters.alert && item.alert !== filters.alert) return false;
      if (filters.fromDate && item.endDate && item.endDate < filters.fromDate)
        return false;
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
    const asOf = query.asOf ?? this.clock();
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
      const page = await this.store.listEmploymentPage(repoQuery);
      return {
        items: await this.summariesFor(page.items, asOf),
        total: page.total,
      };
    }
    const all = await this.list(
      query.search ?? "",
      query.maxDays,
      asOf,
      filters,
    );
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
  async dashboard(
    asOf: LocalDate = this.clock(),
    filters: EmploymentListFilters = {},
  ): Promise<DashboardDto> {
    const employments = await this.store.listEmploymentsByFilter({
      ...(filters.status === "ACTIVE" || filters.status === "RETIRED"
        ? { status: filters.status }
        : {}),
      ...(filters.processName ? { processName: filters.processName } : {}),
      ...(filters.fromDate ? { fromDate: filters.fromDate } : {}),
      ...(filters.toDate ? { toDate: filters.toDate } : {}),
    });
    const items = await this.summariesFor(employments, asOf);
    const activeItems = items.filter((item) => item.status === "ACTIVE");
    const healthCounts = {
      upToDate: 0,
      programmed: 0,
      partial: 0,
      pending: 0,
      overdue: 0,
    };
    for (const item of activeItems) {
      if (item.overduePeriods > 0) healthCounts.overdue++;
      else if (item.availableForScheduling === 0 && item.scheduledDays > 0)
        healthCounts.programmed++;
      else if (item.availableForScheduling > 0 && item.scheduledDays > 0)
        healthCounts.partial++;
      else if (item.availableForScheduling > 0) healthCounts.pending++;
      else healthCounts.upToDate++;
    }
    const healthTotal = activeItems.length;
    const healthPercentages = percentageBreakdown([
      healthCounts.upToDate,
      healthCounts.programmed,
      healthCounts.partial,
      healthCounts.pending,
      healthCounts.overdue,
    ], healthTotal);
    const health = {
      total: healthTotal,
      ...healthCounts,
      upToDatePercent: healthPercentages[0]!,
      programmedPercent: healthPercentages[1]!,
      partialPercent: healthPercentages[2]!,
      pendingPercent: healthPercentages[3]!,
      overduePercent: healthPercentages[4]!,
    };
    const processMap = new Map<string, {
      processName: string;
      activeEmployees: number;
      pendingEmployees: number;
      scheduledEmployees: number;
      overdueEmployees: number;
      pendingDays: number;
      availableDays: number;
      scheduledDays: number;
    }>();
    for (const item of activeItems) {
      const current = processMap.get(item.processName) ?? {
        processName: item.processName,
        activeEmployees: 0,
        pendingEmployees: 0,
        scheduledEmployees: 0,
        overdueEmployees: 0,
        pendingDays: 0,
        availableDays: 0,
        scheduledDays: 0,
      };
      current.activeEmployees++;
      if (item.availableForScheduling > 0) current.pendingEmployees++;
      if (item.scheduledDays > 0) current.scheduledEmployees++;
      if (item.overduePeriods > 0) current.overdueEmployees++;
      current.pendingDays += item.pendingDays;
      current.availableDays += item.availableForScheduling;
      current.scheduledDays += item.scheduledDays;
      processMap.set(item.processName, current);
    }
    const processBreakdown = [...processMap.values()]
      .map((process) => ({
        ...process,
        coveragePercent: process.pendingDays
          ? percentage(process.scheduledDays, process.pendingDays)
          : 100,
      }))
      .sort(
        (left, right) =>
          right.overdueEmployees - left.overdueEmployees ||
          right.availableDays - left.availableDays ||
          left.processName.localeCompare(right.processName, "es"),
      );
    const upcoming = activeItems
      .filter((i) => i.daysUntilAccrual <= 90 && i.status === "ACTIVE")
      .sort((a, b) => a.daysUntilAccrual - b.daysUntilAccrual)
      .slice(0, 25);
    const pendingDays = activeItems.reduce((n, item) => n + item.pendingDays, 0);
    const scheduledDays = activeItems.reduce((n, item) => n + item.scheduledDays, 0);
    return {
      asOf,
      totalEmployees: items.length,
      activeEmployees: activeItems.length,
      pendingPeriods: activeItems.reduce((n, item) => n + item.pendingPeriods, 0),
      pendingDays,
      scheduledDays,
      availableDays: activeItems.reduce((n, item) => n + item.availableForScheduling, 0),
      enjoyedDays: activeItems.reduce((n, item) => n + item.enjoyedDays, 0),
      compensatedDays: activeItems.reduce((n, item) => n + item.compensatedDays, 0),
      pendingEmployees: healthCounts.pending + healthCounts.partial + healthCounts.overdue,
      scheduledEmployees: activeItems.filter((item) => item.scheduledDays > 0).length,
      overdueEmployees: healthCounts.overdue,
      scheduleCoveragePercent: pendingDays ? percentage(scheduledDays, pendingDays) : 100,
      upcoming90Days: activeItems.filter(
        (i) => i.daysUntilAccrual <= 90 && i.status === "ACTIVE",
      ).length,
      priorityCases: activeItems.filter(
        (i) =>
          i.availableForScheduling > 0 && i.daysUntilAccrual <= 30,
      ).length,
      health,
      processBreakdown,
      upcoming,
    };
  }
  async alerts(
    asOf: LocalDate = this.clock(),
  ): Promise<
    Omit<VacationAlert, "id" | "createdAt" | "updatedAt" | "active">[]
  > {
    const items = await this.list("", undefined, asOf);
    const schedules = await this.store.listSchedules();
    const scheduledByEmployment = new Map<string, VacationSchedule[]>();
    for (const schedule of schedules)
      (scheduledByEmployment.get(schedule.employmentId) ?? []).push(schedule);
    const result: Omit<
      VacationAlert,
      "id" | "createdAt" | "updatedAt" | "active"
    >[] = [];
    for (const item of items) {
      if (item.status !== "ACTIVE") continue;
      const dueDate = parseLocalDate(item.nextAccrualDate);
      if (item.daysUntilAccrual <= 90)
        result.push({
          employmentId: item.id,
          type: "UPCOMING_ACCRUAL",
          severity: item.daysUntilAccrual <= 30 ? "WARNING" : "INFO",
          asOf,
          dueDate,
          message: `La próxima causación de ${item.fullName} está prevista para ${item.nextAccrualDate} (${item.daysUntilAccrual} días).`,
        });
      if (item.overduePeriods > 0)
        result.push({
          employmentId: item.id,
          type: "OVERDUE_PERIOD",
          severity: "CRITICAL",
          asOf,
          message: `${item.fullName} tiene ${item.overduePeriods} período(s) vencido(s) sin cerrar.`,
        });
      const upcoming = (scheduledByEmployment.get(item.id) ?? []).some(
        (schedule) =>
          schedule.status === "SCHEDULED" &&
          daysBetween(asOf, schedule.startDate) >= 0 &&
          daysBetween(asOf, schedule.startDate) <= 90,
      );
      if (upcoming)
        result.push({
          employmentId: item.id,
          type: "UPCOMING_VACATION",
          severity: "INFO",
          asOf,
          message: `${item.fullName} tiene vacaciones programadas dentro de los próximos 90 días.`,
        });
      if (item.pendingDays > 0 && item.daysUntilAccrual <= 90)
        result.push({
          employmentId: item.id,
          type: "PENDING_AND_UPCOMING",
          severity: "WARNING",
          asOf,
          dueDate,
          message: `${item.fullName} tiene ${item.pendingDays} día(s) pendientes y una nueva causación próxima.`,
        });
    }
    return result;
  }

  private async workerFor(input: EmploymentInput, now: string) {
    const normalized =
      input.documentNumber.replace(/\D/g, "") ||
      input.documentNumber.trim().toUpperCase();
    let worker = await this.store.findWorkerByNormalizedDocument(normalized);
    if (!worker) {
      worker = {
        id: crypto.randomUUID(),
        documentNumber: input.documentNumber,
        normalizedDocumentNumber: normalized,
        fullName: input.fullName,
        workerType: "EMPLOYEE",
        createdAt: now,
        updatedAt: now,
      };
      await this.store.saveWorker(worker);
      return worker;
    }
    if (
      worker.fullName !== input.fullName ||
      worker.documentNumber !== input.documentNumber
    )
      await this.store.saveWorker({
        ...worker,
        documentNumber: input.documentNumber,
        fullName: input.fullName,
        updatedAt: now,
      });
    return worker;
  }
  async upsertEmployment(input: EmploymentInput, actor = "system") {
    const now = new Date().toISOString();
    const worker = await this.workerFor(input, now);
    const startDate = parseLocalDate(input.startDate);
    const existing = await this.store.findEmploymentByWorkerAndStartDate(
      worker.id,
      startDate,
    );
    const status = input.endDate ? "RETIRED" : "ACTIVE";
    if (existing) {
      const updated: Employment = {
        ...existing,
        startDate,
        ...(input.endDate
          ? { endDate: parseLocalDate(input.endDate) }
          : { endDate: undefined }),
        contractTypeId: input.contractTypeName
          .toLowerCase()
          .replaceAll(" ", "-"),
        contractTypeName: input.contractTypeName,
        processId: input.processName.toLowerCase().replaceAll(" ", "-"),
        processName: input.processName,
        positionId: input.positionName.toLowerCase().replaceAll(" ", "-"),
        positionName: input.positionName,
        ...(input.supervisorName
          ? { supervisorName: input.supervisorName }
          : { supervisorName: undefined }),
        status,
        version: existing.version + 1,
        updatedAt: now,
      };
      await this.store.saveEmployment(updated);
      await this.ensure(updated);
      await this.store.append({
        id: crypto.randomUUID(),
        actorId: actor,
        action: "EMPLOYMENT_UPDATED",
        entityType: "Employment",
        entityId: updated.id,
        metadata: { documentNumber: input.documentNumber, startDate },
        createdAt: now,
      });
      return { summary: this.summary(updated), created: false };
    }
    const employment: Employment = {
      id: crypto.randomUUID(),
      workerId: worker.id,
      startDate,
      ...(input.endDate ? { endDate: parseLocalDate(input.endDate) } : {}),
      contractTypeId: input.contractTypeName.toLowerCase().replaceAll(" ", "-"),
      contractTypeName: input.contractTypeName,
      processId: input.processName.toLowerCase().replaceAll(" ", "-"),
      processName: input.processName,
      positionId: input.positionName.toLowerCase().replaceAll(" ", "-"),
      positionName: input.positionName,
      ...(input.supervisorName ? { supervisorName: input.supervisorName } : {}),
      status,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveEmployment(employment);
    await this.ensure(employment);
    await this.store.append({
      id: crypto.randomUUID(),
      actorId: actor,
      action: "EMPLOYMENT_CREATED",
      entityType: "Employment",
      entityId: employment.id,
      metadata: { documentNumber: input.documentNumber, startDate },
      createdAt: now,
    });
    return { summary: this.summary(employment), created: true };
  }
  async createEmployment(input: EmploymentInput, actor = "system") {
    return (await this.upsertEmployment(input, actor)).summary;
  }
  private checkVersion(actual: number, expected?: number) {
    if (expected !== undefined && actual !== expected)
      throw failure(`Conflict: version ${expected} is stale`, 409);
  }
  async updateEmployment(
    id: string,
    input: EmploymentInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    const existing = await this.store.findEmploymentById(id);
    if (!existing) throw failure("Employment not found", 404);
    this.checkVersion(existing.version, expectedVersion);
    const normalized =
      input.documentNumber.replace(/\D/g, "") ||
      input.documentNumber.trim().toUpperCase();
    const worker = await this.store.findWorkerById(existing.workerId);
    if (!worker) throw failure("Worker not found", 404);
    const duplicate =
      await this.store.findWorkerByNormalizedDocument(normalized);
    if (duplicate && duplicate.id !== worker.id)
      throw failure(
        "The document number already belongs to another worker",
        409,
      );
    await this.store.saveWorker({
      ...worker,
      documentNumber: input.documentNumber,
      normalizedDocumentNumber: normalized,
      fullName: input.fullName,
      updatedAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    const updated: Employment = {
      ...existing,
      startDate: input.startDate,
      ...(input.endDate ? { endDate: input.endDate } : { endDate: undefined }),
      contractTypeName: input.contractTypeName,
      contractTypeId: input.contractTypeName.toLowerCase().replaceAll(" ", "-"),
      processName: input.processName,
      processId: input.processName.toLowerCase().replaceAll(" ", "-"),
      positionName: input.positionName,
      positionId: input.positionName.toLowerCase().replaceAll(" ", "-"),
      ...(input.supervisorName
        ? { supervisorName: input.supervisorName }
        : { supervisorName: undefined }),
      status: input.endDate ? "RETIRED" : "ACTIVE",
      version: existing.version + 1,
      updatedAt: now,
    };
    await this.store.saveEmployment(updated);
    await this.ensure(updated);
    await this.store.append({
      id: crypto.randomUUID(),
      actorId: actor,
      action: "EMPLOYMENT_UPDATED",
      entityType: "Employment",
      entityId: id,
      metadata: { version: updated.version },
      createdAt: now,
    });
    return this.summary(updated);
  }
  async retireEmployment(
    id: string,
    endDate: LocalDate,
    expectedVersion?: number,
    actor = "system",
  ) {
    const existing = await this.store.findEmploymentById(id);
    if (!existing) throw failure("Employment not found", 404);
    this.checkVersion(existing.version, expectedVersion);
    if (endDate < existing.startDate)
      throw failure("Retirement date cannot precede contract date");
    const updated = {
      ...existing,
      endDate,
      status: "RETIRED" as const,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveEmployment(updated);
    await this.ensure(updated);
    await this.store.append({
      id: crypto.randomUUID(),
      actorId: actor,
      action: "EMPLOYMENT_RETIRED",
      entityType: "Employment",
      entityId: id,
      metadata: { endDate },
      createdAt: updated.updatedAt,
    });
    return this.summary(updated);
  }

  async closeRetiredEmployments(
    actor = "system-retirement-closure",
    asOf: LocalDate = this.clock(),
  ) {
    const policy = await this.store.current(asOf);
    const employments = (await this.store.listEmployments()).filter(
      (employment) =>
        employment.status === "RETIRED" &&
        Boolean(employment.endDate) &&
        employment.endDate! <= asOf,
    );
    const storedPeriods = await this.store.findByEmploymentIds(
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
      audits: Parameters<
        VacationStore["closeRetiredEmploymentsTransaction"]
      >[2];
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
          (previous.lifecycleStatus !== "CLOSED" &&
            period.lifecycleStatus === "CLOSED")
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
      await this.store.closeRetiredEmploymentsTransaction(
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

  private async buildVacationPeriodClosurePlan(
    rows: SettlementRawRow[],
    fromDate: LocalDate,
    asOf: LocalDate,
  ) {
    if (fromDate > asOf)
      throw failure("La fecha inicial no puede ser posterior a la fecha de corte");
    const normalized = normalizeSettlementRows(rows);
    const groups = groupSettlementLines(normalized.lines);
    const employments = await this.store.listEmployments();
    const workers = await this.store.listWorkers();
    const workersByDocument = new Map(
      workers.map((worker) => [worker.normalizedDocumentNumber, worker]),
    );
    const employmentsByWorker = new Map<string, Employment[]>();
    for (const employment of employments)
      (
        employmentsByWorker.get(employment.workerId) ??
        employmentsByWorker
          .set(employment.workerId, [])
          .get(employment.workerId)!
      ).push(employment);
    const periods = await this.store.findByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const settlements = await this.store.findSettlementsByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const schedules = await this.store.findSchedulesByEmploymentIds(
      employments.map((employment) => employment.id),
    );
    const periodsByEmployment = new Map<string, VacationPeriod[]>();
    for (const period of periods)
      (
        periodsByEmployment.get(period.employmentId) ??
        periodsByEmployment
          .set(period.employmentId, [])
          .get(period.employmentId)!
      ).push(period);
    const settlementsByEmployment = new Map<string, VacationSettlement[]>();
    const settlementsByPeriod = new Map<string, VacationSettlement[]>();
    for (const settlement of settlements) {
      (
        settlementsByEmployment.get(settlement.employmentId) ??
        settlementsByEmployment
          .set(settlement.employmentId, [])
          .get(settlement.employmentId)!
      ).push(settlement);
      for (const allocation of settlement.allocations)
        (
          settlementsByPeriod.get(allocation.periodId) ??
          settlementsByPeriod
            .set(allocation.periodId, [])
            .get(allocation.periodId)!
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
      const exact = matches.filter(
        (employment) => employment.startDate === line.startDate,
      );
      const employment =
        exact.length === 1
          ? exact[0]
          : matches.length === 1
            ? matches[0]
            : undefined;
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

    const employmentById = new Map(
      employments.map((employment) => [employment.id, employment]),
    );
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
        } else if (oldProtected) {
          decision = "PROTECTED";
          reason =
            protectionReasons.get(employment.id) ??
            (period.lifecycleStatus === "CLOSED"
              ? "Período histórico relacionado con el archivo y ya cerrado; no se modifica"
              : "Período histórico relacionado con una liquidación del archivo de disfrutes");
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
          decision = "KEEP";
          reason = "No tiene saldo pendiente para cerrar";
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
    fromDate: LocalDate = "2025-01-01",
    asOf: LocalDate = this.clock(),
  ) {
    const existing = await this.store.findVacationPeriodClosureByFileHash(
      fileHash,
    );
    if (existing?.status === "APPLIED")
      return {
        alreadyProcessed: existing.status === "APPLIED",
        batch: existing,
        plans: existing.plans,
      };
    const built = await this.buildVacationPeriodClosurePlan(rows, fromDate, asOf);
    const counts = (decision: VacationPeriodClosurePlan["decision"]) =>
      built.plans.filter((plan) => plan.decision === decision).length;
    const batch: VacationPeriodClosureBatch = {
      id: existing?.id ?? crypto.randomUUID(),
      fileName,
      fileHash,
      actorId: actor,
      fromDate,
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
    await this.store.saveVacationPeriodClosureBatch(batch);
    return { alreadyProcessed: false, batch, plans: batch.plans };
  }

  async applyVacationPeriodClosure(
    batchId: string,
    fileName: string,
    fileHash: string,
    previewToken: string,
    rows: SettlementRawRow[],
    actor = "system",
    fromDate: LocalDate = "2025-01-01",
    asOf: LocalDate = this.clock(),
  ) {
    const batch = await this.store.findVacationPeriodClosureBatch(batchId);
    if (!batch) throw failure("No existe la vista previa del cierre masivo", 404);
    if (
      batch.fileName !== fileName ||
      batch.fileHash !== fileHash ||
      batch.previewToken !== previewToken ||
      batch.fromDate !== fromDate ||
      batch.asOf !== asOf
    )
      throw failure("La vista previa está vencida o no coincide con el archivo", 409);
    if (batch.errors.length || batch.reviewPeriods > 0)
      throw failure(
        "El cierre masivo tiene errores o períodos en revisión; resuélvelos antes de aplicar",
        409,
      );
    const current = await this.buildVacationPeriodClosurePlan(rows, fromDate, asOf);
    if (current.errors.length || current.plans.some((plan) => plan.decision === "REVIEW"))
      throw failure("Los datos cambiaron desde la vista previa; genera una nueva vista previa", 409);
    const currentById = new Map(current.plans.map((plan) => [plan.periodId, plan]));
    const storedPeriods = await this.store.findByEmploymentIds(
      [...new Set(batch.plans.map((plan) => plan.employmentId))],
    );
    const periodsById = new Map(storedPeriods.map((period) => [period.id, period]));
    const toClose: VacationPeriod[] = [];
    for (const plan of batch.plans.filter((item) => item.decision === "CLOSE")) {
      const period = periodsById.get(plan.periodId);
      const fresh = currentById.get(plan.periodId);
      if (
        !period ||
        !fresh ||
        period.version !== plan.periodVersion ||
        fresh.decision !== "CLOSE"
      )
        throw failure("Los períodos cambiaron desde la vista previa; genera una nueva vista previa", 409);
      toClose.push({
        ...period,
        lifecycleStatus: "CLOSED",
        closureObservation: batch.observation,
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
          fromDate,
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
          reviewPeriods: batch.reviewPeriods,
          observation: batch.observation,
        },
        createdAt: appliedAt,
      },
    ];
    await this.store.applyVacationPeriodClosure(appliedBatch, toClose, audits);
    return {
      replayed: false,
      batch: appliedBatch,
      closedPeriods: toClose.length,
    };
  }

  private async scheduleValidation(
    input: ScheduleInput,
    ignoreScheduleId?: string,
  ) {
    if (input.endDate < input.startDate)
      throw failure("Schedule end date cannot precede start date");
    const employment = await this.store.findEmploymentById(input.employmentId);
    if (!employment) throw failure("Employment not found", 404);
    if (employment.status !== "ACTIVE")
      throw failure("Only active employments can be scheduled");
    if (input.startDate < employment.startDate)
      throw failure("Schedule cannot start before the employment date");
    if (employment.endDate && input.endDate > employment.endDate)
      throw failure("Schedule cannot extend beyond the employment end date");
    if (
      input.allocations.reduce((n, a) => n + a.days, 0) !== input.scheduledDays
    )
      throw failure("Schedule allocations must equal scheduledDays");
    const detail = await this.detail(employment.id);
    const own = ignoreScheduleId
      ? (detail.schedules.find((s) => s.id === ignoreScheduleId) ?? null)
      : null;
    const periodsById = new Map(
      detail.periods.map((period) => [period.id, period]),
    );
    const futurePeriods = detail.periods.filter(
      (period) => period.lifecycleStatus === "FORMING",
    );
    const keyFor = (allocation: {
      periodId?: string | undefined;
      periodStartDate: string;
      periodEndDate: string;
    }) =>
      allocation.periodId ??
      `${allocation.periodStartDate}|${allocation.periodEndDate}`;
    const availableByKey = new Map<string, number>();
    for (const period of detail.periods) {
      if (period.lifecycleStatus === "CAUSED")
        availableByKey.set(period.id, period.availableForScheduling);
      if (period.lifecycleStatus === "FORMING")
        availableByKey.set(
          `${period.startDate}|${period.endDate}`,
          period.entitledDays,
        );
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
          throw failure("A caused allocation must identify its period");
        const period = periodsById.get(allocation.periodId);
        if (!period || period.lifecycleStatus !== "CAUSED")
          throw failure(
            `Period ${allocation.periodId} is not available for scheduling`,
          );
        if (
          period.startDate !== allocation.periodStartDate ||
          period.endDate !== allocation.periodEndDate
        )
          throw failure(
            `Allocation dates do not match period ${allocation.periodId}`,
          );
      } else {
        if (allocation.periodId)
          throw failure("A future allocation cannot reference a caused period");
        const period = futurePeriods.find(
          (item) =>
            item.startDate === allocation.periodStartDate &&
            item.endDate === allocation.periodEndDate,
        );
        if (!period)
          throw failure(
            "The selected future allocation does not match the forming period",
          );
      }
      requestedByKey.set(key, (requestedByKey.get(key) ?? 0) + allocation.days);
    }
    for (const [key, requested] of requestedByKey) {
      const available = availableByKey.get(key);
      if (available === undefined)
        throw failure("The selected period is not available");
      if (requested > available)
        throw failure(`Schedule exceeds available balance for period ${key}`);
    }
    const holidayWarnings = (await this.store.listHolidays())
      .filter(
        (holiday) =>
          holiday.active &&
          holiday.date >= input.startDate &&
          holiday.date <= input.endDate,
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
      ...(validation.holidayWarnings.length
        ? { holidayWarnings: validation.holidayWarnings }
        : {}),
      status: "SCHEDULED",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveScheduleAndAudit(schedule, {
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
    const existing = await this.store.findScheduleById(id);
    if (!existing) throw failure("Schedule not found", 404);
    this.checkVersion(existing.version, expectedVersion);
    if (existing.status !== "SCHEDULED")
      throw failure("Only scheduled vacations can be edited");
    const validation = await this.scheduleValidation(input, id);
    const updated = {
      ...existing,
      ...input,
      holidayWarnings: validation.holidayWarnings,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveScheduleAndAudit(updated, {
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
    const existing = await this.store.findScheduleById(id);
    if (!existing) throw failure("Schedule not found", 404);
    this.checkVersion(existing.version, expectedVersion);
    if (existing.status !== "SCHEDULED")
      throw failure("Only scheduled vacations can be cancelled");
    const updated = {
      ...existing,
      status: "CANCELLED" as const,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveScheduleAndAudit(updated, {
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
    const page = await this.store.listSchedulePage(query);
    if (!page.items.length) return { items: [], total: page.total };
    const employments = await this.store.findEmploymentsByIds(
      page.items.map((schedule) => schedule.employmentId),
    );
    const workers = await this.store.listWorkersByIds(
      employments.map((employment) => employment.workerId),
    );
    const employmentsById = new Map(
      employments.map((employment) => [employment.id, employment]),
    );
    const workersById = new Map(workers.map((worker) => [worker.id, worker]));
    const items: ScheduleListItem[] = page.items.map((schedule) => {
      const employment = employmentsById.get(schedule.employmentId);
      const worker = employment
        ? workersById.get(employment.workerId)
        : undefined;
      return {
        ...schedule,
        ...(worker?.fullName ? { employeeName: worker.fullName } : {}),
        ...(worker?.documentNumber
          ? { employeeDocumentNumber: worker.documentNumber }
          : {}),
        ...(employment?.processName
          ? { processName: employment.processName }
          : {}),
        ...(employment?.positionName
          ? { positionName: employment.positionName }
          : {}),
      };
    });
    return {
      total: page.total,
      items,
    };
  }

  async annualScheduleReport(
    query: AnnualScheduleReportQuery,
  ): Promise<AnnualScheduleReport> {
    const items = await this.store.listAnnualScheduleReport(query);
    const monthLabels = [
      "Enero",
      "Febrero",
      "Marzo",
      "Abril",
      "Mayo",
      "Junio",
      "Julio",
      "Agosto",
      "Septiembre",
      "Octubre",
      "Noviembre",
      "Diciembre",
    ];
    const monthly = monthLabels.map((label, index) => {
      const month = String(index + 1).padStart(2, "0");
      const lastDay = new Date(Date.UTC(query.year, index + 1, 0))
        .toISOString()
        .slice(0, 10) as LocalDate;
      const monthStart = `${query.year}-${month}-01` as LocalDate;
      const monthItems = items.filter(
        (item) => item.startDate <= lastDay && item.endDate >= monthStart,
      );
      const days = monthItems.reduce((total, item) => {
        const overlapStart = item.startDate > monthStart ? item.startDate : monthStart;
        const overlapEnd = item.endDate < lastDay ? item.endDate : lastDay;
        const fullCalendarDays =
          daysBetween(parseLocalDate(item.startDate), parseLocalDate(item.endDate)) + 1;
        const overlapCalendarDays =
          daysBetween(parseLocalDate(overlapStart), parseLocalDate(overlapEnd)) + 1;
        return total + Math.max(
          1,
          Math.round((item.scheduledDays * overlapCalendarDays) / fullCalendarDays),
        );
      }, 0);
      return {
        month: index + 1,
        label,
        schedules: monthItems.length,
        days,
      };
    });
    return {
      year: query.year,
      generatedAt: new Date().toISOString(),
      preparedBy: "Sistema",
      approvedBy: "Sin configurar",
      totalEmployees: new Set(
        items.map((item) => item.employeeDocumentNumber),
      ).size,
      totalSchedules: items.length,
      totalDays: items.reduce((total, item) => total + item.scheduledDays, 0),
      monthly,
      items,
    };
  }

  private async settlementValidation(
    input: SettlementInput,
    ignoreSettlementId?: string,
  ) {
    if (input.enjoymentEndDate < input.enjoymentStartDate)
      throw failure("Settlement end date cannot precede start date");
    if (
      input.allocations.reduce((n, a) => n + a.enjoyedDays, 0) !==
        input.enjoyedDays ||
      input.allocations.reduce((n, a) => n + a.compensatedDays, 0) !==
        input.compensatedDays
    )
      throw failure("Settlement allocations do not match totals");
    const employment = await this.store.findEmploymentById(input.employmentId);
    if (!employment) throw failure("Employment not found", 404);
    const detail = await this.detail(employment.id);
    const ignored = ignoreSettlementId
      ? detail.settlements.find((s) => s.id === ignoreSettlementId)
      : undefined;
    for (const allocation of input.allocations) {
      const period = detail.periods.find((p) => p.id === allocation.periodId);
      if (!period || period.lifecycleStatus === "FORMING")
        throw failure(`Period ${allocation.periodId} is not available`);
      const otherUsed = detail.settlements
        .filter((s) => s.id !== ignoreSettlementId)
        .flatMap((s) => s.allocations.filter((a) => a.periodId === period.id))
        .reduce((n, a) => n + a.enjoyedDays + a.compensatedDays, 0);
      const restored =
        ignored?.allocations
          .filter((a) => a.periodId === period.id)
          .reduce((n, a) => n + a.enjoyedDays + a.compensatedDays, 0) ?? 0;
      if (
        allocation.enjoyedDays + allocation.compensatedDays >
        period.entitledDays - otherUsed + restored
      )
        throw failure(`Settlement exceeds period balance for ${period.id}`);
    }
    return employment;
  }
  private buildSettlement(
    input: SettlementInput,
    existing: VacationSettlement | undefined,
    employment: Employment,
    now: string,
  ): VacationSettlement {
    const periodEndDate =
      input.periodEndDate ?? existing?.periodEndDate ?? input.enjoymentEndDate;
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
      calendarDays:
        input.calendarDays ?? existing?.calendarDays ?? input.enjoyedDays,
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
    await this.store.saveSettlement(settlement);
    await this.store.append({
      id: crypto.randomUUID(),
      actorId: actor,
      action: existing
        ? "VACATION_SETTLEMENT_UPDATED"
        : "VACATION_SETTLEMENT_REGISTERED",
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
    return this.store.listSettlementPage(query);
  }
  async settlementReport(query: {
    search?: string | undefined;
    status?: VacationSettlement["status"] | undefined;
  }): Promise<SettlementReportItem[]> {
    const settlements = await this.store.listSettlements(
      query.status === undefined || query.status === "ANULADA",
    );
    const employments = await this.store.findEmploymentsByIds(
      [...new Set(settlements.map((item) => item.employmentId))],
    );
    const workers = await this.store.listWorkersByIds(
      employments.map((item) => item.workerId),
    );
    const employmentsById = new Map(
      employments.map((employment) => [employment.id, employment]),
    );
    const workersById = new Map(workers.map((worker) => [worker.id, worker]));
    const search = query.search?.trim().toLowerCase();
    return settlements
      .filter((settlement) => {
        if (query.status && settlement.status !== query.status) return false;
        if (!search) return true;
        const employment = employmentsById.get(settlement.employmentId);
        const worker = employment
          ? workersById.get(employment.workerId)
          : undefined;
        const haystack = [
          settlement.employmentId,
          settlement.accountingDocument,
          settlement.sourceKey,
          worker?.documentNumber,
          worker?.fullName,
          employment?.processName,
          employment?.positionName,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(search);
      })
      .map((settlement) => {
        const employment = employmentsById.get(settlement.employmentId);
        const worker = employment
          ? workersById.get(employment.workerId)
          : undefined;
        return {
          ...settlement,
          ...(worker?.fullName ? { employeeName: worker.fullName } : {}),
          ...(worker?.documentNumber
            ? { employeeDocumentNumber: worker.documentNumber }
            : {}),
          ...(employment?.processName
            ? { processName: employment.processName }
            : {}),
          ...(employment?.positionName
            ? { positionName: employment.positionName }
            : {}),
          ...(employment?.supervisorName
            ? { supervisorName: employment.supervisorName }
            : {}),
        };
      })
      .sort(
        (left, right) =>
          left.periodEndDate.localeCompare(right.periodEndDate) * -1 ||
          (left.employeeName ?? "").localeCompare(
            right.employeeName ?? "",
            "es",
          ),
      );
  }
  async updateSettlement(
    id: string,
    input: SettlementInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    const existing = await this.store.findSettlementById(id);
    if (!existing) throw failure("Settlement not found", 404);
    if (existing.status === "ANULADA")
      throw failure("An annulled settlement cannot be edited");
    this.checkVersion(existing.version, expectedVersion);
    return this.saveSettlement(input, existing, actor);
  }
  async annulSettlement(
    id: string,
    reason: string,
    expectedVersion?: number,
    actor = "system",
  ) {
    const existing = await this.store.findSettlementById(id);
    if (!existing) throw failure("Settlement not found", 404);
    if (existing.status === "ANULADA") return existing;
    this.checkVersion(existing.version, expectedVersion);
    if (!reason.trim())
      throw failure("A reason is required to annul a settlement");
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
    await this.store.saveSettlementAndAudit(updated, {
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
  private async importGroups(
    groups: SettlementGroup[],
    asOf: LocalDate,
    persistPeriods = false,
  ) {
    const employments = await this.store.listEmployments();
    const workers = await this.store.listWorkers();
    const workersByDocument = new Map(
      workers.map((worker) => [worker.normalizedDocumentNumber, worker]),
    );
    const employmentsByWorker = new Map<string, Employment[]>();
    for (const employment of employments)
      (
        employmentsByWorker.get(employment.workerId) ??
        employmentsByWorker
          .set(employment.workerId, [])
          .get(employment.workerId)!
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
        exact.length === 1
          ? exact[0]
          : matches.length === 1
            ? matches[0]
            : undefined;
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
        periods = await this.ensure(employment, asOf, persistPeriods);
        periodsByEmployment.set(employment.id, periods);
      }
      let activeSettlements = settlementsByEmployment.get(employment.id);
      if (!activeSettlements) {
        activeSettlements = await this.store.findSettlementsByEmploymentIds([
          employment.id,
        ]);
        settlementsByEmployment.set(employment.id, activeSettlements);
      }
      const sourceKey = `${employment.id}|${group.normalizedDocument}|${group.accountingDocument.toUpperCase()}`;
      const existingResult =
        await this.store.findSettlementBySourceKey(sourceKey);
      const existing = existingResult ?? undefined;
      if (existing?.status === "ANULADA") {
        plans.push({
          group,
          existing,
          status: "CONFLICT",
          reason:
            "La liquidación existe pero está anulada; requiere reactivación manual",
          employment,
          periods,
          affectedPeriods: existing.allocations.map(
            (allocation) => allocation.periodId,
          ),
          warnings,
          before: { status: existing.status, version: existing.version },
          after: {},
        });
        continue;
      }
      const same = existing
        ? this.sameImportedSettlement(existing, group)
        : false;
      const affected = periods
        .filter(
          (period) =>
            period.accrualStartDate <= group.rangeEnd &&
            period.accrualEndDate >= group.rangeStart,
        )
        .sort((a, b) => a.sequence - b.sequence);
      const allocations = this.allocateGroup(
        group,
        affected,
        activeSettlements,
        existing?.id,
      );
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
      const sourceLines = group.lines.map(
        ({ normalizedDocument: _, ...line }) => line,
      );
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
        observation:
          group.periodEndDate < "2025-01-01"
            ? "Liquidación masiva por migración"
            : undefined,
      };
      const settlement = this.buildSettlement(
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
  private sameImportedSettlement(
    existing: VacationSettlement,
    group: SettlementGroup,
  ) {
    const sourceHashes = (existing.sourceLines ?? [])
      .map((line) => line.lineHash)
      .join(",");
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
        reason:
          "No hay períodos del sistema que cubran el rango de la liquidación",
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
                  (sum, allocation) =>
                    sum + allocation.enjoyedDays + allocation.compensatedDays,
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
        const taken = Math.min(
          remainingTaken,
          Math.max(0, capacity - compensated),
        );
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
    asOf: LocalDate = this.clock(),
  ) {
    const already =
      await this.store.findVacationSettlementImportByFileHash(fileHash);
    if (already && already.status === "APPLIED")
      return { alreadyProcessed: true, batch: already, groups: [] };
    const normalized = normalizeSettlementRows(rows);
    const groups = groupSettlementLines(normalized.lines);
    const plans = await this.importGroups(groups, asOf, false);
    const batch: VacationSettlementImportBatch = {
      id: crypto.randomUUID(),
      fileName,
      fileHash,
      actorId: actor,
      status: "PREVIEW",
      totalRows: rows.length,
      totalSettlements: groups.length,
      newSettlements: plans.filter((plan) => plan.status === "NEW").length,
      unchangedSettlements: plans.filter((plan) => plan.status === "UNCHANGED")
        .length,
      modifiedSettlements: plans.filter((plan) => plan.status === "MODIFIED")
        .length,
      conflicts: plans.filter((plan) => plan.status === "CONFLICT").length,
      invalidRows: normalized.errors.length,
      migrationPeriods: new Set(
        plans.flatMap((plan) =>
          plan.periods
            .filter((period) => period.accrualEndDate < "2025-01-01")
            .map((period) => period.id),
        ),
      ).size,
      warnings: plans.flatMap((plan) => plan.warnings),
      errors: normalized.errors,
      previewToken: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.store.saveVacationSettlementImportBatch(batch);
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
    asOf: LocalDate = this.clock(),
  ) {
    const batch = await this.store.findVacationSettlementImportBatch(batchId);
    if (!batch) throw failure("Import preview not found", 404);
    if (
      batch.fileHash !== fileHash ||
      batch.fileName !== fileName ||
      batch.previewToken !== previewToken
    )
      throw failure(
        "The import preview is stale or does not match the selected file",
        409,
      );
    const replayed = batch.status === "APPLIED";
    const normalized = normalizeSettlementRows(rows);
    const plans = await this.importGroups(
      groupSettlementLines(normalized.lines),
      asOf,
      false,
    );
    const conflicts = plans.filter((plan) => plan.status === "CONFLICT");
    if (conflicts.length || normalized.errors.length)
      throw failure(
        "The import contains conflicts or invalid rows; resolve the preview before applying",
      );
    const settlements = plans
      .filter((plan) => plan.settlement && plan.status !== "UNCHANGED")
      .map((plan) => plan.settlement!);
    const periodMap = new Map<string, VacationPeriod>();
    for (const plan of plans)
      for (const period of plan.periods) periodMap.set(period.id, period);
    for (const plan of plans) {
      for (const period of plan.periods) {
        if (
          period.accrualEndDate < "2025-01-01" &&
          period.lifecycleStatus !== "CLOSED"
        )
          periodMap.set(period.id, {
            ...period,
            lifecycleStatus: "CLOSED",
            closureObservation: "Liquidación masiva por migración",
            updatedAt: new Date().toISOString(),
            version: period.version + 1,
          });
      }
    }
    const periods = [...periodMap.values()];
    const appliedBatch = {
      ...batch,
      status: "APPLIED" as const,
      authorizedAt: batch.authorizedAt ?? new Date().toISOString(),
      appliedAt: new Date().toISOString(),
      actorId: actor,
    };
    const importedScheduleIds = plans.flatMap((plan) =>
      plan.settlement ? [`imported-settlement:${plan.settlement.id}`] : [],
    );
    const existingSchedules = new Map(
      (await this.store.findSchedulesByIds(importedScheduleIds)).map((schedule) => [
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
      const scheduledDays = settlement
        ? settlement.enjoyedDays + settlement.compensatedDays
        : 0;
      if (!settlement || scheduledDays <= 0) continue;
      const allocations = settlement.allocations
        .map((allocation) => {
          const period = plan.periods.find(
            (item) => item.id === allocation.periodId,
          );
          if (!period)
            throw failure(
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
        action: existing
          ? "VACATION_SCHEDULE_IMPORTED_UPDATED"
          : "VACATION_SCHEDULE_IMPORTED",
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
    }[] = settlements.map((settlement) => ({
      id: crypto.randomUUID(),
      actorId: actor,
      action:
        settlement.version === 1
          ? "VACATION_SETTLEMENT_IMPORTED"
          : "VACATION_SETTLEMENT_UPDATED",
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
    }));
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
        closedPeriods: periods.length,
        importedSchedules: schedules.length,
      },
      createdAt: appliedBatch.appliedAt!,
    });
    await this.store.applyVacationSettlementImport(
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
      closedPeriods: periods.length,
      createdSchedules: schedules.filter((item) => item.version === 1).length,
      updatedSchedules: schedules.filter((item) => item.version > 1).length,
    };
  }
  async completeSchedule(
    id: string,
    input: SettlementInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    const schedule = await this.store.findScheduleById(id);
    if (!schedule) throw failure("Schedule not found", 404);
    this.checkVersion(schedule.version, expectedVersion);
    if (schedule.status !== "SCHEDULED")
      throw failure("Only scheduled vacations can be converted");
    if (input.enjoyedDays + input.compensatedDays !== schedule.scheduledDays)
      throw failure(
        "The enjoyment and compensation totals must match the scheduled days",
      );
    const settlementInput = {
      ...input,
      employmentId: schedule.employmentId,
      sourceScheduleId: id,
    };
    const employment = await this.settlementValidation(settlementInput);
    const now = new Date().toISOString();
    const settlement = this.buildSettlement(
      settlementInput,
      undefined,
      employment,
      now,
    );
    const updated = {
      ...schedule,
      status: "COMPLETED" as const,
      version: schedule.version + 1,
      updatedAt: now,
    };
    await this.store.completeScheduleTransaction(updated, settlement, [
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
  async createImportBatch(key: string, totalRows: number) {
    const existing = await this.store.findImportBatchByIdempotencyKey(key);
    if (existing) return existing;
    const batch: ImportBatch = {
      id: crypto.randomUUID(),
      idempotencyKey: key,
      entityType: "EMPLOYMENT",
      status: "PROCESSING",
      totalRows,
      createdRows: 0,
      updatedRows: 0,
      invalidRows: 0,
      errorSummary: [],
      createdAt: new Date().toISOString(),
    };
    await this.store.saveImportBatch(batch);
    return null;
  }
  async finishImportBatch(
    batch: ImportBatch,
    counts: Pick<
      ImportBatch,
      "createdRows" | "updatedRows" | "invalidRows" | "errorSummary"
    >,
  ) {
    const final: ImportBatch = {
      ...batch,
      ...counts,
      status: counts.invalidRows ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
      completedAt: new Date().toISOString(),
    };
    await this.store.saveImportBatch(final);
    return final;
  }
  async seed() {
    // No se incrustan personas de ejemplo en el código. La carga inicial debe
    // venir del importador o de la administración del sistema.
  }
}
