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
import type { MemoryContext } from "./memoryContext.js";

function slice<T>(items: T[], page: number, pageSize: number): { items: T[]; total: number } {
  const total = items.length;
  const start = Math.max(0, (page - 1) * pageSize);
  return { items: items.slice(start, start + pageSize), total };
}

export class MemoryImportRepository
  implements
    ImportBatchRepository,
    VacationSettlementImportRepository,
    VacationPeriodClosureRepository,
    VacationPendingPeriodImportRepository
{
  constructor(private readonly context: MemoryContext) {}

  async findImportBatchByIdempotencyKey(key: string) {
    return this.context.importBatches.get(key) ?? null;
  }

  async findImportBatchById(id: string) {
    return [...this.context.importBatches.values()].find((batch) => batch.id === id) ?? null;
  }

  async claimImportBatch(
    batch: ImportBatch,
    expected?: { status: ImportBatch["status"]; attempt: number },
  ) {
    return this.context.atomic(() => {
      const current = this.context.importBatches.get(batch.idempotencyKey);
      if (!expected) {
        if (current) return false;
      } else if (
        !current ||
        current.status !== expected.status ||
        (current.attempt ?? 0) !== expected.attempt
      ) {
        return false;
      }
      this.context.importBatches.set(batch.idempotencyKey, batch);
      return true;
    });
  }

  async markImportBatchFailed(batch: ImportBatch, expectedAttempt: number) {
    return this.context.atomic(() => {
      const current = this.context.importBatches.get(batch.idempotencyKey);
      if (!current || current.status !== "PROCESSING" || (current.attempt ?? 0) !== expectedAttempt)
        return false;
      this.context.importBatches.set(batch.idempotencyKey, batch);
      return true;
    });
  }

  async saveImportBatch(batch: ImportBatch) {
    this.context.importBatches.set(batch.idempotencyKey, batch);
  }

  async listImportBatchesPage(query: ImportBatchPageQuery): Promise<PagedImportBatches> {
    const all = [...this.context.importBatches.values()].filter((batch) => {
      if (query.actorId !== undefined && batch.idempotencyKey.split(":")[0] !== query.actorId)
        return false;
      if (query.status !== undefined && batch.status !== query.status) return false;
      if (query.fromDate !== undefined && batch.createdAt < query.fromDate) return false;
      if (query.toDate !== undefined && batch.createdAt > query.toDate) return false;
      return true;
    });
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return slice(all, query.page, query.pageSize);
  }

  async findVacationSettlementImportBatch(id: string) {
    return this.context.settlementImportBatches.get(id) ?? null;
  }

  async findVacationSettlementImportByFileHash(hash: string) {
    return (
      [...this.context.settlementImportBatches.values()].find((batch) => batch.fileHash === hash) ??
      null
    );
  }

  async saveVacationSettlementImportBatch(batch: VacationSettlementImportBatch) {
    this.context.settlementImportBatches.set(batch.id, batch);
  }

  async findVacationPeriodClosureBatch(id: string) {
    return this.context.vacationPeriodClosureBatches.get(id) ?? null;
  }

  async findVacationPeriodClosureByFileHash(fileHash: string) {
    return (
      [...this.context.vacationPeriodClosureBatches.values()].find(
        (batch) => batch.fileHash === fileHash,
      ) ?? null
    );
  }

  async saveVacationPeriodClosureBatch(batch: VacationPeriodClosureBatch) {
    this.context.vacationPeriodClosureBatches.set(batch.id, batch);
  }

  async findVacationPendingPeriodImportBatch(id: string) {
    return this.context.vacationPendingPeriodImportBatches.get(id) ?? null;
  }

  async findVacationPendingPeriodImportByFileHash(fileHash: string) {
    return (
      [...this.context.vacationPendingPeriodImportBatches.values()].find(
        (batch) => batch.fileHash === fileHash,
      ) ?? null
    );
  }

  async saveVacationPendingPeriodImportBatch(batch: VacationPendingPeriodImportBatch) {
    this.context.vacationPendingPeriodImportBatches.set(batch.id, batch);
  }
}
