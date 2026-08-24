import { createHash } from "node:crypto";
import type { Request } from "express";
import type { SettlementRawRow } from "../../application/services/settlementImport.js";
import { DomainError } from "../../domain/shared/errors.js";
import type { LocalDate } from "../../domain/shared/localDate.js";
import { env } from "../../infrastructure/config/env.js";
import { parseXlsx } from "../../infrastructure/imports/xlsxParser.js";
import { closureDatesInputSchema, fileImportInputSchema } from "../schemas/imports.js";
import { parseBody } from "./http.js";

function repairUtf8Mojibake(value: string): string {
  if (!/[ÃÂ]/.test(value)) return value;
  try {
    return new TextDecoder("utf-8").decode(
      Uint8Array.from([...value].map((char) => char.charCodeAt(0))),
    );
  } catch {
    return value;
  }
}

function normalizedHeader(value: string): string {
  return repairUtf8Mojibake(value)
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
}

function csvLine(line: string, delimiter = ","): string[] {
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

function csvDelimiter(header: string): string {
  const semicolons = (header.match(/;/g) ?? []).length;
  const commas = (header.match(/,/g) ?? []).length;
  return semicolons > commas ? ";" : ",";
}

export function csvRows(content: string): {
  headers: string[];
  rows: Record<string, unknown>[];
} {
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

function normalizeImportDate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const raw = repairUtf8Mojibake(value).trim();
  if (!raw) return raw;
  const dayFirst = raw.match(/^(\d{1,2})[\\/.-](\d{1,2})[\\/.-](\d{4})$/);
  if (dayFirst)
    return `${dayFirst[3]!}-${dayFirst[2]!.padStart(2, "0")}-${dayFirst[1]!.padStart(2, "0")}`;
  const yearFirst = raw.match(/^(\d{4})[\\/.-](\d{1,2})[\\/.-](\d{1,2})$/);
  return yearFirst
    ? `${yearFirst[1]!}-${yearFirst[2]!.padStart(2, "0")}-${yearFirst[3]!.padStart(2, "0")}`
    : raw;
}

export function mapEmploymentCsvRow(row: Record<string, unknown>): Record<string, unknown> {
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
    const cleanValue = typeof value === "string" ? repairUtf8Mojibake(value).trim() : value;
    if (target === "endDate" && cleanValue === "") continue;
    mapped[target] =
      target === "startDate" || target === "endDate" ? normalizeImportDate(cleanValue) : cleanValue;
  }
  return mapped;
}

export function readImportRows(req: Request): {
  fileName: string;
  fileHash: string;
  rows: SettlementRawRow[];
} {
  const input = parseBody(fileImportInputSchema, req);
  const rawBuffer = input.contentBase64
    ? Buffer.from(input.contentBase64, "base64")
    : Buffer.from(input.content ?? "", "utf8");
  if (rawBuffer.byteLength > env.MAX_UPLOAD_MB * 1024 * 1024) {
    throw new DomainError(
      `El archivo supera el máximo de ${env.MAX_UPLOAD_MB} MB`,
      413,
      "VALIDATION_ERROR",
    );
  }
  const isXlsx =
    input.fileName.toLowerCase().endsWith(".xlsx") ||
    input.fileName.toLowerCase().endsWith(".xlsm");
  const parsed = isXlsx ? parseXlsx(rawBuffer) : csvRows(rawBuffer.toString("utf8"));
  const rows: SettlementRawRow[] = isXlsx
    ? (parsed as { rows: { lineNumber: number; raw: Record<string, unknown> }[] }).rows
    : (parsed as { rows: Record<string, unknown>[] }).rows.map((raw, index) => ({
        lineNumber: index + 2,
        raw,
      }));
  if (rows.length > env.MAX_IMPORT_ROWS) {
    throw new DomainError(
      `El archivo supera el máximo de ${env.MAX_IMPORT_ROWS} líneas`,
      413,
      "VALIDATION_ERROR",
    );
  }
  return {
    fileName: input.fileName,
    fileHash: createHash("sha256").update(rawBuffer).digest("hex"),
    rows,
  };
}

export function readClosureDates(req: Request): {
  fromDate: LocalDate | undefined;
  asOf: LocalDate | undefined;
} {
  const input = parseBody(closureDatesInputSchema, req);
  return {
    fromDate: input.fromDate,
    asOf: input.asOf,
  };
}
