import { z } from "zod";
import { parseLocalDate } from "../../domain/shared/localDate.js";

export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((value, context) => {
    try {
      return parseLocalDate(value);
    } catch {
      context.addIssue({ code: "custom", message: `Invalid LocalDate: ${value}` });
      return z.NEVER;
    }
  });

const queryString = (value: unknown) => (typeof value === "string" ? value : undefined);

export const optionalQueryStringSchema = z.preprocess(queryString, z.string().optional());
export const optionalTrimmedQueryStringSchema = z.preprocess(
  queryString,
  z
    .string()
    .transform((value) => value.trim())
    .optional(),
);
export const optionalQueryDateSchema = z.preprocess((value) => {
  const parsed = queryString(value);
  return parsed ? parsed : undefined;
}, localDateSchema.optional());

export function optionalEnumQuerySchema<const Values extends readonly [string, ...string[]]>(
  values: Values,
) {
  return z.preprocess(
    (value) =>
      typeof value === "string" && (values as readonly string[]).includes(value)
        ? value
        : undefined,
    z.enum(values).optional(),
  );
}

export function numberQuerySchema(fallback: number) {
  return z.preprocess((value) => {
    const number = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
    return Number.isFinite(number) ? number : fallback;
  }, z.number());
}

export function optionalNumberQuerySchema() {
  return z.preprocess((value) => {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }, z.number().optional());
}

export function paginationQuerySchema(maxPageSize: number) {
  return z.object({
    page: numberQuerySchema(1).transform((value) => Math.max(1, value || 1)),
    pageSize: numberQuerySchema(20).transform((value) =>
      Math.min(maxPageSize, Math.max(1, value || 20)),
    ),
  });
}

export function paginatedListQuerySchema<T extends z.ZodRawShape>(
  maxPageSize: number,
  extras: z.ZodObject<T>,
) {
  return paginationQuerySchema(maxPageSize).merge(extras);
}

export const optionalAsOfQuerySchema = z.object({ asOf: optionalQueryDateSchema });

export const holidayYearQuerySchema = z.object({
  year: z.preprocess((value) => {
    if (typeof value !== "string") return undefined;
    const year = Number(value);
    return Number.isInteger(year) ? year : undefined;
  }, z.number().int().optional()),
});
