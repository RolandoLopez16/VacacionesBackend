import type {
  AlertPageQuery,
  AlertRepository,
  AuditEvent,
  AuditPageQuery,
  AuditRepository,
  PagedAlerts,
  PagedAudits,
  PagedSchedulerRuns,
  SchedulerRunPageQuery,
  SchedulerRunRepository,
} from "../../../application/ports/repositories.js";
import type { VacationAlert } from "../../../domain/vacations/alerts.js";
import type { SchedulerRun } from "../../../domain/vacations/schedulerRun.js";
import { type MongoContext, strip } from "./mongoContext.js";

export class MongoAlertsAuditRepository
  implements AlertRepository, SchedulerRunRepository, AuditRepository
{
  constructor(private readonly context: MongoContext) {}

  async listAlerts(filters: { employmentId?: string; active?: boolean } = {}) {
    const filter = {
      ...(filters.employmentId ? { employmentId: filters.employmentId } : {}),
      ...(filters.active === undefined ? {} : { active: filters.active }),
    };
    return (
      await this.context
        .collection<VacationAlert>("vacationAlerts")
        .find(filter)
        .sort({ asOf: -1, employmentId: 1 })
        .toArray()
    ).map(strip);
  }

  async listAlertsPage(query: AlertPageQuery): Promise<PagedAlerts> {
    const filter: Record<string, unknown> = {};
    if (query.employmentId !== undefined) filter.employmentId = query.employmentId;
    if (query.severity !== undefined) filter.severity = query.severity;
    if (query.type !== undefined) filter.type = query.type;
    if (query.active !== undefined) filter.active = query.active;
    const skip = (query.page - 1) * query.pageSize;
    const [facet] = await this.context
      .collection<VacationAlert>("vacationAlerts")
      .aggregate([
        { $match: filter },
        { $sort: { asOf: -1, employmentId: 1 } },
        {
          $facet: {
            items: [{ $skip: skip }, { $limit: query.pageSize }],
            meta: [{ $count: "value" }],
          },
        },
      ])
      .toArray();
    const items = ((facet?.items as VacationAlert[]) ?? []).map(strip);
    const total = (facet?.meta as Array<{ value: number }> | undefined)?.[0]?.value ?? 0;
    return { items, total };
  }

  async saveAlert(alert: VacationAlert) {
    await this.context
      .collection<VacationAlert>("vacationAlerts")
      .replaceOne({ id: alert.id }, alert, { upsert: true });
  }

  async listSchedulerRuns() {
    return (
      await this.context
        .collection<SchedulerRun>("schedulerRuns")
        .find({})
        .sort({ asOf: -1 })
        .toArray()
    ).map(strip);
  }

  async findSchedulerRunById(id: string) {
    const document = await this.context.collection<SchedulerRun>("schedulerRuns").findOne({ id });
    return document ? strip(document) : null;
  }

  async saveSchedulerRun(run: SchedulerRun) {
    await this.context
      .collection<SchedulerRun>("schedulerRuns")
      .replaceOne({ id: run.id }, run, { upsert: true });
  }

  async listSchedulerRunsPage(query: SchedulerRunPageQuery): Promise<PagedSchedulerRuns> {
    const filter: Record<string, unknown> = {};
    if (query.jobName !== undefined) filter.jobName = query.jobName;
    if (query.status !== undefined) filter.status = query.status;
    if (query.fromDate !== undefined)
      filter.asOf = { ...((filter.asOf as object) ?? {}), $gte: query.fromDate };
    if (query.toDate !== undefined)
      filter.asOf = { ...((filter.asOf as object) ?? {}), $lte: query.toDate };
    const skip = (query.page - 1) * query.pageSize;
    const [facet] = await this.context
      .collection<SchedulerRun>("schedulerRuns")
      .aggregate([
        { $match: filter },
        { $sort: { asOf: -1 } },
        {
          $facet: {
            items: [{ $skip: skip }, { $limit: query.pageSize }],
            meta: [{ $count: "value" }],
          },
        },
      ])
      .toArray();
    const items = ((facet?.items as SchedulerRun[]) ?? []).map(strip);
    const total = (facet?.meta as Array<{ value: number }> | undefined)?.[0]?.value ?? 0;
    return { items, total };
  }

  async append(event: AuditEvent) {
    await this.context.collection<AuditEvent>("auditEvents").insertOne(event);
  }

  async listAudits() {
    return (
      await this.context
        .collection<AuditEvent>("auditEvents")
        .find({})
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray()
    ).map(strip);
  }

  async listAuditsPage(query: AuditPageQuery): Promise<PagedAudits> {
    const filter: Record<string, unknown> = {};
    if (query.actorId !== undefined) filter.actorId = query.actorId;
    if (query.action !== undefined) filter.action = query.action;
    if (query.entityType !== undefined) filter.entityType = query.entityType;
    if (query.entityId !== undefined) filter.entityId = query.entityId;
    if (query.fromDate !== undefined || query.toDate !== undefined) {
      filter.createdAt = {
        ...(query.fromDate !== undefined ? { $gte: query.fromDate } : {}),
        ...(query.toDate !== undefined ? { $lte: query.toDate } : {}),
      };
    }
    const skip = (query.page - 1) * query.pageSize;
    const [facet] = await this.context
      .collection<AuditEvent>("auditEvents")
      .aggregate([
        { $match: filter },
        { $sort: { createdAt: -1 } },
        {
          $facet: {
            items: [{ $skip: skip }, { $limit: query.pageSize }],
            meta: [{ $count: "value" }],
          },
        },
      ])
      .toArray();
    const items = ((facet?.items as AuditEvent[]) ?? []).map(strip);
    const total = (facet?.meta as Array<{ value: number }> | undefined)?.[0]?.value ?? 0;
    return { items, total };
  }
}
