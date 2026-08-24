import type { PeriodRepository } from "../../../application/ports/repositories.js";
import type { VacationPeriod } from "../../../domain/vacations/models.js";
import { type MongoContext, strip } from "./mongoContext.js";

export class MongoPeriodRepository implements PeriodRepository {
  constructor(private readonly context: MongoContext) {}

  async findByEmploymentId(id: string) {
    return (
      await this.context
        .collection<VacationPeriod>("vacationPeriods")
        .find({ employmentId: id })
        .sort({ sequence: 1 })
        .toArray()
    ).map(strip);
  }

  async findByEmploymentIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.context
        .collection<VacationPeriod>("vacationPeriods")
        .find({ employmentId: { $in: ids } })
        .sort({ employmentId: 1, sequence: 1 })
        .toArray()
    ).map(strip);
  }

  async findPeriodById(id: string) {
    const document = await this.context
      .collection<VacationPeriod>("vacationPeriods")
      .findOne({ id });
    return document ? strip(document) : null;
  }

  async saveMany(periods: VacationPeriod[]) {
    if (!periods.length) return;
    await this.context.collection<VacationPeriod>("vacationPeriods").bulkWrite(
      periods.map((period) => ({
        replaceOne: {
          filter: { id: period.id },
          replacement: period,
          upsert: true,
        },
      })),
    );
  }
}
