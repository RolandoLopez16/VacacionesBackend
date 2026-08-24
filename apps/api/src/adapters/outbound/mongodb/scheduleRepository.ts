import type {
  AnnualScheduleReportQuery,
  SchedulePageQuery,
  ScheduleReportItem,
  ScheduleRepository,
} from "../../../application/ports/repositories.js";
import type { VacationSchedule } from "../../../domain/vacations/models.js";
import { escapeRegExp, type MongoContext, type Stored, strip } from "./mongoContext.js";

export class MongoScheduleRepository implements ScheduleRepository {
  constructor(private readonly context: MongoContext) {}

  async listSchedules() {
    return (
      await this.context
        .collection<VacationSchedule>("vacationSchedules")
        .find({})
        .sort({ startDate: 1 })
        .toArray()
    ).map(strip);
  }

  async listSchedulePage(query: SchedulePageQuery) {
    const filter: Record<string, unknown> = {};
    if (query.employmentId) filter.employmentId = query.employmentId;
    if (query.status) filter.status = query.status;
    const dateFilters: Record<string, unknown>[] = [];
    if (query.fromDate) dateFilters.push({ endDate: { $gte: query.fromDate } });
    if (query.toDate) dateFilters.push({ startDate: { $lte: query.toDate } });
    if (dateFilters.length) filter.$and = dateFilters;
    const collection = this.context.collection<VacationSchedule>("vacationSchedules");
    if (!query.search?.trim()) {
      const [items, total] = await Promise.all([
        collection
          .find(filter)
          .sort({ startDate: 1, id: 1 })
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize)
          .toArray(),
        collection.countDocuments(filter),
      ]);
      return { items: items.map(strip), total };
    }
    const text = new RegExp(escapeRegExp(query.search.trim()), "i");
    const normalized = query.search.replace(/\D/g, "");
    const pipeline: Record<string, unknown>[] = [
      { $match: filter },
      {
        $lookup: {
          from: "employments",
          localField: "employmentId",
          foreignField: "id",
          as: "employment",
        },
      },
      { $unwind: "$employment" },
      {
        $lookup: {
          from: "workers",
          localField: "employment.workerId",
          foreignField: "id",
          as: "worker",
        },
      },
      { $unwind: "$worker" },
      {
        $match: {
          $or: [
            { "worker.fullName": text },
            { "worker.documentNumber": text },
            {
              "worker.normalizedDocumentNumber": normalized
                ? new RegExp(`^${escapeRegExp(normalized)}`)
                : text,
            },
            { "employment.processName": text },
            { "employment.positionName": text },
            { id: text },
          ],
        },
      },
      {
        $facet: {
          items: [
            { $sort: { startDate: 1, id: 1 } },
            { $skip: (query.page - 1) * query.pageSize },
            { $limit: query.pageSize },
            { $project: { employment: 0, worker: 0 } },
          ],
          total: [{ $count: "value" }],
        },
      },
    ];
    const [result] = await collection
      .aggregate<{ items: Stored<VacationSchedule>[]; total: { value: number }[] }>(pipeline)
      .toArray();
    return {
      items: (result?.items ?? []).map(strip),
      total: result?.total[0]?.value ?? 0,
    };
  }

  async listAnnualScheduleReport(query: AnnualScheduleReportQuery): Promise<ScheduleReportItem[]> {
    const fromDate = query.fromDate ?? (query.year ? `${query.year}-01-01` : undefined);
    const toDate = query.toDate ?? (query.year ? `${query.year}-12-31` : undefined);
    const dateFilters: Record<string, unknown>[] = [];
    if (fromDate) dateFilters.push({ endDate: { $gte: fromDate } });
    if (toDate) dateFilters.push({ startDate: { $lte: toDate } });
    const match: Record<string, unknown> = {
      ...(dateFilters.length ? { $and: dateFilters } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const pipeline: Record<string, unknown>[] = [
      { $match: match },
      {
        $lookup: {
          from: "employments",
          localField: "employmentId",
          foreignField: "id",
          as: "employment",
        },
      },
      { $unwind: "$employment" },
      {
        $lookup: {
          from: "workers",
          localField: "employment.workerId",
          foreignField: "id",
          as: "worker",
        },
      },
      { $unwind: "$worker" },
    ];
    if (query.search?.trim()) {
      const text = new RegExp(escapeRegExp(query.search.trim()), "i");
      const normalized = query.search.replace(/\D/g, "");
      pipeline.push({
        $match: {
          $or: [
            { "worker.fullName": text },
            { "worker.documentNumber": text },
            {
              "worker.normalizedDocumentNumber": normalized
                ? new RegExp(`^${escapeRegExp(normalized)}`)
                : text,
            },
            { "employment.processName": text },
            { "employment.positionName": text },
            { "employment.supervisorName": text },
            { id: text },
          ],
        },
      });
    }
    pipeline.push(
      { $sort: { startDate: 1, "worker.fullName": 1, id: 1 } },
      {
        $project: {
          _id: 0,
          id: 1,
          employmentId: 1,
          startDate: 1,
          endDate: 1,
          scheduledDays: 1,
          allocations: 1,
          holidayWarnings: 1,
          status: 1,
          version: 1,
          createdAt: 1,
          updatedAt: 1,
          employeeName: "$worker.fullName",
          employeeDocumentNumber: "$worker.documentNumber",
          processName: "$employment.processName",
          positionName: "$employment.positionName",
          supervisorName: "$employment.supervisorName",
        },
      },
    );
    return this.context
      .collection<VacationSchedule>("vacationSchedules")
      .aggregate<ScheduleReportItem>(pipeline)
      .toArray();
  }

  async findSchedulesByEmploymentIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.context
        .collection<VacationSchedule>("vacationSchedules")
        .find({ employmentId: { $in: ids } })
        .sort({ startDate: 1 })
        .toArray()
    ).map(strip);
  }

  async findSchedulesByIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.context
        .collection<VacationSchedule>("vacationSchedules")
        .find({ id: { $in: ids } })
        .toArray()
    ).map(strip);
  }

  async findScheduleById(id: string) {
    const document = await this.context
      .collection<VacationSchedule>("vacationSchedules")
      .findOne({ id });
    return document ? strip(document) : null;
  }

  async saveSchedule(schedule: VacationSchedule) {
    await this.context
      .collection<VacationSchedule>("vacationSchedules")
      .replaceOne({ id: schedule.id }, schedule, { upsert: true });
  }
}
