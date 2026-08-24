import type { LocalDate } from "../shared/localDate.js";
export type SchedulerRunStatus = "RUNNING" | "COMPLETED" | "FAILED";
export interface SchedulerRun {
  id: string;
  jobName: "VACATION_ACCRUAL";
  asOf: LocalDate;
  status: SchedulerRunStatus;
  processedEmployments: number;
  generatedPeriods: number;
  generatedAlerts: number;
  startedAt: string;
  finishedAt?: string | undefined;
  errorMessage?: string | undefined;
}
