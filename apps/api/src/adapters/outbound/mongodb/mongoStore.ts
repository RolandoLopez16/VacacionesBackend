import { MongoClient, type Collection, type Db } from "mongodb";
import type {
  AnnualScheduleReportQuery,
  EmploymentPageQuery,
  SchedulePageQuery,
  ScheduleReportItem,
  SettlementPageQuery,
  VacationStore,
} from "../../../application/ports/repositories.js";
import type { Worker, Employment } from "../../../domain/workers/models.js";
import type {
  ImportBatch,
  VacationPeriod,
  VacationPolicy,
  VacationSchedule,
  VacationSettlement,
  VacationSettlementImportBatch,
  VacationPeriodClosureBatch,
} from "../../../domain/vacations/models.js";
import type { User } from "../../../domain/auth/models.js";
import type { Session } from "../../../domain/auth/session.js";
import type { CatalogItem } from "../../../domain/admin/catalog.js";
import type { SystemSetting } from "../../../domain/admin/settings.js";
import type { Holiday } from "../../../domain/admin/holiday.js";
import type { VacationAlert } from "../../../domain/vacations/alerts.js";
import type { SchedulerRun } from "../../../domain/vacations/schedulerRun.js";

type Stored<T> = T & { _id?: unknown };
function strip<T>(doc: Stored<T>): T {
  const { _id: _, ...value } = doc;
  return value as T;
}
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class MongoStore implements VacationStore {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
  ) {}
  static async connect(uri: string, database: string): Promise<MongoStore> {
    const client = new MongoClient(uri, { appName: "vaca-efa-api" });
    await client.connect();
    const store = new MongoStore(client, client.db(database));
    await store.ensureIndexes();
    return store;
  }
  private collection<T>(name: string): Collection<Stored<T>> {
    return this.db.collection<Stored<T>>(name);
  }
  private async ensureIndexes() {
    await Promise.all([
      this.collection<Worker>("workers").createIndex(
        { normalizedDocumentNumber: 1 },
        { unique: true },
      ),
      this.collection<Worker>("workers").createIndex({ fullName: 1 }),
      this.collection<Employment>("employments").createIndex(
        { workerId: 1, startDate: 1 },
        { unique: true },
      ),
      this.collection<Employment>("employments").createIndex({
        status: 1,
        processName: 1,
        startDate: 1,
      }),
      this.collection<VacationPeriod>("vacationPeriods").createIndex(
        { employmentId: 1, sequence: 1 },
        { unique: true },
      ),
      this.collection<VacationSchedule>("vacationSchedules").createIndex({
        employmentId: 1,
        startDate: 1,
      }),
      this.collection<VacationSchedule>("vacationSchedules").createIndex({
        status: 1,
        startDate: 1,
        employmentId: 1,
      }),
      this.collection<VacationSchedule>("vacationSchedules").createIndex({
        status: 1,
        endDate: 1,
        startDate: 1,
      }),
      this.collection<VacationSettlement>("vacationSettlements").createIndex({
        employmentId: 1,
        accountingDocument: 1,
        status: 1,
      }),
      this.collection<VacationSettlement>("vacationSettlements").createIndex({
        periodEndDate: -1,
        status: 1,
      }),
      this.collection<VacationSettlement>("vacationSettlements").createIndex({
        sourceBatchId: 1,
      }),
      this.collection<ImportBatch>("importBatches").createIndex(
        { idempotencyKey: 1 },
        { unique: true },
      ),
      this.collection<VacationSettlementImportBatch>(
        "vacationSettlementImportBatches",
      ).createIndex({ id: 1 }, { unique: true }),
      this.collection<VacationSettlementImportBatch>(
        "vacationSettlementImportBatches",
      ).createIndex({ fileHash: 1 }),
      this.collection<VacationPeriodClosureBatch>(
        "vacationPeriodClosureBatches",
      ).createIndex({ id: 1 }, { unique: true }),
      this.collection<VacationPeriodClosureBatch>(
        "vacationPeriodClosureBatches",
      ).createIndex({ fileHash: 1 }),
      this.collection<Session>("sessions").createIndex(
        { id: 1 },
        { unique: true },
      ),
      this.collection<Session>("sessions").createIndex({ expiresAt: 1 }),
      this.collection<CatalogItem>("catalogItems").createIndex(
        { type: 1, name: 1 },
        { unique: true },
      ),
      this.collection<SystemSetting>("systemSettings").createIndex(
        { key: 1 },
        { unique: true },
      ),
      this.collection<Holiday>("holidays").createIndex(
        { date: 1 },
        { unique: true },
      ),
      this.collection<VacationAlert>("vacationAlerts").createIndex(
        { employmentId: 1, type: 1, asOf: 1 },
        { unique: true },
      ),
      this.collection<SchedulerRun>("schedulerRuns").createIndex(
        { jobName: 1, asOf: 1 },
        { unique: true },
      ),
      this.collection<User>("users").createIndex(
        { username: 1 },
        { unique: true },
      ),
    ]);
  }
  async listWorkers() {
    return (await this.collection<Worker>("workers").find({}).toArray()).map(
      strip,
    );
  }
  async listWorkersByIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.collection<Worker>("workers")
        .find({ id: { $in: ids } })
        .toArray()
    ).map(strip);
  }
  async findWorkerById(id: string) {
    const doc = await this.collection<Worker>("workers").findOne({ id });
    return doc ? strip(doc) : null;
  }
  async findWorkerByNormalizedDocument(normalizedDocumentNumber: string) {
    const doc = await this.collection<Worker>("workers").findOne({
      normalizedDocumentNumber,
    });
    return doc ? strip(doc) : null;
  }
  async saveWorker(worker: Worker) {
    await this.collection<Worker>("workers").replaceOne(
      { id: worker.id },
      worker,
      { upsert: true },
    );
  }
  async listEmployments() {
    return (
      await this.collection<Employment>("employments").find({}).toArray()
    ).map(strip);
  }
  async findEmploymentsByIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.collection<Employment>("employments")
        .find({ id: { $in: ids } })
        .toArray()
    ).map(strip);
  }
  async listEmploymentsByFilter(
    query: Omit<EmploymentPageQuery, "page" | "pageSize" | "search">,
  ) {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.processName)
      filter.processName = new RegExp(escapeRegExp(query.processName), "i");
    if (query.toDate) filter.startDate = { $lte: query.toDate };
    if (query.fromDate)
      filter.$or = [
        { endDate: { $exists: false } },
        { endDate: null },
        { endDate: { $gte: query.fromDate } },
      ];
    return (
      await this.collection<Employment>("employments")
        .find(filter)
        .sort({ startDate: 1, id: 1 })
        .toArray()
    ).map(strip);
  }
  async listEmploymentPage(query: EmploymentPageQuery) {
    const match: Record<string, unknown> = {};
    if (query.status) match.status = query.status;
    if (query.processName)
      match.processName = new RegExp(escapeRegExp(query.processName), "i");
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
    const result = await this.collection<Employment>("employments")
      .aggregate<{ items: Employment[]; meta: { total: number }[] }>(pipeline)
      .toArray();
    const first = result[0];
    return { items: first?.items ?? [], total: first?.meta[0]?.total ?? 0 };
  }
  async findEmploymentById(id: string) {
    const doc = await this.collection<Employment>("employments").findOne({
      id,
    });
    return doc ? strip(doc) : null;
  }
  async findEmploymentByWorkerAndStartDate(
    workerId: string,
    startDate: import("../../../domain/shared/localDate.js").LocalDate,
  ) {
    const doc = await this.collection<Employment>("employments").findOne({
      workerId,
      startDate,
    });
    return doc ? strip(doc) : null;
  }
  async saveEmployment(employment: Employment) {
    await this.collection<Employment>("employments").replaceOne(
      { id: employment.id },
      employment,
      { upsert: true },
    );
  }
  async findByEmploymentId(id: string) {
    return (
      await this.collection<VacationPeriod>("vacationPeriods")
        .find({ employmentId: id })
        .sort({ sequence: 1 })
        .toArray()
    ).map(strip);
  }
  async findByEmploymentIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.collection<VacationPeriod>("vacationPeriods")
        .find({ employmentId: { $in: ids } })
        .sort({ employmentId: 1, sequence: 1 })
        .toArray()
    ).map(strip);
  }
  async findPeriodById(id: string) {
    const doc = await this.collection<VacationPeriod>(
      "vacationPeriods",
    ).findOne({ id });
    return doc ? strip(doc) : null;
  }
  async saveMany(periods: VacationPeriod[]) {
    if (!periods.length) return;
    await this.collection<VacationPeriod>("vacationPeriods").bulkWrite(
      periods.map((period) => ({
        replaceOne: {
          filter: { id: period.id },
          replacement: period,
          upsert: true,
        },
      })),
    );
  }
  async listSchedules() {
    return (
      await this.collection<VacationSchedule>("vacationSchedules")
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
    if (!query.search?.trim()) {
      const [items, total] = await Promise.all([
        this.collection<VacationSchedule>("vacationSchedules")
          .find(filter)
          .sort({ startDate: 1, id: 1 })
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize)
          .toArray(),
        this.collection<VacationSchedule>("vacationSchedules").countDocuments(filter),
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
    const [result] = await this.collection<VacationSchedule>("vacationSchedules")
      .aggregate<{ items: Stored<VacationSchedule>[]; total: { value: number }[] }>(pipeline)
      .toArray();
    return {
      items: (result?.items ?? []).map(strip),
      total: result?.total[0]?.value ?? 0,
    };
  }
  async listAnnualScheduleReport(
    query: AnnualScheduleReportQuery,
  ): Promise<ScheduleReportItem[]> {
    const yearStart = `${query.year}-01-01`;
    const yearEnd = `${query.year}-12-31`;
    const match: Record<string, unknown> = {
      startDate: { $lte: yearEnd },
      endDate: { $gte: yearStart },
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
    return this.collection<VacationSchedule>("vacationSchedules")
      .aggregate<ScheduleReportItem>(pipeline)
      .toArray();
  }
  async findSchedulesByEmploymentIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.collection<VacationSchedule>("vacationSchedules")
        .find({ employmentId: { $in: ids } })
        .sort({ startDate: 1 })
        .toArray()
    ).map(strip);
  }
  async findSchedulesByIds(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.collection<VacationSchedule>("vacationSchedules")
        .find({ id: { $in: ids } })
        .toArray()
    ).map(strip);
  }
  async findScheduleById(id: string) {
    const doc = await this.collection<VacationSchedule>(
      "vacationSchedules",
    ).findOne({ id });
    return doc ? strip(doc) : null;
  }
  async saveSchedule(schedule: VacationSchedule) {
    await this.collection<VacationSchedule>("vacationSchedules").replaceOne(
      { id: schedule.id },
      schedule,
      { upsert: true },
    );
  }
  async listSettlements(includeAnnulled = false) {
    return (
      await this.collection<VacationSettlement>("vacationSettlements")
        .find(
          includeAnnulled ? {} : { status: { $ne: "ANULADA" } },
          { projection: { sourceLines: 0 } },
        )
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
    const collection = this.collection<VacationSettlement>(
      "vacationSettlements",
    );
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
      await this.collection<VacationSettlement>("vacationSettlements")
        .find(
          { employmentId: { $in: ids }, status: { $ne: "ANULADA" } },
          { projection: { sourceLines: 0 } },
        )
        .sort({ enjoymentStartDate: 1 })
        .toArray()
    ).map(strip);
  }
  async findSettlementById(id: string) {
    const [doc] = await this.collection<VacationSettlement>(
      "vacationSettlements",
    )
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
    return doc ? strip(doc) : null;
  }
  async findSettlementBySourceKey(sourceKey: string) {
    const doc = await this.collection<VacationSettlement>(
      "vacationSettlements",
    ).findOne({ sourceKey });
    return doc ? strip(doc) : null;
  }
  async saveSettlement(settlement: VacationSettlement) {
    await this.collection<VacationSettlement>("vacationSettlements").replaceOne(
      { id: settlement.id },
      settlement,
      { upsert: true },
    );
  }
  async findImportBatchByIdempotencyKey(key: string) {
    const doc = await this.collection<ImportBatch>("importBatches").findOne({
      idempotencyKey: key,
    });
    return doc ? strip(doc) : null;
  }
  async saveImportBatch(batch: ImportBatch) {
    await this.collection<ImportBatch>("importBatches").replaceOne(
      { idempotencyKey: batch.idempotencyKey },
      batch,
      { upsert: true },
    );
  }
  async findVacationSettlementImportBatch(id: string) {
    const doc = await this.collection<VacationSettlementImportBatch>(
      "vacationSettlementImportBatches",
    ).findOne({ id });
    return doc ? strip(doc) : null;
  }
  async findVacationSettlementImportByFileHash(hash: string) {
    const doc = await this.collection<VacationSettlementImportBatch>(
      "vacationSettlementImportBatches",
    ).findOne({ fileHash: hash });
    return doc ? strip(doc) : null;
  }
  async saveVacationSettlementImportBatch(
    batch: VacationSettlementImportBatch,
  ) {
    await this.collection<VacationSettlementImportBatch>(
      "vacationSettlementImportBatches",
    ).replaceOne({ id: batch.id }, batch, { upsert: true });
  }
  async findVacationPeriodClosureBatch(id: string) {
    const doc = await this.collection<VacationPeriodClosureBatch>(
      "vacationPeriodClosureBatches",
    ).findOne({ id });
    return doc ? strip(doc) : null;
  }
  async findVacationPeriodClosureByFileHash(fileHash: string) {
    const doc = await this.collection<VacationPeriodClosureBatch>(
      "vacationPeriodClosureBatches",
    ).findOne({ fileHash }, { sort: { createdAt: -1 } });
    return doc ? strip(doc) : null;
  }
  async saveVacationPeriodClosureBatch(batch: VacationPeriodClosureBatch) {
    await this.collection<VacationPeriodClosureBatch>(
      "vacationPeriodClosureBatches",
    ).replaceOne({ id: batch.id }, batch, { upsert: true });
  }
  async findSessionById(id: string) {
    const doc = await this.collection<Session>("sessions").findOne({ id });
    return doc ? strip(doc) : null;
  }
  async saveSession(session: Session) {
    await this.collection<Session>("sessions").replaceOne(
      { id: session.id },
      session,
      { upsert: true },
    );
  }
  async revokeSession(id: string, revokedAt: string) {
    await this.collection<Session>("sessions").updateOne(
      { id },
      { $set: { revokedAt } },
    );
  }
  async listCatalog(type: string) {
    return (
      await this.collection<CatalogItem>("catalogItems")
        .find({ type, active: true })
        .sort({ name: 1 })
        .toArray()
    ).map(strip);
  }
  async saveCatalog(item: CatalogItem) {
    await this.collection<CatalogItem>("catalogItems").replaceOne(
      { id: item.id },
      item,
      { upsert: true },
    );
  }
  async findSystemSettingByKey(key: string) {
    const doc = await this.collection<SystemSetting>("systemSettings").findOne({
      key,
    });
    return doc ? strip(doc) : null;
  }
  async saveSystemSetting(setting: SystemSetting) {
    await this.collection<SystemSetting>("systemSettings").replaceOne(
      { key: setting.key },
      setting,
      { upsert: true },
    );
  }
  async listHolidays(year?: number) {
    const start = `${year}-01-01` as Holiday["date"];
    const end = `${(year ?? 0) + 1}-01-01` as Holiday["date"];
    const filter =
      year === undefined ? {} : { date: { $gte: start, $lt: end } };
    return (
      await this.collection<Holiday>("holidays")
        .find(filter)
        .sort({ date: 1 })
        .toArray()
    ).map(strip);
  }
  async saveHoliday(holiday: Holiday) {
    await this.collection<Holiday>("holidays").replaceOne(
      { id: holiday.id },
      holiday,
      { upsert: true },
    );
  }
  async listAlerts(filters: { employmentId?: string; active?: boolean } = {}) {
    const filter = {
      ...(filters.employmentId ? { employmentId: filters.employmentId } : {}),
      ...(filters.active === undefined ? {} : { active: filters.active }),
    };
    return (
      await this.collection<VacationAlert>("vacationAlerts")
        .find(filter)
        .sort({ asOf: -1, employmentId: 1 })
        .toArray()
    ).map(strip);
  }
  async saveAlert(alert: VacationAlert) {
    await this.collection<VacationAlert>("vacationAlerts").replaceOne(
      { id: alert.id },
      alert,
      { upsert: true },
    );
  }
  async listSchedulerRuns() {
    return (
      await this.collection<SchedulerRun>("schedulerRuns")
        .find({})
        .sort({ asOf: -1 })
        .toArray()
    ).map(strip);
  }
  async findSchedulerRunById(id: string) {
    const doc = await this.collection<SchedulerRun>("schedulerRuns").findOne({
      id,
    });
    return doc ? strip(doc) : null;
  }
  async saveSchedulerRun(run: SchedulerRun) {
    await this.collection<SchedulerRun>("schedulerRuns").replaceOne(
      { id: run.id },
      run,
      { upsert: true },
    );
  }
  async saveScheduleAndAudit(
    schedule: VacationSchedule,
    audit: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    },
  ) {
    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.collection<VacationSchedule>("vacationSchedules").replaceOne(
          { id: schedule.id },
          schedule,
          { upsert: true, session },
        );
        await this.collection<typeof audit>("auditEvents").insertOne(audit, {
          session,
        });
      });
    });
  }
  async completeScheduleTransaction(
    schedule: VacationSchedule,
    settlement: VacationSettlement,
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
  ) {
    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.collection<VacationSettlement>(
          "vacationSettlements",
        ).replaceOne({ id: settlement.id }, settlement, {
          upsert: true,
          session,
        });
        await this.collection<VacationSchedule>("vacationSchedules").replaceOne(
          { id: schedule.id },
          schedule,
          { upsert: true, session },
        );
        for (const event of audits)
          await this.collection<typeof event>("auditEvents").insertOne(event, {
            session,
          });
      });
    });
  }
  async closeRetiredEmploymentTransaction(
    employment: Employment,
    periods: VacationPeriod[],
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
  ) {
    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.collection<Employment>('employments').replaceOne(
          { id: employment.id },
          employment,
          { upsert: true, session },
        );
        if (periods.length)
          await this.collection<VacationPeriod>('vacationPeriods').bulkWrite(
            periods.map((period) => ({
              replaceOne: {
                filter: { id: period.id },
                replacement: period,
                upsert: true,
              },
            })),
            { session },
          );
        if (audits.length)
          await this.collection<(typeof audits)[number]>('auditEvents').insertMany(
            audits,
            { session },
          );
      });
    });
  }
  async closeRetiredEmploymentsTransaction(
    employments: Employment[],
    periods: VacationPeriod[],
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
  ) {
    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        if (employments.length)
          await this.collection<Employment>('employments').bulkWrite(
            employments.map((employment) => ({
              replaceOne: {
                filter: { id: employment.id },
                replacement: employment,
                upsert: true,
              },
            })),
            { session },
          );
        if (periods.length)
          await this.collection<VacationPeriod>('vacationPeriods').bulkWrite(
            periods.map((period) => ({
              replaceOne: {
                filter: { id: period.id },
                replacement: period,
                upsert: true,
              },
            })),
            { session },
          );
        if (audits.length)
          await this.collection<(typeof audits)[number]>('auditEvents').insertMany(
            audits,
            { session },
          );
      });
    });
  }
  async applyVacationSettlementImport(
    batch: VacationSettlementImportBatch,
    settlements: VacationSettlement[],
    periods: VacationPeriod[],
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
    schedules: VacationSchedule[] = [],
  ) {
    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        if (settlements.length)
          await this.collection<VacationSettlement>(
            "vacationSettlements",
          ).bulkWrite(
            settlements.map((settlement) => ({
              replaceOne: {
                filter: { id: settlement.id },
                replacement: settlement,
                upsert: true,
              },
            })),
            { session },
          );
        if (periods.length)
          await this.collection<VacationPeriod>("vacationPeriods").bulkWrite(
            periods.map((period) => ({
              replaceOne: {
                filter: { id: period.id },
                replacement: period,
                upsert: true,
              },
            })),
            { session },
          );
        if (schedules.length)
          await this.collection<VacationSchedule>("vacationSchedules").bulkWrite(
            schedules.map((schedule) => ({
              replaceOne: {
                filter: { id: schedule.id },
                replacement: schedule,
                upsert: true,
              },
            })),
            { session },
          );
        await this.collection<VacationSettlementImportBatch>(
          "vacationSettlementImportBatches",
        ).replaceOne({ id: batch.id }, batch, { upsert: true, session });
        for (const event of audits)
          await this.collection<typeof event>("auditEvents").insertOne(event, {
            session,
          });
      });
    });
  }
  async applyVacationPeriodClosure(
    batch: VacationPeriodClosureBatch,
    periods: VacationPeriod[],
    audits: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    }[],
  ) {
    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        if (periods.length)
          await this.collection<VacationPeriod>("vacationPeriods").bulkWrite(
            periods.map((period) => ({
              replaceOne: {
                filter: { id: period.id },
                replacement: period,
                upsert: true,
              },
            })),
            { session },
          );
        await this.collection<VacationPeriodClosureBatch>(
          "vacationPeriodClosureBatches",
        ).replaceOne({ id: batch.id }, batch, { upsert: true, session });
        if (audits.length)
          await this.collection<(typeof audits)[number]>("auditEvents").insertMany(
            audits,
            { session },
          );
      });
    });
  }
  async saveSettlementAndAudit(
    settlement: VacationSettlement,
    audit: {
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: unknown;
      createdAt: string;
    },
  ) {
    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.collection<VacationSettlement>(
          "vacationSettlements",
        ).replaceOne({ id: settlement.id }, settlement, {
          upsert: true,
          session,
        });
        await this.collection<typeof audit>("auditEvents").insertOne(audit, {
          session,
        });
      });
    });
  }
  async listUsers() {
    return (
      await this.collection<User>("users")
        .find({})
        .sort({ username: 1 })
        .toArray()
    ).map(strip);
  }
  async findUserByUsername(username: string) {
    const doc = await this.collection<User>("users").findOne({ username });
    return doc ? strip(doc) : null;
  }
  async saveUser(user: User) {
    await this.collection<User>("users").replaceOne({ id: user.id }, user, {
      upsert: true,
    });
  }
  async current(asOf: import("../../../domain/shared/localDate.js").LocalDate) {
    const policy = await this.collection<VacationPolicy>(
      "vacationPolicies",
    ).findOne(
      { active: true, effectiveFrom: { $lte: asOf } },
      { sort: { effectiveFrom: -1 } },
    );
    if (policy) return strip(policy);
    const initial: VacationPolicy = {
      id: "default",
      effectiveFrom: "2026-01-01",
      daysPerCompletedYear: 15,
      overdueAfterMonths: 12,
      upcomingAccrualAlerts: [30, 60, 90],
      active: true,
    };
    await this.collection<VacationPolicy>("vacationPolicies").insertOne(
      initial,
    );
    return initial;
  }
  async savePolicy(policy: VacationPolicy) {
    await this.collection<VacationPolicy>("vacationPolicies").replaceOne(
      { id: policy.id },
      policy,
      { upsert: true },
    );
  }
  async append(event: {
    id: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    metadata: unknown;
    createdAt: string;
  }) {
    await this.collection<typeof event>("auditEvents").insertOne(event);
  }
  async listAudits() {
    return (
      await this.collection<unknown>("auditEvents")
        .find({})
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray()
    ).map((doc) => strip(doc as Stored<unknown>));
  }
  async close() {
    await this.client.close();
  }
  async ping() {
    await this.db.command({ ping: 1 });
  }
  async resetVacationDatabase() {
    const collections = [
      "workers",
      "employments",
      "vacationPeriods",
      "vacationSchedules",
      "vacationSettlements",
      "vacationPolicies",
      "auditEvents",
      "importBatches",
      "vacationSettlementImportBatches",
      "sessions",
      "catalogItems",
      "holidays",
      "vacationAlerts",
      "schedulerRuns",
      "users",
    ];
    await Promise.all(
      collections.map((name) => this.db.collection(name).deleteMany({})),
    );
    await this.ensureIndexes();
  }
}
