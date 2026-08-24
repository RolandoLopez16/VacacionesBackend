import type { CatalogItem } from "../../../domain/admin/catalog.js";
import type { Holiday } from "../../../domain/admin/holiday.js";
import type { SystemSetting } from "../../../domain/admin/settings.js";
import type { User } from "../../../domain/auth/models.js";
import type { Session } from "../../../domain/auth/session.js";
import type { AuditEvent } from "../../../application/ports/repositories.js";
import type { VacationAlert } from "../../../domain/vacations/alerts.js";
import type {
  ImportBatch,
  VacationPendingPeriodImportBatch,
  VacationPeriod,
  VacationPeriodClosureBatch,
  VacationPolicy,
  VacationSchedule,
  VacationSettlement,
  VacationSettlementImportBatch,
} from "../../../domain/vacations/models.js";
import type { SchedulerRun } from "../../../domain/vacations/schedulerRun.js";
import type { Employment, Worker } from "../../../domain/workers/models.js";

export class MemoryContext {
  readonly workers = new Map<string, Worker>();
  readonly employments = new Map<string, Employment>();
  readonly periods = new Map<string, VacationPeriod>();
  readonly schedules = new Map<string, VacationSchedule>();
  readonly settlements = new Map<string, VacationSettlement>();
  readonly importBatches = new Map<string, ImportBatch>();
  readonly settlementImportBatches = new Map<string, VacationSettlementImportBatch>();
  readonly vacationPeriodClosureBatches = new Map<string, VacationPeriodClosureBatch>();
  readonly vacationPendingPeriodImportBatches = new Map<string, VacationPendingPeriodImportBatch>();
  readonly sessions = new Map<string, Session>();
  readonly catalogs = new Map<string, CatalogItem>();
  readonly systemSettings = new Map<string, SystemSetting>();
  readonly holidays = new Map<string, Holiday>();
  readonly alerts = new Map<string, VacationAlert>();
  readonly schedulerRuns = new Map<string, SchedulerRun>();
  readonly users = new Map<string, User>();
  readonly audits: AuditEvent[] = [];
  policy: VacationPolicy = {
    id: "default",
    effectiveFrom: "2026-01-01",
    daysPerCompletedYear: 15,
    overdueAfterMonths: 12,
    upcomingAccrualAlerts: [30, 60, 90],
    active: true,
  };

  async atomic<T>(operation: () => T | Promise<T>): Promise<T> {
    const restorers = this.snapshotMaps();
    const audits = this.audits.slice();
    const policy = this.policy;
    try {
      return await operation();
    } catch (error) {
      restorers.forEach((restore) => restore());
      this.audits.splice(0, this.audits.length, ...audits);
      this.policy = policy;
      throw error;
    }
  }

  private snapshotMaps() {
    const snapshot = <T>(target: Map<string, T>) => {
      const values = new Map(target);
      return () => {
        target.clear();
        values.forEach((value, key) => target.set(key, value));
      };
    };
    return [
      snapshot(this.workers),
      snapshot(this.employments),
      snapshot(this.periods),
      snapshot(this.schedules),
      snapshot(this.settlements),
      snapshot(this.importBatches),
      snapshot(this.settlementImportBatches),
      snapshot(this.vacationPeriodClosureBatches),
      snapshot(this.vacationPendingPeriodImportBatches),
      snapshot(this.sessions),
      snapshot(this.catalogs),
      snapshot(this.systemSettings),
      snapshot(this.holidays),
      snapshot(this.alerts),
      snapshot(this.schedulerRuns),
      snapshot(this.users),
    ];
  }
}
