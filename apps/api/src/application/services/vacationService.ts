import type {
  AlertPageDto,
  AuditPageDto,
  CatalogPageDto,
  DashboardDetailKind,
  DashboardDetailPageDto,
  DashboardDto,
  DashboardHealthStatus,
  EmploymentDetailDto,
  EmploymentSummaryDto,
  HolidayPageDto,
  SchedulerRunPageDto,
  UserPageDto,
} from "@vaca-efa/contracts";
import { today, type LocalDate } from "../../domain/shared/localDate.js";
import type { Employment } from "../../domain/workers/models.js";
import type { VacationAlert } from "../../domain/vacations/alerts.js";
import type { VacationSettlement } from "../../domain/vacations/models.js";
import type {
  AlertPageQuery,
  AnnualScheduleReportQuery,
  AuditPageQuery,
  CatalogPageQuery,
  HolidayPageQuery,
  SchedulerRunPageQuery,
  SchedulePageQuery,
  UserPageQuery,
  VacationStore,
} from "../ports/repositories.js";
import type { PendingPeriodRawRow } from "./pendingPeriodImport.js";
import type { SettlementRawRow } from "./settlementImport.js";
import { AccrualReadService } from "./vacation/accrualReadService.js";
import { BulkEmploymentImportService } from "./vacation/bulkEmploymentImportService.js";
import type { VacationServiceContext } from "./vacation/context.js";
import { DashboardReportsService } from "./vacation/dashboardReportsService.js";
import { EmploymentService } from "./vacation/employmentService.js";
import { PendingPeriodImportService } from "./vacation/pendingPeriodImportService.js";
import { PeriodClosureService } from "./vacation/periodClosureService.js";
import { RetirementService } from "./vacation/retirementService.js";
import { ScheduleService } from "./vacation/scheduleService.js";
import { SettlementImportService } from "./vacation/settlementImportService.js";
import { SettlementService } from "./vacation/settlementService.js";
import type {
  AnnualScheduleReport,
  EmploymentInput,
  EmploymentListFilters,
  ScheduleInput,
  ScheduleListItem,
  SettlementInput,
  SettlementReportItem,
} from "./vacation/types.js";

export type {
  AnnualScheduleReport,
  EmploymentInput,
  EmploymentListFilters,
  ScheduleInput,
  SettlementInput,
} from "./vacation/types.js";

export class VacationService {
  private readonly readService: AccrualReadService;
  private readonly dashboardReportsService: DashboardReportsService;
  private readonly bulkEmploymentImportService: BulkEmploymentImportService;
  private readonly employmentService: EmploymentService;
  private readonly retirementService: RetirementService;
  private readonly periodClosureService: PeriodClosureService;
  private readonly pendingPeriodImportService: PendingPeriodImportService;
  private readonly scheduleService: ScheduleService;
  private readonly settlementService: SettlementService;
  private readonly settlementImportService: SettlementImportService;

  constructor(
    private readonly store: VacationStore,
    private readonly clock: () => LocalDate = today,
  ) {
    const context: VacationServiceContext = {
      store: this.store,
      clock: () => this.clock(),
    };
    this.readService = new AccrualReadService(context);
    this.dashboardReportsService = new DashboardReportsService(context, this.readService);
    this.bulkEmploymentImportService = new BulkEmploymentImportService(context);
    this.employmentService = new EmploymentService(context, this.readService);
    this.retirementService = new RetirementService(context, this.readService);
    this.periodClosureService = new PeriodClosureService(context);
    this.pendingPeriodImportService = new PendingPeriodImportService(context);
    this.scheduleService = new ScheduleService(context, this.readService);
    this.settlementService = new SettlementService(context, this.readService);
    this.settlementImportService = new SettlementImportService(
      context,
      this.readService,
      this.settlementService,
    );
  }

  async ensure(employment: Employment, asOf: LocalDate = this.clock(), persist = true) {
    return this.readService.ensure(employment, asOf, persist);
  }

  async summary(
    employment: Employment,
    asOf: LocalDate = this.clock(),
  ): Promise<EmploymentSummaryDto> {
    return this.readService.summary(employment, asOf);
  }

  async detail(id: string, asOf: LocalDate = this.clock()): Promise<EmploymentDetailDto> {
    return this.readService.detail(id, asOf);
  }

  async list(
    search = "",
    maxDays?: number,
    asOf: LocalDate = this.clock(),
    filters: EmploymentListFilters = {},
  ) {
    return this.readService.list(search, maxDays, asOf, filters);
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
    return this.readService.listPage(query);
  }

  async dashboard(
    asOf: LocalDate = this.clock(),
    filters: EmploymentListFilters = {},
  ): Promise<DashboardDto> {
    return this.dashboardReportsService.dashboard(asOf, filters);
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
    return this.dashboardReportsService.dashboardDetail(query);
  }

  async alerts(
    asOf: LocalDate = this.clock(),
  ): Promise<Omit<VacationAlert, "id" | "createdAt" | "updatedAt" | "active">[]> {
    return this.dashboardReportsService.alerts(asOf);
  }

  async upsertEmployment(input: EmploymentInput, actor = "system") {
    return this.employmentService.upsertEmployment(input, actor);
  }

  async createEmployment(input: EmploymentInput, actor = "system") {
    return this.employmentService.createEmployment(input, actor);
  }

  async updateEmployment(
    id: string,
    input: EmploymentInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    return this.employmentService.updateEmployment(id, input, expectedVersion, actor);
  }

  async retireEmployment(
    id: string,
    endDate: LocalDate,
    expectedVersion?: number,
    actor = "system",
  ) {
    return this.retirementService.retireEmployment(id, endDate, expectedVersion, actor);
  }

  async closeRetiredEmployments(
    actor = "system-retirement-closure",
    asOf: LocalDate = this.clock(),
  ) {
    return this.retirementService.closeRetiredEmployments(actor, asOf);
  }

  async retiredVacationReconciliation(asOf: LocalDate = this.clock()) {
    return this.retirementService.retiredVacationReconciliation(asOf);
  }

  async closeRetiredEmploymentsWithAccounting(
    input: {
      accountingDocument: string;
      observation: string;
      amountCOP?: number | undefined;
    },
    actor = "system",
    asOf: LocalDate = this.clock(),
  ) {
    return this.retirementService.closeRetiredEmploymentsWithAccounting(input, actor, asOf);
  }

  async previewVacationPeriodClosure(
    fileName: string,
    fileHash: string,
    rows: SettlementRawRow[],
    actor = "system",
    fromDate?: LocalDate | undefined,
    asOf: LocalDate = this.clock(),
  ) {
    return this.periodClosureService.previewVacationPeriodClosure(
      fileName,
      fileHash,
      rows,
      actor,
      fromDate,
      asOf,
    );
  }

  async applyVacationPeriodClosure(
    batchId: string,
    fileName: string,
    fileHash: string,
    previewToken: string,
    rows: SettlementRawRow[],
    actor = "system",
    fromDate?: LocalDate | undefined,
    asOf: LocalDate = this.clock(),
  ) {
    return this.periodClosureService.applyVacationPeriodClosure(
      batchId,
      fileName,
      fileHash,
      previewToken,
      rows,
      actor,
      fromDate,
      asOf,
    );
  }

  async previewPendingPeriodImport(
    fileName: string,
    fileHash: string,
    rows: PendingPeriodRawRow[],
    actor = "system",
    asOf: LocalDate = this.clock(),
  ) {
    return this.pendingPeriodImportService.previewPendingPeriodImport(
      fileName,
      fileHash,
      rows,
      actor,
      asOf,
    );
  }

  async applyPendingPeriodImport(
    batchId: string,
    fileName: string,
    fileHash: string,
    previewToken: string,
    rows: PendingPeriodRawRow[],
    actor = "system",
    asOf: LocalDate = this.clock(),
  ) {
    return this.pendingPeriodImportService.applyPendingPeriodImport(
      batchId,
      fileName,
      fileHash,
      previewToken,
      rows,
      actor,
      asOf,
    );
  }

  async createSchedule(input: ScheduleInput, actor = "system") {
    return this.scheduleService.createSchedule(input, actor);
  }

  async updateSchedule(
    id: string,
    input: ScheduleInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    return this.scheduleService.updateSchedule(id, input, expectedVersion, actor);
  }

  async cancelSchedule(id: string, expectedVersion?: number, actor = "system") {
    return this.scheduleService.cancelSchedule(id, expectedVersion, actor);
  }

  async schedulePage(
    query: SchedulePageQuery,
  ): Promise<{ items: ScheduleListItem[]; total: number }> {
    return this.scheduleService.schedulePage(query);
  }

  async annualScheduleReport(query: AnnualScheduleReportQuery): Promise<AnnualScheduleReport> {
    return this.dashboardReportsService.annualScheduleReport(query);
  }

  async createSettlement(input: SettlementInput, actor = "system") {
    return this.settlementService.createSettlement(input, actor);
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
    return this.settlementService.settlementPage(query);
  }

  async settlementReport(query: {
    search?: string | undefined;
    status?: VacationSettlement["status"] | undefined;
  }): Promise<SettlementReportItem[]> {
    return this.dashboardReportsService.settlementReport(query);
  }

  async updateSettlement(
    id: string,
    input: SettlementInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    return this.settlementService.updateSettlement(id, input, expectedVersion, actor);
  }

  async annulSettlement(id: string, reason: string, expectedVersion?: number, actor = "system") {
    return this.settlementService.annulSettlement(id, reason, expectedVersion, actor);
  }

  async previewSettlementImport(
    fileName: string,
    fileHash: string,
    rows: SettlementRawRow[],
    actor = "system",
    asOf: LocalDate = this.clock(),
  ) {
    return this.settlementImportService.previewSettlementImport(
      fileName,
      fileHash,
      rows,
      actor,
      asOf,
    );
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
    return this.settlementImportService.applySettlementImport(
      batchId,
      fileName,
      fileHash,
      previewToken,
      rows,
      actor,
      asOf,
    );
  }

  async completeSchedule(
    id: string,
    input: SettlementInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    return this.settlementService.completeSchedule(id, input, expectedVersion, actor);
  }

  async importEmployments(
    idempotencyKey: string,
    rows: unknown[],
    actor = "system",
    payloadHash?: string,
  ) {
    return this.bulkEmploymentImportService.import(idempotencyKey, rows, actor, payloadHash);
  }

  async confirmEmploymentImport(
    batchReference: string,
    rows: unknown[],
    actor = "system",
    payloadHash?: string,
  ) {
    return this.bulkEmploymentImportService.confirm(batchReference, rows, actor, payloadHash);
  }

  async retryEmploymentImport(
    batchReference: string,
    rows: unknown[],
    actor = "system",
    payloadHash?: string,
  ) {
    return this.bulkEmploymentImportService.retry(batchReference, rows, actor, payloadHash);
  }

  listUsersPage(query: UserPageQuery): Promise<UserPageDto> {
    return this.dashboardReportsService.listUsersPage(query);
  }
  listHolidaysPage(query: HolidayPageQuery): Promise<HolidayPageDto> {
    return this.dashboardReportsService.listHolidaysPage(query);
  }
  listCatalogPage(query: CatalogPageQuery): Promise<CatalogPageDto> {
    return this.dashboardReportsService.listCatalogPage(query);
  }
  listAuditsPage(query: AuditPageQuery): Promise<AuditPageDto> {
    return this.dashboardReportsService.listAuditsPage(query);
  }
  listAlertsPage(query: AlertPageQuery): Promise<AlertPageDto> {
    return this.dashboardReportsService.listAlertsPage(query);
  }
  listSchedulerRunsPage(query: SchedulerRunPageQuery): Promise<SchedulerRunPageDto> {
    return this.dashboardReportsService.listSchedulerRunsPage(query);
  }

  async seed() {
    return this.employmentService.seed();
  }
}
