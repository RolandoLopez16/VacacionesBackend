import { z } from "zod";
import {
  numberQuerySchema,
  optionalQueryDateSchema,
  optionalTrimmedQueryStringSchema,
  paginationQuerySchema,
} from "./common.js";
import { employmentFilterQuerySchema } from "./workers.js";

export const dashboardQuerySchema = employmentFilterQuerySchema.extend({
  asOf: optionalQueryDateSchema,
});

export const dashboardAsOfQuerySchema = z.object({ asOf: optionalQueryDateSchema });

export const upcomingDashboardQuerySchema = dashboardAsOfQuerySchema.extend({
  days: numberQuerySchema(90).transform((value) => Math.min(365, Math.max(1, value || 90))),
});

export function dashboardDetailQuerySchema(maxPageSize: number) {
  return dashboardQuerySchema
    .merge(paginationQuerySchema(maxPageSize))
    .extend({
      kind: z.enum([
        "ACTIVE",
        "PENDING_PERIODS",
        "PENDING_DAYS",
        "COVERAGE",
        "PENDING_EMPLOYEES",
        "SCHEDULED",
        "OVERDUE",
        "ENJOYED",
        "COMPENSATED",
        "UPCOMING",
        "PRIORITY",
        "HEALTH",
        "PROCESS",
      ]),
      healthStatus: z
        .enum(["UP_TO_DATE", "PROGRAMMED", "PARTIAL", "PENDING", "OVERDUE"])
        .optional(),
      detailProcess: optionalTrimmedQueryStringSchema,
    })
    .superRefine((value, context) => {
      if (value.kind === "HEALTH" && !value.healthStatus)
        context.addIssue({
          code: "custom",
          path: ["healthStatus"],
          message: "healthStatus es obligatorio para el detalle de salud",
        });
      if (value.kind === "PROCESS" && !value.detailProcess)
        context.addIssue({
          code: "custom",
          path: ["detailProcess"],
          message: "detailProcess es obligatorio para el detalle de proceso",
        });
    });
}
