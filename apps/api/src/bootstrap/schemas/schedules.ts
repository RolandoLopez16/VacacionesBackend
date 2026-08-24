import { z } from "zod";
import {
  localDateSchema,
  optionalEnumQuerySchema,
  optionalQueryDateSchema,
  optionalQueryStringSchema,
  paginationQuerySchema,
} from "./common.js";

export const scheduleInputSchema = z.object({
  employmentId: z.string().min(1),
  startDate: localDateSchema,
  endDate: localDateSchema.optional(),
  scheduledDays: z.number().int().positive(),
  allocations: z
    .array(
      z.object({
        periodId: z.string().optional(),
        periodType: z.enum(["CAUSED", "FUTURE"]),
        periodStartDate: localDateSchema,
        periodEndDate: localDateSchema,
        days: z.number().int().positive(),
      }),
    )
    .min(1),
});

export function scheduleListQuerySchema(maxPageSize: number) {
  return paginationQuerySchema(maxPageSize).extend({
    employmentId: optionalQueryStringSchema,
    search: optionalQueryStringSchema,
    status: optionalEnumQuerySchema(["SCHEDULED", "CANCELLED", "COMPLETED"]),
    from: optionalQueryDateSchema,
    to: optionalQueryDateSchema,
  });
}
