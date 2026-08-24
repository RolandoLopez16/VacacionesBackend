import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseXlsx } from "../src/infrastructure/imports/xlsxParser.js";
import { buildPdf, buildXlsx, excelSafe } from "../src/infrastructure/reports/reportExporters.js";

describe("report exporters", () => {
  it("protects every Excel formula prefix", () => {
    expect(["=SUM(A1:A2)", "+1", "-1", "@cmd", "safe"].map(excelSafe)).toEqual([
      "'=SUM(A1:A2)",
      "'+1",
      "'-1",
      "'@cmd",
      "safe",
    ]);
  });

  it("builds an XLSX with safe cells beyond column Z", async () => {
    const row = Array.from({ length: 28 }, (_, index) => `Columna ${index + 1}`);
    row[27] = "=PELIGRO";
    const output = buildXlsx([row, ["123", "2026-08-21"]]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const worksheet = workbook.worksheets[0];
    expect(output.subarray(0, 2).toString()).toBe("PK");
    expect(worksheet?.name).toBe("Reporte");
    expect(worksheet?.getCell("AB1").value).toBe("'=PELIGRO");
    expect(worksheet?.getCell("B2").value).toBe("2026-08-21");
  });

  it("parses rich cells, formula results, sparse lines and LocalDate values", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.properties.date1904 = true;
    const worksheet = workbook.addWorksheet("Datos históricos");
    worksheet.getRow(1).values = ["Cédula", "Fecha ingreso", "Activo", "Observación", "Total"];
    worksheet.getCell("A4").value = "9001";
    worksheet.getCell("B4").value = 1;
    worksheet.getCell("C4").value = true;
    worksheet.getCell("D4").value = {
      richText: [{ text: "Texto " }, { text: "completo", font: { bold: true } }],
    };
    worksheet.getCell("E4").value = { formula: "1+2", result: 3 };
    worksheet.getCell("A7").value = "9002";
    worksheet.getCell("B7").value = new Date(Date.UTC(2026, 7, 21));
    worksheet.getCell("B7").numFmt = "yyyy-mm-dd";

    const parsed = parseXlsx(Buffer.from(await workbook.xlsx.writeBuffer()));

    expect(parsed.headers).toEqual(["Cédula", "Fecha ingreso", "Activo", "Observación", "Total"]);
    expect(parsed.rows).toEqual([
      {
        lineNumber: 4,
        raw: {
          Cédula: "9001",
          "Fecha ingreso": "1904-01-02",
          Activo: true,
          Observación: "Texto completo",
          Total: 3,
        },
      },
      {
        lineNumber: 7,
        raw: {
          Cédula: "9002",
          "Fecha ingreso": "2026-08-21",
          Activo: "",
          Observación: "",
          Total: "",
        },
      },
    ]);
  });

  it("builds a valid multipage PDF without truncating the report", () => {
    const rows = [["Cédula", "Nombre"]];
    for (let index = 1; index <= 150; index++) rows.push([String(index), `Empleado ${index}`]);

    const output = buildPdf(rows);
    const source = output.toString("latin1");
    expect(output.subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(source.match(/\/Type \/Page\b/g)?.length ?? 0).toBeGreaterThan(1);
    expect(source.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});
