import { z } from "zod";
import {
  localDateSchema,
  optionalEnumQuerySchema,
  optionalQueryDateSchema,
  optionalQueryStringSchema,
  paginationQuerySchema,
} from "./common.js";

export const settlementInputSchema = z.object({
  employmentId: z.string().min(1),
  sourceScheduleId: z.string().optional(),
  enjoymentStartDate: localDateSchema,
  enjoymentEndDate: localDateSchema.optional(),
  periodEndDate: localDateSchema.optional(),
  enjoyedDays: z.number().int().nonnegative(),
  compensatedDays: z.number().int().nonnegative(),
  calendarDays: z.number().int().nonnegative().optional(),
  amountCOP: z.number().nonnegative(),
  accountingDocument: z.string().trim().min(1),
  observation: z.string().trim().optional(),
  allocations: z.array(
    z.object({
      periodId: z.string(),
      enjoyedDays: z.number().int().nonnegative(),
      compensatedDays: z.number().int().nonnegative(),
    }),
  ),
});

export const annulSettlementInputSchema = z.object({ reason: z.string().trim().min(3) });

export function settlementListQuerySchema(maxPageSize: number) {
  return paginationQuerySchema(maxPageSize).extend({
    employmentId: optionalQueryStringSchema,
    search: optionalQueryStringSchema,
    status: optionalEnumQuerySchema(["ACTIVE", "ANULADA"]),
    from: optionalQueryDateSchema,
    to: optionalQueryDateSchema,
  });
}
