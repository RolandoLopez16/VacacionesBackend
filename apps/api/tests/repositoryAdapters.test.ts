import { describe, expect, it, vi } from "vitest";
import type { VacationStore } from "../src/application/ports/repositories.js";
import { MemoryStore } from "../src/adapters/outbound/memory/memoryRepositories.js";
import { MONGO_INDEX_DEFINITIONS } from "../src/adapters/outbound/mongodb/indexes.js";
import { resetVacationDatabase } from "../src/adapters/outbound/mongodb/maintenance.js";
import {
  MONGO_CLIENT_OPTIONS,
  type MongoContext,
  VACATION_COLLECTION_NAMES,
} from "../src/adapters/outbound/mongodb/mongoContext.js";
import {
  EMPLOYMENT_IMPORT_BULK_CHUNK_SIZE,
  EMPLOYMENT_IMPORT_MAX_ATTEMPTS,
  isRetryableMongoTransactionError,
  MongoTransactionRepository,
} from "../src/adapters/outbound/mongodb/transactionRepository.js";
import type {
  ImportBatch,
  VacationPendingPeriodImportBatch,
  VacationPeriod,
  VacationPeriodClosureBatch,
  VacationSchedule,
  VacationSettlement,
  VacationSettlementImportBatch,
} from "../src/domain/vacations/models.js";
import type { Employment, Worker } from "../src/domain/workers/models.js";

type AuditEvent = Parameters<VacationStore["append"]>[0];

const audit: AuditEvent = {
  id: "audit-new",
  actorId: "admin",
  action: "TEST",
  entityType: "TEST",
  entityId: "test",
  metadata: {},
  createdAt: "2026-08-21T00:00:00.000Z",
};
const existingAudit: AuditEvent = { ...audit, id: "audit-existing" };
const schedule: VacationSchedule = {
  id: "schedule-1",
  employmentId: "employment-1",
  startDate: "2026-09-01",
  endDate: "2026-09-05",
  scheduledDays: 5,
  allocations: [
    {
      periodId: "period-1",
      periodType: "CAUSED",
      periodStartDate: "2025-01-01",
      periodEndDate: "2025-12-31",
      days: 5,
    },
  ],
  status: "SCHEDULED",
  version: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const completedSchedule: VacationSchedule = { ...schedule, status: "COMPLETED", version: 2 };
const settlement: VacationSettlement = {
  id: "settlement-1",
  employmentId: "employment-1",
  sourceScheduleId: schedule.id,
  source: "MANUAL",
  status: "ACTIVE",
  enjoymentStartDate: "2026-09-01",
  enjoymentEndDate: "2026-09-05",
  periodEndDate: "2026-09-05",
  enjoyedDays: 5,
  compensatedDays: 0,
  calendarDays: 5,
  amountCOP: 0,
  accountingDocument: "DOC-1",
  allocations: [{ periodId: "period-1", enjoyedDays: 5, compensatedDays: 0 }],
  version: 1,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};
const employment: Employment = {
  id: "employment-1",
  workerId: "worker-1",
  startDate: "2025-01-01",
  contractTypeId: "contract-1",
  contractTypeName: "Indefinido",
  processId: "process-1",
  processName: "Operaciones",
  positionId: "position-1",
  positionName: "Analista",
  status: "ACTIVE",
  version: 1,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};
const retiredEmployment: Employment = {
  ...employment,
  endDate: "2026-08-20",
  status: "RETIRED",
  version: 2,
};
const period: VacationPeriod = {
  id: "period-1",
  employmentId: employment.id,
  sequence: 1,
  accrualStartDate: "2025-01-01",
  accrualEndDate: "2025-12-31",
  causedAt: "2026-01-01",
  entitledDays: 15,
  lifecycleStatus: "CAUSED",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const closedPeriod: VacationPeriod = {
  ...period,
  lifecycleStatus: "CLOSED",
  closureType: "MANUAL",
  version: 2,
};
const settlementImportBatch = {
  id: "settlement-import-1",
  fileName: "settlements.xlsx",
  fileHash: "hash-settlements",
  actorId: "admin",
  status: "APPLIED",
  totalRows: 1,
  totalSettlements: 1,
  newSettlements: 1,
  unchangedSettlements: 0,
  modifiedSettlements: 0,
  conflicts: 0,
  invalidRows: 0,
  migrationPeriods: 0,
  closedByMigration: 1,
  closedEnjoyedPeriods: 0,
  partiallyEnjoyedWarnings: [],
  warnings: [],
  errors: [],
  previewToken: "preview",
  createdAt: "2026-08-21T00:00:00.000Z",
} satisfies VacationSettlementImportBatch;
const closureBatch = {
  id: "closure-1",
  fileName: "closure.xlsx",
  fileHash: "hash-closure",
  actorId: "admin",
  fromDate: "2025-01-01",
  asOf: "2026-08-21",
  observation: "Test",
  status: "APPLIED",
  totalPeriods: 1,
  closedPeriods: 1,
  keptPeriods: 0,
  protectedPeriods: 0,
  futurePeriods: 0,
  reviewPeriods: 0,
  alreadyClosedPeriods: 0,
  warnings: [],
  errors: [],
  plans: [],
  previewToken: "preview",
  createdAt: "2026-08-21T00:00:00.000Z",
} satisfies VacationPeriodClosureBatch;
const pendingImportBatch = {
  id: "pending-import-1",
  fileName: "pending.xlsx",
  fileHash: "hash-pending",
  actorId: "admin",
  asOf: "2026-08-21",
  observation: "Test",
  status: "APPLIED",
  totalRows: 1,
  validRows: 1,
  matchedEmployees: 1,
  missingEmployees: 0,
  createdPeriods: 0,
  keptPeriods: 0,
  releasedPeriods: 1,
  protectedPeriods: 0,
  formingPeriods: 0,
  reviewPeriods: 0,
  alreadyClosedPeriods: 0,
  warnings: [],
  errors: [],
  sourceLines: [],
  plans: [],
  previewToken: "preview",
  createdAt: "2026-08-21T00:00:00.000Z",
} satisfies VacationPendingPeriodImportBatch;

function seededStore() {
  const store = new MemoryStore();
  store.schedules.set(schedule.id, schedule);
  store.settlements.set(settlement.id, { ...settlement, version: 0 });
  store.employments.set(employment.id, employment);
  store.periods.set(period.id, period);
  store.settlementImportBatches.set(settlementImportBatch.id, {
    ...settlementImportBatch,
    status: "PREVIEW",
  });
  store.vacationPeriodClosureBatches.set(closureBatch.id, {
    ...closureBatch,
    status: "PREVIEW",
  });
  store.vacationPendingPeriodImportBatches.set(pendingImportBatch.id, {
    ...pendingImportBatch,
    status: "PREVIEW",
  });
  store.audits.push(existingAudit);
  return store;
}

function snapshot(store: MemoryStore) {
  return {
    workers: [...store.workers],
    employments: [...store.employments],
    periods: [...store.periods],
    schedules: [...store.schedules],
    settlements: [...store.settlements],
    importBatches: [...store.importBatches],
    settlementImportBatches: [...store.settlementImportBatches],
    vacationPeriodClosureBatches: [...store.vacationPeriodClosureBatches],
    vacationPendingPeriodImportBatches: [...store.vacationPendingPeriodImportBatches],
    sessions: [...store.sessions],
    catalogs: [...store.catalogs],
    systemSettings: [...store.systemSettings],
    holidays: [...store.holidays],
    alerts: [...store.alerts],
    schedulerRuns: [...store.schedulerRuns],
    users: [...store.users],
    audits: [...store.audits],
    policy: store.policy,
  };
}

const transactions: {
  name: string;
  run: (store: MemoryStore) => Promise<void>;
}[] = [
  {
    name: "saveScheduleAndAudit",
    run: (store) => store.saveScheduleAndAudit(completedSchedule, audit),
  },
  {
    name: "completeScheduleTransaction",
    run: (store) => store.completeScheduleTransaction(completedSchedule, settlement, [audit]),
  },
  {
    name: "closeRetiredEmploymentTransaction",
    run: (store) =>
      store.closeRetiredEmploymentTransaction(retiredEmployment, [closedPeriod], [audit]),
  },
  {
    name: "closeRetiredEmploymentsTransaction",
    run: (store) =>
      store.closeRetiredEmploymentsTransaction([retiredEmployment], [closedPeriod], [audit]),
  },
  {
    name: "applyVacationSettlementImport",
    run: (store) =>
      store.applyVacationSettlementImport(
        settlementImportBatch,
        [{ ...settlement, version: 2 }],
        [closedPeriod],
        [audit],
        [completedSchedule],
      ),
  },
  {
    name: "applyVacationPeriodClosure",
    run: (store) => store.applyVacationPeriodClosure(closureBatch, [closedPeriod], [audit]),
  },
  {
    name: "applyVacationPendingPeriodImport",
    run: (store) =>
      store.applyVacationPendingPeriodImport(pendingImportBatch, [closedPeriod], [audit]),
  },
  {
    name: "saveSettlementAndAudit",
    run: (store) => store.saveSettlementAndAudit({ ...settlement, version: 2 }, audit),
  },
];

describe("MemoryStore transaction atomicity", () => {
  it.each(transactions)("rolls back $name after a partial write", async ({ run }) => {
    const store = seededStore();
    const mapReferences = {
      employments: store.employments,
      periods: store.periods,
      schedules: store.schedules,
      settlements: store.settlements,
    };
    const before = snapshot(store);
    const failure = new Error("forced audit failure");
    const push = vi.spyOn(store.audits, "push").mockImplementation(() => {
      throw failure;
    });

    await expect(run(store)).rejects.toBe(failure);
    push.mockRestore();

    expect(snapshot(store)).toEqual(before);
    expect(store.employments).toBe(mapReferences.employments);
    expect(store.periods).toBe(mapReferences.periods);
    expect(store.schedules).toBe(mapReferences.schedules);
    expect(store.settlements).toBe(mapReferences.settlements);
  });
});

describe("MongoStore infrastructure", () => {
  it("uses bounded client defaults suitable for the API", () => {
    expect(MONGO_CLIENT_OPTIONS).toMatchObject({
      maxPoolSize: 20,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 10_000,
      retryWrites: true,
    });
  });

  it("resets every declared collection and recreates all indexes", async () => {
    const deleted: string[] = [];
    const indexed: string[] = [];
    const context = {
      collection: (name: string) => ({
        deleteMany: async () => {
          deleted.push(name);
        },
        createIndex: async () => {
          indexed.push(name);
          return `${name}-index`;
        },
      }),
    } as unknown as MongoContext;

    await resetVacationDatabase(context);

    expect(new Set(deleted)).toEqual(new Set(VACATION_COLLECTION_NAMES));
    expect(deleted).toContain("vacationPeriodClosureBatches");
    expect(deleted).toContain("systemSettings");
    expect(indexed).toHaveLength(MONGO_INDEX_DEFINITIONS.length);
    expect(indexed.filter((name) => name === "vacationPeriodClosureBatches")).toHaveLength(2);
    expect(MONGO_INDEX_DEFINITIONS.every(({ collection }) => deleted.includes(collection))).toBe(
      true,
    );
  });

  it("validates pending-import period versions again inside the Mongo transaction", async () => {
    const bulkWrite = vi.fn();
    const session = {
      withTransaction: vi.fn(async (operation: () => Promise<unknown>) => operation()),
    };
    const context = {
      client: {
        withSession: vi.fn(async (operation: (value: typeof session) => Promise<unknown>) =>
          operation(session),
        ),
      },
      collection: (name: string) => {
        if (name === "vacationPeriods")
          return {
            find: vi.fn(() => ({
              toArray: async () => [{ id: period.id, version: period.version + 1 }],
            })),
            bulkWrite,
          };
        return { replaceOne: vi.fn(), insertMany: vi.fn() };
      },
    } as unknown as MongoContext;
    const repository = new MongoTransactionRepository(context);
    const staleBatch: VacationPendingPeriodImportBatch = {
      ...pendingImportBatch,
      plans: [
        {
          periodId: period.id,
          employmentId: employment.id,
          documentNumber: "123",
          employeeName: "Empleado",
          periodStartDate: period.accrualStartDate,
          periodEndDate: period.accrualEndDate,
          causedAt: period.causedAt,
          lifecycleStatus: period.lifecycleStatus,
          periodVersion: period.version,
          sourceLineNumber: 2,
          sourcePendingPeriods: 0,
          sourcePendingDays: 0,
          daysToKeep: 0,
          created: false,
          decision: "RELEASED",
          reason: "Prueba de versión",
        },
      ],
    };

    await expect(
      repository.applyVacationPendingPeriodImport(staleBatch, [closedPeriod], [audit]),
    ).rejects.toThrow("Los períodos cambiaron desde la vista previa");
    expect(bulkWrite).not.toHaveBeenCalled();
  });

  it("uses unordered bulkWrite chunks in one majority transaction for employment imports", async () => {
    const calls: {
      collection: string;
      operations: unknown[];
      options: { ordered?: boolean; session?: unknown };
    }[] = [];
    const session = {
      withTransaction: vi.fn(async (operation: () => Promise<unknown>) => operation()),
    };
    const context = {
      client: {
        withSession: vi.fn(async (operation: (value: typeof session) => Promise<unknown>) =>
          operation(session),
        ),
      },
      collection: (collection: string) => ({
        bulkWrite: async (
          operations: unknown[],
          options: { ordered?: boolean; session?: unknown },
        ) => {
          calls.push({ collection, operations, options });
          return { matchedCount: collection === "importBatches" ? 1 : operations.length };
        },
        findOne: async () => null,
      }),
    } as unknown as MongoContext;
    const repository = new MongoTransactionRepository(context);
    const workers: Worker[] = Array.from({ length: 501 }, (_, index) => ({
      id: `worker-${index}`,
      documentNumber: String(100000 + index),
      normalizedDocumentNumber: String(100000 + index),
      fullName: `Worker ${index}`,
      workerType: "EMPLOYEE",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    }));
    const batch: ImportBatch = {
      id: "employment-import-1",
      idempotencyKey: "employment-import-key-1",
      payloadHash: "payload-hash",
      entityType: "EMPLOYMENT",
      status: "COMPLETED",
      attempt: 1,
      totalRows: 501,
      createdRows: 501,
      updatedRows: 0,
      invalidRows: 0,
      processedRows: 501,
      databaseOperations: 503,
      chunks: 4,
      errorSummary: [],
      createdAt: "2026-08-21T00:00:00.000Z",
      completedAt: "2026-08-21T00:00:01.000Z",
    };

    await repository.applyEmploymentImport(batch, workers, [], [], [audit], Date.now());

    const workerCalls = calls.filter((call) => call.collection === "workers");
    expect(workerCalls.map((call) => call.operations.length)).toEqual([500, 1]);
    expect(calls.every((call) => call.operations.length <= 500)).toBe(true);
    expect(calls.every((call) => call.options.ordered === false)).toBe(true);
    expect(calls.every((call) => call.options.session === session)).toBe(true);
    expect(session.withTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority", j: true },
        readPreference: "primary",
      }),
    );
    expect(EMPLOYMENT_IMPORT_BULK_CHUNK_SIZE).toBe(500);
  });

  it("bounds retries to three transient attempts and excludes unexpected duplicate keys", async () => {
    const session = {
      withTransaction: vi.fn(async (operation: () => Promise<unknown>) => operation()),
    };
    const transientError = Object.assign(new Error("write conflict"), { code: 112 });
    let attempts = 0;
    const context = {
      client: {
        withSession: vi.fn(async (operation: (value: typeof session) => Promise<unknown>) => {
          attempts++;
          if (attempts < EMPLOYMENT_IMPORT_MAX_ATTEMPTS) throw transientError;
          return operation(session);
        }),
      },
      collection: (collection: string) => ({
        bulkWrite: async (operations: unknown[]) => ({
          matchedCount: collection === "importBatches" ? 1 : operations.length,
        }),
        findOne: async () => null,
      }),
    } as unknown as MongoContext;
    const repository = new MongoTransactionRepository(context);
    const batch: ImportBatch = {
      id: "employment-import-retry",
      idempotencyKey: "employment-import-retry-key",
      entityType: "EMPLOYMENT",
      status: "COMPLETED",
      attempt: 1,
      totalRows: 0,
      createdRows: 0,
      updatedRows: 0,
      invalidRows: 0,
      errorSummary: [],
      createdAt: "2026-08-21T00:00:00.000Z",
      completedAt: "2026-08-21T00:00:01.000Z",
    };

    await repository.applyEmploymentImport(batch, [], [], [], [audit], Date.now());

    expect(attempts).toBe(3);
    expect(EMPLOYMENT_IMPORT_MAX_ATTEMPTS).toBe(3);
    expect(isRetryableMongoTransactionError(transientError)).toBe(true);
    expect(isRetryableMongoTransactionError({ code: 11000 })).toBe(false);
    expect(
      isRetryableMongoTransactionError({
        hasErrorLabel: (label: string) => label === "TransientTransactionError",
      }),
    ).toBe(true);
    expect(isRetryableMongoTransactionError(new Error("validation"))).toBe(false);
  });
});
