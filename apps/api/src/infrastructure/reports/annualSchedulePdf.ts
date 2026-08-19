import PDFDocument from "pdfkit";
import type { AnnualScheduleReport } from "../../application/services/vacationService.js";

const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const MARGIN = 28;
const TABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const HEADER_FILL = "#173f32";
const LINE_COLOR = "#cfdad4";
const MUTED = "#52645d";

const columns = [
  { label: "No.", width: 24 },
  { label: "Cédula", width: 60 },
  { label: "Empleado", width: 125 },
  { label: "Proceso", width: 75 },
  { label: "Cargo", width: 75 },
  { label: "Supervisor", width: 75 },
  { label: "Inicio", width: 52 },
  { label: "Fin", width: 52 },
  { label: "Días", width: 32 },
  { label: "Estado", width: 60 },
  { label: "Períodos de origen", width: 106 },
] as const;

function date(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function text(value: unknown) {
  return String(value ?? "—").replace(/\s+/g, " ").trim() || "—";
}

function status(value: string) {
  return (
    {
      SCHEDULED: "Programado",
      COMPLETED: "Completado",
      CANCELLED: "Cancelado",
    } as Record<string, string>
  )[value] ?? value;
}

function periodSummary(item: AnnualScheduleReport["items"][number]) {
  return item.allocations
    .map(
      (allocation) =>
        `${date(allocation.periodStartDate)} - ${date(allocation.periodEndDate)} (${allocation.days} d)`,
    )
    .join("; ");
}

function drawFooter(document: PDFKit.PDFDocument, page: number) {
  const y = PAGE_HEIGHT - 24;
  document
    .strokeColor(LINE_COLOR)
    .moveTo(MARGIN, y - 6)
    .lineTo(PAGE_WIDTH - MARGIN, y - 6)
    .stroke();
  document
    .font("Helvetica")
    .fontSize(7)
    .fillColor(MUTED)
    .text("EFAGRAM · Documento de programación de vacaciones", MARGIN, y, {
      width: 500,
    })
    .text(`Página ${page}`, PAGE_WIDTH - 100, y, { width: 72, align: "right" });
}

function drawTitle(
  document: PDFKit.PDFDocument,
  report: AnnualScheduleReport,
  firstPage: boolean,
) {
  let y = MARGIN;
  document.font("Helvetica-Bold").fontSize(firstPage ? 16 : 11).fillColor(HEADER_FILL);
  document.text("PROGRAMACIÓN ANUAL DE VACACIONES", MARGIN, y);
  y += firstPage ? 22 : 16;
  document.font("Helvetica").fontSize(8).fillColor(MUTED);
  document.text(
    `EFAGRAM · Año ${report.year} · Generado ${date(report.generatedAt.slice(0, 10))} ${report.generatedAt.slice(11, 16)}`,
    MARGIN,
    y,
  );
  y += 15;
  if (!firstPage) return y + 3;
  document
    .fontSize(8)
    .fillColor("#ffffff")
    .rect(MARGIN, y, TABLE_WIDTH, 32)
    .fill("#e9f3ee");
  const summary: [string, string][] = [
    [`${report.totalEmployees}`, "Empleados"],
    [`${report.totalSchedules}`, "Programaciones"],
    [`${report.totalDays}`, "Días programados"],
  ];
  const summaryWidth = TABLE_WIDTH / summary.length;
  summary.forEach(([value, label], index) => {
    const x = MARGIN + index * summaryWidth + 10;
    document.font("Helvetica-Bold").fontSize(12).fillColor(HEADER_FILL).text(value, x, y + 5);
    document.font("Helvetica").fontSize(7).fillColor(MUTED).text(label, x + 38, y + 9, {
      width: summaryWidth - 48,
    });
  });
  y += 42;
  const months = report.monthly
    .filter((month) => month.schedules > 0)
    .map((month) => `${month.label}: ${month.schedules} prog. / ${month.days} días`)
    .join(" · ");
  document.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(
    months || "No hay programaciones para los filtros seleccionados.",
    MARGIN,
    y,
    { width: TABLE_WIDTH },
  );
  return y + 20;
}

function drawTableHeader(document: PDFKit.PDFDocument, y: number) {
  document.fillColor(HEADER_FILL).rect(MARGIN, y, TABLE_WIDTH, 22).fill();
  let x = MARGIN;
  document.font("Helvetica-Bold").fontSize(7).fillColor("#ffffff");
  for (const column of columns) {
    document.text(column.label, x + 3, y + 7, { width: column.width - 6, align: "left" });
    x += column.width;
  }
  return y + 22;
}

function drawTableRow(
  document: PDFKit.PDFDocument,
  row: string[],
  y: number,
  height: number,
  alternate: boolean,
) {
  if (alternate) document.fillColor("#f5f8f6").rect(MARGIN, y, TABLE_WIDTH, height).fill();
  let x = MARGIN;
  document.font("Helvetica").fontSize(6.5).fillColor("#22332d");
  row.forEach((value, index) => {
    const column = columns[index]!;
    document
      .strokeColor(LINE_COLOR)
      .rect(x, y, column.width, height)
      .stroke()
      .fillColor("#22332d")
      .text(value, x + 3, y + 5, {
        width: column.width - 6,
        height: height - 8,
        ellipsis: true,
      });
    x += column.width;
  });
}

export function buildAnnualSchedulePdf(report: AnnualScheduleReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "LETTER",
      layout: "landscape",
      margins: { top: MARGIN, bottom: 34, left: MARGIN, right: MARGIN },
      info: {
        Title: `Programación anual de vacaciones ${report.year}`,
        Author: "EFAGRAM",
        Subject: "Programación anual de vacaciones",
      },
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));

    let page = 1;
    let y = drawTitle(document, report, true);
    y = drawTableHeader(document, y);
    report.items.forEach((item, index) => {
      const row = [
        String(index + 1),
        text(item.employeeDocumentNumber),
        text(item.employeeName),
        text(item.processName),
        text(item.positionName),
        text(item.supervisorName),
        date(item.startDate),
        date(item.endDate),
        String(item.scheduledDays),
        status(item.status),
        periodSummary(item),
      ];
      document.font("Helvetica").fontSize(6.5);
      const heights = row.map((value, rowIndex) =>
        document.heightOfString(value, {
          width: columns[rowIndex]!.width - 6,
        }),
      );
      const rowHeight = Math.max(20, Math.min(48, Math.max(...heights) + 10));
      if (y + rowHeight > PAGE_HEIGHT - 38) {
        drawFooter(document, page);
        document.addPage();
        page += 1;
        y = drawTitle(document, report, false);
        y = drawTableHeader(document, y);
      }
      drawTableRow(document, row, y, rowHeight, index % 2 === 1);
      y += rowHeight;
    });

    if (y + 74 > PAGE_HEIGHT - 38) {
      drawFooter(document, page);
      document.addPage();
      page += 1;
      y = drawTitle(document, report, false);
    }
    y += 24;
    document.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(
      "La información corresponde a cronogramas registrados en el sistema y conserva la trazabilidad de cada programación.",
      MARGIN,
      y,
      { width: TABLE_WIDTH },
    );
    y += 34;
    const signatureWidth = 190;
    ["Elaboró", "Revisó", "Aprobó"].forEach((label, index) => {
      const x = MARGIN + index * 245;
      document.strokeColor(MUTED).moveTo(x, y).lineTo(x + signatureWidth, y).stroke();
      document.font("Helvetica").fontSize(8).fillColor(MUTED).text(label, x, y + 5, {
        width: signatureWidth,
        align: "center",
      });
    });
    drawFooter(document, page);
    document.end();
  });
}
