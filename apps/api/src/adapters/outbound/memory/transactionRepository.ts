import type { TransactionRepository } from "../../../application/ports/repositories.js";
import { ConflictError } from "../../../domain/shared/errors.js";
import type { MemoryContext } from "./memoryContext.js";

export class MemoryTransactionRepository implements TransactionRepository {
  constructor(private readonly context: MemoryContext) {}

  async applyEmploymentImport(
    ...[batch, workers, employments, periods, audits, startedAtMs]: Parameters<
      TransactionRepository["applyEmploymentImport"]
    >
  ) {
    return this.context.atomic(() => {
      const current = this.context.importBatches.get(batch.idempotencyKey);
      if (current?.status !== "PROCESSING" || (current.attempt ?? 0) !== (batch.attempt ?? 0))
        throw new ConflictError("The import batch attempt was superseded");
      workers.forEach((worker) => this.context.workers.set(worker.id, worker));
      employments.forEach((employment) => this.context.employments.set(employment.id, employment));
      periods.forEach((period) => this.context.periods.set(period.id, period));
      audits.forEach((audit) => this.context.audits.push(audit));
      const completed = {
        ...batch,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
      this.context.importBatches.set(completed.idempotencyKey, completed);
      return completed;
    });
  }

  async saveScheduleAndAudit(
    ...[schedule, audit]: Parameters<TransactionRepository["saveScheduleAndAudit"]>
  ) {
    await this.context.atomic(() => {
      this.context.schedules.set(schedule.id, schedule);
      this.context.audits.push(audit);
    });
  }

  async completeScheduleTransaction(
    ...[schedule, settlement, audits]: Parameters<
      TransactionRepository["completeScheduleTransaction"]
    >
  ) {
    await this.context.atomic(() => {
      this.context.settlements.set(settlement.id, settlement);
      this.context.schedules.set(schedule.id, schedule);
      audits.forEach((audit) => this.context.audits.push(audit));
    });
  }

  async closeRetiredEmploymentTransaction(
    ...[employment, periods, audits]: Parameters<
      TransactionRepository["closeRetiredEmploymentTransaction"]
    >
  ) {
    await this.context.atomic(() => {
      this.context.employments.set(employment.id, employment);
      periods.forEach((period) => this.context.periods.set(period.id, period));
      audits.forEach((audit) => this.context.audits.push(audit));
    });
  }

  async closeRetiredEmploymentsTransaction(
    ...[employments, periods, audits]: Parameters<
      TransactionRepository["closeRetiredEmploymentsTransaction"]
    >
  ) {
    await this.context.atomic(() => {
      employments.forEach((employment) => this.context.employments.set(employment.id, employment));
      periods.forEach((period) => this.context.periods.set(period.id, period));
      audits.forEach((audit) => this.context.audits.push(audit));
    });
  }

  async applyVacationSettlementImport(
    ...[batch, settlements, periods, audits, schedules = []]: Parameters<
      TransactionRepository["applyVacationSettlementImport"]
    >
  ) {
    await this.context.atomic(() => {
      settlements.forEach((settlement) => this.context.settlements.set(settlement.id, settlement));
      periods.forEach((period) => this.context.periods.set(period.id, period));
      schedules.forEach((schedule) => this.context.schedules.set(schedule.id, schedule));
      this.context.settlementImportBatches.set(batch.id, batch);
      audits.forEach((audit) => this.context.audits.push(audit));
    });
  }

  async applyVacationPeriodClosure(
    ...[batch, periods, audits]: Parameters<TransactionRepository["applyVacationPeriodClosure"]>
  ) {
    await this.context.atomic(() => {
      periods.forEach((period) => this.context.periods.set(period.id, period));
      this.context.vacationPeriodClosureBatches.set(batch.id, batch);
      audits.forEach((audit) => this.context.audits.push(audit));
    });
  }

  async applyVacationPendingPeriodImport(
    ...[batch, periods, audits]: Parameters<
      TransactionRepository["applyVacationPendingPeriodImport"]
    >
  ) {
    await this.context.atomic(() => {
      periods.forEach((period) => this.context.periods.set(period.id, period));
      this.context.vacationPendingPeriodImportBatches.set(batch.id, batch);
      audits.forEach((audit) => this.context.audits.push(audit));
    });
  }

  async saveSettlementAndAudit(
    ...[settlement, audit]: Parameters<TransactionRepository["saveSettlementAndAudit"]>
  ) {
    await this.context.atomic(() => {
      this.context.settlements.set(settlement.id, settlement);
      this.context.audits.push(audit);
    });
  }
}
