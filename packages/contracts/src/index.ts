export type WorkerType =
  "EMPLOYEE" | "TEMPORARY" | "APPRENTICE" | "HISTORICAL" | "OTHER";
export type EmploymentStatus = "ACTIVE" | "RETIRED";
export type PeriodLifecycle = "FORMING" | "CAUSED" | "CLOSED";
export type VacationPeriodClosureType =
  | "RETIREMENT"
  | "ACCOUNTING_LIQUIDATION"
  | "MASS_MIGRATION"
  | "MANUAL";
export type VacationPeriodDisplayStatus = PeriodLifecycle | "ENJOYED";
export type ScheduleStatus = "SCHEDULED" | "CANCELLED" | "COMPLETED";
export type VacationManagementStatus =
  | "PENDING"
  | "SCHEDULED"
  | "OVERDUE"
  | "CLEAR";

export type DashboardHealthStatus =
  | "UP_TO_DATE"
  | "PROGRAMMED"
  | "PARTIAL"
  | "PENDING"
  | "OVERDUE";

export interface UserProfileDto {
  id: string;
  username: string;
  displayName: string;
  jobTitle: string;
  role: "ADMIN" | "HR" | "VIEWER" | "READ_ONLY";
  active: boolean;
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
  priorityCases: number;
  health: DashboardHealthDto;
  processBreakdown: DashboardProcessDto[];
  upcoming: EmploymentSummaryDto[];
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
export type VacationPeriodClosureDecision =
  | "CLOSE"
  | "KEEP"
  | "PROTECTED"
  | "FUTURE"
  | "REVIEW"
  | "ALREADY_CLOSED";
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
  | "KEEP"
  | "CLOSE"
  | "PROTECTED"
  | "ALREADY_CLOSED"
  | "FORMING"
  | "REVIEW";
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
  closedPeriods: number;
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
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
