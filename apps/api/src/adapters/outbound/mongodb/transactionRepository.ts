import type { AnyBulkWriteOperation, ClientSession, Collection, TransactionOptions } from "mongodb";
import type { TransactionRepository } from "../../../application/ports/repositories.js";
import { ConflictError } from "../../../domain/shared/errors.js";
import type { Employment, Worker } from "../../../domain/workers/models.js";
import type {
  ImportBatch,
  VacationPendingPeriodImportBatch,
  VacationPeriod,
  VacationPeriodClosureBatch,
  VacationSchedule,
  VacationSettlement,
  VacationSettlementImportBatch,
} from "../../../domain/vacations/models.js";
import { type MongoContext, strip, type Stored } from "./mongoContext.js";

export const EMPLOYMENT_IMPORT_BULK_CHUNK_SIZE = 500;
export const EMPLOYMENT_IMPORT_MAX_ATTEMPTS = 3;

const EMPLOYMENT_IMPORT_TRANSACTION_OPTIONS = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority", j: true },
  readPreference: "primary",
} satisfies TransactionOptions;

function errorCode(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined;
}

function hasErrorLabel(error: unknown, label: string): boolean {
  return Boolean(
    typeof error === "object" &&
    error !== null &&
    "hasErrorLabel" in error &&
    typeof error.hasErrorLabel === "function" &&
    error.hasErrorLabel(label),
  );
}

export function isRetryableMongoTransactionError(error: unknown): boolean {
  if (errorCode(error) === 11000) return false;
  if (
    hasErrorLabel(error, "TransientTransactionError") ||
    hasErrorLabel(error, "UnknownTransactionCommitResult")
  )
    return true;
  if ([6, 7, 89, 91, 112, 189, 262].includes(errorCode(error) ?? -1)) return true;
  const name = error instanceof Error ? error.name : "";
  return name.startsWith("MongoNetwork") || name === "MongoServerSelectionError";
}

function operationChunks<T>(operations: T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < operations.length; index += EMPLOYMENT_IMPORT_BULK_CHUNK_SIZE)
    chunks.push(operations.slice(index, index + EMPLOYMENT_IMPORT_BULK_CHUNK_SIZE));
  return chunks;
}

async function bulkWriteInChunks<T>(
  collection: Collection<Stored<T>>,
  operations: AnyBulkWriteOperation<Stored<T>>[],
  session: ClientSession,
): Promise<void> {
  for (const chunk of operationChunks(operations))
    await collection.bulkWrite(chunk, { ordered: false, session });
}

const retryBackoff = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, 25 * 2 ** (attempt - 1)));

export class MongoTransactionRepository implements TransactionRepository {
  constructor(private readonly context: MongoContext) {}

  async applyEmploymentImport(
    ...[batch, workers, employments, periods, audits, startedAtMs]: Parameters<
      TransactionRepository["applyEmploymentImport"]
    >
  ) {
    const batchAttempt = batch.attempt ?? 0;
    for (let persistenceAttempt = 1; ; persistenceAttempt++) {
      try {
        return await this.context.client.withSession(async (session) => {
          const completed = await session.withTransaction(async () => {
            await bulkWriteInChunks<Worker>(
              this.context.collection<Worker>("workers"),
              workers.map((worker) => ({
                replaceOne: {
                  filter: { id: worker.id },
                  replacement: worker,
                  upsert: true,
                },
              })),
              session,
            );
            await bulkWriteInChunks<Employment>(
              this.context.collection<Employment>("employments"),
              employments.map((employment) => ({
                replaceOne: {
                  filter: { id: employment.id },
                  replacement: employment,
                  upsert: true,
                },
              })),
              session,
            );
            await bulkWriteInChunks<VacationPeriod>(
              this.context.collection<VacationPeriod>("vacationPeriods"),
              periods.map((period) => ({
                replaceOne: {
                  filter: { id: period.id },
                  replacement: period,
                  upsert: true,
                },
              })),
              session,
            );
            await bulkWriteInChunks<(typeof audits)[number]>(
              this.context.collection<(typeof audits)[number]>("auditEvents"),
              audits.map((audit) => ({ insertOne: { document: audit } })),
              session,
            );
            const completedBatch: ImportBatch = {
              ...batch,
              persistenceAttempts: persistenceAttempt,
              durationMs: Math.max(0, Date.now() - startedAtMs),
            };
            const batchResult = await this.context
              .collection<ImportBatch>("importBatches")
              .bulkWrite(
                [
                  {
                    replaceOne: {
                      filter: {
                        idempotencyKey: batch.idempotencyKey,
                        status: "PROCESSING",
                        attempt: batchAttempt,
                      },
                      replacement: completedBatch,
                    },
                  },
                ],
                { ordered: false, session },
              );
            if (batchResult.matchedCount !== 1)
              throw new ConflictError("The import batch attempt was superseded");
            return completedBatch;
          }, EMPLOYMENT_IMPORT_TRANSACTION_OPTIONS);
          if (!completed) throw new Error("Employment import transaction returned no result");
          return completed;
        });
      } catch (error) {
        if (hasErrorLabel(error, "UnknownTransactionCommitResult")) {
          try {
            const committed = await this.context.collection<ImportBatch>("importBatches").findOne({
              idempotencyKey: batch.idempotencyKey,
              status: batch.status,
              attempt: batchAttempt,
            });
            if (committed) return strip(committed);
          } catch {
            // The bounded transaction retry below also covers a failed status check.
          }
        }
        if (
          persistenceAttempt >= EMPLOYMENT_IMPORT_MAX_ATTEMPTS ||
          !isRetryableMongoTransactionError(error)
        )
          throw error;
        await retryBackoff(persistenceAttempt);
      }
    }
  }

  async saveScheduleAndAudit(
    ...[schedule, audit]: Parameters<TransactionRepository["saveScheduleAndAudit"]>
  ) {
    await this.context.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.context
          .collection<VacationSchedule>("vacationSchedules")
          .replaceOne({ id: schedule.id }, schedule, { upsert: true, session });
        await this.context.collection<typeof audit>("auditEvents").insertOne(audit, { session });
      });
    });
  }

  async completeScheduleTransaction(
    ...[schedule, settlement, audits]: Parameters<
      TransactionRepository["completeScheduleTransaction"]
    >
  ) {
    await this.context.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.context
          .collection<VacationSettlement>("vacationSettlements")
          .replaceOne({ id: settlement.id }, settlement, { upsert: true, session });
        await this.context
          .collection<VacationSchedule>("vacationSchedules")
          .replaceOne({ id: schedule.id }, schedule, { upsert: true, session });
        for (const audit of audits)
          await this.context.collection<typeof audit>("auditEvents").insertOne(audit, { session });
      });
    });
  }

  async closeRetiredEmploymentTransaction(
    ...[employment, periods, audits]: Parameters<
      TransactionRepository["closeRetiredEmploymentTransaction"]
    >
  ) {
    await this.context.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.context
          .collection<Employment>("employments")
          .replaceOne({ id: employment.id }, employment, { upsert: true, session });
        if (periods.length)
          await this.context.collection<VacationPeriod>("vacationPeriods").bulkWrite(
            periods.map((period) => ({
              replaceOne: {
                filter: { id: period.id },
                replacement: period,
                upsert: true,
              },
            })),
            { session },
          );
        if (audits.length)
          await this.context
            .collection<(typeof audits)[number]>("auditEvents")
            .insertMany(audits, { session });
      });
    });
  }

  async closeRetiredEmploymentsTransaction(
    ...[employments, periods, audits]: Parameters<
      TransactionRepository["closeRetiredEmploymentsTransaction"]
    >
  ) {
    await this.context.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        if (employments.length)
          await this.context.collection<Employment>("employments").bulkWrite(
            employments.map((employment) => ({
              replaceOne: {
                filter: { id: employment.id },
                replacement: employment,
                upsert: true,
              },
            })),
            { session },
          );
        if (periods.length)
          await this.context.collection<VacationPeriod>("vacationPeriods").bulkWrite(
            periods.map((period) => ({
              replaceOne: {
                filter: { id: period.id },
                replacement: period,
                upsert: true,
              },
            })),
            { session },
          );
        if (audits.length)
          await this.context
            .collection<(typeof audits)[number]>("auditEvents")
            .insertMany(audits, { session });
      });
    });
  }

  async applyVacationSettlementImport(
    ...[batch, settlements, periods, audits, schedules = []]: Parameters<
      TransactionRepository["applyVacationSettlementImport"]
    >
  ) {
    await this.context.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        if (settlements.length)
          await this.context.collection<VacationSettlement>("vacationSettlements").bulkWrite(
            settlements.map((settlement) => ({
              replaceOne: {
                filter: { id: settlement.id },
                replacement: settlement,
                upsert: true,
              },
            })),
            { session },
          );
        if (periods.length)
          await this.context.collection<VacationPeriod>("vacationPeriods").bulkWrite(
            periods.map((period) => ({
              replaceOne: {
                filter: { id: period.id },
                replacement: period,
                upsert: true,
              },
            })),
            { session },
          );
        if (schedules.length)
          await this.context.collection<VacationSchedule>("vacationSchedules").bulkWrite(
            schedules.map((schedule) => ({
              replaceOne: {
                filter: { id: schedule.id },
                replacement: schedule,
                upsert: true,
              },
            })),
            { session },
          );
        await this.context
          .collection<VacationSettlementImportBatch>("vacationSettlementImportBatches")
          .replaceOne({ id: batch.id }, batch, { upsert: true, session });
        for (const audit of audits)
          await this.context.collection<typeof audit>("auditEvents").insertOne(audit, { session });
      });
    });
  }

  async applyVacationPeriodClosure(
    ...[batch, periods, audits]: Parameters<TransactionRepository["applyVacationPeriodClosure"]>
  ) {
    await this.context.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        if (periods.length)
          await this.context.collection<VacationPeriod>("vacationPeriods").bulkWrite(
            periods.map((period) => ({
              replaceOne: {
                filter: { id: period.id },
                replacement: period,
                upsert: true,
              },
            })),
            { session },
          );
        await this.context
          .collection<VacationPeriodClosureBatch>("vacationPeriodClosureBatches")
          .replaceOne({ id: batch.id }, batch, { upsert: true, session });
        if (audits.length)
          await this.context
            .collection<(typeof audits)[number]>("auditEvents")
            .insertMany(audits, { session });
      });
    });
  }

  async applyVacationPendingPeriodImport(
    ...[batch, periods, audits]: Parameters<
      TransactionRepository["applyVacationPendingPeriodImport"]
    >
  ) {
    await this.context.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        const periodIds = batch.plans.map((plan) => plan.periodId);
        const currentPeriods = periodIds.length
          ? await this.context
              .collection<Pick<VacationPeriod, "id" | "version">>("vacationPeriods")
              .find(
                { id: { $in: periodIds } },
                { session, projection: { _id: 0, id: 1, version: 1 } },
              )
              .toArray()
          : [];
        const currentById = new Map(currentPeriods.map((period) => [period.id, period]));
        for (const plan of batch.plans) {
          const current = currentById.get(plan.periodId);
          if (
            (plan.created && current) ||
            (!plan.created && (!current || current.version !== plan.periodVersion))
          )
            throw new ConflictError(
              "Los períodos cambiaron desde la vista previa; genera una nueva vista previa",
            );
        }
        if (periods.length)
          await this.context.collection<VacationPeriod>("vacationPeriods").bulkWrite(
            periods.map((period) => ({
              replaceOne: {
                filter: { id: period.id },
                replacement: period,
                upsert: true,
              },
            })),
            { session },
          );
        await this.context
          .collection<VacationPendingPeriodImportBatch>("vacationPendingPeriodImportBatches")
          .replaceOne({ id: batch.id }, batch, { upsert: true, session });
        if (audits.length)
          await this.context
            .collection<(typeof audits)[number]>("auditEvents")
            .insertMany(audits, { session });
      });
    });
  }

  async saveSettlementAndAudit(
    ...[settlement, audit]: Parameters<TransactionRepository["saveSettlementAndAudit"]>
  ) {
    await this.context.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.context
          .collection<VacationSettlement>("vacationSettlements")
          .replaceOne({ id: settlement.id }, settlement, { upsert: true, session });
        await this.context.collection<typeof audit>("auditEvents").insertOne(audit, { session });
      });
    });
  }
}
