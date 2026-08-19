import type { Worker, Employment } from "../../domain/workers/models.js";
import type {
  ImportBatch,
  VacationPeriod,
  VacationPolicy,
  VacationSchedule,
  VacationSettlement,
  VacationSettlementImportBatch,
} from "../../domain/vacations/models.js";
import type { LocalDate } from "../../domain/shared/localDate.js";
import type { User } from "../../domain/auth/models.js";
import type { Session } from "../../domain/auth/session.js";
import type { CatalogItem } from "../../domain/admin/catalog.js";
import type { Holiday } from "../../domain/admin/holiday.js";
import type { VacationAlert } from "../../domain/vacations/alerts.js";
import type { SchedulerRun } from "../../domain/vacations/schedulerRun.js";
export interface WorkerRepository {
  listWorkers(): Promise<Worker[]>;
  listWorkersByIds(ids: string[]): Promise<Worker[]>;
  findWorkerById(id: string): Promise<Worker | null>;
  findWorkerByNormalizedDocument(
    normalizedDocumentNumber: string,
  ): Promise<Worker | null>;
  saveWorker(worker: Worker): Promise<void>;
}
export interface EmploymentPageQuery {
  search?: string | undefined;
  status?: Employment["status"] | undefined;
  processName?: string | undefined;
  fromDate?: LocalDate | undefined;
  toDate?: LocalDate | undefined;
  page: number;
  pageSize: number;
}
export interface EmploymentPage {
  items: Employment[];
  total: number;
}
export interface EmploymentRepository {
  listEmployments(): Promise<Employment[]>;
  findEmploymentsByIds(ids: string[]): Promise<Employment[]>;
  listEmploymentsByFilter(
    query: Omit<EmploymentPageQuery, "page" | "pageSize" | "search">,
  ): Promise<Employment[]>;
  listEmploymentPage(query: EmploymentPageQuery): Promise<EmploymentPage>;
  findEmploymentById(id: string): Promise<Employment | null>;
  findEmploymentByWorkerAndStartDate(
    workerId: string,
    startDate: LocalDate,
  ): Promise<Employment | null>;
  saveEmployment(employment: Employment): Promise<void>;
}
export interface PeriodRepository {
  findByEmploymentId(id: string): Promise<VacationPeriod[]>;
  findByEmploymentIds(ids: string[]): Promise<VacationPeriod[]>;
  findPeriodById(id: string): Promise<VacationPeriod | null>;
  saveMany(periods: VacationPeriod[]): Promise<void>;
}
export interface ScheduleRepository {
  listSchedules(): Promise<VacationSchedule[]>;
  listSchedulePage(query: SchedulePageQuery): Promise<SchedulePage>;
  listAnnualScheduleReport(
    query: AnnualScheduleReportQuery,
  ): Promise<ScheduleReportItem[]>;
  findSchedulesByEmploymentIds(ids: string[]): Promise<VacationSchedule[]>;
  findScheduleById(id: string): Promise<VacationSchedule | null>;
  saveSchedule(schedule: VacationSchedule): Promise<void>;
}
export interface SchedulePageQuery {
  page: number;
  pageSize: number;
  employmentId?: string | undefined;
  search?: string | undefined;
  status?: VacationSchedule["status"] | undefined;
  fromDate?: LocalDate | undefined;
  toDate?: LocalDate | undefined;
}
export interface SchedulePage {
  items: VacationSchedule[];
  total: number;
}
export interface AnnualScheduleReportQuery {
  year: number;
  status?: VacationSchedule["status"] | undefined;
  search?: string | undefined;
}
export interface ScheduleReportItem extends VacationSchedule {
  employeeName: string;
  employeeDocumentNumber: string;
  processName: string;
  positionName: string;
  supervisorName?: string | undefined;
}
export interface SettlementPageQuery {
  page: number;
  pageSize: number;
  employmentId?: string | undefined;
  search?: string | undefined;
  status?: VacationSettlement["status"] | undefined;
  fromDate?: LocalDate | undefined;
  toDate?: LocalDate | undefined;
}
export interface SettlementPage {
  items: VacationSettlement[];
  total: number;
}
export interface SettlementRepository {
  listSettlements(): Promise<VacationSettlement[]>;
  listSettlementPage(query: SettlementPageQuery): Promise<SettlementPage>;
  findSettlementsByEmploymentIds(ids: string[]): Promise<VacationSettlement[]>;
  findSettlementById(id: string): Promise<VacationSettlement | null>;
  findSettlementBySourceKey(
    sourceKey: string,
  ): Promise<VacationSettlement | null>;
  saveSettlement(settlement: VacationSettlement): Promise<void>;
}
export interface PolicyRepository {
  current(asOf: LocalDate): Promise<VacationPolicy>;
  savePolicy(policy: VacationPolicy): Promise<void>;
}
export interface AuditRepository {
  append(event: {
    id: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    metadata: unknown;
    createdAt: string;
  }): Promise<void>;
  listAudits(): Promise<unknown[]>;
}
export interface ImportBatchRepository {
  findImportBatchByIdempotencyKey(key: string): Promise<ImportBatch | null>;
  saveImportBatch(batch: ImportBatch): Promise<void>;
}
export interface VacationSettlementImportRepository {
  findVacationSettlementImportBatch(
    id: string,
  ): Promise<VacationSettlementImportBatch | null>;
  findVacationSettlementImportByFileHash(
    hash: string,
  ): Promise<VacationSettlementImportBatch | null>;
  saveVacationSettlementImportBatch(
    batch: VacationSettlementImportBatch,
  ): Promise<void>;
}
export interface SessionRepository {
  findSessionById(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  revokeSession(id: string, revokedAt: string): Promise<void>;
}
export interface CatalogRepository {
  listCatalog(type: string): Promise<CatalogItem[]>;
  saveCatalog(item: CatalogItem): Promise<void>;
}
export interface HolidayRepository {
  listHolidays(year?: number): Promise<Holiday[]>;
  saveHoliday(holiday: Holiday): Promise<void>;
}
export interface AlertRepository {
  listAlerts(filters?: {
    employmentId?: string;
    active?: boolean;
  }): Promise<VacationAlert[]>;
  saveAlert(alert: VacationAlert): Promise<void>;
}
export interface SchedulerRunRepository {
  listSchedulerRuns(): Promise<SchedulerRun[]>;
  findSchedulerRunById(id: string): Promise<SchedulerRun | null>;
  saveSchedulerRun(run: SchedulerRun): Promise<void>;
}
export interface TransactionRepository {
  saveScheduleAndAudit(
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
  ): Promise<void>;
  closeRetiredEmploymentsTransaction(
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
  ): Promise<void>;
  closeRetiredEmploymentTransaction(
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
  ): Promise<void>;
  completeScheduleTransaction(
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
  ): Promise<void>;
  applyVacationSettlementImport(
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
  ): Promise<void>;
  saveSettlementAndAudit(
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
  ): Promise<void>;
}
export interface UserRepository {
  listUsers(): Promise<User[]>;
  findUserByUsername(username: string): Promise<User | null>;
  saveUser(user: User): Promise<void>;
}
export interface VacationStore
  extends
    WorkerRepository,
    EmploymentRepository,
    PeriodRepository,
    ScheduleRepository,
    SettlementRepository,
    PolicyRepository,
    AuditRepository,
    ImportBatchRepository,
    VacationSettlementImportRepository,
    SessionRepository,
    CatalogRepository,
    HolidayRepository,
    AlertRepository,
    SchedulerRunRepository,
    TransactionRepository,
    UserRepository {
  ping?(): Promise<void>;
}
