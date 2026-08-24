import type { Response } from "express";
import { buildPdf, buildXlsx } from "../../infrastructure/reports/reportExporters.js";

export function csvEscape(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function sendReport(
  res: Response,
  format: unknown,
  filename: string,
  rows: unknown[][],
): boolean {
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
