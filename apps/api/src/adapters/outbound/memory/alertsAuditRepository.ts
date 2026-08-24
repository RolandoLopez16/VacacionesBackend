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
import type { MemoryContext } from "./memoryContext.js";

function slice<T>(items: T[], page: number, pageSize: number): { items: T[]; total: number } {
  const total = items.length;
  const start = Math.max(0, (page - 1) * pageSize);
  return { items: items.slice(start, start + pageSize), total };
}

export class MemoryAlertsAuditRepository
  implements AlertRepository, SchedulerRunRepository, AuditRepository
{
  constructor(private readonly context: MemoryContext) {}

  async listAlerts(filters: { employmentId?: string; active?: boolean } = {}) {
    return [...this.context.alerts.values()]
      .filter(
        (alert) =>
          (filters.employmentId === undefined || alert.employmentId === filters.employmentId) &&
          (filters.active === undefined || alert.active === filters.active),
      )
      .sort((a, b) => a.asOf.localeCompare(b.asOf) || a.employmentId.localeCompare(b.employmentId));
  }

  async listAlertsPage(query: AlertPageQuery): Promise<PagedAlerts> {
    const all = [...this.context.alerts.values()].filter((alert) => {
      if (query.employmentId !== undefined && alert.employmentId !== query.employmentId)
        return false;
      if (query.severity !== undefined && alert.severity !== query.severity) return false;
      if (query.type !== undefined && alert.type !== query.type) return false;
      if (query.active !== undefined && alert.active !== query.active) return false;
      return true;
    });
    all.sort(
      (a, b) => b.asOf.localeCompare(a.asOf) || a.employmentId.localeCompare(b.employmentId),
    );
    return slice(all, query.page, query.pageSize);
  }

  async saveAlert(alert: VacationAlert) {
    this.context.alerts.set(alert.id, alert);
  }

  async listSchedulerRuns() {
    return [...this.context.schedulerRuns.values()].sort((a, b) => b.asOf.localeCompare(a.asOf));
  }

  async findSchedulerRunById(id: string) {
    return this.context.schedulerRuns.get(id) ?? null;
  }

  async saveSchedulerRun(run: SchedulerRun) {
    this.context.schedulerRuns.set(run.id, run);
  }

  async listSchedulerRunsPage(query: SchedulerRunPageQuery): Promise<PagedSchedulerRuns> {
    const all = [...this.context.schedulerRuns.values()].filter((run) => {
      if (query.jobName !== undefined && run.jobName !== query.jobName) return false;
      if (query.status !== undefined && run.status !== query.status) return false;
      if (query.fromDate !== undefined && run.asOf < query.fromDate) return false;
      if (query.toDate !== undefined && run.asOf > query.toDate) return false;
      return true;
    });
    all.sort((a, b) => b.asOf.localeCompare(a.asOf));
    return slice(all, query.page, query.pageSize);
  }

  async append(event: AuditEvent) {
    this.context.audits.push(event);
  }

  async listAudits() {
    return this.context.audits as AuditEvent[];
  }

  async listAuditsPage(query: AuditPageQuery): Promise<PagedAudits> {
    const all = this.context.audits.filter((event) => {
      if (query.actorId !== undefined && event.actorId !== query.actorId) return false;
      if (query.action !== undefined && event.action !== query.action) return false;
      if (query.entityType !== undefined && event.entityType !== query.entityType) return false;
      if (query.entityId !== undefined && event.entityId !== query.entityId) return false;
      if (query.fromDate !== undefined && event.createdAt < query.fromDate) return false;
      if (query.toDate !== undefined && event.createdAt > query.toDate) return false;
      return true;
    });
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return slice(all, query.page, query.pageSize);
  }
}
