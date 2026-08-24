import type { CreateIndexesOptions, IndexSpecification } from "mongodb";
import type { MongoContext, VacationCollectionName } from "./mongoContext.js";

interface MongoIndexDefinition {
  collection: VacationCollectionName;
  key: IndexSpecification;
  options?: CreateIndexesOptions;
}

export const MONGO_INDEX_DEFINITIONS = [
  {
    collection: "workers",
    key: { normalizedDocumentNumber: 1 },
    options: { unique: true },
  },
  { collection: "workers", key: { fullName: 1 } },
  {
    collection: "employments",
    key: { workerId: 1, startDate: 1 },
    options: { unique: true },
  },
  { collection: "employments", key: { status: 1, processName: 1, startDate: 1 } },
  {
    collection: "vacationPeriods",
    key: { employmentId: 1, sequence: 1 },
    options: { unique: true },
  },
  { collection: "vacationSchedules", key: { employmentId: 1, startDate: 1 } },
  { collection: "vacationSchedules", key: { status: 1, startDate: 1, employmentId: 1 } },
  { collection: "vacationSchedules", key: { status: 1, endDate: 1, startDate: 1 } },
  {
    collection: "vacationSettlements",
    key: { employmentId: 1, accountingDocument: 1, status: 1 },
  },
  { collection: "vacationSettlements", key: { periodEndDate: -1, status: 1 } },
  { collection: "vacationSettlements", key: { sourceBatchId: 1 } },
  {
    collection: "importBatches",
    key: { idempotencyKey: 1 },
    options: { unique: true },
  },
  {
    collection: "vacationSettlementImportBatches",
    key: { id: 1 },
    options: { unique: true },
  },
  { collection: "vacationSettlementImportBatches", key: { fileHash: 1 } },
  {
    collection: "vacationPeriodClosureBatches",
    key: { id: 1 },
    options: { unique: true },
  },
  { collection: "vacationPeriodClosureBatches", key: { fileHash: 1 } },
  {
    collection: "vacationPendingPeriodImportBatches",
    key: { id: 1 },
    options: { unique: true },
  },
  { collection: "vacationPendingPeriodImportBatches", key: { fileHash: 1 } },
  { collection: "sessions", key: { id: 1 }, options: { unique: true } },
  { collection: "sessions", key: { expiresAt: 1 } },
  {
    collection: "catalogItems",
    key: { type: 1, name: 1 },
    options: { unique: true },
  },
  { collection: "systemSettings", key: { key: 1 }, options: { unique: true } },
  { collection: "holidays", key: { date: 1 }, options: { unique: true } },
  { collection: "holidays", key: { active: 1, date: 1 } },
  {
    collection: "vacationAlerts",
    key: { employmentId: 1, type: 1, asOf: 1 },
    options: { unique: true },
  },
  { collection: "vacationAlerts", key: { asOf: -1 } },
  { collection: "vacationAlerts", key: { active: 1, severity: 1, asOf: -1 } },
  {
    collection: "schedulerRuns",
    key: { jobName: 1, asOf: 1 },
    options: { unique: true },
  },
  { collection: "schedulerRuns", key: { asOf: -1 } },
  { collection: "schedulerRuns", key: { status: 1, asOf: -1 } },
  { collection: "users", key: { username: 1 }, options: { unique: true } },
  { collection: "users", key: { active: 1, username: 1 } },
  { collection: "users", key: { role: 1, username: 1 } },
  { collection: "auditEvents", key: { createdAt: -1 } },
  { collection: "auditEvents", key: { actorId: 1, createdAt: -1 } },
  { collection: "auditEvents", key: { entityType: 1, entityId: 1, createdAt: -1 } },
  { collection: "auditEvents", key: { action: 1, createdAt: -1 } },
  { collection: "importBatches", key: { status: 1, createdAt: -1 } },
  { collection: "importBatches", key: { createdAt: -1 } },
] satisfies readonly MongoIndexDefinition[];

export async function ensureMongoIndexes(context: MongoContext) {
  await Promise.all(
    MONGO_INDEX_DEFINITIONS.map((definition) => {
      const collection = context.collection<unknown>(definition.collection);
      return "options" in definition
        ? collection.createIndex(definition.key, definition.options)
        : collection.createIndex(definition.key);
    }),
  );
}
