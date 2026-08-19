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
export interface AnnualScheduleReport {
  year: number;
  generatedAt: string;
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
  alert?: string | undefined;
  fromDate?: LocalDate | undefined;
  toDate?: LocalDate | undefined;
}

function failure(message: string, status = 422): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
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
      generatedDays: caused.reduce((n, p) => n + p.entitledDays, 0),
      enjoyedDays: settlements.reduce((n, s) => n + s.enjoyedDays, 0),
      compensatedDays: settlements.reduce((n, s) => n + s.compensatedDays, 0),
      pendingDays: pends.reduce((n, p) => n + p, 0),
      scheduledDays: sched.reduce((n, p) => n + p, 0),
      availableForScheduling: Math.max(
        0,
        pends.reduce((n, p) => n + p, 0) - sched.reduce((n, p) => n + p, 0),
      ),
      nextAccrualDate: next,
      formingStartDate: forming.accrualStartDate,
      formingEndDate: forming.accrualEndDate,
      daysUntilAccrual: days,
      accrualProgressPercent: progress(forming, asOf),
      overduePeriods: caused.filter((p, i) =>
        overdue(p, pends[i]!, policy, asOf),
      ).length,
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
      return {
        id: p.id,
        sequence: p.sequence,
        startDate: p.accrualStartDate,
        endDate: p.accrualEndDate,
        causedAt: p.causedAt,
        entitledDays: p.entitledDays,
        lifecycleStatus: p.lifecycleStatus,
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
    if (query.maxDays === undefined && !filters.alert) {
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
    const start = (query.page - 1) * query.pageSize;
    return {
      items: all.slice(start, start + query.pageSize),
      total: all.length,
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
    const upcoming = items
      .filter((i) => i.daysUntilAccrual <= 90 && i.status === "ACTIVE")
      .sort((a, b) => a.daysUntilAccrual - b.daysUntilAccrual)
      .slice(0, 25);
    return {
      asOf,
      totalEmployees: items.length,
      activeEmployees: items.filter((i) => i.status === "ACTIVE").length,
      pendingPeriods: items
        .filter((i) => i.pendingDays > 0)
        .reduce((n, i) => n + i.causedPeriods, 0),
      pendingDays: items.reduce((n, i) => n + i.pendingDays, 0),
      upcoming90Days: items.filter(
        (i) => i.daysUntilAccrual <= 90 && i.status === "ACTIVE",
      ).length,
      priorityCases: items.filter(
        (i) =>
          i.status === "ACTIVE" &&
          i.pendingDays > 0 &&
          i.daysUntilAccrual <= 30,
      ).length,
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
    if (batch.status === "APPLIED") return { replayed: true, batch };
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
      },
      createdAt: appliedBatch.appliedAt!,
    });
    await this.store.applyVacationSettlementImport(
      appliedBatch,
      settlements,
      periods,
      audits,
    );
    return {
      replayed: false,
      batch: appliedBatch,
      created: settlements.filter((item) => item.version === 1).length,
      updated: settlements.filter((item) => item.version > 1).length,
      closedPeriods: periods.length,
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
