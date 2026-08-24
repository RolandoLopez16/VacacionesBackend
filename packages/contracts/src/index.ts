export type WorkerType = "EMPLOYEE" | "TEMPORARY" | "APPRENTICE" | "HISTORICAL" | "OTHER";
export type EmploymentStatus = "ACTIVE" | "RETIRED";
export type PeriodLifecycle = "FORMING" | "CAUSED" | "CLOSED";
export type VacationPeriodClosureType =
  "RETIREMENT" | "ACCOUNTING_LIQUIDATION" | "MASS_MIGRATION" | "MANUAL";
export type VacationPeriodDisplayStatus = PeriodLifecycle | "ENJOYED";
export type ScheduleStatus = "SCHEDULED" | "CANCELLED" | "COMPLETED";
export type VacationManagementStatus = "PENDING" | "SCHEDULED" | "OVERDUE" | "CLEAR";
export type UserRole = "ADMIN" | "HR" | "VIEWER" | "READ_ONLY";

export type DashboardHealthStatus = "UP_TO_DATE" | "PROGRAMMED" | "PARTIAL" | "PENDING" | "OVERDUE";

export interface UserProfileDto {
  id: string;
  username: string;
  displayName: string;
  jobTitle: string;
  role: UserRole;
  active: boolean;
}

export type UserSummaryDto = UserProfileDto;

export interface VacationPolicyDto {
  id: string;
  effectiveFrom: string;
  daysPerCompletedYear: number;
  overdueAfterMonths: number;
  upcomingAccrualAlerts: number[];
  active: boolean;
}

export interface CatalogItemDto {
  id: string;
  type: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SystemSettingDto {
  key: string;
  value: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface HolidayDto {
  id: string;
  date: string;
  name: string;
  country: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type VacationAlertType =
  "UPCOMING_ACCRUAL" | "OVERDUE_PERIOD" | "UPCOMING_VACATION" | "PENDING_AND_UPCOMING";
export type VacationAlertSeverity = "INFO" | "WARNING" | "CRITICAL";
export interface VacationAlertDto {
  id: string;
  employmentId: string;
  type: VacationAlertType;
  severity: VacationAlertSeverity;
  asOf: string;
  dueDate?: string | undefined;
  message: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SchedulerRunStatus = "RUNNING" | "COMPLETED" | "FAILED";
export interface SchedulerRunDto {
  id: string;
  jobName: "VACATION_ACCRUAL";
  asOf: string;
  status: SchedulerRunStatus;
  processedEmployments: number;
  generatedPeriods: number;
  generatedAlerts: number;
  startedAt: string;
  finishedAt?: string | undefined;
  errorMessage?: string | undefined;
}

export interface SchedulerStatusDto {
  enabled: boolean;
  intervalMs: number;
  lastRun?: SchedulerRunDto;
}

export interface DashboardHealthDto {
  total: number;
  upToDate: number;
  programmed: number;
  partial: number;
  pending: number;
  overdue: number;
  upToDatePercent: number;
  programmedPercent: number;
  partialPercent: number;
  pendingPercent: number;
  overduePercent: number;
}

export interface DashboardProcessDto {
  processName: string;
  activeEmployees: number;
  pendingEmployees: number;
  scheduledEmployees: number;
  overdueEmployees: number;
  pendingDays: number;
  availableDays: number;
  scheduledDays: number;
  coveragePercent: number;
}

export interface PublicVacationStatsDto {
  asOf: string;
  upcoming90Days: number;
}

export interface DashboardDto {
  asOf: string;
  totalEmployees: number;
  activeEmployees: number;
  pendingPeriods: number;
  pendingDays: number;
  scheduledDays: number;
  availableDays: number;
  enjoyedDays: number;
  compensatedDays: number;
  pendingEmployees: number;
  scheduledEmployees: number;
  overdueEmployees: number;
  scheduleCoveragePercent: number;
  upcoming90Days: number;
  upcomingThisYear?: number | undefined;
  priorityCases: number;
  health: DashboardHealthDto;
  processBreakdown: DashboardProcessDto[];
  upcoming: EmploymentSummaryDto[];
}
export type DashboardDetailKind =
  | "ACTIVE"
  | "PENDING_PERIODS"
  | "PENDING_DAYS"
  | "COVERAGE"
  | "PENDING_EMPLOYEES"
  | "SCHEDULED"
  | "OVERDUE"
  | "ENJOYED"
  | "COMPENSATED"
  | "UPCOMING"
  | "PRIORITY"
  | "HEALTH"
  | "PROCESS";
export interface DashboardDetailPageDto {
  items: EmploymentSummaryDto[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  asOf: string;
  kind: DashboardDetailKind;
  healthStatus?: DashboardHealthStatus | undefined;
  processName?: string | undefined;
}
export interface EmploymentPageDto {
  items: EmploymentSummaryDto[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
}
export interface EmploymentSummaryDto {
  id: string;
  workerId: string;
  fullName: string;
  documentNumber: string;
  processName: string;
  positionName: string;
  supervisorName?: string;
  startDate: string;
  endDate?: string | undefined;
  contractTypeName: string;
  status: EmploymentStatus;
  causedPeriods: number;
  pendingPeriods: number;
  generatedDays: number;
  enjoyedDays: number;
  compensatedDays: number;
  pendingDays: number;
  scheduledDays: number;
  availableForScheduling: number;
  nextAccrualDate: string;
  lastCausedAt?: string | undefined;
  formingStartDate: string;
  formingEndDate: string;
  daysUntilAccrual: number;
  accrualProgressPercent: number;
  overduePeriods: number;
  vacationStatus: VacationManagementStatus;
  alert: "NORMAL" | "INFORMATIVE" | "UPCOMING" | "DUE_SOON" | "CAUSED_TODAY";
}
export interface EmploymentDetailDto extends EmploymentSummaryDto {
  periods: VacationPeriodDto[];
  schedules: VacationScheduleDto[];
  settlements: VacationSettlementDto[];
}
export interface EmploymentImportRowDto {
  documentNumber: string;
  fullName: string;
  startDate: string;
  endDate?: string | undefined;
  contractTypeName: string;
  processName: string;
  positionName: string;
  supervisorName?: string | undefined;
}
export interface EmploymentImportPreviewRowDto {
  row: number;
  valid: boolean;
  data?: EmploymentImportRowDto;
  errors: string[];
}
export interface EmploymentImportPreviewDto {
  headers: string[];
  rows: Record<string, unknown>[];
  validatedRows: EmploymentImportPreviewRowDto[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  errors: { row: number; message: string }[];
  payloadHash: string;
}
export interface EmploymentImportBatchDto {
  id: string;
  idempotencyKey: string;
  payloadHash?: string;
  entityType: "EMPLOYMENT";
  status: "PROCESSING" | "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED";
  totalRows: number;
  createdRows: number;
  updatedRows: number;
  invalidRows: number;
  duplicateRows?: number;
  processedRows?: number;
  durationMs?: number;
  databaseOperations?: number;
  chunks?: number;
  errorSummary: { row: number; message: string }[];
  createdAt: string;
  completedAt?: string;
  failedAt?: string;
}
export interface EmploymentImportResultDto {
  replayed?: boolean;
  batch: EmploymentImportBatchDto;
  created: number;
  updated: number;
  invalidRows: number;
  errors: { row: number; message: string }[];
  metrics: {
    durationMs: number;
    processedRows: number;
    databaseOperations: number;
    chunks: number;
  };
}
export interface VacationPeriodDto {
  id: string;
  sequence: number;
  startDate: string;
  endDate: string;
  causedAt: string;
  entitledDays: number;
  lifecycleStatus: PeriodLifecycle;
  closureType?: VacationPeriodClosureType;
  closureObservation?: string;
  closureAccountingDocument?: string;
  closureAmountCOP?: number;
  closedAt?: string;
  closedBy?: string;
  displayStatus: VacationPeriodDisplayStatus;
  pendingDays: number;
  scheduledDays: number;
  availableForScheduling: number;
  isOverdue: boolean;
}
export interface VacationScheduleDto {
  id: string;
  employmentId: string;
  sourceSettlementId?: string;
  employeeName?: string;
  employeeDocumentNumber?: string;
  processName?: string;
  positionName?: string;
  startDate: string;
  endDate: string;
  scheduledDays: number;
  status: ScheduleStatus;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  allocations: {
    periodId?: string | undefined;
    periodType: "CAUSED" | "FUTURE";
    periodStartDate: string;
    periodEndDate: string;
    days: number;
  }[];
  holidayWarnings?: string[];
}
export interface VacationSchedulePageDto {
  items: VacationScheduleDto[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
}
export interface AnnualScheduleReportDto {
  year: number;
  generatedAt: string;
  preparedBy: string;
  approvedBy: string;
  totalEmployees: number;
  totalSchedules: number;
  totalDays: number;
  monthly: { month: number; label: string; schedules: number; days: number }[];
  items: VacationScheduleDto[];
}
export type VacationSettlementStatus = "ACTIVE" | "ANULADA";
export interface VacationSettlementSourceLineDto {
  lineNumber: number;
  lineHash: string;
  employee: string;
  name: string;
  ndc: string;
  startDate: string;
  periodEndDate: string;
  periodStartDate: string;
  periodFinishDate: string;
  enjoymentStartDate: string;
  enjoymentEndDate: string;
  takenDays: number;
  compensatedDays: number;
  calendarDays: number;
  amountCOP: number;
  accountingDocument: string;
  raw: Record<string, unknown>;
}
export interface VacationSettlementDto {
  id: string;
  employmentId: string;
  employeeName?: string;
  employeeDocumentNumber?: string;
  sourceScheduleId?: string | undefined;
  sourceBatchId?: string | undefined;
  sourceKey?: string | undefined;
  source?: "MANUAL" | "MASS_IMPORT";
  status?: VacationSettlementStatus;
  enjoymentStartDate: string;
  enjoymentEndDate: string;
  periodEndDate: string;
  enjoyedDays: number;
  compensatedDays: number;
  calendarDays: number;
  amountCOP: number;
  accountingDocument: string;
  observation?: string;
  sourceLines?: VacationSettlementSourceLineDto[];
  allocations: {
    periodId: string;
    enjoyedDays: number;
    compensatedDays: number;
  }[];
  version?: number;
  cancelledAt?: string;
  cancelledBy?: string;
  cancellationReason?: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface VacationSettlementPageDto {
  items: VacationSettlementDto[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
}
export type VacationSettlementImportStatus =
  "PREVIEW" | "AUTHORIZED" | "APPLIED" | "REJECTED" | "FAILED";
export interface VacationSettlementImportBatchDto {
  id: string;
  fileName: string;
  fileHash: string;
  actorId: string;
  status: VacationSettlementImportStatus;
  totalRows: number;
  totalSettlements: number;
  newSettlements: number;
  unchangedSettlements: number;
  modifiedSettlements: number;
  conflicts: number;
  invalidRows: number;
  migrationPeriods: number;
  closedByMigration: number;
  closedEnjoyedPeriods: number;
  partiallyEnjoyedWarnings: string[];
  warnings: string[];
  errors: { row: number; message: string }[];
  previewToken: string;
  createdAt: string;
  authorizedAt?: string;
  appliedAt?: string;
}
export type VacationSettlementImportGroupStatus = "NEW" | "UNCHANGED" | "MODIFIED" | "CONFLICT";
export interface VacationSettlementImportGroupDto {
  sourceKey: string;
  employee: string;
  document: string;
  accountingDocument: string;
  status: VacationSettlementImportGroupStatus;
  reason?: string;
  before?: unknown;
  after: unknown;
  lines: (VacationSettlementSourceLineDto & { normalizedDocument: string })[];
  affectedPeriods: string[];
  warnings: string[];
}
export interface VacationSettlementImportPreviewDto {
  alreadyProcessed: boolean;
  batch: VacationSettlementImportBatchDto;
  groups: VacationSettlementImportGroupDto[];
}
export type VacationPeriodClosureDecision =
  "CLOSE" | "KEEP" | "PROTECTED" | "FUTURE" | "REVIEW" | "ALREADY_CLOSED";
export interface VacationPeriodClosurePlanDto {
  periodId: string;
  employmentId: string;
  documentNumber: string;
  employeeName: string;
  periodStartDate: string;
  periodEndDate: string;
  causedAt: string;
  lifecycleStatus: PeriodLifecycle;
  periodVersion: number;
  pendingDays: number;
  decision: VacationPeriodClosureDecision;
  reason: string;
  settlementIds: string[];
  accountingDocuments: string[];
}
export interface VacationPeriodClosureBatchDto {
  id: string;
  fileName: string;
  fileHash: string;
  actorId: string;
  fromDate: string;
  asOf: string;
  observation: string;
  status: "PREVIEW" | "AUTHORIZED" | "APPLIED" | "FAILED";
  totalPeriods: number;
  closedPeriods: number;
  keptPeriods: number;
  protectedPeriods: number;
  futurePeriods: number;
  reviewPeriods: number;
  alreadyClosedPeriods: number;
  warnings: string[];
  errors: { row?: number; message: string }[];
  plans: VacationPeriodClosurePlanDto[];
  previewToken: string;
  createdAt: string;
  authorizedAt?: string;
  appliedAt?: string;
}
export type VacationPendingPeriodDecision =
  "KEEP" | "RELEASED" | "PROTECTED" | "ALREADY_CLOSED" | "FORMING" | "REVIEW";
export interface VacationPendingPeriodSourceLineDto {
  lineNumber: number;
  lineHash: string;
  employee: string;
  name: string;
  hireDate: string;
  lastPaidPeriod?: string;
  pendingPeriods: number;
  pendingDays: number;
  totalDays: number;
  lastPeriodDueDate?: string;
  nextPeriodDueDate?: string;
  position?: string;
  raw: Record<string, unknown>;
}
export interface VacationPendingPeriodPlanDto {
  periodId: string;
  employmentId: string;
  documentNumber: string;
  employeeName: string;
  periodStartDate: string;
  periodEndDate: string;
  causedAt: string;
  lifecycleStatus: PeriodLifecycle;
  periodVersion: number;
  sourceLineNumber: number;
  sourcePendingPeriods: number;
  sourcePendingDays: number;
  daysToKeep: number;
  created: boolean;
  decision: VacationPendingPeriodDecision;
  reason: string;
}
export interface VacationPendingPeriodImportBatchDto {
  id: string;
  fileName: string;
  fileHash: string;
  actorId: string;
  asOf: string;
  observation: string;
  status: "PREVIEW" | "AUTHORIZED" | "APPLIED" | "FAILED";
  totalRows: number;
  validRows: number;
  matchedEmployees: number;
  missingEmployees: number;
  createdPeriods: number;
  keptPeriods: number;
  releasedPeriods: number;
  protectedPeriods: number;
  formingPeriods: number;
  reviewPeriods: number;
  alreadyClosedPeriods: number;
  warnings: string[];
  errors: { row?: number; message: string }[];
  sourceLines: VacationPendingPeriodSourceLineDto[];
  plans: VacationPendingPeriodPlanDto[];
  previewToken: string;
  createdAt: string;
  authorizedAt?: string;
  appliedAt?: string;
}
export interface VacationPendingPeriodImportPreviewDto {
  alreadyProcessed: boolean;
  batch: VacationPendingPeriodImportBatchDto;
  plans: VacationPendingPeriodPlanDto[];
}
export type RetiredVacationPeriodState = "ENJOYED" | "LIQUIDATED" | "PENDING_LIQUIDATION";
export interface RetiredVacationPeriodDto {
  periodId: string;
  periodStartDate: string;
  periodEndDate: string;
  lifecycleStatus: PeriodLifecycle;
  closureType?: VacationPeriodClosureType;
  closureObservation?: string;
  closureAccountingDocument?: string;
  pendingDays: number;
  enjoyedDays: number;
  compensatedDays: number;
  state: RetiredVacationPeriodState;
}
export interface RetiredEmploymentReconciliationItemDto {
  employmentId: string;
  workerId: string;
  employeeName: string;
  documentNumber: string;
  endDate?: string;
  pendingPeriods: number;
  enjoyedPeriods: number;
  liquidatedPeriods: number;
  closedPeriods: number;
  periods: RetiredVacationPeriodDto[];
}
export interface RetiredEmploymentReconciliationDto {
  asOf: string;
  totalEmployments: number;
  employmentsWithPending: number;
  pendingPeriods: number;
  items: RetiredEmploymentReconciliationItemDto[];
}
export interface RetiredAccountingClosureResultDto {
  asOf: string;
  employmentsScanned: number;
  employmentsChanged: number;
  periodsClosed: number;
  accountingDocument: string;
}
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface PageDto<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
}

export interface AuditEventDto {
  id: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: unknown;
  createdAt: string;
}
export type AuditPageDto = PageDto<AuditEventDto>;

export type HolidayPageDto = PageDto<HolidayDto>;
export interface HolidayPageQuery {
  page: number;
  pageSize: number;
  year?: number;
  active?: boolean;
  search?: string;
}

export type UserPageDto = PageDto<UserSummaryDto>;
export interface UserPageQuery {
  page: number;
  pageSize: number;
  search?: string;
  active?: boolean;
  role?: UserRole;
}

export type CatalogPageDto = PageDto<CatalogItemDto>;
export interface CatalogPageQuery {
  page: number;
  pageSize: number;
  type: string;
  active?: boolean;
  search?: string;
}

export type AlertPageDto = PageDto<VacationAlertDto>;
export interface AlertPageQuery {
  page: number;
  pageSize: number;
  employmentId?: string;
  severity?: VacationAlertSeverity;
  type?: VacationAlertType;
  active?: boolean;
}

export type SchedulerRunPageDto = PageDto<SchedulerRunDto>;
export interface SchedulerRunPageQuery {
  page: number;
  pageSize: number;
  jobName?: SchedulerRunDto["jobName"];
  status?: SchedulerRunStatus;
  fromDate?: string;
  toDate?: string;
}

export interface ImportBatchSummaryDto {
  id: string;
  fileName?: string;
  fileHash?: string;
  actorId?: string;
  status: "PROCESSING" | "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED";
  attempt?: number;
  totalRows: number;
  createdRows: number;
  updatedRows: number;
  invalidRows: number;
  durationMs?: number;
  processedRows?: number;
  databaseOperations?: number;
  chunks?: number;
  errorSummary?: { row: number; message: string }[];
  createdAt: string;
  completedAt?: string;
  failedAt?: string;
}
export type ImportBatchPageDto = PageDto<ImportBatchSummaryDto>;
export interface ImportBatchPageQuery {
  page: number;
  pageSize: number;
  actorId?: string;
  status?: ImportBatchSummaryDto["status"];
  fileName?: string;
  fromDate?: string;
  toDate?: string;
}

export interface RetiredReconciliationItemPageDto {
  items: RetiredEmploymentReconciliationItemDto[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}
export interface RetiredReconciliationPageQuery {
  page: number;
  pageSize: number;
  search?: string;
  state?: RetiredVacationPeriodState;
}

export interface VacationPeriodClosurePlanPageDto {
  items: VacationPeriodClosurePlanDto[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}
export interface VacationPeriodClosurePlanPageQuery {
  batchId: string;
  page: number;
  pageSize: number;
  decision?: VacationPeriodClosureDecision;
}

export interface VacationPendingPeriodPlanPageDto {
  items: VacationPendingPeriodPlanDto[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}
export interface VacationPendingPeriodPlanPageQuery {
  batchId: string;
  page: number;
  pageSize: number;
  decision?: VacationPendingPeriodDecision;
}
