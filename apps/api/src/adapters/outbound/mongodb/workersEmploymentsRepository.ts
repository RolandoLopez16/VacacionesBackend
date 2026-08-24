import type {
  EmploymentPageQuery,
  EmploymentRepository,
  WorkerRepository,
} from "../../../application/ports/repositories.js";
import type { LocalDate } from "../../../domain/shared/localDate.js";
import type { Employment, Worker } from "../../../domain/workers/models.js";
import { escapeRegExp, type MongoContext, strip } from "./mongoContext.js";

export class MongoWorkersEmploymentsRepository implements WorkerRepository, EmploymentRepository {
  constructor(private readonly context: MongoContext) {}

  async listWorkers() {
    return (await this.context.collection<Worker>("workers").find({}).toArray()).map(strip);
  }

  async listWorkersByIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.context
        .collection<Worker>("workers")
        .find({ id: { $in: ids } })
        .toArray()
    ).map(strip);
  }

  async findWorkersByNormalizedDocuments(normalizedDocumentNumbers: string[]) {
    if (!normalizedDocumentNumbers.length) return [];
    return (
      await this.context
        .collection<Worker>("workers")
        .find({ normalizedDocumentNumber: { $in: normalizedDocumentNumbers } })
        .toArray()
    ).map(strip);
  }

  async findWorkerById(id: string) {
    const document = await this.context.collection<Worker>("workers").findOne({ id });
    return document ? strip(document) : null;
  }

  async findWorkerByNormalizedDocument(normalizedDocumentNumber: string) {
    const document = await this.context.collection<Worker>("workers").findOne({
      normalizedDocumentNumber,
    });
    return document ? strip(document) : null;
  }

  async saveWorker(worker: Worker) {
    await this.context.collection<Worker>("workers").replaceOne({ id: worker.id }, worker, {
      upsert: true,
    });
  }

  async listEmployments() {
    return (await this.context.collection<Employment>("employments").find({}).toArray()).map(strip);
  }

  async findEmploymentsByIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.context
        .collection<Employment>("employments")
        .find({ id: { $in: ids } })
        .toArray()
    ).map(strip);
  }

  async findEmploymentsByWorkerIds(workerIds: string[]) {
    if (!workerIds.length) return [];
    return (
      await this.context
        .collection<Employment>("employments")
        .find({ workerId: { $in: workerIds } })
        .toArray()
    ).map(strip);
  }

  async listEmploymentsByFilter(query: Omit<EmploymentPageQuery, "page" | "pageSize" | "search">) {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.processName) filter.processName = new RegExp(escapeRegExp(query.processName), "i");
    if (query.toDate) filter.startDate = { $lte: query.toDate };
    if (query.fromDate)
      filter.$or = [
        { endDate: { $exists: false } },
        { endDate: null },
        { endDate: { $gte: query.fromDate } },
      ];
    return (
      await this.context
        .collection<Employment>("employments")
        .find(filter)
        .sort({ startDate: 1, id: 1 })
        .toArray()
    ).map(strip);
  }

  async listEmploymentPage(query: EmploymentPageQuery) {
    const match: Record<string, unknown> = {};
    if (query.status) match.status = query.status;
    if (query.processName) match.processName = new RegExp(escapeRegExp(query.processName), "i");
    if (query.toDate) match.startDate = { $lte: query.toDate };
    if (query.fromDate)
      match.$or = [
        { endDate: { $exists: false } },
        { endDate: null },
        { endDate: { $gte: query.fromDate } },
      ];
    const pipeline: Record<string, unknown>[] = [
      { $match: match },
      {
        $lookup: {
          from: "workers",
          localField: "workerId",
          foreignField: "id",
          as: "worker",
        },
      },
      { $unwind: "$worker" },
    ];
    if (query.search) {
      const text = new RegExp(escapeRegExp(query.search), "i");
      const normalized = query.search.replace(/\D/g, "");
      pipeline.push({
        $match: {
          $or: [
            { "worker.fullName": text },
            { "worker.documentNumber": text },
            {
              "worker.normalizedDocumentNumber": normalized
                ? new RegExp(`^${escapeRegExp(normalized)}`, "i")
                : text,
            },
            { processName: text },
            { positionName: text },
            { supervisorName: text },
          ],
        },
      });
    }
    pipeline.push({
      $facet: {
        items: [
          { $sort: { "worker.fullName": 1, startDate: -1, id: 1 } },
          { $skip: (query.page - 1) * query.pageSize },
          { $limit: query.pageSize },
          {
            $project: {
              _id: 0,
              id: 1,
              workerId: 1,
              startDate: 1,
              endDate: 1,
              contractTypeId: 1,
              contractTypeName: 1,
              processId: 1,
              processName: 1,
              positionId: 1,
              positionName: 1,
              supervisorWorkerId: 1,
              supervisorName: 1,
              status: 1,
              version: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        ],
        meta: [{ $count: "total" }],
      },
    });
    const result = await this.context
      .collection<Employment>("employments")
      .aggregate<{ items: Employment[]; meta: { total: number }[] }>(pipeline)
      .toArray();
    const first = result[0];
    return { items: first?.items ?? [], total: first?.meta[0]?.total ?? 0 };
  }

  async findEmploymentById(id: string) {
    const document = await this.context.collection<Employment>("employments").findOne({ id });
    return document ? strip(document) : null;
  }

  async findEmploymentByWorkerAndStartDate(workerId: string, startDate: LocalDate) {
    const document = await this.context.collection<Employment>("employments").findOne({
      workerId,
      startDate,
    });
    return document ? strip(document) : null;
  }

  async saveEmployment(employment: Employment) {
    await this.context
      .collection<Employment>("employments")
      .replaceOne({ id: employment.id }, employment, { upsert: true });
  }
}
