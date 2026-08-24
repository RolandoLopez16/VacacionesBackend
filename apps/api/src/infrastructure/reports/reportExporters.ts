import PDFDocument from "pdfkit";
import { runExcelJsSync } from "../exceljsSync.js";

export function excelSafe(value: unknown) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function buildXlsx(rows: unknown[][]) {
  return runExcelJsSync(
    "build",
    rows.map((row) => row.map(excelSafe)),
  );
}

function pdfText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, " ");
}

export function buildPdf(rows: unknown[][]) {
  const document = new PDFDocument({
    size: [612, 842],
    margins: { top: 40, right: 40, bottom: 40, left: 40 },
    pdfVersion: "1.4",
    info: {
      Title: "Reporte de vacaciones",
      Author: "Sistema Web Vaca EFA",
    },
  });

  rows.forEach((row, index) => {
    document.font(index === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    document.text(row.map(pdfText).join(" | "), {
      width: 532,
      lineGap: 2,
    });
    if (index < rows.length - 1) document.moveDown(0.25);
  });
  document.end();

  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = document.read() as Buffer | null) !== null) chunks.push(Buffer.from(chunk));
  const output = Buffer.concat(chunks);
  if (!output.length) throw new Error("No fue posible generar el PDF");
  return output;
}
