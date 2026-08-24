import type {
  AnnualScheduleReportQuery,
  SchedulePageQuery,
  ScheduleReportItem,
  ScheduleRepository,
} from "../../../application/ports/repositories.js";
import type { VacationSchedule } from "../../../domain/vacations/models.js";
import type { MemoryContext } from "./memoryContext.js";

export class MemoryScheduleRepository implements ScheduleRepository {
  constructor(private readonly context: MemoryContext) {}

  async listSchedules() {
    return [...this.context.schedules.values()];
  }

  async listSchedulePage(query: SchedulePageQuery) {
    const search = query.search?.toLowerCase().trim();
    const workersById = new Map(
      [...this.context.workers.values()].map((worker) => [worker.id, worker]),
    );
    const employmentsById = new Map(
      [...this.context.employments.values()].map((employment) => [employment.id, employment]),
    );
    const filtered = [...this.context.schedules.values()]
      .filter((schedule) => {
        const employment = employmentsById.get(schedule.employmentId);
        const worker = employment ? workersById.get(employment.workerId) : undefined;
        if (query.employmentId && schedule.employmentId !== query.employmentId) return false;
        if (query.status && schedule.status !== query.status) return false;
        if (query.fromDate && schedule.endDate < query.fromDate) return false;
        if (query.toDate && schedule.startDate > query.toDate) return false;
        if (search) {
          const haystack =
            `${worker?.documentNumber ?? ""} ${worker?.fullName ?? ""} ${employment?.processName ?? ""} ${employment?.positionName ?? ""} ${schedule.id}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
    const start = (query.page - 1) * query.pageSize;
    return { items: filtered.slice(start, start + query.pageSize), total: filtered.length };
  }

  async listAnnualScheduleReport(query: AnnualScheduleReportQuery): Promise<ScheduleReportItem[]> {
    const fromDate = query.fromDate ?? (query.year ? (`${query.year}-01-01` as const) : undefined);
    const toDate = query.toDate ?? (query.year ? (`${query.year}-12-31` as const) : undefined);
    const search = query.search?.trim().toLowerCase();
    const workersById = new Map(
      [...this.context.workers.values()].map((worker) => [worker.id, worker]),
    );
    const employmentsById = new Map(
      [...this.context.employments.values()].map((employment) => [employment.id, employment]),
    );
    return [...this.context.schedules.values()]
      .filter((schedule) => {
        if (fromDate && schedule.endDate < fromDate) return false;
        if (toDate && schedule.startDate > toDate) return false;
        if (query.status && schedule.status !== query.status) return false;
        const employment = employmentsById.get(schedule.employmentId);
        const worker = employment ? workersById.get(employment.workerId) : undefined;
        if (search) {
          const haystack =
            `${worker?.documentNumber ?? ""} ${worker?.fullName ?? ""} ${employment?.processName ?? ""} ${employment?.positionName ?? ""} ${employment?.supervisorName ?? ""} ${schedule.id}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id))
      .map((schedule) => {
        const employment = employmentsById.get(schedule.employmentId);
        const worker = employment ? workersById.get(employment.workerId) : undefined;
        return {
          ...schedule,
          employeeName: worker?.fullName ?? "Vínculo no encontrado",
          employeeDocumentNumber: worker?.documentNumber ?? schedule.employmentId,
          processName: employment?.processName ?? "—",
          positionName: employment?.positionName ?? "—",
          ...(employment?.supervisorName ? { supervisorName: employment.supervisorName } : {}),
        };
      });
  }

  async findSchedulesByEmploymentIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.context.schedules.values()].filter((schedule) =>
      selected.has(schedule.employmentId),
    );
  }

  async findSchedulesByIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.context.schedules.values()].filter((schedule) => selected.has(schedule.id));
  }

  async findScheduleById(id: string) {
    return this.context.schedules.get(id) ?? null;
  }

  async saveSchedule(schedule: VacationSchedule) {
    this.context.schedules.set(schedule.id, schedule);
  }
}
