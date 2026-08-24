import type {
  EmploymentPageQuery,
  EmploymentRepository,
  WorkerRepository,
} from "../../../application/ports/repositories.js";
import type { LocalDate } from "../../../domain/shared/localDate.js";
import type { Employment, Worker } from "../../../domain/workers/models.js";
import type { MemoryContext } from "./memoryContext.js";

export class MemoryWorkersEmploymentsRepository implements WorkerRepository, EmploymentRepository {
  constructor(private readonly context: MemoryContext) {}

  async listWorkers() {
    return [...this.context.workers.values()];
  }

  async listWorkersByIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.context.workers.values()].filter((item) => selected.has(item.id));
  }

  async findWorkersByNormalizedDocuments(normalizedDocumentNumbers: string[]) {
    const selected = new Set(normalizedDocumentNumbers);
    return [...this.context.workers.values()].filter((item) =>
      selected.has(item.normalizedDocumentNumber),
    );
  }

  async findWorkerById(id: string) {
    return this.context.workers.get(id) ?? null;
  }

  async findWorkerByNormalizedDocument(normalizedDocumentNumber: string) {
    return (
      [...this.context.workers.values()].find(
        (item) => item.normalizedDocumentNumber === normalizedDocumentNumber,
      ) ?? null
    );
  }

  async saveWorker(worker: Worker) {
    this.context.workers.set(worker.id, worker);
  }

  async listEmployments() {
    return [...this.context.employments.values()];
  }

  async findEmploymentsByIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.context.employments.values()].filter((item) => selected.has(item.id));
  }

  async findEmploymentsByWorkerIds(workerIds: string[]) {
    const selected = new Set(workerIds);
    return [...this.context.employments.values()].filter((item) => selected.has(item.workerId));
  }

  async listEmploymentsByFilter(query: Omit<EmploymentPageQuery, "page" | "pageSize" | "search">) {
    return [...this.context.employments.values()].filter(
      (item) =>
        (!query.status || item.status === query.status) &&
        (!query.processName ||
          item.processName.toLowerCase().includes(query.processName.toLowerCase())) &&
        (!query.toDate || item.startDate <= query.toDate) &&
        (!query.fromDate || !item.endDate || item.endDate >= query.fromDate),
    );
  }

  async listEmploymentPage(query: EmploymentPageQuery) {
    const search = query.search?.toLowerCase();
    const workersById = new Map(
      [...this.context.workers.values()].map((worker) => [worker.id, worker]),
    );
    const filtered = [...this.context.employments.values()]
      .filter((item) => {
        const worker = workersById.get(item.workerId);
        if (query.status && item.status !== query.status) return false;
        if (
          query.processName &&
          !item.processName.toLowerCase().includes(query.processName.toLowerCase())
        )
          return false;
        if (query.toDate && item.startDate > query.toDate) return false;
        if (query.fromDate && item.endDate && item.endDate < query.fromDate) return false;
        if (search) {
          const haystack =
            `${worker?.documentNumber ?? ""} ${worker?.normalizedDocumentNumber ?? ""} ${worker?.fullName ?? ""} ${item.processName} ${item.positionName} ${item.supervisorName ?? ""}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const left = workersById.get(a.workerId)?.fullName ?? "";
        const right = workersById.get(b.workerId)?.fullName ?? "";
        return left.localeCompare(right, "es") || b.startDate.localeCompare(a.startDate);
      });
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize),
      total: filtered.length,
    };
  }

  async findEmploymentById(id: string) {
    return this.context.employments.get(id) ?? null;
  }

  async findEmploymentByWorkerAndStartDate(workerId: string, startDate: LocalDate) {
    return (
      [...this.context.employments.values()].find(
        (employment) => employment.workerId === workerId && employment.startDate === startDate,
      ) ?? null
    );
  }

  async saveEmployment(employment: Employment) {
    this.context.employments.set(employment.id, employment);
  }
}
