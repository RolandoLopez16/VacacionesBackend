import { runExcelJsSync } from "../exceljsSync.js";

export type SpreadsheetRow = { lineNumber: number; raw: Record<string, unknown> };

export function parseXlsx(buffer: Buffer): { headers: string[]; rows: SpreadsheetRow[] } {
  return JSON.parse(runExcelJsSync("parse", buffer).toString("utf8")) as {
    headers: string[];
    rows: SpreadsheetRow[];
  };
}
