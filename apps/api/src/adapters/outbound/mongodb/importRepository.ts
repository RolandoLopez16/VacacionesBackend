import type {
  ImportBatchPageQuery,
  ImportBatchRepository,
  PagedImportBatches,
  VacationPendingPeriodImportRepository,
  VacationPeriodClosureRepository,
  VacationSettlementImportRepository,
} from "../../../application/ports/repositories.js";
import type {
  ImportBatch,
  VacationPendingPeriodImportBatch,
  VacationPeriodClosureBatch,
  VacationSettlementImportBatch,
} from "../../../domain/vacations/models.js";
import { type MongoContext, strip } from "./mongoContext.js";

export class MongoImportRepository
  implements
    ImportBatchRepository,
    VacationSettlementImportRepository,
    VacationPeriodClosureRepository,
    VacationPendingPeriodImportRepository
{
  constructor(private readonly context: MongoContext) {}

  async findImportBatchByIdempotencyKey(key: string) {
    const document = await this.context
      .collection<ImportBatch>("importBatches")
      .findOne({ idempotencyKey: key });
    return document ? strip(document) : null;
  }

  async findImportBatchById(id: string) {
    const document = await this.context.collection<ImportBatch>("importBatches").findOne({ id });
    return document ? strip(document) : null;
  }

  async claimImportBatch(
    batch: ImportBatch,
    expected?: { status: ImportBatch["status"]; attempt: number },
  ) {
    const collection = this.context.collection<ImportBatch>("importBatches");
    const writeConcern = { w: "majority" as const };
    if (!expected) {
      try {
        await collection.insertOne(batch, { writeConcern });
        return true;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === 11000)
          return false;
        throw error;
      }
    }
    const attemptFilter =
      expected.attempt === 0
        ? { $or: [{ attempt: 0 }, { attempt: { $exists: false } }] }
        : { attempt: expected.attempt };
    const result = await collection.replaceOne(
      {
        idempotencyKey: batch.idempotencyKey,
        status: expected.status,
        ...attemptFilter,
      },
      batch,
      { writeConcern },
    );
    return result.matchedCount === 1;
  }

  async markImportBatchFailed(batch: ImportBatch, expectedAttempt: number) {
    const result = await this.context.collection<ImportBatch>("importBatches").replaceOne(
      {
        idempotencyKey: batch.idempotencyKey,
        status: "PROCESSING",
        attempt: expectedAttempt,
      },
      batch,
      { writeConcern: { w: "majority" } },
    );
    return result.matchedCount === 1;
  }

  async saveImportBatch(batch: ImportBatch) {
    await this.context
      .collection<ImportBatch>("importBatches")
      .replaceOne({ idempotencyKey: batch.idempotencyKey }, batch, { upsert: true });
  }

  async listImportBatchesPage(query: ImportBatchPageQuery): Promise<PagedImportBatches> {
    const filter: Record<string, unknown> = {};
    if (query.status !== undefined) filter.status = query.status;
    if (query.fileName !== undefined) filter.fileName = { $regex: query.fileName, $options: "i" };
    if (query.fromDate !== undefined || query.toDate !== undefined) {
      filter.createdAt = {
        ...(query.fromDate !== undefined ? { $gte: query.fromDate } : {}),
        ...(query.toDate !== undefined ? { $lte: query.toDate } : {}),
      };
    }
    const skip = (query.page - 1) * query.pageSize;
    const [facet] = await this.context
      .collection<ImportBatch>("importBatches")
      .aggregate([
        { $match: filter },
        { $sort: { createdAt: -1 } },
        {
          $facet: {
            items: [{ $skip: skip }, { $limit: query.pageSize }],
            meta: [{ $count: "value" }],
          },
        },
      ])
      .toArray();
    const items = ((facet?.items as ImportBatch[]) ?? []).map(strip);
    const total = (facet?.meta as Array<{ value: number }> | undefined)?.[0]?.value ?? 0;
    return { items, total };
  }

  async findVacationSettlementImportBatch(id: string) {
    const document = await this.context
      .collection<VacationSettlementImportBatch>("vacationSettlementImportBatches")
      .findOne({ id });
    return document ? strip(document) : null;
  }

  async findVacationSettlementImportByFileHash(hash: string) {
    const document = await this.context
      .collection<VacationSettlementImportBatch>("vacationSettlementImportBatches")
      .findOne({ fileHash: hash });
    return document ? strip(document) : null;
  }

  async saveVacationSettlementImportBatch(batch: VacationSettlementImportBatch) {
    await this.context
      .collection<VacationSettlementImportBatch>("vacationSettlementImportBatches")
      .replaceOne({ id: batch.id }, batch, { upsert: true });
  }

  async findVacationPeriodClosureBatch(id: string) {
    const document = await this.context
      .collection<VacationPeriodClosureBatch>("vacationPeriodClosureBatches")
      .findOne({ id });
    return document ? strip(document) : null;
  }

  async findVacationPeriodClosureByFileHash(fileHash: string) {
    const document = await this.context
      .collection<VacationPeriodClosureBatch>("vacationPeriodClosureBatches")
      .findOne({ fileHash }, { sort: { createdAt: -1 } });
    return document ? strip(document) : null;
  }

  async saveVacationPeriodClosureBatch(batch: VacationPeriodClosureBatch) {
    await this.context
      .collection<VacationPeriodClosureBatch>("vacationPeriodClosureBatches")
      .replaceOne({ id: batch.id }, batch, { upsert: true });
  }

  async findVacationPendingPeriodImportBatch(id: string) {
    const document = await this.context
      .collection<VacationPendingPeriodImportBatch>("vacationPendingPeriodImportBatches")
      .findOne({ id });
    return document ? strip(document) : null;
  }

  async findVacationPendingPeriodImportByFileHash(fileHash: string) {
    const document = await this.context
      .collection<VacationPendingPeriodImportBatch>("vacationPendingPeriodImportBatches")
      .findOne({ fileHash }, { sort: { createdAt: -1 } });
    return document ? strip(document) : null;
  }

  async saveVacationPendingPeriodImportBatch(batch: VacationPendingPeriodImportBatch) {
    await this.context
      .collection<VacationPendingPeriodImportBatch>("vacationPendingPeriodImportBatches")
      .replaceOne({ id: batch.id }, batch, { upsert: true });
  }
}
