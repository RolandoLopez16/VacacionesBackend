import { z } from "zod";
import {
  numberQuerySchema,
  optionalEnumQuerySchema,
  optionalQueryDateSchema,
  optionalQueryStringSchema,
  optionalTrimmedQueryStringSchema,
} from "./common.js";

const reportFormatSchema = optionalEnumQuerySchema(["json", "csv", "xlsx", "pdf"]);

export const balancesReportQuerySchema = z.object({
  search: optionalQueryStringSchema,
  asOf: optionalQueryDateSchema,
  format: reportFormatSchema,
});

export const datedReportQuerySchema = z.object({
  asOf: optionalQueryDateSchema,
  format: reportFormatSchema,
});

export const upcomingReportQuerySchema = datedReportQuerySchema.extend({
  days: numberQuerySchema(90).transform((value) => Math.min(365, Math.max(1, value || 90))),
});

export const settlementReportQuerySchema = z.object({
  search: optionalTrimmedQueryStringSchema,
  status: optionalEnumQuerySchema(["ACTIVE", "ANULADA"]),
  format: reportFormatSchema,
});

export const annualScheduleReportQuerySchema = z.object({
  year: z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : Number(value)),
    z
      .number()
      .int()
      .min(2000, "El año debe estar entre 2000 y 2100")
      .max(2100, { message: "El año debe estar entre 2000 y 2100" })
      .optional(),
  ),
  from: optionalQueryDateSchema,
  to: optionalQueryDateSchema,
  status: optionalEnumQuerySchema(["SCHEDULED", "CANCELLED", "COMPLETED"]),
  search: optionalTrimmedQueryStringSchema,
  format: optionalEnumQuerySchema(["json", "pdf"]),
});
