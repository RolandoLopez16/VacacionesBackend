import { createHash } from "node:crypto";
import { parseLocalDate, type LocalDate } from "../../domain/shared/localDate.js";
import type { VacationPendingPeriodSourceLine } from "../../domain/vacations/models.js";

export type PendingPeriodRawRow = {
  lineNumber: number;
  raw: Record<string, unknown>;
};
export type NormalizedPendingPeriodLine = VacationPendingPeriodSourceLine & {
  normalizedDocument: string;
};

function repair(value: string) {
  if (!/[ÃÂ]/.test(value)) return value;
  try {
    return new TextDecoder("utf-8").decode(
      Uint8Array.from([...value].map((char) => char.charCodeAt(0))),
    );
  } catch {
    return value;
  }
}
function header(value: string) {
  return repair(value)
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[.]/g, "")
    .replace(/[\s-]+/g, "_");
}
const aliases: Record<string, string> = {
  empleado: "employee",
  cedula: "employee",
  documento: "employee",
  documento_de_identidad: "employee",
  nombre: "name",
  fecha_ing: "hireDate",
  fecha_ingreso: "hireDate",
  fecha_de_ingreso: "hireDate",
  ult_per_pagado: "lastPaidPeriod",
  ultimo_periodo_pagado: "lastPaidPeriod",
  periodo_pendiente: "pendingPeriods",
  periodos_pendientes: "pendingPeriods",
  dias_pendientes: "pendingDays",
  total_dias: "totalDays",
  fecha_venc_ult_periodo: "lastPeriodDueDate",
  fecha_venc_ultimo_periodo: "lastPeriodDueDate",
  fecha_venc_prox_periodo: "nextPeriodDueDate",
  fecha_venc_proximo_periodo: "nextPeriodDueDate",
  cargo: "position",
  descripcion: "description",
};
const months: Record<string, number> = {
  ene: 1,
  enero: 1,
  jan: 1,
  january: 1,
  feb: 2,
  febrero: 2,
  february: 2,
  mar: 3,
  marzo: 3,
  march: 3,
  abr: 4,
  abril: 4,
  apr: 4,
  april: 4,
  may: 5,
  mayo: 5,
  jun: 6,
  junio: 6,
  jul: 7,
  julio: 7,
  ago: 8,
  agosto: 8,
  aug: 8,
  sep: 9,
  sept: 9,
  septiembre: 9,
  oct: 10,
  octubre: 10,
  nov: 11,
  noviembre: 11,
  dec: 12,
  dic: 12,
  diciembre: 12,
};
function read(row: Record<string, unknown>, target: string) {
  for (const [key, value] of Object.entries(row))
    if ((aliases[header(key)] ?? header(key)) === target) return value;
  return "";
}
function parseDate(value: unknown, label: string, line: number): LocalDate {
  if (typeof value === "number" && Number.isFinite(value)) {
    const output = new Date(
      Date.UTC(1899, 11, 30) + Math.round(value * 86_400_000),
    );
    return `${output.getUTCFullYear()}-${String(output.getUTCMonth() + 1).padStart(2, "0")}-${String(output.getUTCDate()).padStart(2, "0")}` as LocalDate;
  }
  const raw = repair(String(value ?? "")).trim();
  if (!raw || raw === "--")
    throw new Error(`Fila ${line}: ${label} es obligatorio`);
  let match = raw.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (match)
    return parseLocalDate(
      `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`,
    );
  match = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (match)
    return parseLocalDate(
      `${match[3]}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`,
    );
  match = raw
    .toLowerCase()
    .match(/^(\d{4})[-\/.]([a-záéíóú]+)[-\/.](\d{1,2})$/);
  if (match) {
    const month =
      months[match[2]!.normalize("NFD").replace(/[\u0300-\u036f]/g, "")];
    if (month)
      return parseLocalDate(
        `${match[1]}-${String(month).padStart(2, "0")}-${match[3]!.padStart(2, "0")}`,
      );
  }
  throw new Error(`Fila ${line}: ${label} no tiene un formato válido`);
}
function optionalDate(value: unknown, label: string, line: number) {
  const text = String(value ?? "").trim();
  return !text || text === "--" ? undefined : parseDate(value, label, line);
}
function numberValue(value: unknown, label: string, line: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = repair(String(value ?? "")).trim().replace(/[$\s]/g, "");
  if (!raw || raw === "--") return 0;
  const normalized =
    raw.includes(",") && raw.includes(".")
      ? raw.lastIndexOf(",") > raw.lastIndexOf(".")
        ? raw.replaceAll(".", "").replace(",", ".")
        : raw.replaceAll(",", "")
      : raw.includes(",")
        ? raw.split(",").at(-1)?.length === 3
          ? raw.replaceAll(",", "")
          : raw.replace(",", ".")
        : raw;
  const result = Number(normalized);
  if (!Number.isFinite(result))
    throw new Error(`Fila ${line}: ${label} no es numérico`);
  return result;
}
function text(value: unknown) {
  return repair(String(value ?? "")).trim();
}
function stable(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = value[key];
        return result;
      }, {}),
  );
}
export function normalizePendingPeriodRows(rows: PendingPeriodRawRow[]) {
  const lines: NormalizedPendingPeriodLine[] = [];
  const errors: { row: number; message: string }[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    const values = Object.values(row.raw).map(text);
    if (
      values.length &&
      values.every((value) => !value || value === "--" || /^[-]+$/.test(value))
    )
      continue;
    try {
      const employee = text(read(row.raw, "employee"));
      const name = text(read(row.raw, "name"));
      if (!employee || !name)
        throw new Error("requiere Empleado y Nombre");
      const pendingPeriods = numberValue(
        read(row.raw, "pendingPeriods"),
        "Periodo Pendiente",
        row.lineNumber,
      );
      const pendingDays = numberValue(
        read(row.raw, "pendingDays"),
        "Dias Pendientes",
        row.lineNumber,
      );
      const totalDays = numberValue(
        read(row.raw, "totalDays"),
        "Total Dias",
        row.lineNumber,
      );
      if (!Number.isInteger(pendingPeriods) || pendingPeriods < 0)
        throw new Error("Periodo Pendiente debe ser un entero no negativo");
      if (pendingDays < 0 || totalDays < 0)
        throw new Error("Los días no pueden ser negativos");
      const hireDate = parseDate(
        read(row.raw, "hireDate"),
        "Fecha Ing.",
        row.lineNumber,
      );
      const line: NormalizedPendingPeriodLine = {
        lineNumber: row.lineNumber,
        lineHash: createHash("sha256").update(stable(row.raw)).digest("hex"),
        employee,
        name,
        hireDate,
        lastPaidPeriod: optionalDate(
          read(row.raw, "lastPaidPeriod"),
          "Ult. Per. Pagado",
          row.lineNumber,
        ),
        pendingPeriods,
        pendingDays,
        totalDays,
        lastPeriodDueDate: optionalDate(
          read(row.raw, "lastPeriodDueDate"),
          "Fecha Venc. Ult. Periodo",
          row.lineNumber,
        ),
        nextPeriodDueDate: optionalDate(
          read(row.raw, "nextPeriodDueDate"),
          "Fecha Venc. Prox. Periodo",
          row.lineNumber,
        ),
        position: text(read(row.raw, "position")) || undefined,
        raw: row.raw,
        normalizedDocument: employee.replace(/\D/g, "") || employee.toUpperCase(),
      };
      if (totalDays !== pendingPeriods * 15 + pendingDays)
        warnings.push(
          `Fila ${row.lineNumber}: Total Dias no coincide con Periodo Pendiente × 15 + Dias Pendientes; se usarán únicamente los períodos completos de 15 días`,
        );
      lines.push(line);
    } catch (error) {
      errors.push({
        row: row.lineNumber,
        message: error instanceof Error ? error.message : "Fila inválida",
      });
    }
  }
  return { lines, errors, warnings };
}
