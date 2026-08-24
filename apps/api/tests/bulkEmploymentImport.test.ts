import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/adapters/outbound/memory/memoryRepositories.js";
import { VacationService } from "../src/application/services/vacationService.js";
import { parseLocalDate } from "../src/domain/shared/localDate.js";

const row = (
  documentNumber: string,
  startDate: string,
  overrides: Record<string, unknown> = {},
) => ({
  documentNumber,
  fullName: `Empleado ${documentNumber}`,
  startDate,
  contractTypeName: "Indefinido",
  processName: "Operaciones",
  positionName: "Analista",
  ...overrides,
});

describe("bulk employment import", () => {
  it("preloads once, applies the last duplicate row and preserves sequential counts", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const preloadSpies = [
      vi.spyOn(store, "findWorkersByNormalizedDocuments"),
      vi.spyOn(store, "findEmploymentsByWorkerIds"),
      vi.spyOn(store, "current"),
      vi.spyOn(store, "findByEmploymentIds"),
      vi.spyOn(store, "findSettlementsByEmploymentIds"),
      vi.spyOn(store, "findSchedulesByEmploymentIds"),
    ];
    const individualSpies = [
      vi.spyOn(store, "listWorkers"),
      vi.spyOn(store, "findWorkerByNormalizedDocument"),
      vi.spyOn(store, "findEmploymentByWorkerAndStartDate"),
      vi.spyOn(store, "findByEmploymentId"),
    ];
    const rows = [
      row("1.234.567", "2025-01-01", {
        fullName: "Nombre inicial",
        positionName: "Auxiliar",
      }),
      row("1234567", "2025-01-01", {
        fullName: "Nombre intermedio",
        positionName: "Coordinador",
      }),
      row("1234567", "2026-01-01", { fullName: "Nombre final" }),
    ];

    const imported = await service.importEmployments("bulk-duplicate-001", rows, "admin");

    expect(imported).toMatchObject({ replayed: false, created: 2, updated: 1, invalidRows: 0 });
    expect(imported.batch).toMatchObject({
      status: "COMPLETED",
      duplicateRows: 1,
      processedRows: 3,
    });
    expect(store.workers.size).toBe(1);
    expect(store.employments.size).toBe(2);
    expect([...store.workers.values()][0]?.fullName).toBe("Nombre final");
    expect(
      [...store.employments.values()].find((employment) => employment.startDate === "2025-01-01"),
    ).toMatchObject({
      positionName: "Coordinador",
      version: 3,
      status: "RETIRED",
      endDate: "2025-12-31",
    });
    expect(
      [...store.employments.values()].find((employment) => employment.startDate === "2026-01-01"),
    ).toMatchObject({ positionName: "Analista", version: 1, status: "ACTIVE" });
    preloadSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    individualSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    expect(
      store.audits.filter(
        (audit) =>
          typeof audit === "object" &&
          audit !== null &&
          "entityType" in audit &&
          audit.entityType === "Employment",
      ),
    ).toHaveLength(3);
    expect(
      store.audits.some(
        (audit) =>
          typeof audit === "object" &&
          audit !== null &&
          "action" in audit &&
          audit.action === "EMPLOYMENT_RETIRED_BY_IMPORT",
      ),
    ).toBe(true);
    expect(
      store.audits.some(
        (audit) =>
          typeof audit === "object" &&
          audit !== null &&
          "action" in audit &&
          audit.action === "EMPLOYMENT_IMPORT_COMPLETED",
      ),
    ).toBe(true);

    const replayed = await service.importEmployments("bulk-duplicate-001", rows, "admin");
    expect(replayed.replayed).toBe(true);
    expect(store.workers.size).toBe(1);
    expect(store.employments.size).toBe(2);
    preloadSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    await expect(
      service.importEmployments(
        "bulk-duplicate-001",
        [...rows, row("999999", "2026-01-01")],
        "admin",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("returns row errors without applying invalid rows", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const result = await service.importEmployments(
      "bulk-invalid-001",
      [row("800001", "2026-01-01"), row("x", "invalid-date")],
      "admin",
    );

    expect(result).toMatchObject({ created: 1, updated: 0, invalidRows: 1 });
    expect(result.batch.status).toBe("COMPLETED_WITH_ERRORS");
    expect(result.errors[0]).toMatchObject({ row: 2 });
    expect(store.workers.size).toBe(1);
    expect(store.employments.size).toBe(1);
  });

  it("preserves periods, settlements, schedules and their derived balance on updates", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const employee = await service.createEmployment({
      ...row("805001", "2024-01-01"),
      startDate: parseLocalDate("2024-01-01"),
    });
    const period = (await service.detail(employee.id)).periods.find(
      (item) => item.lifecycleStatus === "CAUSED",
    )!;
    await service.createSettlement({
      employmentId: employee.id,
      enjoymentStartDate: "2026-02-01",
      enjoymentEndDate: "2026-02-05",
      enjoyedDays: 5,
      compensatedDays: 0,
      amountCOP: 100,
      accountingDocument: "BALANCE-IMPORT-1",
      allocations: [{ periodId: period.id, enjoyedDays: 5, compensatedDays: 0 }],
    });
    await service.createSchedule({
      employmentId: employee.id,
      startDate: "2026-10-01",
      endDate: "2026-10-03",
      scheduledDays: 3,
      allocations: [
        {
          periodId: period.id,
          periodType: "CAUSED",
          periodStartDate: parseLocalDate(period.startDate),
          periodEndDate: parseLocalDate(period.endDate),
          days: 3,
        },
      ],
    });
    const before = await service.detail(employee.id);
    const settlementsBefore = structuredClone([...store.settlements.values()]);
    const schedulesBefore = structuredClone([...store.schedules.values()]);

    await service.importEmployments(
      "bulk-balance-001",
      [row("805001", "2024-01-01", { processName: "Administración" })],
      "admin",
    );

    const after = await service.detail(employee.id);
    expect(after).toMatchObject({
      pendingDays: before.pendingDays,
      scheduledDays: before.scheduledDays,
      availableForScheduling: before.availableForScheduling,
      processName: "Administración",
    });
    expect([...store.settlements.values()]).toEqual(settlementsBefore);
    expect([...store.schedules.values()]).toEqual(schedulesBefore);
    expect(after.periods.map((item) => item.id)).toEqual(before.periods.map((item) => item.id));
  });

  it("rolls back partial writes, marks FAILED and retries the same rows atomically", async () => {
    const store = new MemoryStore();
    const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
    const rows = [row("810001", "2025-01-01")];
    const failureLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const auditFailure = vi.spyOn(store.audits, "push").mockImplementation(() => {
      throw new Error("forced bulk audit failure");
    });

    await expect(
      service.importEmployments("bulk-failure-001", rows, "admin"),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    auditFailure.mockRestore();

    expect(store.workers.size).toBe(0);
    expect(store.employments.size).toBe(0);
    expect(store.periods.size).toBe(0);
    expect(store.audits).toHaveLength(0);
    const failed = await store.findImportBatchByIdempotencyKey("bulk-failure-001");
    expect(failed).toMatchObject({ status: "FAILED", attempt: 1 });
    expect(failed?.errorSummary.some((error) => error.row === 0)).toBe(true);

    const retried = await service.retryEmploymentImport(failed!.id, rows, "admin");
    failureLog.mockRestore();
    expect(retried).toMatchObject({ replayed: false, created: 1, invalidRows: 0 });
    expect(retried.batch).toMatchObject({ status: "COMPLETED", attempt: 2 });
    expect(store.workers.size).toBe(1);
    expect(store.employments.size).toBe(1);
  });
});
