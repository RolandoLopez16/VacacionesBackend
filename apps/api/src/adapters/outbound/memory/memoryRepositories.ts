import type { Worker, Employment } from "../../../domain/workers/models.js";
import type {
  ImportBatch,
  VacationPeriod,
  VacationPolicy,
  VacationSchedule,
  VacationSettlement,
  VacationSettlementImportBatch,
  VacationPeriodClosureBatch,
  VacationPendingPeriodImportBatch,
} from "../../../domain/vacations/models.js";
import type { User } from "../../../domain/auth/models.js";
import type { Session } from "../../../domain/auth/session.js";
import type { CatalogItem } from "../../../domain/admin/catalog.js";
import type { SystemSetting } from "../../../domain/admin/settings.js";
import type { Holiday } from "../../../domain/admin/holiday.js";
import type { VacationAlert } from "../../../domain/vacations/alerts.js";
import type { SchedulerRun } from "../../../domain/vacations/schedulerRun.js";
import type {
  AuditRepository,
  AlertRepository,
  AnnualScheduleReportQuery,
  CatalogRepository,
  EmploymentPageQuery,
  EmploymentRepository,
  HolidayRepository,
  ImportBatchRepository,
  PeriodRepository,
  PolicyRepository,
  ScheduleRepository,
  ScheduleReportItem,
  SchedulerRunRepository,
  SessionRepository,
  SettlementPageQuery,
  SettlementRepository,
  TransactionRepository,
  VacationSettlementImportRepository,
  VacationPendingPeriodImportRepository,
  WorkerRepository,
} from "../../../application/ports/repositories.js";
export class MemoryStore
  implements
    WorkerRepository,
    EmploymentRepository,
    PeriodRepository,
    ScheduleRepository,
    SettlementRepository,
    PolicyRepository,
    AuditRepository,
    ImportBatchRepository,
    VacationSettlementImportRepository,
    VacationPendingPeriodImportRepository,
    SessionRepository,
    CatalogRepository,
    HolidayRepository,
    AlertRepository,
    SchedulerRunRepository,
    TransactionRepository
{
  workers = new Map<string, Worker>();
  employments = new Map<string, Employment>();
  periods = new Map<string, VacationPeriod>();
  schedules = new Map<string, VacationSchedule>();
  settlements = new Map<string, VacationSettlement>();
  importBatches = new Map<string, ImportBatch>();
  settlementImportBatches = new Map<string, VacationSettlementImportBatch>();
  vacationPeriodClosureBatches = new Map<string, VacationPeriodClosureBatch>();
  vacationPendingPeriodImportBatches = new Map<string, VacationPendingPeriodImportBatch>();
  sessions = new Map<string, Session>();
  catalogs = new Map<string, CatalogItem>();
  systemSettings = new Map<string, SystemSetting>();
  holidays = new Map<string, Holiday>();
  alerts = new Map<string, VacationAlert>();
  schedulerRuns = new Map<string, SchedulerRun>();
  users = new Map<string, User>();
  audits: unknown[] = [];
  policy: VacationPolicy = {
    id: "default",
    effectiveFrom: "2026-01-01",
    daysPerCompletedYear: 15,
    overdueAfterMonths: 12,
    upcomingAccrualAlerts: [30, 60, 90],
    active: true,
  };
  async listWorkers() {
    return [...this.workers.values()];
  }
  async listWorkersByIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.workers.values()].filter((item) => selected.has(item.id));
  }
  async findWorkerById(id: string) {
    return this.workers.get(id) ?? null;
  }
  async findWorkerByNormalizedDocument(normalizedDocumentNumber: string) {
    return (
      [...this.workers.values()].find(
        (item) => item.normalizedDocumentNumber === normalizedDocumentNumber,
      ) ?? null
    );
  }
  async saveWorker(v: Worker) {
    this.workers.set(v.id, v);
  }
  async listEmployments() {
    return [...this.employments.values()];
  }
  async findEmploymentsByIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.employments.values()].filter((item) => selected.has(item.id));
  }
  async listEmploymentsByFilter(
    query: Omit<EmploymentPageQuery, "page" | "pageSize" | "search">,
  ) {
    return [...this.employments.values()].filter(
      (item) =>
        (!query.status || item.status === query.status) &&
        (!query.processName ||
          item.processName
            .toLowerCase()
            .includes(query.processName.toLowerCase())) &&
        (!query.toDate || item.startDate <= query.toDate) &&
        (!query.fromDate || !item.endDate || item.endDate >= query.fromDate),
    );
  }
  async listEmploymentPage(query: EmploymentPageQuery) {
    const search = query.search?.toLowerCase();
    const workersById = new Map(
      [...this.workers.values()].map((worker) => [worker.id, worker]),
    );
    const filtered = [...this.employments.values()]
      .filter((item) => {
        const worker = workersById.get(item.workerId);
        if (query.status && item.status !== query.status) return false;
        if (
          query.processName &&
          !item.processName
            .toLowerCase()
            .includes(query.processName.toLowerCase())
        )
          return false;
        if (query.toDate && item.startDate > query.toDate) return false;
        if (query.fromDate && item.endDate && item.endDate < query.fromDate)
          return false;
        if (search) {
          const haystack =
            `${worker?.documentNumber ?? ""} ${worker?.normalizedDocumentNumber ?? ""} ${worker?.fullName ?? ""} ${item.processName} ${item.positionName} ${item.supervisorName ?? ""}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const left = workersById.get(a.workerId)?.fullName ?? "";
        const right = workersById.get(b.workerId)?.fullName ?? "";
        return (
          left.localeCompare(right, "es") ||
          b.startDate.localeCompare(a.startDate)
        );
      });
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize),
      total: filtered.length,
    };
  }
  async findEmploymentById(id: string) {
    return this.employments.get(id) ?? null;
  }
  async findEmploymentByWorkerAndStartDate(
    workerId: string,
    startDate: import("../../../domain/shared/localDate.js").LocalDate,
  ) {
    return (
      [...this.employments.values()].find(
        (v) => v.workerId === workerId && v.startDate === startDate,
      ) ?? null
    );
  }
  async saveEmployment(v: Employment) {
    this.employments.set(v.id, v);
  }
  async findByEmploymentId(id: string) {
    return [...this.periods.values()].filter((p) => p.employmentId === id);
  }
  async findByEmploymentIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.periods.values()].filter((p) =>
      selected.has(p.employmentId),
    );
  }
  async findPeriodById(id: string) {
    return this.periods.get(id) ?? null;
  }
  async saveMany(v: VacationPeriod[]) {
    v.forEach((p) => this.periods.set(p.id, p));
  }
  async listSchedules() {
    return [...this.schedules.values()];
  }
  async listSchedulePage(query: import("../../../application/ports/repositories.js").SchedulePageQuery) {
    const search = query.search?.toLowerCase().trim();
    const workersById = new Map([...this.workers.values()].map((worker) => [worker.id, worker]));
    const employmentsById = new Map([...this.employments.values()].map((employment) => [employment.id, employment]));
    const filtered = [...this.schedules.values()]
      .filter((schedule) => {
        const employment = employmentsById.get(schedule.employmentId);
        const worker = employment ? workersById.get(employment.workerId) : undefined;
        if (query.employmentId && schedule.employmentId !== query.employmentId) return false;
        if (query.status && schedule.status !== query.status) return false;
        if (query.fromDate && schedule.endDate < query.fromDate) return false;
        if (query.toDate && schedule.startDate > query.toDate) return false;
        if (search) {
          const haystack = `${worker?.documentNumber ?? ""} ${worker?.fullName ?? ""} ${employment?.processName ?? ""} ${employment?.positionName ?? ""} ${schedule.id}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
    const start = (query.page - 1) * query.pageSize;
    return { items: filtered.slice(start, start + query.pageSize), total: filtered.length };
  }
  async listAnnualScheduleReport(query: AnnualScheduleReportQuery): Promise<ScheduleReportItem[]> {
    const yearStart = `${query.year}-01-01`;
    const yearEnd = `${query.year}-12-31`;
    const search = query.search?.trim().toLowerCase();
    const workersById = new Map([...this.workers.values()].map((worker) => [worker.id, worker]));
    const employmentsById = new Map([...this.employments.values()].map((employment) => [employment.id, employment]));
    return [...this.schedules.values()]
      .filter((schedule) => {
        if (schedule.startDate > yearEnd || schedule.endDate < yearStart) return false;
        if (query.status && schedule.status !== query.status) return false;
        const employment = employmentsById.get(schedule.employmentId);
        const worker = employment ? workersById.get(employment.workerId) : undefined;
        if (search) {
          const haystack = `${worker?.documentNumber ?? ""} ${worker?.fullName ?? ""} ${employment?.processName ?? ""} ${employment?.positionName ?? ""} ${employment?.supervisorName ?? ""} ${schedule.id}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id))
      .map((schedule) => {
        const employment = employmentsById.get(schedule.employmentId);
        const worker = employment ? workersById.get(employment.workerId) : undefined;
        return {
          ...schedule,
          employeeName: worker?.fullName ?? "Vínculo no encontrado",
          employeeDocumentNumber: worker?.documentNumber ?? schedule.employmentId,
          processName: employment?.processName ?? "—",
          positionName: employment?.positionName ?? "—",
          ...(employment?.supervisorName ? { supervisorName: employment.supervisorName } : {}),
        };
      });
  }
  async findSchedulesByEmploymentIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.schedules.values()].filter((item) =>
      selected.has(item.employmentId),
    );
  }
  async findSchedulesByIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.schedules.values()].filter((item) => selected.has(item.id));
  }
  async findScheduleById(id: string) {
    return this.schedules.get(id) ?? null;
  }
  async saveSchedule(v: VacationSchedule) {
    this.schedules.set(v.id, v);
  }
  async listSettlements(includeAnnulled = false) {
    return [...this.settlements.values()].filter(
      (item) => includeAnnulled || item.status !== "ANULADA",
    );
  }
  private withSettlementEmployee(item: VacationSettlement) {
    const employment = this.employments.get(item.employmentId);
    const worker = employment ? this.workers.get(employment.workerId) : undefined;
    return {
      ...item,
      ...(worker
        ? {
            employeeName: worker.fullName,
            employeeDocumentNumber: worker.documentNumber,
          }
        : {}),
    };
  }
  async listSettlementPage(query: SettlementPageQuery) {
    const search = query.search?.toLowerCase().trim();
    const employmentsById = new Map(this.employments);
    const workersById = new Map(this.workers);
    const all = [...this.settlements.values()]
      .filter(
        (item) => {
          const employment = employmentsById.get(item.employmentId);
          const worker = employment ? workersById.get(employment.workerId) : undefined;
          return (
            (query.status
              ? item.status === query.status
              : item.status !== "ANULADA") &&
            (!query.employmentId || item.employmentId === query.employmentId) &&
            (!query.fromDate || item.periodEndDate >= query.fromDate) &&
            (!query.toDate || item.periodEndDate <= query.toDate) &&
            (!search ||
              `${item.accountingDocument} ${item.employmentId} ${item.sourceKey ?? ""} ${worker?.fullName ?? ""} ${worker?.documentNumber ?? ""}`
                .toLowerCase()
                .includes(search))
          );
        },
      )
      .sort(
        (a, b) =>
          b.periodEndDate.localeCompare(a.periodEndDate) ||
          b.createdAt.localeCompare(a.createdAt),
      );
    const start = (query.page - 1) * query.pageSize;
    return {
      items: all
        .slice(start, start + query.pageSize)
        .map((item) => this.withSettlementEmployee(item)),
      total: all.length,
    };
  }
  async findSettlementsByEmploymentIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.settlements.values()].filter(
      (item) => selected.has(item.employmentId) && item.status !== "ANULADA",
    );
  }
  async findSettlementById(id: string) {
    const item = this.settlements.get(id);
    return item ? this.withSettlementEmployee(item) : null;
  }
  async findSettlementBySourceKey(sourceKey: string) {
    return (
      [...this.settlements.values()].find(
        (item) => item.sourceKey === sourceKey,
      ) ?? null
    );
  }
  async saveSettlement(v: VacationSettlement) {
    this.settlements.set(v.id, v);
  }
  async findImportBatchByIdempotencyKey(key: string) {
    return this.importBatches.get(key) ?? null;
  }
  async saveImportBatch(batch: ImportBatch) {
    this.importBatches.set(batch.idempotencyKey, batch);
  }
  async findVacationSettlementImportBatch(id: string) {
    return this.settlementImportBatches.get(id) ?? null;
  }
  async findVacationSettlementImportByFileHash(hash: string) {
    return (
      [...this.settlementImportBatches.values()].find(
        (batch) => batch.fileHash === hash,
      ) ?? null
    );
  }
  async saveVacationSettlementImportBatch(
    batch: VacationSettlementImportBatch,
  ) {
    this.settlementImportBatches.set(batch.id, batch);
  }
  async findVacationPeriodClosureBatch(id: string) {
    return this.vacationPeriodClosureBatches.get(id) ?? null;
  }
  async findVacationPeriodClosureByFileHash(fileHash: string) {
    return (
      [...this.vacationPeriodClosureBatches.values()].find(
        (batch) => batch.fileHash === fileHash,
      ) ?? null
    );
  }
  async saveVacationPeriodClosureBatch(batch: VacationPeriodClosureBatch) {
    this.vacationPeriodClosureBatches.set(batch.id, batch);
  }
  async findVacationPendingPeriodImportBatch(id: string) {
    return this.vacationPendingPeriodImportBatches.get(id) ?? null;
  }
  async findVacationPendingPeriodImportByFileHash(fileHash: string) {
    return (
      [...this.vacationPendingPeriodImportBatches.values()].find(
        (batch) => batch.fileHash === fileHash,
      ) ?? null
    );
  }
  async saveVacationPendingPeriodImportBatch(
    batch: VacationPendingPeriodImportBatch,
  ) {
    this.vacationPendingPeriodImportBatches.set(batch.id, batch);
  }
  async findSessionById(id: string) {
    return this.sessions.get(id) ?? null;
  }
  async saveSession(session: Session) {
    this.sessions.set(session.id, session);
  }
  async revokeSession(id: string, revokedAt: string) {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, revokedAt });
  }
  async listCatalog(type: string) {
    return [...this.catalogs.values()].filter((item) => item.type === type);
  }
  async saveCatalog(item: CatalogItem) {
    this.catalogs.set(item.id, item);
  }
  async findSystemSettingByKey(key: string) {
    return this.systemSettings.get(key) ?? null;
  }
  async saveSystemSetting(setting: SystemSetting) {
    this.systemSettings.set(setting.key, setting);
  }
  async listHolidays(year?: number) {
    return [...this.holidays.values()].filter(
      (item) => year === undefined || Number(item.date.slice(0, 4)) === year,
    );
  }
  async saveHoliday(holiday: Holiday) {
    this.holidays.set(holiday.id, holiday);
  }
  async listAlerts(filters: { employmentId?: string; active?: boolean } = {}) {
    return [...this.alerts.values()]
      .filter(
        (item) =>
          (filters.employmentId === undefined ||
            item.employmentId === filters.employmentId) &&
          (filters.active === undefined || item.active === filters.active),
      )
      .sort(
        (a, b) =>
          a.asOf.localeCompare(b.asOf) ||
          a.employmentId.localeCompare(b.employmentId),
      );
  }
  async saveAlert(alert: VacationAlert) {
    this.alerts.set(alert.id, alert);
  }
  async listSchedulerRuns() {
    return [...this.schedulerRuns.values()].sort((a, b) =>
      b.asOf.localeCompare(a.asOf),
    );
  }
  async findSchedulerRunById(id: string) {
    return this.schedulerRuns.get(id) ?? null;
  }
  async saveSchedulerRun(run: SchedulerRun) {
    this.schedulerRuns.set(run.id, run);
  }
  async saveScheduleAndAudit(
    schedule: VacationSchedule,
    audit: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    },
  ) {
    this.schedules.set(schedule.id, schedule);
    this.audits.push(audit);
  }
  async completeScheduleTransaction(
    schedule: VacationSchedule,
    settlement: VacationSettlement,
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
  ) {
    this.settlements.set(settlement.id, settlement);
    this.schedules.set(schedule.id, schedule);
    audits.forEach((event) => this.audits.push(event));
  }
  async closeRetiredEmploymentTransaction(
    employment: Employment,
    periods: VacationPeriod[],
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
  ) {
    this.employments.set(employment.id, employment);
    periods.forEach((item) => this.periods.set(item.id, item));
    audits.forEach((event) => this.audits.push(event));
  }
  async closeRetiredEmploymentsTransaction(
    employments: Employment[],
    periods: VacationPeriod[],
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
  ) {
    employments.forEach((item) => this.employments.set(item.id, item));
    periods.forEach((item) => this.periods.set(item.id, item));
    audits.forEach((event) => this.audits.push(event));
  }
  async applyVacationSettlementImport(
    batch: VacationSettlementImportBatch,
    settlements: VacationSettlement[],
    periods: VacationPeriod[],
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
    schedules: VacationSchedule[] = [],
  ) {
    settlements.forEach((item) => this.settlements.set(item.id, item));
    periods.forEach((item) => this.periods.set(item.id, item));
    schedules.forEach((item) => this.schedules.set(item.id, item));
    this.settlementImportBatches.set(batch.id, batch);
    audits.forEach((event) => this.audits.push(event));
  }
  async applyVacationPeriodClosure(
    batch: VacationPeriodClosureBatch,
    periods: VacationPeriod[],
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
  ) {
    periods.forEach((item) => this.periods.set(item.id, item));
    this.vacationPeriodClosureBatches.set(batch.id, batch);
    audits.forEach((event) => this.audits.push(event));
  }
  async applyVacationPendingPeriodImport(
    batch: VacationPendingPeriodImportBatch,
    periods: VacationPeriod[],
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
  ) {
    periods.forEach((item) => this.periods.set(item.id, item));
    this.vacationPendingPeriodImportBatches.set(batch.id, batch);
    audits.forEach((event) => this.audits.push(event));
  }
  async saveSettlementAndAudit(
    settlement: VacationSettlement,
    audit: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    },
  ) {
    this.settlements.set(settlement.id, settlement);
    this.audits.push(audit);
  }
  async listUsers() {
    return [...this.users.values()];
  }
  async findUserByUsername(username: string) {
    return (
      [...this.users.values()].find((user) => user.username === username) ??
      null
    );
  }
  async saveUser(user: User) {
    this.users.set(user.id, user);
  }
  async current(
    _asOf: import("../../../domain/shared/localDate.js").LocalDate,
  ) {
    return this.policy;
  }
  async savePolicy(policy: VacationPolicy) {
    this.policy = policy;
  }
  async append(e: unknown) {
    this.audits.push(e);
  }
  async listAudits() {
    return this.audits;
  }
  async ping() {
    return undefined;
  }
}
