import { describe, expect, it } from "vitest";
import { daysBetween, parseLocalDate } from "../src/domain/shared/localDate.js";
import { buildPdf, buildXlsx } from "../src/infrastructure/reports/reportExporters.js";

describe("backend smoke tests", () => {
  it("calculates local date differences", () => {
    expect(daysBetween(parseLocalDate("2026-01-01"), parseLocalDate("2026-01-15"))).toBe(14);
  });

  it("generates valid export signatures", () => {
    expect(buildPdf([["Header"], ["Value"]]).subarray(0, 5).toString()).toBe("%PDF-");
    expect(buildXlsx([["Header"], ["Value"]]).subarray(0, 2).toString()).toBe("PK");
  });
});
