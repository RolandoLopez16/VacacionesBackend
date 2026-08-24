import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { MemoryStore } from "../src/adapters/outbound/memory/memoryRepositories.js";
import { VacationService } from "../src/application/services/vacationService.js";
import { parseLocalDate } from "../src/domain/shared/localDate.js";

it("imports 1,818 new employments in MemoryStore in under five seconds", async () => {
  const store = new MemoryStore();
  const service = new VacationService(store, () => parseLocalDate("2026-08-18"));
  const rows = Array.from({ length: 1_818 }, (_, index) => ({
    documentNumber: String(2_000_000 + index),
    fullName: `Empleado de carga ${index}`,
    startDate: "2026-01-01",
    contractTypeName: "Indefinido",
    processName: "Operaciones",
    positionName: "Analista",
  }));
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const startedAt = performance.now();

  const result = await service.importEmployments("bulk-benchmark-1818", rows, "benchmark");
  const elapsedMs = performance.now() - startedAt;
  log.mockRestore();

  expect(elapsedMs).toBeLessThan(5_000);
  expect(result).toMatchObject({ created: 1_818, updated: 0, invalidRows: 0 });
  expect(result.batch).toMatchObject({
    status: "COMPLETED",
    processedRows: 1_818,
    databaseOperations: 7_274,
    chunks: 17,
  });
  expect(store.workers.size).toBe(1_818);
  expect(store.employments.size).toBe(1_818);
  expect(store.periods.size).toBe(1_818);
}, 10_000);
