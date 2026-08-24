import { createHash } from "node:crypto";
import { parseLocalDate, type LocalDate } from "../../domain/shared/localDate.js";
import type { VacationSettlementSourceLine } from "../../domain/vacations/models.js";

export type SettlementRawRow = {
  lineNumber: number;
  raw: Record<string, unknown>;
};
export type NormalizedSettlementLine = VacationSettlementSourceLine & {
  normalizedDocument: string;
};
export type SettlementGroup = {
  sourceKey: string;
  normalizedDocument: string;
  accountingDocument: string;
  lines: NormalizedSettlementLine[];
  rangeStart: LocalDate;
  rangeEnd: LocalDate;
  periodEndDate: LocalDate;
  enjoymentStartDate: LocalDate;
  enjoymentEndDate: LocalDate;
  enjoyedDays: number;
  compensatedDays: number;
  calendarDays: number;
  amountCOP: number;
  warnings: string[];
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
  ndc: "ndc",
  nombre: "name",
  fecha_ing: "startDate",
  fecha_ingreso: "startDate",
  fecha_de_ingreso: "startDate",
  fecha_vaca: "periodEndDate",
  periodo_liq_ini: "periodStartDate",
  periodo_liq_fin: "periodFinishDate",
  vaca_disfru_ini: "enjoymentStartDate",
  vaca_disfru_fin: "enjoymentEndDate",
  dias_tomados: "takenDays",
  dias_compensa: "compensatedDays",
  dias_disfruta: "calendarDays",
  valor: "amountCOP",
  documento_de_liquidacion: "accountingDocument",
  documento_liquidacion: "accountingDocument",
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
  for (const [key, value] of Object.entries(row)) {
    if ((aliases[header(key)] ?? header(key)) === target) return value;
  }
  return "";
}
function date(value: unknown, label: string, line: number): LocalDate {
  if (typeof value === "number" && Number.isFinite(value)) {
    const output = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86_400_000));
    return `${output.getUTCFullYear()}-${String(output.getUTCMonth() + 1).padStart(2, "0")}-${String(output.getUTCDate()).padStart(2, "0")}` as LocalDate;
  }
  const raw = repair(String(value ?? "")).trim();
  if (!raw || raw === "--") throw new Error(`Fila ${line}: ${label} es obligatorio`);
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match)
    return parseLocalDate(
      `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`,
    );
  match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match)
    return parseLocalDate(
      `${match[3]}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`,
    );
  match = raw.toLowerCase().match(/^(\d{4})[-/.]([a-záéíóú]+)[-/.](\d{1,2})$/);
  if (match) {
    const month = months[match[2]!.normalize("NFD").replace(/[\u0300-\u036f]/g, "")];
    if (month)
      return parseLocalDate(
        `${match[1]}-${String(month).padStart(2, "0")}-${match[3]!.padStart(2, "0")}`,
      );
  }
  throw new Error(`Fila ${line}: ${label} no tiene un formato válido`);
}
function number(value: unknown, label: string, line: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = repair(String(value ?? ""))
    .trim()
    .replace(/[$\s]/g, "");
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
  if (!Number.isFinite(result)) throw new Error(`Fila ${line}: ${label} no es numérico`);
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
export function normalizeSettlementRows(rows: SettlementRawRow[]) {
  const normalized: NormalizedSettlementLine[] = [];
  const errors: { row: number; message: string }[] = [];
  for (const row of rows) {
    const raw = row.raw;
    const values = Object.values(raw).map((value) => text(value));
    if (values.length && values.every((value) => !value || value === "--" || /^[-]+$/.test(value)))
      continue;
    try {
      const employee = text(read(raw, "employee"));
      const name = text(read(raw, "name"));
      const accountingDocument = text(read(raw, "accountingDocument"));
      if (!employee || !name || !accountingDocument)
        throw new Error("requiere Empleado, Nombre y Documento de Liquidación");
      const line: NormalizedSettlementLine = {
        lineNumber: row.lineNumber,
        lineHash: createHash("sha256").update(stable(raw)).digest("hex"),
        employee,
        name,
        ndc: text(read(raw, "ndc")),
        normalizedDocument: employee.replace(/\D/g, "") || employee.toUpperCase(),
        startDate: date(read(raw, "startDate"), "Fecha Ing.", row.lineNumber),
        periodEndDate: date(read(raw, "periodEndDate"), "Fecha Vaca.", row.lineNumber),
        periodStartDate: date(read(raw, "periodStartDate"), "Periodo Liq. Ini.", row.lineNumber),
        periodFinishDate: date(read(raw, "periodFinishDate"), "Periodo Liq. Fin.", row.lineNumber),
        enjoymentStartDate: date(
          read(raw, "enjoymentStartDate"),
          "Vaca. Disfru. Ini.",
          row.lineNumber,
        ),
        enjoymentEndDate: date(read(raw, "enjoymentEndDate"), "Vaca. Disfru. Fin.", row.lineNumber),
        takenDays: number(read(raw, "takenDays"), "Días tomados", row.lineNumber),
        compensatedDays: number(read(raw, "compensatedDays"), "Días compensados", row.lineNumber),
        calendarDays: number(read(raw, "calendarDays"), "Días disfruta", row.lineNumber),
        amountCOP: number(read(raw, "amountCOP"), "Valor", row.lineNumber),
        accountingDocument,
        raw,
      };
      if (line.periodFinishDate < line.periodStartDate)
        throw new Error("Periodo Liq. Fin. no puede ser menor que Periodo Liq. Ini.");
      if (line.takenDays < 0 || line.compensatedDays < 0)
        throw new Error("Los días no pueden ser negativos");
      normalized.push(line);
    } catch (error) {
      errors.push({
        row: row.lineNumber,
        message: error instanceof Error ? error.message : "Fila inválida",
      });
    }
  }
  return { lines: normalized, errors };
}
export function groupSettlementLines(lines: NormalizedSettlementLine[]): SettlementGroup[] {
  const groups = new Map<string, NormalizedSettlementLine[]>();
  for (const line of lines) {
    const key = `${line.normalizedDocument}|${line.accountingDocument.toUpperCase()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(line);
  }
  return [...groups.entries()].map(([sourceKey, groupLines]) => {
    const lines = [...groupLines].sort(
      (a, b) => a.periodStartDate.localeCompare(b.periodStartDate) || a.lineNumber - b.lineNumber,
    );
    const warnings: string[] = [];
    for (let index = 1; index < lines.length; index++) {
      const previous = lines[index - 1]!;
      const current = lines[index]!;
      if (
        current.periodStartDate > previous.periodFinishDate &&
        current.periodStartDate !== addOne(previous.periodFinishDate)
      )
        warnings.push(
          `Hay un salto entre las líneas ${previous.lineNumber} y ${current.lineNumber}`,
        );
      if (
        current.periodStartDate <= previous.periodFinishDate &&
        current.periodStartDate !== previous.periodStartDate
      )
        warnings.push(
          `Hay traslape entre las líneas ${previous.lineNumber} y ${current.lineNumber}`,
        );
    }
    const first = lines[0]!;
    const last = lines.at(-1)!;
    return {
      sourceKey,
      normalizedDocument: first.normalizedDocument,
      accountingDocument: first.accountingDocument,
      lines,
      rangeStart: first.periodStartDate,
      rangeEnd: last.periodFinishDate,
      periodEndDate: last.periodEndDate,
      enjoymentStartDate: lines.reduce(
        (min, line) => (line.enjoymentStartDate < min ? line.enjoymentStartDate : min),
        first.enjoymentStartDate,
      ),
      enjoymentEndDate: lines.reduce(
        (max, line) => (line.enjoymentEndDate > max ? line.enjoymentEndDate : max),
        first.enjoymentEndDate,
      ),
      enjoyedDays: lines.reduce((total, line) => total + line.takenDays, 0),
      compensatedDays: lines.reduce((total, line) => total + line.compensatedDays, 0),
      calendarDays: lines.reduce((total, line) => total + line.calendarDays, 0),
      amountCOP: lines.reduce((total, line) => total + line.amountCOP, 0),
      warnings,
    };
  });
}
function addOne(value: LocalDate) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
