import type { LocalDate } from "../shared/localDate.js";
export type WorkerType = "EMPLOYEE" | "TEMPORARY" | "APPRENTICE" | "HISTORICAL" | "OTHER";
export type EmploymentStatus = "ACTIVE" | "RETIRED";
export interface Worker {
  id: string;
  documentNumber: string;
  normalizedDocumentNumber: string;
  fullName: string;
  workerType: WorkerType;
  createdAt: string;
  updatedAt: string;
}
export interface Employment {
  id: string;
  workerId: string;
  startDate: LocalDate;
  endDate?: LocalDate | undefined;
  contractTypeId: string;
  contractTypeName: string;
  processId: string;
  processName: string;
  positionId: string;
  positionName: string;
  supervisorWorkerId?: string | undefined;
  supervisorName?: string | undefined;
  status: EmploymentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}
