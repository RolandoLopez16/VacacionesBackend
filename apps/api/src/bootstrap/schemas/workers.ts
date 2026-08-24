import { z } from "zod";
import type { EmploymentListFilters } from "../../application/services/vacationService.js";
import {
  localDateSchema,
  optionalEnumQuerySchema,
  optionalNumberQuerySchema,
  optionalQueryDateSchema,
  optionalQueryStringSchema,
  optionalTrimmedQueryStringSchema,
  paginationQuerySchema,
} from "./common.js";

export const employmentInputSchema = z.object({
  documentNumber: z.string().trim().min(3),
  fullName: z.string().trim().min(2),
  startDate: localDateSchema,
  endDate: localDateSchema.optional(),
  contractTypeName: z.string().trim().min(2),
  processName: z.string().trim().min(2),
  positionName: z.string().trim().min(2),
  supervisorName: z.string().trim().optional(),
});

export const retirementInputSchema = z.object({ endDate: localDateSchema });

export const workerInputSchema = z.object({
  documentNumber: z.string().trim().min(3),
  fullName: z.string().trim().min(2),
});

export const employmentFilterQuerySchema = z.object({
  status: optionalEnumQuerySchema(["ACTIVE", "RETIRED"]),
  process: optionalTrimmedQueryStringSchema,
  vacationStatus: optionalEnumQuerySchema(["PENDING", "SCHEDULED", "OVERDUE", "CLEAR"]),
  alert: optionalTrimmedQueryStringSchema,
  from: optionalQueryDateSchema,
  to: optionalQueryDateSchema,
});

export type EmploymentFilterQuery = z.infer<typeof employmentFilterQuerySchema>;

export function employmentFilters(query: EmploymentFilterQuery): EmploymentListFilters {
  return {
    ...(query.status ? { status: query.status } : {}),
    ...(query.process ? { processName: query.process } : {}),
    ...(query.vacationStatus ? { vacationStatus: query.vacationStatus } : {}),
    ...(query.alert ? { alert: query.alert } : {}),
    ...(query.from ? { fromDate: query.from } : {}),
    ...(query.to ? { toDate: query.to } : {}),
  };
}

export const dashboardQuerySchema = employmentFilterQuerySchema.extend({
  asOf: optionalQueryDateSchema,
});

export function employmentListQuerySchema(maxPageSize: number) {
  return paginationQuerySchema(maxPageSize).extend({
    search: optionalQueryStringSchema,
    accrualWithin: optionalNumberQuerySchema(),
    asOf: optionalQueryDateSchema,
    status: optionalEnumQuerySchema(["ACTIVE", "RETIRED"]),
    process: optionalTrimmedQueryStringSchema,
    vacationStatus: optionalEnumQuerySchema(["PENDING", "SCHEDULED", "OVERDUE", "CLEAR"]),
    alert: optionalTrimmedQueryStringSchema,
    from: optionalQueryDateSchema,
    to: optionalQueryDateSchema,
    sort: optionalEnumQuerySchema(["pendingDays"]),
  });
}
