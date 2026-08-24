import type {
  SettlementPageQuery,
  SettlementRepository,
} from "../../../application/ports/repositories.js";
import type { VacationSettlement } from "../../../domain/vacations/models.js";
import type { MemoryContext } from "./memoryContext.js";

export class MemorySettlementRepository implements SettlementRepository {
  constructor(private readonly context: MemoryContext) {}

  async listSettlements(includeAnnulled = false) {
    return [...this.context.settlements.values()].filter(
      (settlement) => includeAnnulled || settlement.status !== "ANULADA",
    );
  }

  async listSettlementPage(query: SettlementPageQuery) {
    const search = query.search?.toLowerCase().trim();
    const employmentsById = new Map(this.context.employments);
    const workersById = new Map(this.context.workers);
    const all = [...this.context.settlements.values()]
      .filter((settlement) => {
        const employment = employmentsById.get(settlement.employmentId);
        const worker = employment ? workersById.get(employment.workerId) : undefined;
        return (
          (query.status ? settlement.status === query.status : settlement.status !== "ANULADA") &&
          (!query.employmentId || settlement.employmentId === query.employmentId) &&
          (!query.fromDate || settlement.periodEndDate >= query.fromDate) &&
          (!query.toDate || settlement.periodEndDate <= query.toDate) &&
          (!search ||
            `${settlement.accountingDocument} ${settlement.employmentId} ${settlement.sourceKey ?? ""} ${worker?.fullName ?? ""} ${worker?.documentNumber ?? ""}`
              .toLowerCase()
              .includes(search))
        );
      })
      .sort(
        (a, b) =>
          b.periodEndDate.localeCompare(a.periodEndDate) || b.createdAt.localeCompare(a.createdAt),
      );
    const start = (query.page - 1) * query.pageSize;
    return {
      items: all
        .slice(start, start + query.pageSize)
        .map((settlement) => this.withEmployee(settlement)),
      total: all.length,
    };
  }

  async findSettlementsByEmploymentIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.context.settlements.values()].filter(
      (settlement) => selected.has(settlement.employmentId) && settlement.status !== "ANULADA",
    );
  }

  async findSettlementById(id: string) {
    const settlement = this.context.settlements.get(id);
    return settlement ? this.withEmployee(settlement) : null;
  }

  async findSettlementBySourceKey(sourceKey: string) {
    return (
      [...this.context.settlements.values()].find(
        (settlement) => settlement.sourceKey === sourceKey,
      ) ?? null
    );
  }

  async saveSettlement(settlement: VacationSettlement) {
    this.context.settlements.set(settlement.id, settlement);
  }

  private withEmployee(settlement: VacationSettlement) {
    const employment = this.context.employments.get(settlement.employmentId);
    const worker = employment ? this.context.workers.get(employment.workerId) : undefined;
    return {
      ...settlement,
      ...(worker
        ? {
            employeeName: worker.fullName,
            employeeDocumentNumber: worker.documentNumber,
          }
        : {}),
    };
  }
}
