import type { LocalDate } from "../shared/localDate.js";
export type PeriodLifecycle = "FORMING" | "CAUSED" | "CLOSED";
export interface VacationPolicy {
  id: string;
  effectiveFrom: LocalDate;
  daysPerCompletedYear: number;
  overdueAfterMonths: number;
  upcomingAccrualAlerts: number[];
  active: boolean;
}
export interface VacationPeriod {
  id: string;
  employmentId: string;
  sequence: number;
  accrualStartDate: LocalDate;
  accrualEndDate: LocalDate;
  causedAt: LocalDate;
  entitledDays: number;
  lifecycleStatus: PeriodLifecycle;
  closureObservation?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export type VacationSettlementStatus = "ACTIVE" | "ANULADA";
export type VacationSettlementSource = "MANUAL" | "MASS_IMPORT";
export interface VacationSettlementSourceLine {
  lineNumber: number;
  lineHash: string;
  employee: string;
  name: string;
  ndc: string;
  startDate: LocalDate;
  periodEndDate: LocalDate;
  periodStartDate: LocalDate;
  periodFinishDate: LocalDate;
  enjoymentStartDate: LocalDate;
  enjoymentEndDate: LocalDate;
  takenDays: number;
  compensatedDays: number;
  calendarDays: number;
  amountCOP: number;
  accountingDocument: string;
  raw: Record<string, unknown>;
}
export interface VacationSettlement {
  id: string;
  employmentId: string;
  /** Lightweight employee identity used by paginated views. */
  employeeName?: string;
  employeeDocumentNumber?: string;
  sourceScheduleId?: string;
  sourceBatchId?: string;
  sourceKey?: string;
  source: VacationSettlementSource;
  status: VacationSettlementStatus;
  enjoymentStartDate: LocalDate;
  enjoymentEndDate: LocalDate;
  periodEndDate: LocalDate;
  enjoyedDays: number;
  compensatedDays: number;
  calendarDays: number;
  amountCOP: number;
  accountingDocument: string;
  observation?: string;
  sourceLines?: VacationSettlementSourceLine[];
  allocations: {
    periodId: string;
    enjoyedDays: number;
    compensatedDays: number;
  }[];
  version: number;
  cancelledAt?: string;
  cancelledBy?: string;
  cancellationReason?: string;
  createdAt: string;
  updatedAt: string;
}
export type ScheduleStatus = "SCHEDULED" | "CANCELLED" | "COMPLETED";
export interface VacationSchedule {
  id: string;
  employmentId: string;
  /** Settlement imported or registered as the source of this historical schedule. */
  sourceSettlementId?: string;
  startDate: LocalDate;
  endDate: LocalDate;
  scheduledDays: number;
  allocations: {
    periodId?: string | undefined;
    periodType: "CAUSED" | "FUTURE";
    periodStartDate: LocalDate;
    periodEndDate: LocalDate;
    days: number;
  }[];
  holidayWarnings?: LocalDate[];
  status: ScheduleStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export type ImportBatchStatus =
  "PROCESSING" | "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED";
export interface ImportBatch {
  id: string;
  idempotencyKey: string;
  entityType: "EMPLOYMENT";
  status: ImportBatchStatus;
  totalRows: number;
  createdRows: number;
  updatedRows: number;
  invalidRows: number;
  errorSummary: { row: number; message: string }[];
  createdAt: string;
  completedAt?: string;
}
export type VacationSettlementImportStatus =
  "PREVIEW" | "AUTHORIZED" | "APPLIED" | "REJECTED" | "FAILED";
export interface VacationSettlementImportBatch {
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
  warnings: string[];
  errors: { row: number; message: string }[];
  previewToken: string;
  createdAt: string;
  authorizedAt?: string;
  appliedAt?: string;
}
export type VacationPeriodClosureDecision =
  | "CLOSE"
  | "KEEP"
  | "PROTECTED"
  | "FUTURE"
  | "REVIEW"
  | "ALREADY_CLOSED";
export type VacationPeriodClosureBatchStatus =
  | "PREVIEW"
  | "AUTHORIZED"
  | "APPLIED"
  | "FAILED";
export interface VacationPeriodClosurePlan {
  periodId: string;
  employmentId: string;
  documentNumber: string;
  employeeName: string;
  periodStartDate: LocalDate;
  periodEndDate: LocalDate;
  causedAt: LocalDate;
  lifecycleStatus: PeriodLifecycle;
  periodVersion: number;
  pendingDays: number;
  decision: VacationPeriodClosureDecision;
  reason: string;
  settlementIds: string[];
  accountingDocuments: string[];
}
export interface VacationPeriodClosureBatch {
  id: string;
  fileName: string;
  fileHash: string;
  actorId: string;
  fromDate: LocalDate;
  asOf: LocalDate;
  observation: string;
  status: VacationPeriodClosureBatchStatus;
  totalPeriods: number;
  closedPeriods: number;
  keptPeriods: number;
  protectedPeriods: number;
  futurePeriods: number;
  reviewPeriods: number;
  alreadyClosedPeriods: number;
  warnings: string[];
  errors: { row?: number; message: string }[];
  plans: VacationPeriodClosurePlan[];
  previewToken: string;
  createdAt: string;
  authorizedAt?: string;
  appliedAt?: string;
}
