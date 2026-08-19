export type WorkerType =
  "EMPLOYEE" | "TEMPORARY" | "APPRENTICE" | "HISTORICAL" | "OTHER";
export type EmploymentStatus = "ACTIVE" | "RETIRED";
export type PeriodLifecycle = "FORMING" | "CAUSED" | "CLOSED";
export type ScheduleStatus = "SCHEDULED" | "CANCELLED" | "COMPLETED";

export interface DashboardDto {
  asOf: string;
  totalEmployees: number;
  activeEmployees: number;
  pendingPeriods: number;
  pendingDays: number;
  upcoming90Days: number;
  priorityCases: number;
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
  pendingDays: number;
  scheduledDays: number;
  availableForScheduling: number;
  isOverdue: boolean;
}
export interface VacationScheduleDto {
  id: string;
  employmentId: string;
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
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
