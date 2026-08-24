import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker, workerData } from "node:worker_threads";
import ExcelJS, { type Cell, type CellValue, type Row } from "exceljs";

const WORKER_MARKER = "vaca-efa-exceljs";
const CHUNK_BYTES = 1024 * 1024;
const TIMEOUT_MS = 60_000;
const STATE_INDEX = 0;
const LENGTH_INDEX = 1;
const IDLE = 0;
const CHUNK = 1;
const DONE = 2;
const FAILED = 3;

type ExcelJsOperation = "build" | "parse";
type WorkerInput = string[][] | Uint8Array;
type ExcelJsWorkerData = {
  marker: typeof WORKER_MARKER;
  operation: ExcelJsOperation;
  input: WorkerInput;
  controlBuffer: SharedArrayBuffer;
  dataBuffer: SharedArrayBuffer;
};

type ParsedCellValue = string | number | boolean | Date;
type ParsedWorkbook = {
  headers: string[];
  rows: { lineNumber: number; raw: Record<string, unknown> }[];
};

function isExcelJsWorkerData(value: unknown): value is ExcelJsWorkerData {
  return (
    typeof value === "object" &&
    value !== null &&
    "marker" in value &&
    value.marker === WORKER_MARKER
  );
}

function localDate(value: Date) {
  if (!Number.isFinite(value.getTime())) return "";
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(
    value.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function serialLocalDate(value: number, date1904: boolean) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return localDate(new Date(epoch + Math.floor(value) * 86_400_000));
}

function resolvedCellValue(cell: Cell): ParsedCellValue {
  const resolve = (value: CellValue): ParsedCellValue => {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value;
    if (typeof value !== "object") return value;
    if ("formula" in value || "sharedFormula" in value) return resolve(value.result as CellValue);
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return value.text;
    if ("error" in value) return value.error;
    return cell.text;
  };
  return resolve(cell.value);
}

function parsedValue(cell: Cell, isDateColumn: boolean, date1904: boolean) {
  const value = resolvedCellValue(cell);
  if (value instanceof Date) return localDate(value);
  if (isDateColumn && typeof value === "number") return serialLocalDate(value, date1904);
  return value;
}

function populatedRows(worksheet: ExcelJS.Worksheet) {
  const rows: Row[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => rows.push(row));
  return rows;
}

async function parseWorkbook(input: Uint8Array): Promise<ParsedWorkbook> {
  const workbook = new ExcelJS.Workbook();
  const workbookBuffer = Buffer.from(input) as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(workbookBuffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("No fue posible leer la primera hoja del XLSX");

  const sourceRows = populatedRows(worksheet);
  const headerRow = sourceRows[0];
  if (!headerRow) return { headers: [], rows: [] };

  const headers = Array.from({ length: headerRow.cellCount }, (_, index) =>
    String(resolvedCellValue(headerRow.getCell(index + 1)) ?? "").trim(),
  );
  const dateColumns = new Set(
    headers
      .map((header, index) => (/fecha|periodo\s*liq|vaca\.?\s*disfru/i.test(header) ? index : -1))
      .filter((index) => index >= 0),
  );
  const date1904 = Boolean(workbook.properties.date1904);
  const rows = sourceRows.slice(1).map((row) => {
    const raw: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      if (header)
        raw[header] = parsedValue(row.getCell(index + 1), dateColumns.has(index), date1904);
    });
    return { lineNumber: row.number, raw };
  });
  return { headers, rows };
}

async function buildWorkbook(rows: string[][]) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Reporte");
  worksheet.addRows(rows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function waitUntilIdle(control: Int32Array) {
  while (true) {
    const state = Atomics.load(control, STATE_INDEX);
    if (state === IDLE) return;
    Atomics.wait(control, STATE_INDEX, state);
  }
}

function publish(control: Int32Array, data: Uint8Array, state: number, chunk: Uint8Array) {
  waitUntilIdle(control);
  const length = Math.min(chunk.byteLength, data.byteLength);
  data.set(chunk.subarray(0, length), 0);
  Atomics.store(control, LENGTH_INDEX, length);
  Atomics.store(control, STATE_INDEX, state);
  Atomics.notify(control, STATE_INDEX);
}

function publishResult(control: Int32Array, data: Uint8Array, result: Buffer) {
  for (let offset = 0; offset < result.byteLength; offset += data.byteLength)
    publish(control, data, CHUNK, result.subarray(offset, offset + data.byteLength));
  publish(control, data, DONE, Buffer.alloc(0));
}

async function executeWorker(data: ExcelJsWorkerData) {
  const control = new Int32Array(data.controlBuffer);
  const output = new Uint8Array(data.dataBuffer);
  try {
    const result =
      data.operation === "build"
        ? await buildWorkbook(data.input as string[][])
        : Buffer.from(JSON.stringify(await parseWorkbook(data.input as Uint8Array)), "utf8");
    publishResult(control, output, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publish(control, output, FAILED, Buffer.from(message, "utf8"));
  }
}

function workerModule() {
  const compiled = new URL("./exceljsSync.js", import.meta.url);
  return existsSync(fileURLToPath(compiled))
    ? compiled
    : new URL("./exceljsSync.ts", import.meta.url);
}

export function runExcelJsSync(
  operation: ExcelJsOperation,
  input: WorkerInput,
): Buffer<ArrayBuffer> {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const dataBuffer = new SharedArrayBuffer(CHUNK_BYTES);
  const moduleUrl = workerModule();
  const isTypeScript = moduleUrl.pathname.endsWith(".ts");
  const worker = new Worker(moduleUrl, {
    workerData: { marker: WORKER_MARKER, operation, input, controlBuffer, dataBuffer },
    execArgv: isTypeScript ? ["--import", "tsx"] : [],
  });
  worker.on("error", () => undefined);
  worker.unref();

  const control = new Int32Array(controlBuffer);
  const data = new Uint8Array(dataBuffer);
  const chunks: Buffer[] = [];
  const deadline = Date.now() + TIMEOUT_MS;
  while (true) {
    const state = Atomics.load(control, STATE_INDEX);
    if (state === IDLE) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || Atomics.wait(control, STATE_INDEX, IDLE, remaining) === "timed-out") {
        void worker.terminate();
        throw new Error("La operación XLSX excedió el tiempo permitido");
      }
      continue;
    }

    const length = Atomics.load(control, LENGTH_INDEX);
    if (state === CHUNK) {
      chunks.push(Buffer.from(data.slice(0, length)));
      Atomics.store(control, STATE_INDEX, IDLE);
      Atomics.notify(control, STATE_INDEX);
      continue;
    }
    void worker.terminate();
    if (state === DONE) return Buffer.concat(chunks);
    if (state === FAILED)
      throw new Error(
        Buffer.from(data.slice(0, length)).toString("utf8") || "No fue posible procesar el XLSX",
      );
    throw new Error("El procesador XLSX devolvió un estado inválido");
  }
}

if (isExcelJsWorkerData(workerData)) void executeWorker(workerData);
