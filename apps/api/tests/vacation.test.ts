import { describe, expect, it } from "vitest";
import {
  addYearsAnniversary,
  daysBetween,
  parseLocalDate,
} from "../src/domain/shared/localDate.js";
import {
  alertFor,
  createPeriod,
  pendingDays,
  scheduledDays,
} from "../src/domain/vacations/calculations.js";
import type { Employment } from "../src/domain/workers/models.js";
import type { VacationPolicy } from "../src/domain/vacations/models.js";
import { MemoryStore } from "../src/adapters/outbound/memory/memoryRepositories.js";
import { VacationService } from "../src/application/services/vacationService.js";
import { AuthService } from "../src/application/services/authService.js";
import { VacationAccrualScheduler } from "../src/application/services/vacationScheduler.js";
import {
  buildPdf,
  buildXlsx,
} from "../src/infrastructure/reports/reportExporters.js";
import { can } from "../src/application/services/permissionService.js";
import { parseXlsx } from "../src/infrastructure/imports/xlsxParser.js";
import { normalizeSettlementRows } from "../src/application/services/settlementImport.js";
import { existsSync, readFileSync } from "node:fs";
import { buildAnnualSchedulePdf } from "../src/infrastructure/reports/annualSchedulePdf.js";

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
    expect(
      createPeriod(employment, 1, "2026-06-18", policy, "2027-06-17")
        .lifecycleStatus,
    ).toBe("FORMING");
    expect(
      createPeriod(employment, 1, "2026-06-18", policy, "2027-06-18")
        .lifecycleStatus,
    ).toBe("CAUSED");
  });
  it("calculates calendar days without timezone drift", () => {
    expect(
      daysBetween(parseLocalDate("2026-08-18"), parseLocalDate("2026-08-20")),
    ).toBe(2);
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
      scheduledDays(p, [
        { status: "SCHEDULED", allocations: [{ periodId: p.id, days: 3 }] },
      ]),
    ).toBe(3);
  });
  it("maps upcoming alert bands", () => {
    expect(alertFor(100)).toBe("NORMAL");
    expect(alertFor(75)).toBe("INFORMATIVE");
    expect(alertFor(45)).toBe("UPCOMING");
    expect(alertFor(20)).toBe("DUE_SOON");
    expect(alertFor(0)).toBe("CAUSED_TODAY");
  });
});
describe("vacation application invariants", () => {
  it("imports pending periods as full 15-day units and protects 2015 from later mass closure", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-02-01"),
    );
    const employee = await service.createEmployment({
      documentNumber: "9915",
      fullName: "Empleado Periodos Pendientes",
      startDate: "2015-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const rows = [
      {
        lineNumber: 2,
        raw: {
          Empleado: "9915",
          Nombre: "Empleado Periodos Pendientes",
          "Fecha Ing.": "2015-01-01",
          "Ult. Per. Pagado": "2024-12-31",
          "Periodo Pendiente": 1,
          "Dias Pendientes": 7,
          "Total Dias": 22,
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
    expect(preview.batch.keptPeriods).toBe(1);
    expect(preview.batch.closedPeriods).toBeGreaterThan(0);
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
    const historical = periods.find((period) => period.accrualStartDate === "2015-01-01")!;
    const latest = periods.find((period) => period.accrualStartDate === "2025-01-01")!;
    const previous = periods.find((period) => period.accrualStartDate === "2024-01-01")!;
    expect(historical.lifecycleStatus).toBe("CAUSED");
    expect(historical.pendingImportProtected).toBe(true);
    expect(latest.lifecycleStatus).toBe("CAUSED");
    expect(latest.pendingImportProtected).toBe(true);
    expect(previous.lifecycleStatus).toBe("CLOSED");

    const enjoyedRows = [
      {
        lineNumber: 2,
        raw: {
          Empleado: "9915",
          Nombre: "Empleado Periodos Pendientes",
          NDC: "01",
          "Fecha Ing.": "2015-01-01",
          "Fecha Vaca.": "2015-12-31",
          "Periodo Liq. Ini.": "2015-01-01",
          "Periodo Liq. Fin.": "2015-12-31",
          "Vaca. Disfru. Ini.": "2016-01-05",
          "Vaca. Disfru. Fin.": "2016-01-19",
          "Dias Tomados": 15,
          "Dias Compensa.": 0,
          "Dias Disfruta.": 15,
          Valor: 100,
          "Documento de Liquidacion": "2016/01 LIQ-1",
        },
      },
    ];
    const settlementPreview = await service.previewSettlementImport(
      "disfrutes.xlsx",
      "enjoyed-after-pending-test",
      enjoyedRows,
      "admin",
    );
    await service.applySettlementImport(
      settlementPreview.batch.id,
      "disfrutes.xlsx",
      "enjoyed-after-pending-test",
      settlementPreview.batch.previewToken,
      enjoyedRows,
      "admin",
    );
    const protectedAfterEnjoyed = (await store.findByEmploymentId(employee.id)).find(
      (period) => period.accrualStartDate === "2015-01-01",
    )!;
    expect(protectedAfterEnjoyed.lifecycleStatus).toBe("CAUSED");
    expect(protectedAfterEnjoyed.pendingImportProtected).toBe(true);
  });

  it("reconciles retired employees and closes protected periods only with accounting authorization", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-02-01"),
    );
    const employee = await service.createEmployment({
      documentNumber: "9920",
      fullName: "Empleado Retirado Liquidado",
      startDate: "2024-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const periods = await store.findByEmploymentId(employee.id);
    const protectedPeriod = periods.find(
      (period) => period.accrualStartDate === "2025-01-01",
    )!;
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
    expect(before.items[0]?.periods.some((period) => period.state === "PENDING_LIQUIDATION")).toBe(true);
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
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-19"),
    );
    const employee = await service.createEmployment({
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
    const protectedPlan = preview.batch.plans.find(
      (plan) => plan.decision === "PROTECTED",
    );
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
    expect(closed.every((period) => period.closureObservation === "Liquidación en sistema contable")).toBe(true);
    expect(
      (await service.previewVacationPeriodClosure(
        "disfrutes.xlsx",
        "mass-closure-test",
        [row],
        "admin",
        "2025-01-01",
        "2026-08-19",
      )).alreadyProcessed,
    ).toBe(true);
  });

  it("keeps one worker, updates the same contract date, and creates a re-entry for a new date", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
    const employee = await service.createEmployment({
      documentNumber: "9001",
      fullName: "Empleado Prueba",
      startDate: "2024-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const detail = await service.detail(employee.id);
    const period = detail.periods.find(
      (item) => item.lifecycleStatus === "CAUSED",
    )!;
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
    await expect(service.cancelSchedule(schedule.id, 1)).rejects.toThrow(
      "stale",
    );
    const settlement = await service.createSettlement({
      employmentId: employee.id,
      enjoymentStartDate: "2026-09-01",
      enjoymentEndDate: "2026-09-05",
      enjoyedDays: 2,
      compensatedDays: 0,
      amountCOP: 100,
      accountingDocument: "LIQ-1",
      allocations: [
        { periodId: period.id, enjoyedDays: 2, compensatedDays: 0 },
      ],
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
          allocations: [
            { periodId: period.id, enjoyedDays: 3, compensatedDays: 0 },
          ],
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
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
        allocations: [{
          periodId: period.id,
          periodType: "CAUSED",
          periodStartDate: parseLocalDate(period.startDate),
          periodEndDate: parseLocalDate(period.endDate),
          days: 2,
        }],
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
        allocations: [{
          periodType: "FUTURE",
          periodStartDate: parseLocalDate("2020-01-01"),
          periodEndDate: parseLocalDate("2020-12-31"),
          days: 2,
        }],
      }),
    ).rejects.toThrow("forming period");
    expect(store.audits.some((event) => typeof event === "object" && event !== null && "action" in event && event.action === "VACATION_SCHEDULED")).toBe(true);
    expect(forming.lifecycleStatus).toBe("FORMING");
  });
  it("requires completed schedules to reconcile exactly with the registered enjoyment", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
      allocations: [{
        periodId: period.id,
        periodType: "CAUSED",
        periodStartDate: parseLocalDate(period.startDate),
        periodEndDate: parseLocalDate(period.endDate),
        days: 5,
      }],
    });
    await expect(service.completeSchedule(schedule.id, {
      employmentId: employee.id,
      enjoymentStartDate: "2026-10-01",
      enjoymentEndDate: "2026-10-04",
      enjoyedDays: 4,
      compensatedDays: 0,
      amountCOP: 100,
      accountingDocument: "LIQ-CRON-1",
      allocations: [{ periodId: period.id, enjoyedDays: 4, compensatedDays: 0 }],
    }, 1)).rejects.toThrow("must match the scheduled days");
  });
  it("builds the annual schedule report by year, status and employee without duplicate lookups", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
        allocations: [{
          periodId: period.id,
          periodType: "CAUSED",
          periodStartDate: parseLocalDate(period.startDate),
          periodEndDate: parseLocalDate(period.endDate),
          days: 5,
        }],
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
    expect((await service.annualScheduleReport({ year: 2025, status: "SCHEDULED" })).totalSchedules).toBe(1);
    const pdf = await buildAnnualSchedulePdf(annual);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
    await service.cancelSchedule((await store.listSchedules())[0]!.id, 1);
    expect((await service.annualScheduleReport({ year: 2026, status: "SCHEDULED" })).totalSchedules).toBe(1);
    expect((await service.annualScheduleReport({ year: 2026 })).totalSchedules).toBe(2);
    expect(employees).toHaveLength(2);
  });
  it("paginates summaries without changing the result count or loading unrelated pages", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
    expect(
      filtered.items.every((item) => item.processName === "Administración"),
    ).toBe(true);
  });
  it("orders by pending days and exposes vacation workflow statuses", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
      allocations: [{
        periodId: scheduledPeriod.id,
        periodType: "CAUSED",
        periodStartDate: parseLocalDate(scheduledPeriod.startDate),
        periodEndDate: parseLocalDate(scheduledPeriod.endDate),
        days: 15,
      }],
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
    expect((await service.listPage({ page: 1, pageSize: 10, filters: { vacationStatus: "OVERDUE" }, sortByPendingDays: true })).items).toHaveLength(1);
    expect((await service.listPage({ page: 1, pageSize: 10, filters: { vacationStatus: "PENDING" }, sortByPendingDays: true })).items).toHaveLength(1);
    expect((await service.listPage({ page: 1, pageSize: 10, filters: { vacationStatus: "SCHEDULED" }, sortByPendingDays: true })).items).toHaveLength(1);
  });
  it("calculates dashboard health and process coverage from active balances", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    await service.createEmployment({ documentNumber: "9401", fullName: "Pendiente", startDate: "2025-08-01", contractTypeName: "Indefinido", processName: "Operaciones", positionName: "Analista" });
    await service.createEmployment({ documentNumber: "9402", fullName: "En formación", startDate: "2026-08-10", contractTypeName: "Indefinido", processName: "Administración", positionName: "Analista" });
    await service.createEmployment({ documentNumber: "9403", fullName: "Vencido", startDate: "2024-01-01", contractTypeName: "Indefinido", processName: "Operaciones", positionName: "Analista" });
    const dashboard = await service.dashboard(parseLocalDate("2026-08-18"), { status: "ACTIVE" });
    expect(dashboard.health.total).toBe(3);
    expect(dashboard.health.upToDate).toBe(1);
    expect(dashboard.health.pending).toBe(1);
    expect(dashboard.health.overdue).toBe(1);
    expect(dashboard.health.upToDatePercent + dashboard.health.programmedPercent + dashboard.health.partialPercent + dashboard.health.pendingPercent + dashboard.health.overduePercent).toBe(100);
    expect(dashboard.processBreakdown[0]).toMatchObject({ processName: "Operaciones", activeEmployees: 2, pendingEmployees: 2, overdueEmployees: 1 });
  });
  it("warns holidays and completes schedule settlement in one store operation", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
        allocations: [
          { periodId: period.id, enjoyedDays: 5, compensatedDays: 0 },
        ],
      },
      1,
    );
    expect(result.schedule.status).toBe("COMPLETED");
    expect(store.settlements.size).toBe(1);
    expect(
      store.audits.filter((item) => typeof item === "object" && item !== null)
        .length,
    ).toBe(4);
  });
  it("closes every open period when a contract is retired and removes its pending balance", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
    const employee = await service.createEmployment({
      documentNumber: "9010",
      fullName: "Empleado Retirado",
      startDate: "2020-01-01",
      contractTypeName: "Indefinido",
      processName: "Operaciones",
      positionName: "Analista",
    });
    const retired = await service.retireEmployment(
      employee.id,
      "2025-06-15",
    );
    const periods = await store.findByEmploymentId(employee.id);
    expect(periods.length).toBeGreaterThan(0);
    expect(periods.every((period) => period.lifecycleStatus === "CLOSED")).toBe(
      true,
    );
    expect(
      periods.every(
        (period) =>
          period.closureObservation ===
          "Cierre de vacaciones por terminación de contrato",
      ),
    ).toBe(true);
    expect(retired.status).toBe("RETIRED");
    expect(retired.pendingDays).toBe(0);
    expect(retired.availableForScheduling).toBe(0);
  });
  it("regularizes existing retired contracts with no persisted periods", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
    expect([...store.sessions.values()][0]?.tokenHash).not.toBe(
      tokens?.refreshToken,
    );
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
    const created = await auth.createUser("analyst", "T3st-password!", "VIEWER", "Ana Analista", "Analista de nómina");
    expect(created).toMatchObject({ username: "analyst", displayName: "Ana Analista", jobTitle: "Analista de nómina", active: true });
    await expect(auth.createUser("ANALYST", "T3st-password!", "VIEWER")).rejects.toMatchObject({ status: 409 });
    const updated = await auth.updateUser(created.id, { username: "people", displayName: "Ana López", jobTitle: "Coordinadora", role: "HR" }, "admin");
    expect(updated).toMatchObject({ username: "people", displayName: "Ana López", jobTitle: "Coordinadora", role: "HR" });
    await auth.updateUser(created.id, { active: false }, "admin");
    await expect(auth.login("people", "T3st-password!")).resolves.toBeNull();
    await auth.updateUser(created.id, { active: true }, "admin");
    await expect(auth.login("people", "T3st-password!")).resolves.not.toBeNull();
    await expect(auth.updateUser(admin.id, { active: false }, "system")).rejects.toMatchObject({ status: 422 });
    await expect(auth.updateUser(admin.id, { active: false }, "admin")).rejects.toMatchObject({ status: 422 });
  });
  it("runs accrual scheduler idempotently, persists alerts and generates valid report files", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
  it.skipIf(!existsSync("C:/Users/SISTEMAS/Documents/Empresa/1. Empresa Efagram/AC Procesos/Lesmin Carton/2026/7. Julio/Vaca_Disfrutada.xlsx"))("reads the supplied workbook shape and ignores the separator row", () => {
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
    const service = new VacationService(store, () =>
      parseLocalDate("2026-08-18"),
    );
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
      allocations: [
        { periodId: period.id, enjoyedDays: 5, compensatedDays: 0 },
      ],
    });
    await service.annulSettlement(
      settlement.id,
      "Corrección contable",
      1,
      "admin",
    );
    expect(
      (await store.listSettlements()).some((item) => item.id === settlement.id),
    ).toBe(false);
    expect((await store.findSettlementById(settlement.id))?.status).toBe(
      "ANULADA",
    );
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
