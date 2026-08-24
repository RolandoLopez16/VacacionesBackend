import type { ScheduleReportItem } from "../../ports/repositories.js";
import type { LocalDate } from "../../../domain/shared/localDate.js";
import type {
  VacationSchedule,
  VacationSettlement,
  VacationSettlementSourceLine,
} from "../../../domain/vacations/models.js";

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

export type ScheduleListItem = VacationSchedule & {
  employeeName?: string | undefined;
  employeeDocumentNumber?: string | undefined;
  processName?: string | undefined;
  positionName?: string | undefined;
};

export type SettlementReportItem = VacationSettlement & {
  employeeName?: string | undefined;
  employeeDocumentNumber?: string | undefined;
  processName?: string | undefined;
  positionName?: string | undefined;
  supervisorName?: string | undefined;
};

export interface AnnualScheduleReport {
  fromDate?: LocalDate | undefined;
  toDate?: LocalDate | undefined;
  rangeLabel: string;
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
