import type {
  AlertPageDto,
  AuditPageDto,
  CatalogPageDto,
  DashboardDetailKind,
  DashboardDetailPageDto,
  DashboardDto,
  DashboardHealthStatus,
  EmploymentSummaryDto,
  HolidayPageDto,
  SchedulerRunPageDto,
  UserPageDto,
} from "@vaca-efa/contracts";
import {
  addDays,
  addMonths,
  daysBetween,
  formatDate,
  parseLocalDate,
  type LocalDate,
} from "../../../domain/shared/localDate.js";
import type { VacationAlert } from "../../../domain/vacations/alerts.js";
import type { VacationSchedule, VacationSettlement } from "../../../domain/vacations/models.js";
import type {
  AlertPageQuery,
  AuditPageQuery,
  CatalogPageQuery,
  HolidayPageQuery,
  PagedAudits,
  SchedulerRunPageQuery,
  UserPageQuery,
} from "../../ports/repositories.js";
import type { AnnualScheduleReportQuery } from "../../ports/repositories.js";
import { AccrualReadService } from "./accrualReadService.js";
import type { VacationServiceContext } from "./context.js";
import type { AnnualScheduleReport, EmploymentListFilters, SettlementReportItem } from "./types.js";

function percentage(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function percentageBreakdown(values: number[], total: number) {
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const result = exact.map((value) => Math.floor(value));
  const remaining = 100 - result.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder);
  for (let index = 0; index < remaining; index++) result[order[index % order.length]!.index]!++;
  return result;
}

function dashboardHealthStatus(item: EmploymentSummaryDto): DashboardHealthStatus {
  if (item.overduePeriods > 0) return "OVERDUE";
  if (item.availableForScheduling === 0 && item.scheduledDays > 0) return "PROGRAMMED";
  if (item.availableForScheduling > 0 && item.scheduledDays > 0) return "PARTIAL";
  if (item.availableForScheduling > 0) return "PENDING";
  return "UP_TO_DATE";
}

const MONTH_SHORT_LABELS = [
  "Ene",
  "Feb",
  "Mar",
  "Abr",
  "May",
  "Jun",
  "Jul",
  "Ago",
  "Sep",
  "Oct",
  "Nov",
  "Dic",
];

function rangeLabelFor(from: LocalDate | undefined, to: LocalDate | undefined): string {
  if (from && to) return `Desde ${formatDate(from)} hasta ${formatDate(to)}`;
  if (from) return `Desde ${formatDate(from)}`;
  if (to) return `Hasta ${formatDate(to)}`;
  return "Todas las fechas";
}

function monthlyBreakdown(
  items: AnnualScheduleReport["items"],
  from: LocalDate | undefined,
  to: LocalDate | undefined,
): AnnualScheduleReport["monthly"] {
  if (!items.length) return [];
  const effectiveFrom =
    from ??
    items.reduce((min, item) => (item.startDate < min ? item.startDate : min), items[0]!.startDate);
  const effectiveTo =
    to ?? items.reduce((max, item) => (item.endDate > max ? item.endDate : max), items[0]!.endDate);
  const firstYear = Number(effectiveFrom.slice(0, 4));
  const firstMonth = Number(effectiveFrom.slice(5, 7));
  const lastYear = Number(effectiveTo.slice(0, 4));
  const lastMonth = Number(effectiveTo.slice(5, 7));
  const totalMonths = (lastYear - firstYear) * 12 + (lastMonth - firstMonth) + 1;
  if (totalMonths > 60)
    return [
      {
        month: 0,
        label: "Rango amplio",
        schedules: items.length,
        days: items.reduce((total, item) => total + item.scheduledDays, 0),
      },
    ];
  const monthly: AnnualScheduleReport["monthly"] = [];
  let cursor = parseLocalDate(`${effectiveFrom.slice(0, 7)}-01`);
  let index = 0;
  while (index < totalMonths) {
    const year = Number(cursor.slice(0, 4));
    const month = Number(cursor.slice(5, 7));
    const monthStart = cursor;
    const monthEnd = addDays(addMonths(monthStart, 1), -1);
    const monthItems = items.filter(
      (item) => item.startDate <= monthEnd && item.endDate >= monthStart,
    );
    const days = monthItems.reduce((total, item) => {
      const overlapStart = item.startDate > monthStart ? item.startDate : monthStart;
      const overlapEnd = item.endDate < monthEnd ? item.endDate : monthEnd;
      const fullCalendarDays =
        daysBetween(parseLocalDate(item.startDate), parseLocalDate(item.endDate)) + 1;
      const overlapCalendarDays =
        daysBetween(parseLocalDate(overlapStart), parseLocalDate(overlapEnd)) + 1;
      return (
        total +
        Math.max(1, Math.round((item.scheduledDays * overlapCalendarDays) / fullCalendarDays))
      );
    }, 0);
    monthly.push({
      month,
      label: `${MONTH_SHORT_LABELS[month - 1]} ${year}`,
      schedules: monthItems.length,
      days,
    });
    cursor = addMonths(monthStart, 1);
    index += 1;
  }
  return monthly;
}

export class DashboardReportsService {
  constructor(
    private readonly context: VacationServiceContext,
    private readonly readService: AccrualReadService,
  ) {}

  async dashboard(
    asOf: LocalDate = this.context.clock(),
    filters: EmploymentListFilters = {},
  ): Promise<DashboardDto> {
    const employments = await this.context.store.listEmploymentsByFilter({
      ...(filters.status === "ACTIVE" || filters.status === "RETIRED"
        ? { status: filters.status }
        : {}),
      ...(filters.processName ? { processName: filters.processName } : {}),
      ...(filters.fromDate ? { fromDate: filters.fromDate } : {}),
      ...(filters.toDate ? { toDate: filters.toDate } : {}),
    });
    const items = await this.readService.summariesFor(employments, asOf);
    const activeItems = items.filter((item) => item.status === "ACTIVE");
    const healthCounts = {
      upToDate: 0,
      programmed: 0,
      partial: 0,
      pending: 0,
      overdue: 0,
    };
    for (const item of activeItems) {
      const status = dashboardHealthStatus(item);
      if (status === "OVERDUE") healthCounts.overdue++;
      else if (status === "PROGRAMMED") healthCounts.programmed++;
      else if (status === "PARTIAL") healthCounts.partial++;
      else if (status === "PENDING") healthCounts.pending++;
      else healthCounts.upToDate++;
    }
    const healthTotal = activeItems.length;
    const healthPercentages = percentageBreakdown(
      [
        healthCounts.upToDate,
        healthCounts.programmed,
        healthCounts.partial,
        healthCounts.pending,
        healthCounts.overdue,
      ],
      healthTotal,
    );
    const health = {
      total: healthTotal,
      ...healthCounts,
      upToDatePercent: healthPercentages[0]!,
      programmedPercent: healthPercentages[1]!,
      partialPercent: healthPercentages[2]!,
      pendingPercent: healthPercentages[3]!,
      overduePercent: healthPercentages[4]!,
    };
    const processMap = new Map<
      string,
      {
        processName: string;
        activeEmployees: number;
        pendingEmployees: number;
        scheduledEmployees: number;
        overdueEmployees: number;
        pendingDays: number;
        availableDays: number;
        scheduledDays: number;
      }
    >();
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
    const yearEnd = `${asOf.slice(0, 4)}-12-31` as LocalDate;
    const upcomingThisYear = activeItems.filter(
      (item) =>
        item.status === "ACTIVE" && item.daysUntilAccrual >= 0 && item.nextAccrualDate <= yearEnd,
    );
    const upcoming = upcomingThisYear
      .sort(
        (left, right) =>
          Number(right.pendingDays > 0) - Number(left.pendingDays > 0) ||
          right.overduePeriods - left.overduePeriods ||
          left.daysUntilAccrual - right.daysUntilAccrual,
      )
      .slice(0, 5);
    const pendingDays = activeItems.reduce((total, item) => total + item.pendingDays, 0);
    const scheduledDays = activeItems.reduce((total, item) => total + item.scheduledDays, 0);
    return {
      asOf,
      totalEmployees: items.length,
      activeEmployees: activeItems.length,
      pendingPeriods: activeItems.reduce((total, item) => total + item.pendingPeriods, 0),
      pendingDays,
      scheduledDays,
      availableDays: activeItems.reduce((total, item) => total + item.availableForScheduling, 0),
      enjoyedDays: activeItems.reduce((total, item) => total + item.enjoyedDays, 0),
      compensatedDays: activeItems.reduce((total, item) => total + item.compensatedDays, 0),
      pendingEmployees: healthCounts.pending + healthCounts.partial + healthCounts.overdue,
      scheduledEmployees: activeItems.filter((item) => item.scheduledDays > 0).length,
      overdueEmployees: healthCounts.overdue,
      scheduleCoveragePercent: pendingDays ? percentage(scheduledDays, pendingDays) : 100,
      upcoming90Days: activeItems.filter(
        (item) => item.daysUntilAccrual <= 90 && item.status === "ACTIVE",
      ).length,
      upcomingThisYear: upcomingThisYear.length,
      priorityCases: activeItems.filter(
        (item) => item.availableForScheduling > 0 && item.daysUntilAccrual <= 30,
      ).length,
      health,
      processBreakdown,
      upcoming,
    };
  }

  async dashboardDetail(query: {
    kind: DashboardDetailKind;
    healthStatus?: DashboardHealthStatus | undefined;
    processName?: string | undefined;
    page: number;
    pageSize: number;
    asOf?: LocalDate | undefined;
    filters?: EmploymentListFilters | undefined;
  }): Promise<DashboardDetailPageDto> {
    const asOf = query.asOf ?? this.context.clock();
    const filters = query.filters ?? {};
    const employments = await this.context.store.listEmploymentsByFilter({
      ...(filters.status === "ACTIVE" || filters.status === "RETIRED"
        ? { status: filters.status }
        : {}),
      ...(filters.processName ? { processName: filters.processName } : {}),
      ...(filters.fromDate ? { fromDate: filters.fromDate } : {}),
      ...(filters.toDate ? { toDate: filters.toDate } : {}),
    });
    const activeItems = (await this.readService.summariesFor(employments, asOf)).filter(
      (item) => item.status === "ACTIVE",
    );
    const matches = (item: EmploymentSummaryDto) => {
      switch (query.kind) {
        case "ACTIVE":
          return true;
        case "PENDING_PERIODS":
          return item.pendingPeriods > 0;
        case "PENDING_DAYS":
        case "COVERAGE":
          return item.pendingDays > 0;
        case "PENDING_EMPLOYEES":
          return ["PENDING", "PARTIAL", "OVERDUE"].includes(dashboardHealthStatus(item));
        case "SCHEDULED":
          return item.scheduledDays > 0;
        case "OVERDUE":
          return item.overduePeriods > 0;
        case "ENJOYED":
          return item.enjoyedDays > 0;
        case "COMPENSATED":
          return item.compensatedDays > 0;
        case "UPCOMING":
          return (
            item.daysUntilAccrual >= 0 &&
            item.nextAccrualDate <= (`${asOf.slice(0, 4)}-12-31` as LocalDate)
          );
        case "PRIORITY":
          return item.availableForScheduling > 0 && item.daysUntilAccrual <= 30;
        case "HEALTH":
          return Boolean(query.healthStatus) && dashboardHealthStatus(item) === query.healthStatus;
        case "PROCESS":
          return Boolean(query.processName) && item.processName === query.processName;
      }
    };
    const filtered = activeItems.filter(matches).sort((left, right) => {
      if (query.kind === "UPCOMING")
        return (
          Number(right.pendingDays > 0) - Number(left.pendingDays > 0) ||
          right.overduePeriods - left.overduePeriods ||
          left.daysUntilAccrual - right.daysUntilAccrual
        );
      if (query.kind === "PRIORITY") return left.daysUntilAccrual - right.daysUntilAccrual;
      if (query.kind === "OVERDUE") return right.overduePeriods - left.overduePeriods;
      return (
        right.pendingDays - left.pendingDays || left.fullName.localeCompare(right.fullName, "es")
      );
    });
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      hasNext: start + query.pageSize < filtered.length,
      asOf,
      kind: query.kind,
      ...(query.healthStatus ? { healthStatus: query.healthStatus } : {}),
      ...(query.processName ? { processName: query.processName } : {}),
    };
  }

  async alerts(
    asOf: LocalDate = this.context.clock(),
  ): Promise<Omit<VacationAlert, "id" | "createdAt" | "updatedAt" | "active">[]> {
    const items = await this.readService.list("", undefined, asOf);
    const schedules = await this.context.store.listSchedules();
    const scheduledByEmployment = new Map<string, VacationSchedule[]>();
    for (const schedule of schedules)
      (scheduledByEmployment.get(schedule.employmentId) ?? []).push(schedule);
    const result: Omit<VacationAlert, "id" | "createdAt" | "updatedAt" | "active">[] = [];
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

  async annualScheduleReport(query: AnnualScheduleReportQuery): Promise<AnnualScheduleReport> {
    const items = await this.context.store.listAnnualScheduleReport(query);
    const from = query.fromDate ?? (query.year ? (`${query.year}-01-01` as LocalDate) : undefined);
    const to = query.toDate ?? (query.year ? (`${query.year}-12-31` as LocalDate) : undefined);
    return {
      ...(from ? { fromDate: from } : {}),
      ...(to ? { toDate: to } : {}),
      rangeLabel: rangeLabelFor(from, to),
      generatedAt: new Date().toISOString(),
      preparedBy: "Sistema",
      approvedBy: "Sin configurar",
      totalEmployees: new Set(items.map((item) => item.employeeDocumentNumber)).size,
      totalSchedules: items.length,
      totalDays: items.reduce((total, item) => total + item.scheduledDays, 0),
      monthly: monthlyBreakdown(items, from, to),
      items,
    };
  }

  async settlementReport(query: {
    search?: string | undefined;
    status?: VacationSettlement["status"] | undefined;
  }): Promise<SettlementReportItem[]> {
    const settlements = await this.context.store.listSettlements(
      query.status === undefined || query.status === "ANULADA",
    );
    const employments = await this.context.store.findEmploymentsByIds([
      ...new Set(settlements.map((item) => item.employmentId)),
    ]);
    const workers = await this.context.store.listWorkersByIds(
      employments.map((item) => item.workerId),
    );
    const employmentsById = new Map(employments.map((employment) => [employment.id, employment]));
    const workersById = new Map(workers.map((worker) => [worker.id, worker]));
    const search = query.search?.trim().toLowerCase();
    return settlements
      .filter((settlement) => {
        if (query.status && settlement.status !== query.status) return false;
        if (!search) return true;
        const employment = employmentsById.get(settlement.employmentId);
        const worker = employment ? workersById.get(employment.workerId) : undefined;
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
        const worker = employment ? workersById.get(employment.workerId) : undefined;
        return {
          ...settlement,
          ...(worker?.fullName ? { employeeName: worker.fullName } : {}),
          ...(worker?.documentNumber ? { employeeDocumentNumber: worker.documentNumber } : {}),
          ...(employment?.processName ? { processName: employment.processName } : {}),
          ...(employment?.positionName ? { positionName: employment.positionName } : {}),
          ...(employment?.supervisorName ? { supervisorName: employment.supervisorName } : {}),
        };
      })
      .sort(
        (left, right) =>
          left.periodEndDate.localeCompare(right.periodEndDate) * -1 ||
          (left.employeeName ?? "").localeCompare(right.employeeName ?? "", "es"),
      );
  }

  async listUsersPage(query: UserPageQuery): Promise<UserPageDto> {
    const { items, total } = await this.context.store.listUsersPage(query);
    const projected = items.map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName?.trim() || user.username,
      jobTitle: user.jobTitle?.trim() || user.role,
      role: user.role,
      active: user.active,
    }));
    return toPageDto(projected, query, total);
  }

  async listHolidaysPage(query: HolidayPageQuery): Promise<HolidayPageDto> {
    const { items, total } = await this.context.store.listHolidaysPage(query);
    return toPageDto(items, query, total);
  }

  async listCatalogPage(query: CatalogPageQuery): Promise<CatalogPageDto> {
    const { items, total } = await this.context.store.listCatalogPage(query);
    return toPageDto(items, query, total);
  }

  async listAuditsPage(query: AuditPageQuery): Promise<AuditPageDto> {
    const { items, total } = await this.context.store.listAuditsPage(query);
    return toPageDto<PagedAudits["items"][number]>(items, query, total);
  }

  async listAlertsPage(query: AlertPageQuery): Promise<AlertPageDto> {
    const { items, total } = await this.context.store.listAlertsPage(query);
    return toPageDto(items, query, total);
  }

  async listSchedulerRunsPage(query: SchedulerRunPageQuery): Promise<SchedulerRunPageDto> {
    const { items, total } = await this.context.store.listSchedulerRunsPage(query);
    return toPageDto(items, query, total);
  }
}

function toPageDto<T>(
  items: T[],
  query: { page: number; pageSize: number },
  total: number,
): { items: T[]; page: number; pageSize: number; total: number; hasNext: boolean } {
  const hasNext = query.page * query.pageSize < total;
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    hasNext,
  };
}
