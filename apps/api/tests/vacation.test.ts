import { describe, expect, it } from "vitest";
import {
  addYearsAnniversary,
  daysBetween,
  parseLocalDate,
} from "../src/domain/shared/localDate.js";
import {
  alertFor,
  createPeriod,
  overdue,
  pendingDays,
  scheduledDays,
} from "../src/domain/vacations/calculations.js";
import type { Employment } from "../src/domain/workers/models.js";
import type { VacationPolicy } from "../src/domain/vacations/models.js";
import { MemoryStore } from "../src/adapters/outbound/memory/memoryRepositories.js";
import { VacationService } from "../src/application/services/vacationService.js";
import { AuthService } from "../src/application/services/authService.js";
import { VacationAccrualScheduler } from "../src/application/services/vacationScheduler.js";
import { buildPdf, buildXlsx } from "../src/infrastructure/reports/reportExporters.js";
import { can } from "../src/application/services/permissionService.js";
import { parseXlsx } from "../src/infrastructure/imports/xlsxParser.js";
import { normalizeSettlementRows } from "../src/application/services/settlementImport.js";
import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { buildAnnualSchedulePdf } from "../src/infrastructure/reports/annualSchedulePdf.js";
import type { AnnualScheduleReport } from "../src/application/services/vacationService.js";

const employment: Employment = {
  id: "e1",
  workerId: "w1",
  startDate: "2026-06-18",
  contractTypeId: "standard",
  contractTypeName: "Indefinido",
  processId: "p",
  processName: "Cosecha",
  positionId: "o",
  positionName: "Operario",
  status: "ACTIVE",
  version: 1,
  createdAt: "",
  updatedAt: "",
};
const policy: VacationPolicy = {
  id: "p",
  effectiveFrom: "2026-01-01",
  daysPerCompletedYear: 15,
  overdueAfterMonths: 12,
  upcomingAccrualAlerts: [30, 60, 90],
  active: true,
};
describe("vacation domain", () => {
  it("keeps a period forming until the anniversary", () => {
    expect(createPeriod(employment, 1, "2026-06-18", policy, "2027-06-17").lifecycleStatus).toBe(
      "FORMING",
    );
    expect(createPeriod(employment, 1, "2026-06-18", policy, "2027-06-18").lifecycleStatus).toBe(
      "CAUSED",
    );
  });
  it("calculates calendar days without timezone drift", () => {
    expect(daysBetween(parseLocalDate("2026-08-18"), parseLocalDate("2026-08-20"))).toBe(2);
  });
  it("handles leap-day anniversaries explicitly", () => {
    expect(addYearsAnniversary("2024-02-29", 1)).toBe("2025-02-28");
  });
  it("separates legal pending from scheduled availability", () => {
    const p = createPeriod(employment, 1, "2025-06-18", policy, "2026-06-18");
    expect(
      pendingDays(p, [
        {
          allocations: [{ periodId: p.id, enjoyedDays: 5, compensatedDays: 2 }],
        },
      ]),
    ).toBe(8);
    expect(
      scheduledDays(p, [{ status: "SCHEDULED", allocations: [{ periodId: p.id, days: 3 }] }]),
    ).toBe(3);
  });
  it("maps upcoming alert bands", () => {
    expect(alertFor(100)).toBe("NORMAL");
    expect(alertFor(75)).toBe("INFORMATIVE");
    expect(alertFor(45)).toBe("UPCOMING");
    expect(alertFor(20)).toBe("DUE_SOON");
    expect(alertFor(0)).toBe("CAUSED_TODAY");
  });
  it("applies the overdue policy from the causation date", () => {
    const longPolicy = { ...policy, overdueAfterMonths: 48 };
    const historicalEmployment = {
      ...employment,
      startDate: parseLocalDate("2023-02-01"),
    };
    const period = createPeriod(historicalEmployment, 1, "2023-02-01", longPolicy, "2026-08-22");

    expect(period.causedAt).toBe("2024-02-01");
    expect(overdue(period, 15, longPolicy, "2026-08-22")).toBe(false);
    expect(overdue(period, 15, longPolicy, "2028-01-31")).toBe(false);
    expect(overdue(period, 15, longPolicy, "2028-02-01")).toBe(true);
  });
});
describe("vacation application invariants", () => {
  it("reconciles legacy protections to the authoritative pending-period count", async () => {
    const store = new MemoryStore();
    await store.savePolicy({
      ...policy,
      effectiveFrom: "2020-01-01",
      overdueAfterMonths: 48,
    });
    const service = new VacationService(store, () => parseLocalDate("2026-08-22"));
    const employee = await service.createEmployment({
      documentNumber: "9915",
      fullName: "Empleado Periodos Pendientes",
      startDate: "2010-02-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const initialPeriods = await store.findByEmploymentId(employee.id);
    await store.saveMany(
      initialPeriods.map((period) =>
        period.sequence <= 6
          ? {
              ...period,
              lifecycleStatus: "CAUSED" as const,
              pendingImportProtected: true,
              pendingImportBatchId: "legacy-import",
              version: period.version + 1,
            }
          : period,
      ),
    );
    const rows = [
      {
        lineNumber: 2,
        raw: {
          Empleado: "9915",
          Nombre: "Empleado Periodos Pendientes",
          "Fecha Ing.": "2010-02-01",
          "Ult. Per. Pagado": "2024-12-31",
          "Periodo Pendiente": 3,
          "Dias Pendientes": 0,
          "Total Dias": 45,
          "Fecha Venc. Ult. Periodo": "2025-12-31",
          "Fecha Venc. Prox. Periodo": "2026-12-31",
          Cargo: "Analista",
        },
      },
    ];
    const preview = await service.previewPendingPeriodImport(
      "pendientes.xlsx",
      "pending-period-test",
      rows,
      "admin",
    );
    expect(preview.batch.errors).toHaveLength(0);
    expect(preview.batch.keptPeriods).toBe(3);
    expect(preview.batch.releasedPeriods).toBe(13);
    expect(preview.batch.protectedPeriods).toBe(0);
    const applied = await service.applyPendingPeriodImport(
      preview.batch.id,
      "pendientes.xlsx",
      "pending-period-test",
      preview.batch.previewToken,
      rows,
      "admin",
    );
    expect(applied.replayed).toBe(false);
    const periods = await store.findByEmploymentId(employee.id);
    const historical = periods.filter((period) => period.sequence <= 13);
    const pending = periods.filter((period) => period.sequence >= 14 && period.sequence <= 16);
    expect(historical.every((period) => period.lifecycleStatus === "CAUSED")).toBe(true);
    expect(historical.every((period) => period.pendingImportReleased)).toBe(true);
    expect(historical.every((period) => !period.pendingImportProtected)).toBe(true);
    expect(pending.every((period) => period.lifecycleStatus === "CAUSED")).toBe(true);
    expect(pending.every((period) => period.pendingImportProtected)).toBe(true);

    const detail = await service.detail(employee.id);
    expect(detail.pendingPeriods).toBe(3);
    expect(detail.pendingDays).toBe(45);
    expect(detail.overduePeriods).toBe(0);
    expect(detail.vacationStatus).toBe("PENDING");
  });

  it("reconciles retired employees and closes protected periods only with accounting authorization", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-02-01"));
    const employee = await service.createEmployment({
      documentNumber: "9920",
      fullName: "Empleado Retirado Liquidado",
      startDate: "2024-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const periods = await store.findByEmploymentId(employee.id);
    const protectedPeriod = periods.find((period) => period.accrualStartDate === "2025-01-01")!;
    await store.saveMany([
      {
        ...protectedPeriod,
        pendingImportProtected: true,
        pendingImportBatchId: "pending-test",
      },
    ]);
    await service.retireEmployment(employee.id, "2026-01-15", 1, "admin");
    const before = await service.retiredVacationReconciliation();
    expect(before.pendingPeriods).toBe(3);
    expect(before.items[0]?.periods.some((period) => period.state === "PENDING_LIQUIDATION")).toBe(
      true,
    );
    const result = await service.closeRetiredEmploymentsWithAccounting(
      {
        accountingDocument: "LIQ-9920",
        observation: "Liquidación en sistema contable",
        amountCOP: 250000,
      },
      "admin",
    );
    expect(result.periodsClosed).toBe(3);
    const after = await service.retiredVacationReconciliation();
    expect(after.pendingPeriods).toBe(0);
    expect(after.items[0]?.liquidatedPeriods).toBe(3);
    const closed = (await store.findByEmploymentId(employee.id)).find(
      (period) => period.id === protectedPeriod.id,
    )!;
    expect(closed.closureType).toBe("ACCOUNTING_LIQUIDATION");
    expect(closed.closureAccountingDocument).toBe("LIQ-9920");
    expect(closed.closureAmountCOP).toBe(250000);
  });

  it("previews and applies the mass closure without closing protected historical enjoyment periods", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-19"));
    await service.createEmployment({
      documentNumber: "9901",
      fullName: "Empleado Cierre Masivo",
      startDate: "2020-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const employeeToClose = await service.createEmployment({
      documentNumber: "9902",
      fullName: "Empleado Sin Disfrute Histórico",
      startDate: "2020-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const row = {
      lineNumber: 2,
      raw: {
        Empleado: "9901",
        Nombre: "Empleado Cierre Masivo",
        NDC: "01",
        "Fecha Ing.": "2020-01-01",
        "Fecha Vaca.": "2020-12-31",
        "Periodo Liq. Ini.": "2020-01-01",
        "Periodo Liq. Fin.": "2020-12-31",
        "Vaca. Disfru. Ini.": "2025-01-05",
        "Vaca. Disfru. Fin.": "2025-01-19",
        "Dias Tomados": "15",
        "Dias Compensa.": "0",
        "Dias Disfruta.": "15",
        Valor: "1000",
        "Documento de Liquidacion": "2025/01 LIQ-1",
      },
    };
    const preview = await service.previewVacationPeriodClosure(
      "disfrutes.xlsx",
      "mass-closure-test",
      [row],
      "admin",
      "2025-01-01",
      "2026-08-19",
    );
    expect(preview.batch.status).toBe("PREVIEW");
    expect(preview.batch.protectedPeriods).toBeGreaterThan(0);
    expect(preview.batch.closedPeriods).toBeGreaterThan(0);
    expect(preview.batch.reviewPeriods).toBe(0);
    const protectedPlan = preview.batch.plans.find((plan) => plan.decision === "PROTECTED");
    expect(protectedPlan?.periodStartDate).toBe("2020-01-01");
    const applied = await service.applyVacationPeriodClosure(
      preview.batch.id,
      "disfrutes.xlsx",
      "mass-closure-test",
      preview.batch.previewToken,
      [row],
      "admin",
      "2025-01-01",
      "2026-08-19",
    );
    expect(applied.closedPeriods).toBe(preview.batch.closedPeriods);
    const closed = (await store.findByEmploymentId(employeeToClose.id)).filter(
      (period) => period.lifecycleStatus === "CLOSED",
    );
    expect(
      closed.every((period) => period.closureObservation === "Liquidación en sistema contable"),
    ).toBe(true);
    expect(
      (
        await service.previewVacationPeriodClosure(
          "disfrutes.xlsx",
          "mass-closure-test",
          [row],
          "admin",
          "2025-01-01",
          "2026-08-19",
        )
      ).alreadyProcessed,
    ).toBe(true);
  });

  it("keeps one worker, updates the same contract date, and creates a re-entry for a new date", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    await service.createEmployment({
      documentNumber: "1.234.567",
      fullName: "Persona Inicial",
      startDate: "2024-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    await service.createEmployment({
      documentNumber: "1234567",
      fullName: "Persona Actualizada",
      startDate: "2024-01-01",
      contractTypeName: "Término fijo",
      processName: "Operaciones",
      positionName: "Coordinador",
    });
    await service.createEmployment({
      documentNumber: "1234567",
      fullName: "Persona Actualizada",
      startDate: "2026-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    expect(await store.listWorkers()).toHaveLength(1);
    expect(await store.listEmployments()).toHaveLength(2);
    expect((await service.list())[0]?.positionName).toBe("Coordinador");
  });
  it("enforces scheduling, settlement allocation, optimistic version and cancellation", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const employee = await service.createEmployment({
      documentNumber: "9001",
      fullName: "Empleado Prueba",
      startDate: "2024-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const detail = await service.detail(employee.id);
    const period = detail.periods.find((item) => item.lifecycleStatus === "CAUSED")!;
    const schedule = await service.createSchedule({
      employmentId: employee.id,
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      scheduledDays: 5,
      allocations: [
        {
          periodId: period.id,
          periodType: "CAUSED",
          periodStartDate: parseLocalDate(period.startDate),
          periodEndDate: parseLocalDate(period.endDate),
          days: 5,
        },
      ],
    });
    await expect(
      service.updateSchedule(
        schedule.id,
        {
          employmentId: employee.id,
          startDate: "2026-09-02",
          endDate: "2026-09-06",
          scheduledDays: 5,
          allocations: schedule.allocations,
        },
        1,
      ),
    ).resolves.toMatchObject({ version: 2 });
    await expect(service.cancelSchedule(schedule.id, 1)).rejects.toThrow("stale");
    const settlement = await service.createSettlement({
      employmentId: employee.id,
      enjoymentStartDate: "2026-09-01",
      enjoymentEndDate: "2026-09-05",
      enjoyedDays: 2,
      compensatedDays: 0,
      amountCOP: 100,
      accountingDocument: "LIQ-1",
      allocations: [{ periodId: period.id, enjoyedDays: 2, compensatedDays: 0 }],
    });
    await expect(
      service.updateSettlement(
        settlement.id,
        {
          employmentId: employee.id,
          enjoymentStartDate: "2026-09-01",
          enjoymentEndDate: "2026-09-05",
          enjoyedDays: 3,
          compensatedDays: 0,
          amountCOP: 100,
          accountingDocument: "LIQ-1",
          allocations: [{ periodId: period.id, enjoyedDays: 3, compensatedDays: 0 }],
        },
        1,
      ),
    ).resolves.toMatchObject({ version: 2, enjoyedDays: 3 });
    const settlementPage = await service.settlementPage({
      page: 1,
      pageSize: 10,
      search: "9001",
    });
    expect(settlementPage.items[0]).toMatchObject({
      employeeName: "Empleado Prueba",
      employeeDocumentNumber: "9001",
    });
    await store.saveMany(
      (await store.findByEmploymentId(employee.id)).map((storedPeriod) =>
        storedPeriod.id === period.id
          ? { ...storedPeriod, lifecycleStatus: "CLOSED" as const }
          : storedPeriod,
      ),
    );
    const employeeDetail = await service.detail(employee.id);
    expect(employeeDetail.periods.find((item) => item.id === period.id)).toMatchObject({
      lifecycleStatus: "CLOSED",
      displayStatus: "ENJOYED",
    });
  });
  it("paginates schedules, enriches the employee identity and rejects invalid future allocations", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const employees = [];
    for (let index = 0; index < 3; index++) {
      const employee = await service.createEmployment({
        documentNumber: `910${index}`,
        fullName: `Empleado Cronograma ${index}`,
        startDate: "2024-01-01",
        contractTypeName: "Indefinido",
        processName: "Operaciones",
        positionName: "Analista",
      });
      employees.push(employee);
      const period = (await service.detail(employee.id)).periods.find(
        (item) => item.lifecycleStatus === "CAUSED",
      )!;
      await service.createSchedule({
        employmentId: employee.id,
        startDate: parseLocalDate(`2026-09-0${index + 1}`),
        endDate: parseLocalDate(`2026-09-0${index + 2}`),
        scheduledDays: 2,
        allocations: [
          {
            periodId: period.id,
            periodType: "CAUSED",
            periodStartDate: parseLocalDate(period.startDate),
            periodEndDate: parseLocalDate(period.endDate),
            days: 2,
          },
        ],
      });
    }
    const page = await service.schedulePage({ page: 1, pageSize: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.employeeName).toContain("Empleado Cronograma");
    const searched = await service.schedulePage({
      page: 1,
      pageSize: 10,
      search: "9101",
    });
    expect(searched.total).toBe(1);
    const forming = (await service.detail(employees[0]!.id)).periods.find(
      (item) => item.lifecycleStatus === "FORMING",
    )!;
    await expect(
      service.createSchedule({
        employmentId: employees[0]!.id,
        startDate: "2026-10-01",
        endDate: "2026-10-02",
        scheduledDays: 2,
        allocations: [
          {
            periodType: "FUTURE",
            periodStartDate: parseLocalDate("2020-01-01"),
            periodEndDate: parseLocalDate("2020-12-31"),
            days: 2,
          },
        ],
      }),
    ).rejects.toThrow("forming period");
    expect(
      store.audits.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "action" in event &&
          event.action === "VACATION_SCHEDULED",
      ),
    ).toBe(true);
    expect(forming.lifecycleStatus).toBe("FORMING");
  });
  it("requires completed schedules to reconcile exactly with the registered enjoyment", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const employee = await service.createEmployment({
      documentNumber: "9110",
      fullName: "Conversión Cronograma",
      startDate: "2024-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const period = (await service.detail(employee.id)).periods.find(
      (item) => item.lifecycleStatus === "CAUSED",
    )!;
    const schedule = await service.createSchedule({
      employmentId: employee.id,
      startDate: "2026-10-01",
      endDate: "2026-10-05",
      scheduledDays: 5,
      allocations: [
        {
          periodId: period.id,
          periodType: "CAUSED",
          periodStartDate: parseLocalDate(period.startDate),
          periodEndDate: parseLocalDate(period.endDate),
          days: 5,
        },
      ],
    });
    await expect(
      service.completeSchedule(
        schedule.id,
        {
          employmentId: employee.id,
          enjoymentStartDate: "2026-10-01",
          enjoymentEndDate: "2026-10-04",
          enjoyedDays: 4,
          compensatedDays: 0,
          amountCOP: 100,
          accountingDocument: "LIQ-CRON-1",
          allocations: [{ periodId: period.id, enjoyedDays: 4, compensatedDays: 0 }],
        },
        1,
      ),
    ).rejects.toThrow("must match the scheduled days");
  });
  it("builds the annual schedule report by year, status and employee without duplicate lookups", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const employees = [];
    const reportEmployees: [string, string][] = [
      ["9201", "Reporte Anual Uno"],
      ["9202", "Reporte Anual Dos"],
    ];
    for (const [documentNumber, fullName] of reportEmployees) {
      const employee = await service.createEmployment({
        documentNumber,
        fullName,
        startDate: "2024-01-01",
        contractTypeName: "Indefinido",
        processName: "Operaciones",
        positionName: "Analista",
      });
      const period = (await service.detail(employee.id)).periods.find(
        (item) => item.lifecycleStatus === "CAUSED",
      )!;
      await service.createSchedule({
        employmentId: employee.id,
        startDate: documentNumber === "9201" ? "2025-12-30" : "2026-08-10",
        endDate: documentNumber === "9201" ? "2026-01-03" : "2026-08-14",
        scheduledDays: 5,
        allocations: [
          {
            periodId: period.id,
            periodType: "CAUSED",
            periodStartDate: parseLocalDate(period.startDate),
            periodEndDate: parseLocalDate(period.endDate),
            days: 5,
          },
        ],
      });
      employees.push(employee);
    }
    const annual = await service.annualScheduleReport({ year: 2026, status: "SCHEDULED" });
    expect(annual.totalEmployees).toBe(2);
    expect(annual.totalSchedules).toBe(2);
    expect(annual.totalDays).toBe(10);
    expect(annual.preparedBy).toBe("Sistema");
    expect(annual.approvedBy).toBe("Sin configurar");
    expect(annual.monthly.find((month) => month.month === 1)?.schedules).toBe(1);
    expect(
      (await service.annualScheduleReport({ year: 2025, status: "SCHEDULED" })).totalSchedules,
    ).toBe(1);
    const pdf = await buildAnnualSchedulePdf(annual);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
    await service.cancelSchedule((await store.listSchedules())[0]!.id, 1);
    expect(
      (await service.annualScheduleReport({ year: 2026, status: "SCHEDULED" })).totalSchedules,
    ).toBe(1);
    expect((await service.annualScheduleReport({ year: 2026 })).totalSchedules).toBe(2);
    expect(employees).toHaveLength(2);
  });
  it("filters the annual report by the current schedule date range", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const employee = await service.createEmployment({
      documentNumber: "9203",
      fullName: "Empleado Rango",
      startDate: "2024-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const periods = await store.findByEmploymentId(employee.id);
    const caused = periods.filter((period) => period.lifecycleStatus === "CAUSED");
    for (const [index, dates] of [
      ["2026-07-01", "2026-07-15"],
      ["2025-01-01", "2025-01-15"],
    ].entries()) {
      const period = caused[index]!;
      await service.createSchedule({
        employmentId: employee.id,
        startDate: parseLocalDate(dates[0]!),
        endDate: parseLocalDate(dates[1]!),
        scheduledDays: 5,
        allocations: [
          {
            periodId: period.id,
            periodType: "CAUSED",
            periodStartDate: parseLocalDate(period.accrualStartDate),
            periodEndDate: parseLocalDate(period.accrualEndDate),
            days: 5,
          },
        ],
      });
    }
    const ranged = await service.annualScheduleReport({
      fromDate: "2026-06-01",
      toDate: "2026-08-31",
      status: "SCHEDULED",
    });
    expect(ranged.totalSchedules).toBe(1);
    expect(ranged.rangeLabel).toBe("Desde 01/06/2026 hasta 31/08/2026");
    expect(ranged.monthly.map((month) => month.label)).toEqual([
      "Jun 2026",
      "Jul 2026",
      "Ago 2026",
    ]);
    const all = await service.annualScheduleReport({});
    expect(all.totalSchedules).toBe(2);
    expect(all.rangeLabel).toBe("Todas las fechas");
  });
  it("builds the annual PDF without blank pages and with an exact page count", async () => {
    const makeItem = (index: number): AnnualScheduleReport["items"][number] => ({
      id: `schedule-${index}`,
      employmentId: `employment-${index}`,
      startDate: "2026-08-01",
      endDate: "2026-08-15",
      scheduledDays: 15,
      allocations: [],
      status: "SCHEDULED",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      employeeName: `Empleado ${index}`,
      employeeDocumentNumber: String(9000 + index),
      processName: "Operaciones",
      positionName: "Analista",
      supervisorName: "Supervisión",
    });
    const items = Array.from({ length: 45 }, (_, index) => makeItem(index));
    const report: AnnualScheduleReport = {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      rangeLabel: "Desde 01/01/2026 hasta 31/12/2026",
      generatedAt: "2026-08-18T12:00:00.000Z",
      preparedBy: "Sistema",
      approvedBy: "Gerente",
      totalEmployees: 45,
      totalSchedules: 45,
      totalDays: 675,
      monthly: [],
      items,
    };
    const pdf = await buildAnnualSchedulePdf(report);
    const source = pdf.toString("latin1");
    const pages = source.match(/\/Type \/Page\b/g)?.length ?? 0;
    expect(pages).toBe(3);
    expect(source.trimEnd().endsWith("%%EOF")).toBe(true);
    const single = await buildAnnualSchedulePdf({
      ...report,
      items: items.slice(0, 1),
      totalEmployees: 1,
      totalSchedules: 1,
      totalDays: 15,
    });
    expect(single.toString("latin1").match(/\/Type \/Page\b/g)?.length ?? 0).toBe(1);
  });
  it("keeps the footer on every page and the signatures on the last page", async () => {
    const makeItem = (index: number): AnnualScheduleReport["items"][number] => ({
      id: `schedule-r-${index}`,
      employmentId: `employment-r-${index}`,
      startDate:
        `2026-07-${String((index % 28) + 1).padStart(2, "0")}` as `${number}-${number}-${number}`,
      endDate:
        `2026-07-${String(((index + 14) % 28) + 1).padStart(2, "0")}` as `${number}-${number}-${number}`,
      scheduledDays: 15,
      allocations: [
        {
          periodId: `period-${index}-a`,
          periodType: "CAUSED",
          periodStartDate: "2025-01-01",
          periodEndDate: "2025-12-31",
          days: 10,
        },
        {
          periodId: `period-${index}-b`,
          periodType: "CAUSED",
          periodStartDate: "2024-01-01",
          periodEndDate: "2024-12-31",
          days: 5,
        },
      ],
      status: index % 3 === 0 ? "COMPLETED" : "SCHEDULED",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      employeeName: `Empleado ${index}`,
      employeeDocumentNumber: String(9000 + index),
      processName: "Operaciones",
      positionName: "Analista",
      supervisorName: "Supervisión",
    });
    const report: AnnualScheduleReport = {
      fromDate: "2026-06-01",
      toDate: "2026-08-31",
      rangeLabel: "Desde 01/06/2026 hasta 31/08/2026",
      generatedAt: "2026-08-18T12:00:00.000Z",
      preparedBy: "Sistema",
      approvedBy: "Gerente",
      totalEmployees: 60,
      totalSchedules: 60,
      totalDays: 900,
      monthly: [
        { month: 6, label: "Jun 2026", schedules: 20, days: 300 },
        { month: 7, label: "Jul 2026", schedules: 30, days: 450 },
        { month: 8, label: "Ago 2026", schedules: 10, days: 150 },
      ],
      items: Array.from({ length: 60 }, (_, index) => makeItem(index)),
    };
    const pdf = await buildAnnualSchedulePdf(report);
    const source = pdf.toString("latin1");
    const pages = source.match(/\/Type \/Page\b/g)?.length ?? 0;
    const streams = [...source.matchAll(/\/Type \/Page\b[\s\S]*?\/Contents (\d+) 0 R/g)].map(
      (match) => {
        const obj = source.match(
          new RegExp(`${match[1]} 0 obj[\\s\\S]*?stream\\r?\\n([\\s\\S]*?)endstream`),
        );
        try {
          return inflateSync(Buffer.from(obj?.[1] ?? "", "latin1")).toString("latin1");
        } catch {
          return obj?.[1] ?? "";
        }
      },
    );
    const pageTexts = streams.map((stream) => {
      const parts: string[] = [];
      for (const block of stream.matchAll(/\[([^\]]+)\]\s*TJ/g))
        parts.push(
          [...block[1]!.matchAll(/<([0-9a-fA-F]+)>/g)]
            .map((hex) =>
              Buffer.from(hex[1]!.replace(/[^0-9a-fA-F]/g, ""), "hex").toString("latin1"),
            )
            .join(""),
        );
      for (const literal of stream.matchAll(/\(([^)]+)\)\s*Tj/g)) parts.push(literal[1]!);
      return parts.join("|");
    });
    expect(pageTexts.length).toBe(pages);
    pageTexts.forEach((text) => {
      expect(text).toContain("EFAGRAM · Documento");
      expect(text).toMatch(/Página \d/);
    });
    const last = pageTexts[pageTexts.length - 1]!;
    expect(last).toContain("Aprobado por");
    expect(last).toContain("Empleado");
    const phantom = pageTexts.filter(
      (text) => !text.includes("Empleado") && !text.includes("PROGRAMACIÓN"),
    );
    expect(phantom).toHaveLength(0);
  });
  it("paginates summaries without changing the result count or loading unrelated pages", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    for (let index = 0; index < 35; index++)
      await service.createEmployment({
        documentNumber: `8${String(index).padStart(3, "0")}`,
        fullName: `Empleado ${String(index).padStart(2, "0")}`,
        startDate: "2025-01-01",
        contractTypeName: "Indefinido",
        processName: index % 2 ? "Operaciones" : "Administración",
        positionName: "Analista",
      });
    const first = await service.listPage({
      page: 1,
      pageSize: 10,
      filters: { status: "ACTIVE" },
    });
    const second = await service.listPage({
      page: 2,
      pageSize: 10,
      filters: { status: "ACTIVE" },
    });
    const filtered = await service.listPage({
      page: 1,
      pageSize: 10,
      filters: { processName: "Administración" },
    });
    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(10);
    expect(first.total).toBe(35);
    expect(new Set(first.items.map((item) => item.id)).size).toBe(10);
    expect(filtered.total).toBe(18);
    expect(filtered.items.every((item) => item.processName === "Administración")).toBe(true);
  });
  it("orders by pending days and exposes vacation workflow statuses", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const create = (documentNumber: string, startDate: `${number}-${number}-${number}`) =>
      service.createEmployment({
        documentNumber,
        fullName: `Empleado ${documentNumber}`,
        startDate,
        contractTypeName: "Indefinido",
        processName: "Operaciones",
        positionName: "Analista",
      });
    const overdueEmployee = await create("9301", "2024-08-01");
    const pendingEmployee = await create("9302", "2025-08-01");
    const scheduledEmployee = await create("9303", "2025-08-02");
    const scheduledDetail = await service.detail(scheduledEmployee.id);
    const scheduledPeriod = scheduledDetail.periods.find(
      (item) => item.lifecycleStatus === "CAUSED",
    )!;
    await service.createSchedule({
      employmentId: scheduledEmployee.id,
      startDate: parseLocalDate("2026-09-01"),
      endDate: parseLocalDate("2026-09-15"),
      scheduledDays: 15,
      allocations: [
        {
          periodId: scheduledPeriod.id,
          periodType: "CAUSED",
          periodStartDate: parseLocalDate(scheduledPeriod.startDate),
          periodEndDate: parseLocalDate(scheduledPeriod.endDate),
          days: 15,
        },
      ],
    });
    const page = await service.listPage({
      page: 1,
      pageSize: 10,
      sortByPendingDays: true,
    });
    expect(page.items.map((item) => item.id)).toEqual([
      overdueEmployee.id,
      pendingEmployee.id,
      scheduledEmployee.id,
    ]);
    expect(
      (
        await service.listPage({
          page: 1,
          pageSize: 10,
          filters: { vacationStatus: "OVERDUE" },
          sortByPendingDays: true,
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (
        await service.listPage({
          page: 1,
          pageSize: 10,
          filters: { vacationStatus: "PENDING" },
          sortByPendingDays: true,
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (
        await service.listPage({
          page: 1,
          pageSize: 10,
          filters: { vacationStatus: "SCHEDULED" },
          sortByPendingDays: true,
        })
      ).items,
    ).toHaveLength(1);
  });
  it("calculates dashboard health and process coverage from active balances", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    await service.createEmployment({
      documentNumber: "9401",
      fullName: "Pendiente",
      startDate: "2025-08-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    await service.createEmployment({
      documentNumber: "9402",
      fullName: "En formación",
      startDate: "2026-08-10",
      contractTypeName: "Indefinido",
      processName: "Administración",
      positionName: "Analista",
    });
    await service.createEmployment({
      documentNumber: "9403",
      fullName: "Vencido",
      startDate: "2024-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const dashboard = await service.dashboard(parseLocalDate("2026-08-18"), { status: "ACTIVE" });
    expect(dashboard.health.total).toBe(3);
    expect(dashboard.health.upToDate).toBe(1);
    expect(dashboard.health.pending).toBe(1);
    expect(dashboard.health.overdue).toBe(1);
    expect(
      dashboard.health.upToDatePercent +
        dashboard.health.programmedPercent +
        dashboard.health.partialPercent +
        dashboard.health.pendingPercent +
        dashboard.health.overduePercent,
    ).toBe(100);
    expect(dashboard.processBreakdown[0]).toMatchObject({
      processName: "Operaciones",
      activeEmployees: 2,
      pendingEmployees: 2,
      overdueEmployees: 1,
    });
    const pendingDetail = await service.dashboardDetail({
      kind: "PENDING_EMPLOYEES",
      page: 1,
      pageSize: 10,
      asOf: parseLocalDate("2026-08-18"),
      filters: { status: "ACTIVE" },
    });
    expect(pendingDetail.total).toBe(dashboard.pendingEmployees);
    const overdueDetail = await service.dashboardDetail({
      kind: "HEALTH",
      healthStatus: "OVERDUE",
      page: 1,
      pageSize: 10,
      asOf: parseLocalDate("2026-08-18"),
      filters: { status: "ACTIVE" },
    });
    expect(overdueDetail.total).toBe(1);
    expect(overdueDetail.items[0]?.fullName).toBe("Vencido");

    const processDetail = await service.dashboardDetail({
      kind: "PROCESS",
      processName: "Operaciones",
      page: 1,
      pageSize: 1,
      asOf: parseLocalDate("2026-08-18"),
      filters: { status: "ACTIVE" },
    });
    expect(processDetail.total).toBe(2);
    expect(processDetail.items).toHaveLength(1);
    expect(processDetail.hasNext).toBe(true);
    expect(processDetail.items[0]?.processName).toBe("Operaciones");
  });
  it("orders upcoming accruals to year end with pending days first and exposes the last causation", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const pendingFirst = await service.createEmployment({
      documentNumber: "9451",
      fullName: "Con Días Pendientes",
      startDate: "2023-10-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const soon = await service.createEmployment({
      documentNumber: "9452",
      fullName: "Causa Pronto",
      startDate: "2025-10-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const later = await service.createEmployment({
      documentNumber: "9453",
      fullName: "Causa Más Tarde",
      startDate: "2025-11-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const closestNoPending = await service.createEmployment({
      documentNumber: "9455",
      fullName: "Cercano Sin Pendientes",
      startDate: "2025-09-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    await service.createEmployment({
      documentNumber: "9454",
      fullName: "Fuera Del Año",
      startDate: "2026-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const dashboard = await service.dashboard(parseLocalDate("2026-08-18"), {
      status: "ACTIVE",
    });
    expect(dashboard.upcomingThisYear).toBe(4);
    expect(dashboard.upcoming90Days).toBe(4);
    expect(dashboard.upcoming.map((item) => item.fullName)).toEqual([
      "Con Días Pendientes",
      "Cercano Sin Pendientes",
      "Causa Pronto",
      "Causa Más Tarde",
    ]);
    const upcomingDetail = await service.dashboardDetail({
      kind: "UPCOMING",
      page: 1,
      pageSize: 10,
      asOf: parseLocalDate("2026-08-18"),
      filters: { status: "ACTIVE" },
    });
    expect(upcomingDetail.total).toBe(4);
    expect(upcomingDetail.items[0]?.fullName).toBe("Con Días Pendientes");
    expect(upcomingDetail.items[1]?.fullName).toBe("Cercano Sin Pendientes");
    expect((await service.detail(pendingFirst.id)).lastCausedAt).toBe("2025-10-01");
    expect((await service.detail(soon.id)).lastCausedAt).toBeUndefined();
    expect((await service.detail(later.id)).lastCausedAt).toBeUndefined();
    expect((await service.detail(closestNoPending.id)).lastCausedAt).toBeUndefined();
  });
  it("warns holidays and completes schedule settlement in one store operation", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    await service.createEmployment({
      documentNumber: "9002",
      fullName: "Empleado Festivo",
      startDate: "2024-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const employee = (await service.list())[0]!;
    const period = (await service.detail(employee.id)).periods.find(
      (item) => item.lifecycleStatus === "CAUSED",
    )!;
    await store.saveHoliday({
      id: "h1",
      date: "2026-09-02",
      name: "Festivo de prueba",
      country: "CO",
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const schedule = await service.createSchedule({
      employmentId: employee.id,
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      scheduledDays: 5,
      allocations: [
        {
          periodId: period.id,
          periodType: "CAUSED",
          periodStartDate: parseLocalDate(period.startDate),
          periodEndDate: parseLocalDate(period.endDate),
          days: 5,
        },
      ],
    });
    expect(schedule.holidayWarnings).toEqual(["2026-09-02"]);
    const result = await service.completeSchedule(
      schedule.id,
      {
        employmentId: employee.id,
        enjoymentStartDate: "2026-09-01",
        enjoymentEndDate: "2026-09-05",
        enjoyedDays: 5,
        compensatedDays: 0,
        amountCOP: 100,
        accountingDocument: "LIQ-2",
        allocations: [{ periodId: period.id, enjoyedDays: 5, compensatedDays: 0 }],
      },
      1,
    );
    expect(result.schedule.status).toBe("COMPLETED");
    expect(store.settlements.size).toBe(1);
    expect(store.audits.filter((item) => typeof item === "object" && item !== null).length).toBe(4);
  });
  it("closes every open period when a contract is retired and removes its pending balance", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const employee = await service.createEmployment({
      documentNumber: "9010",
      fullName: "Empleado Retirado",
      startDate: "2020-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const retired = await service.retireEmployment(employee.id, "2025-06-15");
    const periods = await store.findByEmploymentId(employee.id);
    expect(periods.length).toBeGreaterThan(0);
    expect(periods.every((period) => period.lifecycleStatus === "CLOSED")).toBe(true);
    expect(
      periods.every(
        (period) =>
          period.closureObservation === "Cierre de vacaciones por terminación de contrato",
      ),
    ).toBe(true);
    expect(retired.status).toBe("RETIRED");
    expect(retired.pendingDays).toBe(0);
    expect(retired.availableForScheduling).toBe(0);
  });
  it("regularizes existing retired contracts with no persisted periods", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    await store.saveWorker({
      id: "w-retired",
      documentNumber: "9011",
      normalizedDocumentNumber: "9011",
      fullName: "Retirado Histórico",
      workerType: "EMPLOYEE",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    await store.saveEmployment({
      ...employment,
      id: "e-retired",
      workerId: "w-retired",
      startDate: "2020-01-01",
      endDate: "2024-12-31",
      status: "RETIRED",
    });
    const result = await service.closeRetiredEmployments("migration-test");
    expect(result.employmentsScanned).toBe(1);
    expect(result.employmentsChanged).toBe(1);
    expect(result.periodsClosed).toBeGreaterThan(0);
    expect(
      (await store.findByEmploymentId("e-retired")).every(
        (period) => period.lifecycleStatus === "CLOSED",
      ),
    ).toBe(true);
    expect((await store.listAudits()).length).toBeGreaterThan(1);
  });
});
describe("security and operational adapters", () => {
  it("rotates and revokes refresh sessions without storing the raw token", async () => {
    const store = new MemoryStore();
    const auth = new AuthService(
      store,
      {
        jwtSecret: "a".repeat(40),
        refreshSecret: "b".repeat(40),
        accessExpiresIn: "15m",
        refreshExpiresIn: "7d",
      },
      store,
    );
    const testPassword = "T3st-password!";
    await auth.ensureAdmin("admin", testPassword);
    const tokens = await auth.login("admin", testPassword);
    expect(tokens).not.toBeNull();
    expect(store.sessions.size).toBe(1);
    expect([...store.sessions.values()][0]?.tokenHash).not.toBe(tokens?.refreshToken);
    const refreshed = await auth.refresh(tokens!.refreshToken);
    expect(refreshed).not.toBeNull();
    expect(store.sessions.size).toBe(2);
    await auth.revokeRefreshToken(refreshed!.refreshToken);
    await expect(auth.refresh(refreshed!.refreshToken)).resolves.toBeNull();
  });
  it("supports the user lifecycle while protecting administrator access", async () => {
    const store = new MemoryStore();
    const auth = new AuthService(store, {
      jwtSecret: "a".repeat(40),
      refreshSecret: "b".repeat(40),
      accessExpiresIn: "15m",
      refreshExpiresIn: "7d",
    });
    const admin = await auth.ensureAdmin(" Admin ", "T3st-password!");
    const created = await auth.createUser(
      "analyst",
      "T3st-password!",
      "VIEWER",
      "Ana Analista",
      "Analista de nómina",
    );
    expect(created).toMatchObject({
      username: "analyst",
      displayName: "Ana Analista",
      jobTitle: "Analista de nómina",
      active: true,
    });
    await expect(auth.createUser("ANALYST", "T3st-password!", "VIEWER")).rejects.toMatchObject({
      status: 409,
    });
    const updated = await auth.updateUser(
      created.id,
      { username: "people", displayName: "Ana López", jobTitle: "Coordinadora", role: "HR" },
      "admin",
    );
    expect(updated).toMatchObject({
      username: "people",
      displayName: "Ana López",
      jobTitle: "Coordinadora",
      role: "HR",
    });
    await auth.updateUser(created.id, { active: false }, "admin");
    await expect(auth.login("people", "T3st-password!")).resolves.toBeNull();
    await auth.updateUser(created.id, { active: true }, "admin");
    await expect(auth.login("people", "T3st-password!")).resolves.not.toBeNull();
    await expect(auth.updateUser(admin.id, { active: false }, "system")).rejects.toMatchObject({
      status: 422,
    });
    await expect(auth.updateUser(admin.id, { active: false }, "admin")).rejects.toMatchObject({
      status: 422,
    });
  });
  it("runs accrual scheduler idempotently, persists alerts and generates valid report files", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    await service.createEmployment({
      documentNumber: "7001",
      fullName: "Scheduler Test",
      startDate: "2025-11-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const scheduler = new VacationAccrualScheduler(store, service, () =>
      parseLocalDate("2026-08-18"),
    );
    await expect(scheduler.runOnce()).resolves.toMatchObject({
      processed: 1,
      generatedAlerts: 1,
    });
    await expect(scheduler.runOnce()).resolves.toMatchObject({
      replayed: true,
    });
    expect(store.schedulerRuns.size).toBe(1);
    expect(store.alerts.size).toBe(1);
    const xlsx = buildXlsx([["Nombre", "=PELIGRO"]]);
    const pdf = buildPdf([["Nombre", "Valor"]]);
    expect(xlsx.subarray(0, 2).toString()).toBe("PK");
    expect(pdf.subarray(0, 8).toString()).toBe("%PDF-1.4");
  });
  it("keeps permissions centralized by role", () => {
    expect(can("ADMIN", "settings.manage")).toBe(true);
    expect(can("HR", "employment.create")).toBe(true);
    expect(can("VIEWER", "employment.create")).toBe(false);
    expect(can("VIEWER", "report.read")).toBe(true);
  });
});
describe("massive enjoyed vacation import", () => {
  const row = (values: Record<string, unknown>, lineNumber = 2) => ({
    lineNumber,
    raw: values,
  });
  it("groups split lines and distributes a multi-period liquidation without using calendar days", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    await service.createEmployment({
      documentNumber: "9003",
      fullName: "Empleado Importado",
      startDate: "2021-06-05",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const rows = [
      row({
        Empleado: "9003",
        Nombre: "Empleado Importado",
        NDC: "01",
        "Fecha Ing.": "2021-jun-05",
        "Fecha Vaca.": "2026-jun-04",
        "Periodo Liq. Ini.": "2024-jun-05",
        "Periodo Liq. Fin.": "2024-dic-05",
        "Vaca. Disfru. Ini.": "2026-jul-01",
        "Vaca. Disfru. Fin.": "2026-jul-01",
        "Dias Tomados": 0,
        "Dias Compensa.": 7,
        "Dias Disfruta.": 0,
        Valor: "700,000.00",
        "Documento de Liquidacion": "DOC-9003",
      }),
      row({
        Empleado: "9003",
        Nombre: "Empleado Importado",
        NDC: "01",
        "Fecha Ing.": "2021-jun-05",
        "Fecha Vaca.": "2026-jun-04",
        "Periodo Liq. Ini.": "2024-dic-06",
        "Periodo Liq. Fin.": "2025-jun-04",
        "Vaca. Disfru. Ini.": "2026-jul-02",
        "Vaca. Disfru. Fin.": "2026-jul-12",
        "Dias Tomados": 8,
        "Dias Compensa.": 0,
        "Dias Disfruta.": 10,
        Valor: "800,000.00",
        "Documento de Liquidacion": "DOC-9003",
      }),
    ];
    const preview = await service.previewSettlementImport(
      "historico.csv",
      "hash-9003",
      rows,
      "admin",
      "2026-08-18",
    );
    expect(preview.batch.totalSettlements).toBe(1);
    expect(preview.batch.newSettlements).toBe(1);
    expect(preview.batch.conflicts).toBe(0);
    const group = preview.groups[0] as {
      after: {
        allocations: { enjoyedDays: number; compensatedDays: number }[];
      };
    };
    expect(group.after.allocations).toHaveLength(1);
    expect(group.after.allocations[0]).toMatchObject({
      enjoyedDays: 8,
      compensatedDays: 7,
    });
    const applied = await service.applySettlementImport(
      preview.batch.id,
      "historico.csv",
      "hash-9003",
      preview.batch.previewToken,
      rows,
      "admin",
      "2026-08-18",
    );
    expect(applied.created).toBe(1);
    expect(applied.createdSchedules).toBe(1);
    const importedSchedule = [...store.schedules.values()][0];
    expect(importedSchedule).toMatchObject({
      status: "COMPLETED",
      sourceSettlementId: [...store.settlements.values()][0]?.id,
      startDate: "2026-07-01",
      endDate: "2026-07-12",
      scheduledDays: 15,
    });
    const annual = await service.annualScheduleReport({
      year: 2026,
      status: "COMPLETED",
    });
    expect(annual.items[0]).toMatchObject({
      employeeName: "Empleado Importado",
      employeeDocumentNumber: "9003",
    });
    const report = await service.settlementReport({
      search: "9003",
      status: "ACTIVE",
    });
    expect(report[0]).toMatchObject({
      employeeName: "Empleado Importado",
      employeeDocumentNumber: "9003",
    });
    const replay = await service.previewSettlementImport(
      "historico.csv",
      "hash-9003",
      rows,
      "admin",
      "2026-08-18",
    );
    expect(replay.alreadyProcessed).toBe(true);
    store.schedules.clear();
    const replayApply = await service.applySettlementImport(
      preview.batch.id,
      "historico.csv",
      "hash-9003",
      preview.batch.previewToken,
      rows,
      "admin",
      "2026-08-18",
    );
    expect(replayApply.replayed).toBe(true);
    expect(replayApply.createdSchedules).toBe(1);
    expect(store.schedules.size).toBe(1);
  });

  it("sweeps the whole base at apply: enjoyed, migrated, protected, partial and recent periods", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const inFile = await service.createEmployment({
      documentNumber: "9005",
      fullName: "Empleado Con Archivo",
      startDate: "2020-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const outsideFile = await service.createEmployment({
      documentNumber: "9006",
      fullName: "Empleado Sin Archivo",
      startDate: "2018-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const protectedEmployee = await service.createEmployment({
      documentNumber: "9007",
      fullName: "Empleado Protegido",
      startDate: "2020-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const protectedPeriods = await store.findByEmploymentId(protectedEmployee.id);
    await store.saveMany(
      protectedPeriods.map((period) =>
        period.accrualStartDate === "2020-01-01"
          ? {
              ...period,
              pendingImportProtected: true,
              pendingImportBatchId: "pending-batch",
              version: period.version + 1,
            }
          : period,
      ),
    );
    const partialEmployee = await service.createEmployment({
      documentNumber: "9008",
      fullName: "Empleado Parcial",
      startDate: "2020-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const partialPeriod = (await store.findByEmploymentId(partialEmployee.id)).find(
      (period) => period.accrualStartDate === "2020-01-01",
    )!;
    await service.createSettlement({
      employmentId: partialEmployee.id,
      enjoymentStartDate: "2021-01-10",
      enjoymentEndDate: "2021-01-14",
      enjoyedDays: 5,
      compensatedDays: 0,
      amountCOP: 100,
      accountingDocument: "PARCIAL-9008",
      allocations: [{ periodId: partialPeriod.id, enjoyedDays: 5, compensatedDays: 0 }],
    });
    const rows = [
      row({
        Empleado: "9005",
        Nombre: "Empleado Con Archivo",
        NDC: "01",
        "Fecha Ing.": "2020-01-01",
        "Fecha Vaca.": "2020-12-31",
        "Periodo Liq. Ini.": "2020-01-01",
        "Periodo Liq. Fin.": "2020-12-31",
        "Vaca. Disfru. Ini.": "2021-01-10",
        "Vaca. Disfru. Fin.": "2021-01-24",
        "Dias Tomados": 15,
        "Dias Compensa.": 0,
        "Dias Disfruta.": 15,
        Valor: "1000",
        "Documento de Liquidacion": "DOC-9005-2020",
      }),
    ];
    const preview = await service.previewSettlementImport(
      "historico.csv",
      "hash-9005",
      rows,
      "admin",
      "2026-08-18",
    );
    const applied = await service.applySettlementImport(
      preview.batch.id,
      "historico.csv",
      "hash-9005",
      preview.batch.previewToken,
      rows,
      "admin",
      "2026-08-18",
    );
    expect(applied.closedEnjoyedPeriods).toBeGreaterThanOrEqual(1);
    expect(applied.closedByMigration).toBeGreaterThanOrEqual(7);
    expect(applied.partiallyEnjoyedWarnings).toHaveLength(1);

    const inFilePeriods = await store.findByEmploymentId(inFile.id);
    const enjoyed = inFilePeriods.find((period) => period.accrualStartDate === "2020-01-01");
    expect(enjoyed).toMatchObject({
      lifecycleStatus: "CLOSED",
      closureType: "ACCOUNTING_LIQUIDATION",
      closureObservation: "Disfrutado (liquidación registrada)",
    });
    for (const start of ["2021-01-01", "2022-01-01", "2023-01-01", "2024-01-01"]) {
      expect(inFilePeriods.find((period) => period.accrualStartDate === start)).toMatchObject({
        lifecycleStatus: "CLOSED",
        closureObservation: "Cerrado por migración",
      });
    }
    expect(inFilePeriods.find((period) => period.accrualStartDate === "2025-01-01")).toMatchObject({
      lifecycleStatus: "CAUSED",
    });

    const outsidePeriods = await store.findByEmploymentId(outsideFile.id);
    expect(outsidePeriods.find((period) => period.accrualStartDate === "2018-01-01")).toMatchObject(
      {
        lifecycleStatus: "CLOSED",
        closureObservation: "Cerrado por migración",
      },
    );
    expect(outsidePeriods.find((period) => period.accrualStartDate === "2025-01-01")).toMatchObject(
      { lifecycleStatus: "CAUSED" },
    );

    const protectedAfter = (await store.findByEmploymentId(protectedEmployee.id)).find(
      (period) => period.accrualStartDate === "2020-01-01",
    );
    expect(protectedAfter).toMatchObject({
      lifecycleStatus: "CAUSED",
      pendingImportProtected: true,
    });

    const partialAfter = (await store.findByEmploymentId(partialEmployee.id)).find(
      (period) => period.id === partialPeriod.id,
    );
    expect(partialAfter).toMatchObject({ lifecycleStatus: "CAUSED" });
    expect(
      (await store.listAudits()).some(
        (audit) =>
          typeof audit === "object" &&
          audit !== null &&
          "action" in audit &&
          audit.action === "VACATION_PERIOD_CLOSED_BY_SETTLEMENT_IMPORT",
      ),
    ).toBe(true);
  });

  it("warns and skips rows of retired contracts in the pending period import", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    await service.createEmployment({
      documentNumber: "9009",
      fullName: "Empleado Reingreso",
      startDate: "2015-01-01",
      endDate: "2018-12-31",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    await service.createEmployment({
      documentNumber: "9009",
      fullName: "Empleado Reingreso",
      startDate: "2019-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const rows = [
      {
        lineNumber: 2,
        raw: {
          Empleado: "9009",
          Nombre: "Empleado Reingreso",
          "Fecha Ing.": "2015-01-01",
          "Ult. Per. Pagado": "2018-12-31",
          "Periodo Pendiente": 1,
          "Dias Pendientes": 0,
          "Total Dias": 15,
          "Fecha Venc. Ult. Periodo": "2018-12-31",
          "Fecha Venc. Prox. Periodo": "2019-12-31",
          Cargo: "Analista",
        },
      },
    ];
    const preview = await service.previewPendingPeriodImport(
      "pendientes.xlsx",
      "hash-9009",
      rows,
      "admin",
      "2026-08-18",
    );
    expect(preview.batch.errors).toHaveLength(0);
    expect(preview.batch.matchedEmployees).toBe(0);
    expect(preview.batch.warnings.join(" ")).toContain("está retirado");
  });

  it("applies the mass closure partially, closing only safe periods and preserving review", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const employee = await service.createEmployment({
      documentNumber: "9010",
      fullName: "Empleado Cierre Parcial",
      startDate: "2020-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const periods = await store.findByEmploymentId(employee.id);
    const withSettlement = periods.find((period) => period.accrualStartDate === "2021-01-01")!;
    await service.createSettlement({
      employmentId: employee.id,
      enjoymentStartDate: "2022-01-10",
      enjoymentEndDate: "2022-01-14",
      enjoyedDays: 5,
      compensatedDays: 0,
      amountCOP: 100,
      accountingDocument: "PARCIAL-9010",
      allocations: [{ periodId: withSettlement.id, enjoyedDays: 5, compensatedDays: 0 }],
    });
    const preview = await service.previewVacationPeriodClosure(
      "cierre.xlsx",
      "hash-9010",
      [],
      "admin",
      "2025-01-01",
      "2026-08-18",
    );
    expect(preview.batch.reviewPeriods).toBeGreaterThanOrEqual(1);
    expect(preview.batch.closedPeriods).toBeGreaterThanOrEqual(1);
    const applied = await service.applyVacationPeriodClosure(
      preview.batch.id,
      "cierre.xlsx",
      "hash-9010",
      preview.batch.previewToken,
      [],
      "admin",
      "2025-01-01",
      "2026-08-18",
    );
    expect(applied.closedPeriods).toBe(preview.batch.closedPeriods);
    expect(applied.pendingReviewPeriods).toBeGreaterThanOrEqual(1);
    expect(applied.batch.status).toBe("APPLIED");
    const after = await store.findByEmploymentId(employee.id);
    expect(after.find((period) => period.id === withSettlement.id)).toMatchObject({
      lifecycleStatus: "CAUSED",
    });
  });

  it("uses the closure cutoff setting when the mass closure omits the date", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    await store.saveSystemSetting({
      key: "VACATION_CLOSURE_FROM_DATE",
      value: "2024-01-01",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
    await service.createEmployment({
      documentNumber: "9011",
      fullName: "Empleado Corte Ajuste",
      startDate: "2020-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const preview = await service.previewVacationPeriodClosure(
      "cierre.xlsx",
      "hash-9011",
      [],
      "admin",
      undefined,
      "2026-08-18",
    );
    expect(preview.batch.fromDate).toBe("2024-01-01");
  });
  it.skipIf(
    !existsSync(
      "C:/Users/SISTEMAS/Documents/Empresa/1. Empresa Efagram/AC Procesos/Lesmin Carton/2026/7. Julio/Vaca_Disfrutada.xlsx",
    ),
  )("reads the supplied workbook shape and ignores the separator row", () => {
    const workbook = parseXlsx(
      readFileSync(
        "C:/Users/SISTEMAS/Documents/Empresa/1. Empresa Efagram/AC Procesos/Lesmin Carton/2026/7. Julio/Vaca_Disfrutada.xlsx",
      ),
    );
    const normalized = normalizeSettlementRows(workbook.rows);
    expect(workbook.headers).toHaveLength(14);
    expect(workbook.rows).toHaveLength(96);
    expect(normalized.lines).toHaveLength(95);
    expect(normalized.errors).toHaveLength(0);
  });
  it("annuls logically, removes from the active page and preserves the record", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const employee = await service.createEmployment({
      documentNumber: "9004",
      fullName: "Empleado Anulación",
      startDate: "2024-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const period = (await service.detail(employee.id)).periods.find(
      (item) => item.lifecycleStatus === "CAUSED",
    )!;
    const settlement = await service.createSettlement({
      employmentId: employee.id,
      enjoymentStartDate: "2026-09-01",
      enjoymentEndDate: "2026-09-05",
      enjoyedDays: 5,
      compensatedDays: 0,
      amountCOP: 100,
      accountingDocument: "DOC-ANUL",
      allocations: [{ periodId: period.id, enjoyedDays: 5, compensatedDays: 0 }],
    });
    await service.annulSettlement(settlement.id, "Corrección contable", 1, "admin");
    expect((await store.listSettlements()).some((item) => item.id === settlement.id)).toBe(false);
    expect((await store.findSettlementById(settlement.id))?.status).toBe("ANULADA");
    expect(
      (await store.listAudits()).some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "action" in item &&
          item.action === "VACATION_SETTLEMENT_ANNULLED",
      ),
    ).toBe(true);
  });
});
