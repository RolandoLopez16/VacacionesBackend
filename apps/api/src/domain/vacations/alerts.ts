import type { LocalDate } from "../shared/localDate.js";
export type AlertType =
  "UPCOMING_ACCRUAL" | "OVERDUE_PERIOD" | "UPCOMING_VACATION" | "PENDING_AND_UPCOMING";
export interface VacationAlert {
  id: string;
  employmentId: string;
  type: AlertType;
  severity: "INFO" | "WARNING" | "CRITICAL";
  asOf: LocalDate;
  dueDate?: LocalDate | undefined;
  message: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
