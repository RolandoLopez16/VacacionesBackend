import type { PeriodRepository } from "../../../application/ports/repositories.js";
import type { VacationPeriod } from "../../../domain/vacations/models.js";
import type { MemoryContext } from "./memoryContext.js";

export class MemoryPeriodRepository implements PeriodRepository {
  constructor(private readonly context: MemoryContext) {}

  async findByEmploymentId(id: string) {
    return [...this.context.periods.values()].filter((period) => period.employmentId === id);
  }

  async findByEmploymentIds(ids: string[]) {
    const selected = new Set(ids);
    return [...this.context.periods.values()].filter((period) => selected.has(period.employmentId));
  }

  async findPeriodById(id: string) {
    return this.context.periods.get(id) ?? null;
  }

  async saveMany(periods: VacationPeriod[]) {
    periods.forEach((period) => this.context.periods.set(period.id, period));
  }
}
