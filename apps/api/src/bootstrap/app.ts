import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
import { z } from "zod";
import { MemoryStore } from "../adapters/outbound/memory/memoryRepositories.js";
import type { VacationStore } from "../application/ports/repositories.js";
import {
  VacationService,
  type EmploymentInput,
  type ScheduleInput,
  type SettlementInput,
} from "../application/services/vacationService.js";
import { env } from "../infrastructure/config/env.js";
import {
  addDays,
  parseLocalDate,
  type LocalDate,
} from "../domain/shared/localDate.js";
import {
  AuthService,
  refreshSecretFrom,
} from "../application/services/authService.js";
import {
  can,
  permissionFor,
} from "../application/services/permissionService.js";
import {
  buildPdf,
  buildXlsx,
} from "../infrastructure/reports/reportExporters.js";
import { buildAnnualSchedulePdf } from "../infrastructure/reports/annualSchedulePdf.js";
import { parseXlsx } from "../infrastructure/imports/xlsxParser.js";
import type { SettlementRawRow } from "../application/services/settlementImport.js";

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((value) => parseLocalDate(value));
const queryDate = (value: unknown): LocalDate | undefined =>
  typeof value === "string" ? parseLocalDate(value) : undefined;
function queryYear(value: unknown) {
  const year = value === undefined ? new Date().getUTCFullYear() : Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw Object.assign(new Error("El año debe estar entre 2000 y 2100"), {
      status: 400,
    });
  }
  return year;
}
function listFilters(query: Request["query"]) {
  return {
    ...(query.status === "ACTIVE" || query.status === "RETIRED"
      ? { status: query.status }
      : {}),
    ...(typeof query.process === "string" && query.process.trim()
      ? { processName: query.process.trim() }
      : {}),
    ...(query.vacationStatus === "PENDING" ||
    query.vacationStatus === "SCHEDULED" ||
    query.vacationStatus === "OVERDUE" ||
    query.vacationStatus === "CLEAR"
      ? { vacationStatus: query.vacationStatus }
      : {}),
    ...(typeof query.alert === "string" && query.alert.trim()
      ? { alert: query.alert.trim() }
      : {}),
    ...(query.from ? { fromDate: queryDate(query.from) } : {}),
    ...(query.to ? { toDate: queryDate(query.to) } : {}),
  };
}
const employmentInput = z.object({
  documentNumber: z.string().trim().min(3),
  fullName: z.string().trim().min(2),
  startDate: localDate,
  endDate: localDate.optional(),
  contractTypeName: z.string().trim().min(2),
  processName: z.string().trim().min(2),
  positionName: z.string().trim().min(2),
  supervisorName: z.string().trim().optional(),
});
const scheduleInput = z.object({
  employmentId: z.string().min(1),
  startDate: localDate,
  endDate: localDate.optional(),
  scheduledDays: z.number().int().positive(),
  allocations: z
    .array(
      z.object({
        periodId: z.string().optional(),
        periodType: z.enum(["CAUSED", "FUTURE"]),
        periodStartDate: localDate,
        periodEndDate: localDate,
        days: z.number().int().positive(),
      }),
    )
    .min(1),
});
const settlementInput = z.object({
  employmentId: z.string().min(1),
  sourceScheduleId: z.string().optional(),
  enjoymentStartDate: localDate,
  enjoymentEndDate: localDate.optional(),
  periodEndDate: localDate.optional(),
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
const retirementInput = z.object({ endDate: localDate });
const workerInput = z.object({
  documentNumber: z.string().trim().min(3),
  fullName: z.string().trim().min(2),
});
const policyInput = z.object({
  effectiveFrom: localDate,
  daysPerCompletedYear: z.number().int().positive(),
  overdueAfterMonths: z.number().int().positive(),
  upcomingAccrualAlerts: z.array(z.number().int().positive()).min(1),
  active: z.boolean().default(true),
});
const userInput = z.object({
  username: z.string().trim().min(3),
  password: z.string().min(8),
  role: z.enum(["ADMIN", "HR", "VIEWER", "READ_ONLY"]),
  displayName: z.string().trim().min(2).optional(),
  jobTitle: z.string().trim().min(2).optional(),
});
const catalogInput = z.object({
  name: z.string().trim().min(2),
  active: z.boolean().optional(),
});
const systemSettingInput = z.object({
  value: z.string().trim().min(2).max(160),
});
const holidayInput = z.object({
  date: localDate,
  name: z.string().trim().min(2),
  country: z.string().trim().default("CO"),
  active: z.boolean().default(true),
});
const holidayPatchInput = z.object({
  date: localDate.optional(),
  name: z.string().trim().min(2).optional(),
  country: z.string().trim().min(2).optional(),
  active: z.boolean().optional(),
});
function body<T>(schema: z.ZodType<T>, req: Request): T {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const error = new Error(
      parsed.error.issues.map((i) => i.message).join("; "),
    ) as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  return parsed.data;
}
function scheduleBody(req: Request): ScheduleInput {
  const input = body(scheduleInput, req);
  return {
    ...input,
    endDate: input.endDate ?? addDays(input.startDate, input.scheduledDays - 1),
  } as ScheduleInput;
}
function settlementBody(req: Request): SettlementInput {
  const input = body(settlementInput, req);
  const total = Math.max(1, input.enjoyedDays + input.compensatedDays);
  return {
    ...input,
    enjoymentEndDate:
      input.enjoymentEndDate ?? addDays(input.enjoymentStartDate, total - 1),
  } as SettlementInput;
}
function importRows(req: Request): {
  fileName: string;
  fileHash: string;
  rows: SettlementRawRow[];
} {
  const input = z
    .object({
      fileName: z.string().trim().min(1),
      contentBase64: z.string().optional(),
      content: z.string().optional(),
    })
    .refine((value) => Boolean(value.contentBase64 || value.content), {
      message: "Debe seleccionar un archivo",
    })
    .parse(req.body);
  const rawBuffer = input.contentBase64
    ? Buffer.from(input.contentBase64, "base64")
    : Buffer.from(input.content ?? "", "utf8");
  if (rawBuffer.byteLength > env.MAX_UPLOAD_MB * 1024 * 1024)
    throw Object.assign(
      new Error(`El archivo supera el máximo de ${env.MAX_UPLOAD_MB} MB`),
      { status: 413 },
    );
  const isXlsx =
    input.fileName.toLowerCase().endsWith(".xlsx") ||
    input.fileName.toLowerCase().endsWith(".xlsm");
  const parsed = isXlsx
    ? parseXlsx(rawBuffer)
    : csvRows(rawBuffer.toString("utf8"));
  const rows: SettlementRawRow[] = isXlsx
    ? (
        parsed as {
          rows: { lineNumber: number; raw: Record<string, unknown> }[];
        }
      ).rows
    : (parsed as { rows: Record<string, unknown>[] }).rows.map(
        (raw, index) => ({ lineNumber: index + 2, raw }),
      );
  if (rows.length > env.MAX_IMPORT_ROWS)
    throw Object.assign(
      new Error(`El archivo supera el máximo de ${env.MAX_IMPORT_ROWS} líneas`),
      { status: 413 },
    );
  return {
    fileName: input.fileName,
    fileHash: createHash("sha256").update(rawBuffer).digest("hex"),
    rows,
  };
}
function closureDates(req: Request) {
  const input = body(
    z.object({
      fromDate: z.string().optional(),
      asOf: z.string().optional(),
    }),
    req,
  );
  return {
    fromDate: input.fromDate
      ? parseLocalDate(input.fromDate)
      : ("2025-01-01" as LocalDate),
    asOf: input.asOf ? parseLocalDate(input.asOf) : undefined,
  };
}
function cookie(req: Request, name: string) {
  return req.headers.cookie
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function expectedVersion(req: Request) {
  const value = req.header("If-Match") ?? req.body?.version;
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 1
    ? parsed
    : undefined;
}
function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
) {
  const secure = env.NODE_ENV === "production";
  const flags = `HttpOnly; SameSite=Lax; Path=/${secure ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", [
    `vaca_access=${accessToken}; Max-Age=900; ${flags}`,
    `vaca_refresh=${refreshToken}; Max-Age=604800; ${flags}`,
  ]);
}
function clearAuthCookies(res: Response) {
  res.setHeader("Set-Cookie", [
    "vaca_access=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/",
    "vaca_refresh=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/",
  ]);
}
function requireSession(req: Request, auth: AuthService) {
  const path = req.originalUrl.split("?")[0] ?? req.path;
  const isPublic =
    path.startsWith("/api/v1/health") ||
    path.startsWith("/health") ||
    path.endsWith("/auth/login") ||
    path.endsWith("/auth/refresh") ||
    path.endsWith("/auth/logout");
  if (isPublic) return;
  const session = auth.verifyAccess(cookie(req, "vaca_access") ?? "");
  if (!session) {
    const e = new Error("Authentication required") as Error & {
      status?: number;
    };
    e.status = 401;
    throw e;
  }
  const permission = permissionFor(req.method, path);
  if (permission && !can(session.role, permission)) {
    const e = new Error("Insufficient permissions") as Error & {
      status?: number;
    };
    e.status = 403;
    throw e;
  }
  (req as Request & { actorId?: string }).actorId = session.username;
}
function actor(req: Request) {
  return (req as Request & { actorId?: string }).actorId ?? "system";
}
function requestId(req: Request, res: Response, next: NextFunction) {
  const id = req.header("X-Request-Id") ?? crypto.randomUUID();
  res.setHeader("X-Request-Id", id);
  (req as Request & { requestId?: string }).requestId = id;
  next();
}
function repairUtf8Mojibake(value: string) {
  if (!/[ÃÂ]/.test(value)) return value;
  try {
    return new TextDecoder("utf-8").decode(
      Uint8Array.from([...value].map((char) => char.charCodeAt(0))),
    );
  } catch {
    return value;
  }
}
function normalizedHeader(value: string) {
  return repairUtf8Mojibake(value)
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
}
function csvLine(line: string, delimiter = ",") {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index++;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      values.push(repairUtf8Mojibake(current.trim()));
      current = "";
      continue;
    }
    current += char;
  }
  values.push(repairUtf8Mojibake(current.trim()));
  return values;
}
function csvDelimiter(header: string) {
  const semicolons = (header.match(/;/g) ?? []).length;
  const commas = (header.match(/,/g) ?? []).length;
  return semicolons > commas ? ";" : ",";
}
function csvRows(content: string) {
  const lines = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const delimiter = csvDelimiter(lines[0] ?? "");
  const headers = csvLine(lines.shift() ?? "", delimiter);
  return {
    headers,
    rows: lines.map((line) =>
      Object.fromEntries(
        csvLine(line, delimiter).map((value, index) => [
          headers[index] ?? `column${index + 1}`,
          value,
        ]),
      ),
    ),
  };
}
function normalizeImportDate(value: unknown) {
  if (typeof value !== "string") return value;
  const raw = repairUtf8Mojibake(value).trim();
  if (!raw) return raw;
  const dayFirst = raw.match(/^(\d{1,2})[\\/.\-](\d{1,2})[\\/.\-](\d{4})$/);
  if (dayFirst)
    return `${dayFirst[3]!}-${dayFirst[2]!.padStart(2, "0")}-${dayFirst[1]!.padStart(2, "0")}`;
  const yearFirst = raw.match(/^(\d{4})[\\/.\-](\d{1,2})[\\/.\-](\d{1,2})$/);
  return yearFirst
    ? `${yearFirst[1]!}-${yearFirst[2]!.padStart(2, "0")}-${yearFirst[3]!.padStart(2, "0")}`
    : raw;
}
function mapCsvRow(row: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(row)) {
    const key = normalizedHeader(header);
    const target =
      (
        {
          cedula: "documentNumber",
          documento: "documentNumber",
          documento_de_identidad: "documentNumber",
          document_number: "documentNumber",
          documentnumber: "documentNumber",
          nombre: "fullName",
          nombre_completo: "fullName",
          full_name: "fullName",
          fullname: "fullName",
          fecha_contrato: "startDate",
          fecha_ingreso: "startDate",
          fecha_de_ingreso: "startDate",
          start_date: "startDate",
          startdate: "startDate",
          fecha_retiro: "endDate",
          fecha_de_retiro: "endDate",
          end_date: "endDate",
          enddate: "endDate",
          tipo_contrato: "contractTypeName",
          tipo_de_contrato: "contractTypeName",
          contract_type: "contractTypeName",
          contracttypename: "contractTypeName",
          proceso: "processName",
          process_name: "processName",
          processname: "processName",
          cargo: "positionName",
          posicion: "positionName",
          position_name: "positionName",
          positionname: "positionName",
          supervisor: "supervisorName",
          nombre_supervisor: "supervisorName",
          supervisor_name: "supervisorName",
          supervisorname: "supervisorName",
        } as Record<string, string>
      )[key] ?? key;
    const cleanValue =
      typeof value === "string" ? repairUtf8Mojibake(value).trim() : value;
    if (target === "endDate" && cleanValue === "") continue;
    mapped[target] =
      target === "startDate" || target === "endDate"
        ? normalizeImportDate(cleanValue)
        : cleanValue;
  }
  return mapped;
}
function csvEscape(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}
function sendReport(
  res: Response,
  format: unknown,
  filename: string,
  rows: unknown[][],
) {
  if (format === "xlsx") {
    res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .set("Content-Disposition", `attachment; filename="${filename}.xlsx"`)
      .send(buildXlsx(rows));
    return true;
  }
  if (format === "pdf") {
    res
      .type("application/pdf")
      .set("Content-Disposition", `attachment; filename="${filename}.pdf"`)
      .send(buildPdf(rows));
    return true;
  }
  if (format === "csv") {
    res
      .type("text/csv")
      .set("Content-Disposition", `attachment; filename="${filename}.csv"`)
      .send(rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
    return true;
  }
  return false;
}

export async function createApp(
  store: VacationStore = new MemoryStore(),
  seedDemo = false,
  auth?: AuthService,
) {
  const service = new VacationService(store);
  const authService =
    auth ??
    new AuthService(
      store,
      {
        jwtSecret: env.JWT_SECRET,
        refreshSecret:
          env.JWT_REFRESH_SECRET ?? refreshSecretFrom(env.JWT_SECRET),
        accessExpiresIn: env.JWT_EXPIRES_IN,
        refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
      },
      store,
    );
  await authService.ensureAdmin(
    env.BOOTSTRAP_ADMIN_USERNAME,
    env.BOOTSTRAP_ADMIN_PASSWORD,
  );
  if (seedDemo) await service.seed();
  const app = express();
  app.disable("x-powered-by");
  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.split(",").map((x) => x.trim()),
      credentials: true,
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.use(express.json({ limit: `${Math.ceil(env.MAX_UPLOAD_MB * 1.4)}mb` }));
  app.use((req, _res, next) => {
    try {
      requireSession(req, authService);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/v1/health", (_req, res) =>
    res.json({
      status: "ok",
      service: "vaca-efa-api",
      storage: env.STORAGE_MODE,
    }),
  );
  app.get("/api/v1/health/live", (_req, res) =>
    res.json({ status: "ok", service: "vaca-efa-api" }),
  );
  app.get("/api/v1/health/ready", async (_req, res, next) => {
    try {
      await store.ping?.();
      res.json({ status: "ready", storage: env.STORAGE_MODE });
    } catch (error) {
      next(error);
    }
  });
  app.get("/health/live", (_req, res) =>
    res.json({ status: "ok", service: "vaca-efa-api" }),
  );
  app.get("/health/ready", async (_req, res, next) => {
    try {
      await store.ping?.();
      res.json({ status: "ready", storage: env.STORAGE_MODE });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/v1/auth/login", async (req, res) => {
    const input = body(
      z.object({ username: z.string().min(1), password: z.string().min(1) }),
      req,
    );
    const tokens = await authService.login(input.username, input.password);
    if (!tokens)
      return res.status(401).json({
        code: "INVALID_CREDENTIALS",
        message: "Usuario o contraseña inválidos",
      });
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    return res.json({ user: tokens.user });
  });
  app.post("/api/v1/auth/refresh", async (req, res) => {
    const tokens = await authService.refresh(cookie(req, "vaca_refresh") ?? "");
    if (!tokens) {
      clearAuthCookies(res);
      return res.status(401).json({
        code: "INVALID_REFRESH_TOKEN",
        message: "La sesión de actualización expiró",
      });
    }
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    return res.json({ user: tokens.user });
  });
  app.post("/api/v1/auth/logout", async (req, res) => {
    await authService.revokeRefreshToken(cookie(req, "vaca_refresh") ?? "");
    clearAuthCookies(res);
    res.status(204).end();
  });
  app.get("/api/v1/auth/me", async (req, res) => {
    const session = authService.verifyAccess(cookie(req, "vaca_access") ?? "");
    if (!session)
      return res
        .status(401)
        .json({ code: "UNAUTHORIZED", message: "Authentication required" });
    const user = await authService.currentUser(session.username);
    if (!user)
      return res
        .status(401)
        .json({ code: "UNAUTHORIZED", message: "User inactive" });
    res.json({ user });
  });
  app.post("/api/v1/auth/change-password", async (req, res) => {
    const session = authService.verifyAccess(cookie(req, "vaca_access") ?? "");
    if (!session)
      return res
        .status(401)
        .json({ code: "UNAUTHORIZED", message: "Authentication required" });
    const input = body(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8),
      }),
      req,
    );
    const changed = await authService.changePassword(
      session.username,
      input.currentPassword,
      input.newPassword,
    );
    if (!changed)
      return res.status(400).json({
        code: "INVALID_PASSWORD",
        message: "La contraseña actual no es válida",
      });
    clearAuthCookies(res);
    res.status(204).end();
  });
  app.get("/api/v1/dashboard", async (req, res) =>
    res.json(
      await service.dashboard(
        queryDate(req.query.asOf),
        listFilters(req.query),
      ),
    ),
  );
  app.get("/api/v1/dashboard/summary", async (req, res) => {
    const data = await service.dashboard(
      queryDate(req.query.asOf),
      listFilters(req.query),
    );
    res.json({ data, ...data });
  });
  app.get("/api/v1/dashboard/upcoming-accruals", async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
    const data = await service.list("", days, queryDate(req.query.asOf));
    res.json({ data, items: data });
  });
  app.get("/api/v1/dashboard/overdue-periods", async (req, res) => {
    const data = (
      await service.list("", undefined, queryDate(req.query.asOf))
    ).filter((item) => item.overduePeriods > 0);
    res.json({ data, items: data });
  });
  app.get("/api/v1/dashboard/upcoming-vacations", async (req, res) => {
    const data = (await store.listSchedules())
      .filter((item) => item.status === "SCHEDULED")
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    res.json({ data, items: data });
  });
  app.get("/api/v1/dashboard/pending-and-upcoming", async (req, res) => {
    const data = (await service.list("", 90, queryDate(req.query.asOf))).filter(
      (item) => item.pendingDays > 0,
    );
    res.json({ data, items: data });
  });
  app.get("/api/v1/workers", async (_req, res) => {
    const data = await store.listWorkers();
    res.json({ data, items: data });
  });
  app.post("/api/v1/workers", async (req, res) => {
    const input = body(workerInput, req);
    const normalized =
      input.documentNumber.replace(/\D/g, "") ||
      input.documentNumber.toUpperCase();
    if (
      (await store.listWorkers()).some(
        (worker) => worker.normalizedDocumentNumber === normalized,
      )
    )
      throw new Error("The document number already exists");
    const now = new Date().toISOString();
    const worker = {
      id: crypto.randomUUID(),
      documentNumber: input.documentNumber,
      normalizedDocumentNumber: normalized,
      fullName: input.fullName,
      workerType: "EMPLOYEE" as const,
      createdAt: now,
      updatedAt: now,
    };
    await store.saveWorker(worker);
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: "WORKER_CREATED",
      entityType: "Worker",
      entityId: worker.id,
      metadata: {},
      createdAt: now,
    });
    res.status(201).json({ data: worker, ...worker });
  });
  app.get("/api/v1/workers/:workerId", async (req, res) => {
    const worker = await store.findWorkerById(req.params.workerId);
    if (!worker)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Worker not found" });
    res.json({ data: worker, ...worker });
  });
  app.patch("/api/v1/workers/:workerId", async (req, res) => {
    const worker = await store.findWorkerById(req.params.workerId);
    if (!worker)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Worker not found" });
    const input = body(workerInput.partial(), req);
    const normalized = input.documentNumber
      ? input.documentNumber.replace(/\D/g, "") ||
        input.documentNumber.toUpperCase()
      : worker.normalizedDocumentNumber;
    const duplicate = (await store.listWorkers()).some(
      (item) =>
        item.id !== worker.id && item.normalizedDocumentNumber === normalized,
    );
    if (duplicate) throw new Error("The document number already exists");
    const updated = {
      ...worker,
      ...input,
      documentNumber: input.documentNumber ?? worker.documentNumber,
      fullName: input.fullName ?? worker.fullName,
      normalizedDocumentNumber: normalized,
      updatedAt: new Date().toISOString(),
    };
    await store.saveWorker(updated);
    res.json({ data: updated, ...updated });
  });
  app.get("/api/v1/workers/:workerId/employments", async (req, res) => {
    const data = (await store.listEmployments()).filter(
      (item) => item.workerId === req.params.workerId,
    );
    res.json({ data, items: data });
  });
  app.post("/api/v1/workers/:workerId/employments", async (req, res) => {
    const worker = await store.findWorkerById(req.params.workerId);
    if (!worker)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Worker not found" });
    const input = body(employmentInput, req);
    const result = await service.upsertEmployment(
      { ...input, documentNumber: worker.documentNumber },
      actor(req),
    );
    res.status(result.created ? 201 : 200).json(await result.summary);
  });
  app.get("/api/v1/employments", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      env.MAX_PAGE_SIZE,
      Math.max(1, Number(req.query.pageSize) || 20),
    );
    const max =
      typeof req.query.accrualWithin === "string"
        ? Number(req.query.accrualWithin)
        : undefined;
    const result = await service.listPage({
      page,
      pageSize,
      search: typeof req.query.search === "string" ? req.query.search : "",
      maxDays: Number.isFinite(max) ? max : undefined,
      asOf: queryDate(req.query.asOf),
      filters: listFilters(req.query),
      sortByPendingDays: req.query.sort === "pendingDays",
    });
    res.json({
      items: result.items,
      page,
      pageSize,
      total: result.total,
      hasNext: page * pageSize < result.total,
    });
  });
  app.get("/api/v1/employments/:id", async (req, res) =>
    res.json(await service.detail(req.params.id, queryDate(req.query.asOf))),
  );
  app.get("/api/v1/employments/:id/periods", async (req, res) => {
    const detail = await service.detail(
      req.params.id,
      queryDate(req.query.asOf),
    );
    res.json({ items: detail.periods });
  });
  app.get("/api/v1/employments/:id/vacation-summary", async (req, res) => {
    const detail = await service.detail(
      req.params.id,
      queryDate(req.query.asOf),
    );
    res.json({ data: detail, ...detail });
  });
  app.get("/api/v1/employments/:id/vacation-periods", async (req, res) => {
    const detail = await service.detail(
      req.params.id,
      queryDate(req.query.asOf),
    );
    res.json({ data: detail.periods, items: detail.periods });
  });
  app.post("/api/v1/employments", async (req, res) => {
    const result = await service.upsertEmployment(
      body(employmentInput, req) as EmploymentInput,
      actor(req),
    );
    return res.status(result.created ? 201 : 200).json(await result.summary);
  });
  app.patch("/api/v1/employments/:id", async (req, res) =>
    res.json(
      await service.updateEmployment(
        req.params.id,
        body(employmentInput, req) as EmploymentInput,
        expectedVersion(req),
        actor(req),
      ),
    ),
  );
  app.post("/api/v1/employments/:id/retire", async (req, res) =>
    res.json(
      await service.retireEmployment(
        req.params.id,
        body(retirementInput, req).endDate,
        expectedVersion(req),
        actor(req),
      ),
    ),
  );
  app.get("/api/v1/vacation-periods", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      env.MAX_PAGE_SIZE,
      Math.max(1, Number(req.query.pageSize) || 20),
    );
    const employmentId =
      typeof req.query.employmentId === "string"
        ? req.query.employmentId
        : undefined;
    if (employmentId) {
      const detail = await service.detail(
        employmentId,
        queryDate(req.query.asOf),
      );
      const start = (page - 1) * pageSize;
      const items = detail.periods.slice(start, start + pageSize);
      return res.json({
        data: items,
        items,
        page,
        pageSize,
        total: detail.periods.length,
        hasNext: page * pageSize < detail.periods.length,
      });
    }
    const employments = await store.listEmploymentPage({ page, pageSize });
    const periods = await store.findByEmploymentIds(
      employments.items.map((item) => item.id),
    );
    res.json({
      data: periods,
      items: periods,
      page,
      pageSize,
      total: employments.total,
      hasNext: page * pageSize < employments.total,
    });
  });
  app.get("/api/v1/vacation-periods/:periodId", async (req, res) => {
    const period = await store.findPeriodById(req.params.periodId);
    if (!period)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Vacation period not found" });
    res.json({ data: period, ...period });
  });
  app.get("/api/v1/schedules", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      env.MAX_PAGE_SIZE,
      Math.max(1, Number(req.query.pageSize) || 20),
    );
    const status =
      req.query.status === "SCHEDULED" ||
      req.query.status === "CANCELLED" ||
      req.query.status === "COMPLETED"
        ? req.query.status
        : undefined;
    const result = await service.schedulePage({
      page,
      pageSize,
      ...(typeof req.query.employmentId === "string"
        ? { employmentId: req.query.employmentId }
        : {}),
      ...(typeof req.query.search === "string" ? { search: req.query.search } : {}),
      ...(status ? { status } : {}),
      ...(req.query.from ? { fromDate: queryDate(req.query.from) } : {}),
      ...(req.query.to ? { toDate: queryDate(req.query.to) } : {}),
    });
    res.json({
      items: result.items,
      page,
      pageSize,
      total: result.total,
      hasNext: page * pageSize < result.total,
    });
  });
  app.post("/api/v1/schedules", async (req, res) =>
    res
      .status(201)
      .json(await service.createSchedule(scheduleBody(req), actor(req))),
  );
  app.patch("/api/v1/schedules/:id", async (req, res) =>
    res.json(
      await service.updateSchedule(
        req.params.id,
        scheduleBody(req),
        expectedVersion(req),
        actor(req),
      ),
    ),
  );
  app.post("/api/v1/schedules/:id/cancel", async (req, res) =>
    res.json(
      await service.cancelSchedule(
        req.params.id,
        expectedVersion(req),
        actor(req),
      ),
    ),
  );
  app.post("/api/v1/schedules/:id/complete", async (req, res) =>
    res.json(
      await service.completeSchedule(
        req.params.id,
        settlementBody(req),
        expectedVersion(req),
        actor(req),
      ),
    ),
  );
  app.get("/api/v1/vacation-schedules", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      env.MAX_PAGE_SIZE,
      Math.max(1, Number(req.query.pageSize) || 20),
    );
    const status =
      req.query.status === "SCHEDULED" ||
      req.query.status === "CANCELLED" ||
      req.query.status === "COMPLETED"
        ? req.query.status
        : undefined;
    const result = await service.schedulePage({
      page,
      pageSize,
      ...(typeof req.query.employmentId === "string"
        ? { employmentId: req.query.employmentId }
        : {}),
      ...(typeof req.query.search === "string" ? { search: req.query.search } : {}),
      ...(status ? { status } : {}),
      ...(req.query.from ? { fromDate: queryDate(req.query.from) } : {}),
      ...(req.query.to ? { toDate: queryDate(req.query.to) } : {}),
    });
    res.json({
      data: result.items,
      items: result.items,
      page,
      pageSize,
      total: result.total,
      hasNext: page * pageSize < result.total,
    });
  });
  app.post("/api/v1/vacation-schedules", async (req, res) =>
    res
      .status(201)
      .json(await service.createSchedule(scheduleBody(req), actor(req))),
  );
  app.get("/api/v1/vacation-schedules/:id", async (req, res) => {
    const schedule = await store.findScheduleById(req.params.id);
    if (!schedule)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Schedule not found" });
    res.json({ data: schedule, ...schedule });
  });
  app.post("/api/v1/vacation-schedules/:id/reschedule", async (req, res) =>
    res.json(
      await service.updateSchedule(
        req.params.id,
        scheduleBody(req),
        expectedVersion(req),
        actor(req),
      ),
    ),
  );
  app.post("/api/v1/vacation-schedules/:id/cancel", async (req, res) =>
    res.json(
      await service.cancelSchedule(
        req.params.id,
        expectedVersion(req),
        actor(req),
      ),
    ),
  );
  app.post(
    "/api/v1/vacation-schedules/:id/register-settlement",
    async (req, res) =>
      res.json(
        await service.completeSchedule(
          req.params.id,
          settlementBody(req),
          expectedVersion(req),
          actor(req),
        ),
      ),
  );
  app.get("/api/v1/settlements", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      env.MAX_PAGE_SIZE,
      Math.max(1, Number(req.query.pageSize) || 20),
    );
    const status =
      req.query.status === "ANULADA"
        ? "ANULADA"
        : req.query.status === "ACTIVE"
          ? "ACTIVE"
          : undefined;
    const result = await service.settlementPage({
      page,
      pageSize,
      ...(typeof req.query.employmentId === "string"
        ? { employmentId: req.query.employmentId }
        : {}),
      ...(typeof req.query.search === "string" && req.query.search.trim()
        ? { search: req.query.search.trim() }
        : {}),
      ...(typeof req.query.from === "string"
        ? { fromDate: queryDate(req.query.from) }
        : {}),
      ...(typeof req.query.to === "string"
        ? { toDate: queryDate(req.query.to) }
        : {}),
      ...(status ? { status } : {}),
    });
    res.json({
      items: result.items,
      page,
      pageSize,
      total: result.total,
      hasNext: page * pageSize < result.total,
    });
  });
  app.post("/api/v1/settlements", async (req, res) =>
    res
      .status(201)
      .json(await service.createSettlement(settlementBody(req), actor(req))),
  );
  app.patch("/api/v1/settlements/:id", async (req, res) =>
    res.json(
      await service.updateSettlement(
        req.params.id,
        settlementBody(req),
        expectedVersion(req),
        actor(req),
      ),
    ),
  );
  app.get("/api/v1/vacation-settlements", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      env.MAX_PAGE_SIZE,
      Math.max(1, Number(req.query.pageSize) || 20),
    );
    const status =
      req.query.status === "ANULADA"
        ? "ANULADA"
        : req.query.status === "ACTIVE"
          ? "ACTIVE"
          : undefined;
    const result = await service.settlementPage({
      page,
      pageSize,
      ...(typeof req.query.employmentId === "string"
        ? { employmentId: req.query.employmentId }
        : {}),
      ...(typeof req.query.search === "string" && req.query.search.trim()
        ? { search: req.query.search.trim() }
        : {}),
      ...(status ? { status } : {}),
    });
    res.json({
      data: result.items,
      items: result.items,
      page,
      pageSize,
      total: result.total,
      hasNext: page * pageSize < result.total,
    });
  });
  app.post("/api/v1/vacation-settlements", async (req, res) =>
    res
      .status(201)
      .json(await service.createSettlement(settlementBody(req), actor(req))),
  );
  app.get("/api/v1/vacation-settlements/:id", async (req, res) => {
    const item = await store.findSettlementById(req.params.id);
    if (!item)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Settlement not found" });
    res.json({ data: item, ...item });
  });
  app.patch("/api/v1/vacation-settlements/:id", async (req, res) =>
    res.json(
      await service.updateSettlement(
        req.params.id,
        settlementBody(req),
        expectedVersion(req),
        actor(req),
      ),
    ),
  );
  app.post("/api/v1/vacation-settlements/:id/annul", async (req, res) => {
    const input = body(z.object({ reason: z.string().trim().min(3) }), req);
    res.json({
      data: await service.annulSettlement(
        req.params.id,
        input.reason,
        expectedVersion(req),
        actor(req),
      ),
    });
  });
  app.post("/api/v1/vacation-settlements/import/preview", async (req, res) => {
    const input = importRows(req);
    res.json(
      await service.previewSettlementImport(
        input.fileName,
        input.fileHash,
        input.rows,
        actor(req),
      ),
    );
  });
  app.post(
    "/api/v1/vacation-settlements/import/:batchId/apply",
    async (req, res) => {
      const input = importRows(req);
      const parsed = body(z.object({ previewToken: z.string().min(1) }), req);
      res.json(
        await service.applySettlementImport(
          req.params.batchId,
          input.fileName,
          input.fileHash,
          parsed.previewToken,
          input.rows,
          actor(req),
        ),
      );
    },
  );
  app.get("/api/v1/vacation-settlements/import/:batchId", async (req, res) => {
    const batch = await store.findVacationSettlementImportBatch(
      req.params.batchId,
    );
    if (!batch)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Import batch not found" });
    res.json({ data: batch, ...batch });
  });
  app.post(
    "/api/v1/admin/vacation-period-closures/preview",
    async (req, res) => {
      const input = importRows(req);
      const dates = closureDates(req);
      res.json(
        await service.previewVacationPeriodClosure(
          input.fileName,
          input.fileHash,
          input.rows,
          actor(req),
          dates.fromDate,
          dates.asOf,
        ),
      );
    },
  );
  app.post(
    "/api/v1/admin/vacation-period-closures/:batchId/apply",
    async (req, res) => {
      const input = importRows(req);
      const dates = closureDates(req);
      const parsed = body(z.object({ previewToken: z.string().min(1) }), req);
      res.json(
        await service.applyVacationPeriodClosure(
          req.params.batchId,
          input.fileName,
          input.fileHash,
          parsed.previewToken,
          input.rows,
          actor(req),
          dates.fromDate,
          dates.asOf,
        ),
      );
    },
  );
  app.get(
    "/api/v1/admin/vacation-period-closures/:batchId",
    async (req, res) => {
      const batch = await store.findVacationPeriodClosureBatch(req.params.batchId);
      if (!batch)
        return res
          .status(404)
          .json({ code: "NOT_FOUND", message: "Cierre masivo no encontrado" });
      res.json({ data: batch, ...batch });
    },
  );
  app.get("/api/v1/reports/balances", async (req, res) => {
    const items = await service.list(
      typeof req.query.search === "string" ? req.query.search : "",
      undefined,
      queryDate(req.query.asOf),
    );
    const rows = [
      [
        "Cédula",
        "Nombre",
        "Proceso",
        "Cargo",
        "Estado",
        "Días pendientes",
        "Disponible para programar",
        "Próxima causación",
      ],
      ...items.map((item) => [
        item.documentNumber,
        item.fullName,
        item.processName,
        item.positionName,
        item.status,
        item.pendingDays,
        item.availableForScheduling,
        item.nextAccrualDate,
      ]),
    ];
    if (sendReport(res, req.query.format, "saldos-vacaciones", rows)) return;
    res.json({
      generatedAt: new Date().toISOString(),
      totals: {
        employees: items.length,
        active: items.filter((i) => i.status === "ACTIVE").length,
        pendingDays: items.reduce((n, i) => n + i.pendingDays, 0),
        availableForScheduling: items.reduce(
          (n, i) => n + i.availableForScheduling,
          0,
        ),
      },
      items,
    });
  });
  app.get("/api/v1/reports/balances.csv", async (req, res) => {
    const items = await service.list("", undefined, queryDate(req.query.asOf));
    const lines = [
      [
        "Cédula",
        "Nombre",
        "Proceso",
        "Cargo",
        "Estado",
        "Días pendientes",
        "Disponible para programar",
        "Próxima causación",
      ]
        .map(csvEscape)
        .join(","),
      ...items.map((item) =>
        [
          item.documentNumber,
          item.fullName,
          item.processName,
          item.positionName,
          item.status,
          item.pendingDays,
          item.availableForScheduling,
          item.nextAccrualDate,
        ]
          .map(csvEscape)
          .join(","),
      ),
    ];
    res
      .type("text/csv")
      .set(
        "Content-Disposition",
        'attachment; filename="saldos-vacaciones.csv"',
      )
      .send(lines.join("\n"));
  });
  app.get("/api/v1/reports/upcoming", async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
    const items = await service.list("", days, queryDate(req.query.asOf));
    res.json({ days, items });
  });
  app.get("/api/v1/reports/workers", async (req, res) => {
    const data = await store.listWorkers();
    const rows = [
      ["Cédula", "Nombre", "Tipo"],
      ...data.map((item) => [
        item.documentNumber,
        item.fullName,
        item.workerType,
      ]),
    ];
    if (sendReport(res, req.query.format, "trabajadores", rows)) return;
    res.json({ data, items: data });
  });
  app.get("/api/v1/reports/pending-periods", async (req, res) => {
    const data = (
      await service.list("", undefined, queryDate(req.query.asOf))
    ).filter((item) => item.pendingDays > 0);
    const rows = [
      ["Cédula", "Nombre", "Pendientes", "Atrasados"],
      ...data.map((item) => [
        item.documentNumber,
        item.fullName,
        item.pendingDays,
        item.overduePeriods,
      ]),
    ];
    if (sendReport(res, req.query.format, "periodos-pendientes", rows)) return;
    res.json({ data, items: data });
  });
  app.get("/api/v1/reports/upcoming-accruals", async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
    const data = await service.list("", days, queryDate(req.query.asOf));
    const rows = [
      ["Cédula", "Nombre", "Próxima causación", "Días restantes"],
      ...data.map((item) => [
        item.documentNumber,
        item.fullName,
        item.nextAccrualDate,
        item.daysUntilAccrual,
      ]),
    ];
    if (sendReport(res, req.query.format, "proximas-causaciones", rows)) return;
    res.json({ data, items: data });
  });
  app.get("/api/v1/reports/settlements", async (req, res) => {
    const status =
      req.query.status === "ACTIVE" || req.query.status === "ANULADA"
        ? req.query.status
        : undefined;
    const data = await service.settlementReport({
      ...(typeof req.query.search === "string" && req.query.search.trim()
        ? { search: req.query.search.trim() }
        : {}),
      ...(status ? { status } : {}),
    });
    const rows = [
      [
        "Empleado",
        "Cédula",
        "Proceso",
        "Cargo",
        "Supervisor",
        "Inicio disfrute",
        "Fin disfrute",
        "Fecha fin período",
        "Días tomados",
        "Días compensados",
        "Total calendario",
        "Valor total",
        "Documento de liquidación",
        "Estado",
      ],
      ...data.map((item) => [
        item.employeeName ?? "Empleado no identificado",
        item.employeeDocumentNumber ?? item.employmentId,
        item.processName ?? "",
        item.positionName ?? "",
        item.supervisorName ?? "",
        item.enjoymentStartDate,
        item.enjoymentEndDate,
        item.periodEndDate,
        item.enjoyedDays,
        item.compensatedDays,
        item.calendarDays,
        item.amountCOP,
        item.accountingDocument,
        item.status,
      ]),
    ];
    if (sendReport(res, req.query.format, "liquidaciones", rows)) return;
    res.json({ data, items: data });
  });
  app.get("/api/v1/reports/compensations", async (req, res) => {
    const data = (await store.listSettlements()).filter(
      (item) => item.compensatedDays > 0,
    );
    const rows = [
      ["Vínculo", "Días compensados", "Valor", "Documento"],
      ...data.map((item) => [
        item.employmentId,
        item.compensatedDays,
        item.amountCOP,
        item.accountingDocument,
      ]),
    ];
    if (sendReport(res, req.query.format, "compensaciones", rows)) return;
    res.json({ data, items: data });
  });
  app.get("/api/v1/reports/schedules/annual", async (req, res) => {
    const year = queryYear(req.query.year);
    const status =
      req.query.status === "SCHEDULED" ||
      req.query.status === "CANCELLED" ||
      req.query.status === "COMPLETED"
        ? req.query.status
        : undefined;
    const search =
      typeof req.query.search === "string" && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;
    const baseReport = await service.annualScheduleReport({
      year,
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
    });
    const currentUser = await authService.currentUser(actor(req));
    const gerente = await store.findSystemSettingByKey("GERENTE");
    const report = {
      ...baseReport,
      preparedBy:
        currentUser?.displayName?.trim() || currentUser?.username || actor(req),
      approvedBy: gerente?.value?.trim() || "Sin configurar",
    };
    if (req.query.format === "json") return res.json(report);
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: "SCHEDULE_ANNUAL_REPORT_EXPORTED",
      entityType: "VacationScheduleReport",
      entityId: String(year),
      metadata: {
        status: status ?? "ALL",
        search: search ?? "",
        totalEmployees: report.totalEmployees,
        totalSchedules: report.totalSchedules,
        totalDays: report.totalDays,
        preparedBy: report.preparedBy,
        approvedBy: report.approvedBy,
      },
      createdAt: new Date().toISOString(),
    });
    const pdf = await buildAnnualSchedulePdf(report);
    res
      .type("application/pdf")
      .set(
        "Content-Disposition",
        `attachment; filename="programacion-vacaciones-${year}.pdf"`,
      )
      .send(pdf);
  });
  app.get("/api/v1/reports/schedules", async (req, res) => {
    const data = await store.listSchedules();
    const rows = [
      ["Vínculo", "Inicio", "Fin", "Días", "Estado"],
      ...data.map((item) => [
        item.employmentId,
        item.startDate,
        item.endDate,
        item.scheduledDays,
        item.status,
      ]),
    ];
    if (sendReport(res, req.query.format, "cronograma", rows)) return;
    res.json({ data, items: data });
  });
  app.get("/api/v1/reports/workers/:id/history", async (req, res) => {
    const employments = (await store.listEmployments()).filter(
      (item) => item.workerId === req.params.id,
    );
    const data = [];
    for (const employment of employments)
      data.push(await service.detail(employment.id, queryDate(req.query.asOf)));
    res.json({ data, items: data });
  });
  app.get("/api/v1/admin/vacation-policy", async (req, res) => {
    const data = await store.current(
      queryDate(req.query.asOf) ??
        (new Date().toISOString().slice(0, 10) as LocalDate),
    );
    res.json({ data, ...data });
  });
  app.post("/api/v1/admin/vacation-policy", async (req, res) => {
    const input = body(policyInput, req);
    const policy = { id: "default", ...input };
    await store.savePolicy(policy);
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: "VACATION_POLICY_UPDATED",
      entityType: "VacationPolicy",
      entityId: policy.id,
      metadata: {
        daysPerCompletedYear: policy.daysPerCompletedYear,
        overdueAfterMonths: policy.overdueAfterMonths,
      },
      createdAt: new Date().toISOString(),
    });
    res.json({ data: policy, ...policy });
  });
  app.get("/api/v1/holidays", async (req, res) => {
    const year =
      typeof req.query.year === "string" ? Number(req.query.year) : undefined;
    const data = await store.listHolidays(
      Number.isInteger(year) ? year : undefined,
    );
    res.json({ data, items: data });
  });
  app.get("/api/v1/admin/holidays", async (req, res) => {
    const year =
      typeof req.query.year === "string" ? Number(req.query.year) : undefined;
    const data = await store.listHolidays(
      Number.isInteger(year) ? year : undefined,
    );
    res.json({ data, items: data });
  });
  app.post("/api/v1/admin/holidays", async (req, res) => {
    const input = body(holidayInput, req);
    const now = new Date().toISOString();
    const holiday = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    await store.saveHoliday(holiday);
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: "HOLIDAY_CREATED",
      entityType: "Holiday",
      entityId: holiday.id,
      metadata: { date: holiday.date },
      createdAt: now,
    });
    res.status(201).json({ data: holiday, ...holiday });
  });
  app.get("/api/v1/admin/holidays/:id", async (req, res) => {
    const holiday = (await store.listHolidays()).find(
      (item) => item.id === req.params.id,
    );
    if (!holiday)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Holiday not found" });
    res.json({ data: holiday, ...holiday });
  });
  app.patch("/api/v1/admin/holidays/:id", async (req, res) => {
    const holiday = (await store.listHolidays()).find(
      (item) => item.id === req.params.id,
    );
    if (!holiday)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Holiday not found" });
    const input = body(holidayPatchInput, req);
    const updated = {
      ...holiday,
      ...(input.date === undefined ? {} : { date: input.date }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.country === undefined ? {} : { country: input.country }),
      ...(input.active === undefined ? {} : { active: input.active }),
      updatedAt: new Date().toISOString(),
    };
    await store.saveHoliday(updated);
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: "HOLIDAY_UPDATED",
      entityType: "Holiday",
      entityId: holiday.id,
      metadata: { date: updated.date, active: updated.active },
      createdAt: updated.updatedAt,
    });
    res.json({ data: updated, ...updated });
  });
  app.delete("/api/v1/admin/holidays/:id", async (req, res) => {
    const holiday = (await store.listHolidays()).find(
      (item) => item.id === req.params.id,
    );
    if (!holiday)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Holiday not found" });
    const updated = {
      ...holiday,
      active: false,
      updatedAt: new Date().toISOString(),
    };
    await store.saveHoliday(updated);
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: "HOLIDAY_DEACTIVATED",
      entityType: "Holiday",
      entityId: holiday.id,
      metadata: { date: holiday.date },
      createdAt: updated.updatedAt,
    });
    res.json({ data: updated, ...updated });
  });
  app.get("/api/v1/alerts", async (req, res) => {
    const filters = {
      ...(typeof req.query.employmentId === "string"
        ? { employmentId: req.query.employmentId }
        : {}),
      ...(typeof req.query.active === "string"
        ? { active: req.query.active === "true" }
        : {}),
    };
    const data = await store.listAlerts(filters);
    res.json({ data, items: data });
  });
  app.get("/api/v1/admin/scheduler-runs", async (_req, res) => {
    const data = await store.listSchedulerRuns();
    res.json({ data, items: data });
  });
  app.post("/api/v1/admin/retired-employments/close-pending", async (req, res) => {
    const result = await service.closeRetiredEmployments(actor(req), queryDate(req.query.asOf));
    res.json({ data: result, ...result });
  });
  app.get("/api/v1/admin/settings/:key", async (req, res) => {
    const key = req.params.key.trim().toUpperCase();
    if (key !== "GERENTE")
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Setting not found" });
    const setting = await store.findSystemSettingByKey(key);
    const data = setting ?? { key, value: "" };
    res.json({ data, ...data });
  });
  app.patch("/api/v1/admin/settings/:key", async (req, res) => {
    const key = req.params.key.trim().toUpperCase();
    if (key !== "GERENTE")
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Setting not found" });
    const input = body(systemSettingInput, req);
    const setting = {
      key,
      value: input.value,
      updatedBy: actor(req),
      updatedAt: new Date().toISOString(),
    };
    await store.saveSystemSetting(setting);
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: "SYSTEM_SETTING_UPDATED",
      entityType: "SystemSetting",
      entityId: key,
      metadata: { key, value: input.value },
      createdAt: setting.updatedAt,
    });
    res.json({ data: setting, ...setting });
  });
  app.get("/api/v1/admin/catalogs/:type", async (req, res) => {
    const type = req.params.type;
    let data = await store.listCatalog(type);
    if (!data.length) {
      const employments = await store.listEmployments();
      const workers = await store.listWorkers();
      const names =
        type === "contract-types"
          ? [...new Set(employments.map((item) => item.contractTypeName))]
          : type === "processes"
            ? [...new Set(employments.map((item) => item.processName))]
            : type === "positions"
              ? [...new Set(employments.map((item) => item.positionName))]
              : [];
      for (const name of names) {
        const now = new Date().toISOString();
        const item = {
          id: crypto.randomUUID(),
          type,
          name,
          active: true,
          createdAt: now,
          updatedAt: now,
        };
        await store.saveCatalog(item);
        data.push(item);
      }
      if (type === "supervisors")
        data = workers.map((worker) => ({
          id: worker.id,
          type,
          name: worker.fullName,
          active: true,
          createdAt: worker.createdAt,
          updatedAt: worker.updatedAt,
        }));
    }
    res.json({ data, items: data });
  });
  app.post("/api/v1/admin/catalogs/:type", async (req, res) => {
    const input = body(catalogInput, req);
    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      type: req.params.type,
      name: input.name,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    await store.saveCatalog(item);
    res.status(201).json({ data: item, ...item });
  });
  app.patch("/api/v1/admin/catalogs/:type/:id", async (req, res) => {
    const input = body(catalogInput.partial(), req);
    const existing = (await store.listCatalog(req.params.type)).find(
      (item) => item.id === req.params.id,
    );
    if (!existing)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Catalog item not found" });
    const item = {
      ...existing,
      ...(input.name ? { name: input.name } : {}),
      ...(input.active === undefined ? {} : { active: input.active }),
      updatedAt: new Date().toISOString(),
    };
    await store.saveCatalog(item);
    res.json({ data: item, ...item });
  });
  app.get("/api/v1/admin/users", async (_req, res) => {
    const data = await authService.listUsers();
    res.json({ data, items: data });
  });
  app.post("/api/v1/admin/users", async (req, res) => {
    const input = body(userInput, req);
    const user = await authService.createUser(
      input.username,
      input.password,
      input.role,
      input.displayName,
      input.jobTitle,
    );
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: "USER_CREATED",
      entityType: "USER",
      entityId: user.id,
      metadata: { username: user.username, displayName: user.displayName, jobTitle: user.jobTitle, role: user.role, active: user.active },
      createdAt: new Date().toISOString(),
    });
    res.status(201).json({ data: user, ...user });
  });
  app.patch("/api/v1/admin/users/:id", async (req, res) => {
    const input = body(
      z.object({
        username: z.string().trim().min(3).optional(),
        displayName: z.string().trim().min(2).optional(),
        jobTitle: z.string().trim().min(2).optional(),
        password: z.string().min(8).optional(),
        role: z.enum(["ADMIN", "HR", "VIEWER", "READ_ONLY"]).optional(),
        active: z.boolean().optional(),
      }),
      req,
    );
    const user = await authService.updateUser(req.params.id, input, actor(req));
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: input.active === undefined ? "USER_UPDATED" : input.active ? "USER_ACTIVATED" : "USER_DEACTIVATED",
      entityType: "USER",
      entityId: user.id,
      metadata: { username: user.username, displayName: user.displayName, jobTitle: user.jobTitle, role: user.role, active: user.active },
      createdAt: new Date().toISOString(),
    });
    res.json({ data: user, ...user });
  });
  app.get("/api/v1/admin/audit-events", async (_req, res) => {
    const data = await store.listAudits();
    res.json({ data, items: data });
  });
  app.get("/api/v1/audit", async (_req, res) =>
    res.json({ items: await store.listAudits() }),
  );
  app.post("/api/v1/import/preview", (req, res) => {
    const csv = z
      .object({ content: z.string().min(1) })
      .parse(req.body).content;
    const parsed = csvRows(csv);
    const rows = parsed.rows.map(mapCsvRow);
    const valid = rows.map((row) => employmentInput.safeParse(row));
    res.json({
      headers: parsed.headers,
      rows,
      validRows: valid.filter((x) => x.success).length,
      invalidRows: valid.filter((x) => !x.success).length,
      errors: valid.flatMap((item, index) =>
        item.success
          ? []
          : [
              {
                row: index + 2,
                message: item.error.issues
                  .map((issue) => issue.message)
                  .join("; "),
              },
            ],
      ),
    });
  });
  app.get("/api/v1/worker-imports/template", (_req, res) => {
    res
      .type("text/csv")
      .set(
        "Content-Disposition",
        'attachment; filename="plantilla-empleados.csv"',
      )
      .send(
        "Cédula,Nombre,Fecha contrato,Fecha de retiro,Tipo de contrato,Proceso,Cargo,Supervisor\n",
      );
  });
  app.post("/api/v1/worker-imports/preview", (req, res) => {
    const csv = z
      .object({ content: z.string().min(1) })
      .parse(req.body).content;
    const parsed = csvRows(csv);
    const rows = parsed.rows.map(mapCsvRow);
    const valid = rows.map((row) => employmentInput.safeParse(row));
    res.json({
      data: rows,
      headers: parsed.headers,
      rows,
      validRows: valid.filter((x) => x.success).length,
      invalidRows: valid.filter((x) => !x.success).length,
      errors: valid.flatMap((item, index) =>
        item.success
          ? []
          : [
              {
                row: index + 2,
                message: item.error.issues
                  .map((issue) => issue.message)
                  .join("; "),
              },
            ],
      ),
    });
  });
  app.post("/api/v1/import/employments", async (req, res) => {
    const raw = z
      .object({
        rows: z.array(z.unknown()).min(1).max(env.MAX_IMPORT_ROWS),
        idempotencyKey: z.string().trim().min(8).optional(),
      })
      .parse(req.body);
    const key =
      req.header("Idempotency-Key") ??
      raw.idempotencyKey ??
      createHash("sha256").update(JSON.stringify(raw.rows)).digest("hex");
    const existing = await store.findImportBatchByIdempotencyKey(key);
    if (existing)
      return res.status(200).json({ replayed: true, batch: existing });
    await service.createImportBatch(key, raw.rows.length);
    const current = await store.findImportBatchByIdempotencyKey(key);
    if (!current) throw new Error("Unable to initialize import batch");
    let createdRows = 0,
      updatedRows = 0,
      invalidRows = 0;
    const errors: { row: number; message: string }[] = [];
    for (const [index, rawRow] of raw.rows.entries()) {
      const parsed = employmentInput.safeParse(
        mapCsvRow(
          (rawRow && typeof rawRow === "object" ? rawRow : {}) as Record<
            string,
            unknown
          >,
        ),
      );
      if (!parsed.success) {
        invalidRows++;
        errors.push({
          row: index + 1,
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
        continue;
      }
      const result = await service.upsertEmployment(parsed.data, actor(req));
      if (result.created) createdRows++;
      else updatedRows++;
    }
    const final = await service.finishImportBatch(current, {
      createdRows,
      updatedRows,
      invalidRows,
      errorSummary: errors,
    });
    res.status(invalidRows ? 207 : 201).json({
      batch: final,
      created: createdRows,
      updated: updatedRows,
      invalidRows,
      errors,
    });
  });
  app.get("/api/v1/worker-imports/:batchId", async (req, res) => {
    const batch = await store.findImportBatchByIdempotencyKey(
      req.params.batchId,
    );
    if (!batch)
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Import batch not found" });
    res.json({ data: batch, ...batch });
  });
  app.post("/api/v1/worker-imports/:batchId/confirm", async (req, res) => {
    const raw = z
      .object({ rows: z.array(z.unknown()).min(1).max(env.MAX_IMPORT_ROWS) })
      .parse(req.body);
    const existing = await store.findImportBatchByIdempotencyKey(
      req.params.batchId,
    );
    if (
      existing?.status === "COMPLETED" ||
      existing?.status === "COMPLETED_WITH_ERRORS"
    )
      return res.json({ replayed: true, batch: existing });
    if (!existing)
      await service.createImportBatch(req.params.batchId, raw.rows.length);
    const current = await store.findImportBatchByIdempotencyKey(
      req.params.batchId,
    );
    if (!current) throw new Error("Unable to initialize import batch");
    let createdRows = 0,
      updatedRows = 0,
      invalidRows = 0;
    const errors: { row: number; message: string }[] = [];
    for (const [index, rawRow] of raw.rows.entries()) {
      const parsed = employmentInput.safeParse(
        mapCsvRow(
          (rawRow && typeof rawRow === "object" ? rawRow : {}) as Record<
            string,
            unknown
          >,
        ),
      );
      if (!parsed.success) {
        invalidRows++;
        errors.push({
          row: index + 1,
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
        continue;
      }
      const result = await service.upsertEmployment(parsed.data, actor(req));
      if (result.created) createdRows++;
      else updatedRows++;
    }
    const batch = await service.finishImportBatch(current, {
      createdRows,
      updatedRows,
      invalidRows,
      errorSummary: errors,
    });
    res.status(invalidRows ? 207 : 201).json({
      data: batch,
      batch,
      created: createdRows,
      updated: updatedRows,
      invalidRows,
      errors,
    });
  });
  app.use((req, res) =>
    res.status(404).json({
      code: "NOT_FOUND",
      message: `Ruta no encontrada: ${req.method} ${req.path}`,
    }),
  );
  app.use(
    (error: unknown, req: Request, res: Response, _next: NextFunction) => {
      const status =
        typeof error === "object" &&
        error &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : 500;
      const message =
        error instanceof Error ? error.message : "Unexpected error";
      const code =
        status === 401
          ? "UNAUTHORIZED"
          : status === 403
            ? "FORBIDDEN"
            : status === 404
              ? "NOT_FOUND"
              : status === 409
                ? "CONFLICT"
                : status === 422
                  ? "BUSINESS_RULE_VIOLATION"
                  : status === 500
                    ? "INTERNAL_ERROR"
                    : "VALIDATION_ERROR";
      if (status >= 500)
        console.error(
          JSON.stringify({
            requestId: (req as Request & { requestId?: string }).requestId,
            message,
          }),
        );
      res.status(status).json({
        code,
        message,
        requestId: (req as Request & { requestId?: string })?.requestId,
      });
    },
  );
  return app;
}
