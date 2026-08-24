import type {
  SettlementPageQuery,
  SettlementRepository,
} from "../../../application/ports/repositories.js";
import type { VacationSettlement } from "../../../domain/vacations/models.js";
import { escapeRegExp, type MongoContext, strip } from "./mongoContext.js";

export class MongoSettlementRepository implements SettlementRepository {
  constructor(private readonly context: MongoContext) {}

  async listSettlements(includeAnnulled = false) {
    return (
      await this.context
        .collection<VacationSettlement>("vacationSettlements")
        .find(includeAnnulled ? {} : { status: { $ne: "ANULADA" } }, {
          projection: { sourceLines: 0 },
        })
        .sort({ periodEndDate: -1 })
        .toArray()
    ).map(strip);
  }

  async listSettlementPage(query: SettlementPageQuery) {
    const filter: Record<string, unknown> = {
      status: query.status ?? { $ne: "ANULADA" },
    };
    if (query.employmentId) filter.employmentId = query.employmentId;
    if (query.fromDate || query.toDate)
      filter.periodEndDate = {
        ...(query.fromDate ? { $gte: query.fromDate } : {}),
        ...(query.toDate ? { $lte: query.toDate } : {}),
      };
    const collection = this.context.collection<VacationSettlement>("vacationSettlements");
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
      { $unwind: { path: "$employment", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "workers",
          localField: "employment.workerId",
          foreignField: "id",
          as: "worker",
        },
      },
      { $unwind: { path: "$worker", preserveNullAndEmptyArrays: true } },
    ];
    if (query.search?.trim()) {
      const text = new RegExp(escapeRegExp(query.search.trim()), "i");
      const normalized = query.search.replace(/\D/g, "");
      pipeline.push({
        $match: {
          $or: [
            { accountingDocument: text },
            { employmentId: text },
            { sourceKey: text },
            { "worker.fullName": text },
            { "worker.documentNumber": text },
            {
              "worker.normalizedDocumentNumber": normalized
                ? new RegExp(`^${escapeRegExp(normalized)}`)
                : text,
            },
          ],
        },
      });
    }
    pipeline.push({
      $facet: {
        items: [
          { $sort: { periodEndDate: -1, createdAt: -1 } },
          { $skip: (query.page - 1) * query.pageSize },
          { $limit: query.pageSize },
          {
            $project: {
              _id: 0,
              id: 1,
              employmentId: 1,
              sourceScheduleId: 1,
              sourceBatchId: 1,
              sourceKey: 1,
              source: 1,
              status: 1,
              enjoymentStartDate: 1,
              enjoymentEndDate: 1,
              periodEndDate: 1,
              enjoyedDays: 1,
              compensatedDays: 1,
              calendarDays: 1,
              amountCOP: 1,
              accountingDocument: 1,
              observation: 1,
              allocations: 1,
              version: 1,
              cancelledAt: 1,
              cancelledBy: 1,
              cancellationReason: 1,
              createdAt: 1,
              updatedAt: 1,
              employeeName: "$worker.fullName",
              employeeDocumentNumber: "$worker.documentNumber",
            },
          },
        ],
        total: [{ $count: "value" }],
      },
    });
    const [result] = await collection
      .aggregate<{
        items: (VacationSettlement & {
          employeeName?: string;
          employeeDocumentNumber?: string;
        })[];
        total: { value: number }[];
      }>(pipeline)
      .toArray();
    return {
      items: result?.items ?? [],
      total: result?.total[0]?.value ?? 0,
    };
  }

  async findSettlementsByEmploymentIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.context
        .collection<VacationSettlement>("vacationSettlements")
        .find(
          { employmentId: { $in: ids }, status: { $ne: "ANULADA" } },
          { projection: { sourceLines: 0 } },
        )
        .sort({ enjoymentStartDate: 1 })
        .toArray()
    ).map(strip);
  }

  async findSettlementById(id: string) {
    const [document] = await this.context
      .collection<VacationSettlement>("vacationSettlements")
      .aggregate<
        VacationSettlement & {
          employeeName?: string;
          employeeDocumentNumber?: string;
        }
      >([
        { $match: { id } },
        {
          $lookup: {
            from: "employments",
            localField: "employmentId",
            foreignField: "id",
            as: "employment",
          },
        },
        {
          $unwind: {
            path: "$employment",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "workers",
            localField: "employment.workerId",
            foreignField: "id",
            as: "worker",
          },
        },
        { $unwind: { path: "$worker", preserveNullAndEmptyArrays: true } },
        {
          $set: {
            employeeName: "$worker.fullName",
            employeeDocumentNumber: "$worker.documentNumber",
          },
        },
        { $project: { employment: 0, worker: 0 } },
      ])
      .toArray();
    return document ? strip(document) : null;
  }

  async findSettlementBySourceKey(sourceKey: string) {
    const document = await this.context
      .collection<VacationSettlement>("vacationSettlements")
      .findOne({ sourceKey });
    return document ? strip(document) : null;
  }

  async saveSettlement(settlement: VacationSettlement) {
    await this.context
      .collection<VacationSettlement>("vacationSettlements")
      .replaceOne({ id: settlement.id }, settlement, { upsert: true });
  }
}
