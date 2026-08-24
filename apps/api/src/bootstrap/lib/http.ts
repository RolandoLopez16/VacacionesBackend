import type { Request } from "express";
import type { z } from "zod";
import { ValidationError } from "../../domain/shared/errors.js";

export interface RequestContext extends Request {
  actorId?: string;
  actorRole?: "ADMIN" | "HR" | "VIEWER" | "READ_ONLY";
  requestId?: string;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}

export function parseBody<T>(schema: z.ZodType<T>, req: Request): T {
  return parse(schema, req.body);
}

export function parseQuery<T>(schema: z.ZodType<T>, req: Request): T {
  return parse(schema, req.query);
}

export function compactQuery<T extends Record<string, unknown>>(
  query: T,
  required: Array<keyof T> = [],
): T {
  const result = { ...query };
  for (const key of Object.keys(query) as Array<keyof T>) {
    if (required.includes(key)) continue;
    const value = query[key];
    if (value === undefined || value === null || value === "") {
      delete result[key];
    }
  }
  return result as T;
}

export function actor(req: Request): string {
  return (req as RequestContext).actorId ?? "system";
}

export function expectedVersion(req: Request): number | undefined {
  const value = req.header("If-Match") ?? req.body?.version;
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
