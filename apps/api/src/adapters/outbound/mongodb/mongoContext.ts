import { type Collection, type Db, MongoClient, type MongoClientOptions } from "mongodb";

export const MONGO_CLIENT_OPTIONS = {
  appName: "vaca-efa-api",
  maxPoolSize: 20,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  retryWrites: true,
} satisfies MongoClientOptions;

export const VACATION_COLLECTION_NAMES = [
  "workers",
  "employments",
  "vacationPeriods",
  "vacationSchedules",
  "vacationSettlements",
  "vacationPolicies",
  "auditEvents",
  "importBatches",
  "vacationSettlementImportBatches",
  "vacationPeriodClosureBatches",
  "vacationPendingPeriodImportBatches",
  "sessions",
  "catalogItems",
  "systemSettings",
  "holidays",
  "vacationAlerts",
  "schedulerRuns",
  "users",
] as const;

export type VacationCollectionName = (typeof VACATION_COLLECTION_NAMES)[number];
export type Stored<T> = T & { _id?: unknown };

export function strip<T>(document: Stored<T>): T {
  const { _id: _, ...value } = document;
  return value as T;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class MongoContext {
  constructor(
    readonly client: MongoClient,
    readonly db: Db,
  ) {}

  collection<T>(name: VacationCollectionName): Collection<Stored<T>> {
    return this.db.collection<Stored<T>>(name);
  }
}
