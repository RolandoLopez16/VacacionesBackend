import { z } from "zod";
import {
  holidayYearQuerySchema,
  localDateSchema,
  optionalEnumQuerySchema,
  optionalQueryDateSchema,
  optionalQueryStringSchema,
  optionalTrimmedQueryStringSchema,
  paginatedListQuerySchema,
} from "./common.js";

const MAX_PAGE_SIZE = 200;

export const policyInputSchema = z.object({
  effectiveFrom: localDateSchema,
  daysPerCompletedYear: z.number().int().positive(),
  overdueAfterMonths: z.number().int().positive(),
  upcomingAccrualAlerts: z.array(z.number().int().positive()).min(1),
  active: z.boolean().default(true),
});

export const userInputSchema = z.object({
  username: z.string().trim().min(3),
  password: z.string().min(8),
  role: z.enum(["ADMIN", "HR", "VIEWER", "READ_ONLY"]),
  displayName: z.string().trim().min(2).optional(),
  jobTitle: z.string().trim().min(2).optional(),
});

export const userPatchInputSchema = z.object({
  username: z.string().trim().min(3).optional(),
  displayName: z.string().trim().min(2).optional(),
  jobTitle: z.string().trim().min(2).optional(),
  password: z.string().min(8).optional(),
  role: z.enum(["ADMIN", "HR", "VIEWER", "READ_ONLY"]).optional(),
  active: z.boolean().optional(),
});

export const catalogInputSchema = z.object({
  name: z.string().trim().min(2),
  active: z.boolean().optional(),
});

export const systemSettingInputSchema = z.object({
  value: z.string().trim().min(2).max(160),
});

export const closureFromDateSettingInputSchema = z.object({
  value: localDateSchema,
});

export const retiredAccountingClosureInputSchema = z.object({
  accountingDocument: z.string().trim().min(1).max(160),
  observation: z.string().trim().min(3).max(240),
  amountCOP: z.number().nonnegative().optional(),
});

export const holidayInputSchema = z.object({
  date: localDateSchema,
  name: z.string().trim().min(2),
  country: z.string().trim().default("CO"),
  active: z.boolean().default(true),
});

export const holidayPatchInputSchema = z.object({
  date: localDateSchema.optional(),
  name: z.string().trim().min(2).optional(),
  country: z.string().trim().min(2).optional(),
  active: z.boolean().optional(),
});

export const alertsQuerySchema = z.object({
  employmentId: optionalQueryStringSchema,
  active: z.preprocess(
    (value) => (typeof value === "string" ? value === "true" : undefined),
    z.boolean().optional(),
  ),
});

export const adminAsOfQuerySchema = z.object({ asOf: optionalQueryDateSchema });
export { holidayYearQuerySchema };

export const holidayPageQuerySchema = paginatedListQuerySchema(
  MAX_PAGE_SIZE,
  z.object({
    year: z.preprocess((value) => {
      if (typeof value !== "string") return undefined;
      const number = Number(value);
      return Number.isInteger(number) ? number : undefined;
    }, z.number().int().optional()),
    active: z.preprocess(
      (value) => (typeof value === "string" ? value === "true" : undefined),
      z.boolean().optional(),
    ),
    search: optionalTrimmedQueryStringSchema,
  }),
);

export const userPageQuerySchema = paginatedListQuerySchema(
  MAX_PAGE_SIZE,
  z.object({
    search: optionalTrimmedQueryStringSchema,
    active: z.preprocess(
      (value) => (typeof value === "string" ? value === "true" : undefined),
      z.boolean().optional(),
    ),
    role: optionalEnumQuerySchema(["ADMIN", "HR", "VIEWER", "READ_ONLY"] as const),
  }),
);

export const catalogPageQuerySchema = paginatedListQuerySchema(
  MAX_PAGE_SIZE,
  z.object({
    type: z.string().trim().min(1),
    active: z.preprocess(
      (value) => (typeof value === "string" ? value === "true" : undefined),
      z.boolean().optional(),
    ),
    search: optionalTrimmedQueryStringSchema,
  }),
);

export const auditPageQuerySchema = paginatedListQuerySchema(
  MAX_PAGE_SIZE,
  z.object({
    actorId: optionalQueryStringSchema,
    action: optionalQueryStringSchema,
    entityType: optionalQueryStringSchema,
    entityId: optionalQueryStringSchema,
    fromDate: optionalQueryDateSchema,
    toDate: optionalQueryDateSchema,
  }),
);

export const alertPageQuerySchema = paginatedListQuerySchema(
  MAX_PAGE_SIZE,
  z.object({
    employmentId: optionalQueryStringSchema,
    severity: optionalEnumQuerySchema(["INFO", "WARNING", "CRITICAL"] as const),
    type: optionalEnumQuerySchema([
      "UPCOMING_ACCRUAL",
      "OVERDUE_PERIOD",
      "UPCOMING_VACATION",
      "PENDING_AND_UPCOMING",
    ] as const),
    active: z.preprocess(
      (value) => (typeof value === "string" ? value === "true" : undefined),
      z.boolean().optional(),
    ),
  }),
);

export const schedulerRunPageQuerySchema = paginatedListQuerySchema(
  MAX_PAGE_SIZE,
  z.object({
    jobName: optionalEnumQuerySchema(["VACATION_ACCRUAL"] as const),
    status: optionalEnumQuerySchema(["RUNNING", "COMPLETED", "FAILED"] as const),
    fromDate: optionalQueryDateSchema,
    toDate: optionalQueryDateSchema,
  }),
);

export const importBatchPageQuerySchema = paginatedListQuerySchema(
  MAX_PAGE_SIZE,
  z.object({
    actorId: optionalQueryStringSchema,
    status: optionalEnumQuerySchema([
      "PROCESSING",
      "COMPLETED",
      "COMPLETED_WITH_ERRORS",
      "FAILED",
    ] as const),
    fileName: optionalTrimmedQueryStringSchema,
    fromDate: optionalQueryDateSchema,
    toDate: optionalQueryDateSchema,
  }),
);

export const reconciliationPageQuerySchema = paginatedListQuerySchema(
  MAX_PAGE_SIZE,
  z.object({
    search: optionalTrimmedQueryStringSchema,
    state: optionalEnumQuerySchema(["ENJOYED", "LIQUIDATED", "PENDING_LIQUIDATION"] as const),
  }),
);
