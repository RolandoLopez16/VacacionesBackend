import { today, type LocalDate } from "../../domain/shared/localDate.js";
import type { VacationAlert } from "../../domain/vacations/alerts.js";
import type { SchedulerRun } from "../../domain/vacations/schedulerRun.js";
import type { VacationStore } from "../ports/repositories.js";
import { VacationService } from "./vacationService.js";

export class VacationAccrualScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly store: VacationStore,
    private readonly service = new VacationService(store),
    private readonly clock: () => LocalDate = today,
  ) {}
  async runOnce(asOf: LocalDate = this.clock()) {
    const runId = `VACATION_ACCRUAL:${asOf}`;
    const existing = await this.store.findSchedulerRunById(runId);
    if (existing?.status === "COMPLETED")
      return {
        processed: existing.processedEmployments,
        generatedPeriods: existing.generatedPeriods,
        generatedAlerts: existing.generatedAlerts,
        asOf,
        replayed: true,
      };
    const startedAt = new Date().toISOString();
    const run: SchedulerRun = {
      id: runId,
      jobName: "VACATION_ACCRUAL",
      asOf,
      status: "RUNNING",
      processedEmployments: 0,
      generatedPeriods: 0,
      generatedAlerts: 0,
      startedAt,
    };
    await this.store.saveSchedulerRun(run);
    try {
      for (const employment of await this.store.listEmployments()) {
        if (employment.status !== "ACTIVE") continue;
        const before = (await this.store.findByEmploymentId(employment.id)).length;
        const after = await this.service.ensure(employment, asOf);
        run.processedEmployments++;
        run.generatedPeriods += Math.max(0, after.length - before);
      }
      const generated = await this.service.alerts(asOf);
      const previous = await this.store.listAlerts();
      for (const alert of generated) {
        const id = `${alert.asOf}:${alert.employmentId}:${alert.type}`;
        const prior = previous.find((item) => item.id === id);
        const persisted: VacationAlert = {
          ...alert,
          id,
          active: true,
          createdAt: prior?.createdAt ?? startedAt,
          updatedAt: new Date().toISOString(),
        };
        await this.store.saveAlert(persisted);
      }
      const completed: SchedulerRun = {
        ...run,
        status: "COMPLETED",
        generatedAlerts: generated.length,
        finishedAt: new Date().toISOString(),
      };
      await this.store.saveSchedulerRun(completed);
      return {
        processed: completed.processedEmployments,
        generatedPeriods: completed.generatedPeriods,
        generatedAlerts: completed.generatedAlerts,
        asOf,
      };
    } catch (error) {
      const failed: SchedulerRun = {
        ...run,
        status: "FAILED",
        finishedAt: new Date().toISOString(),
        errorMessage: error instanceof Error ? error.message : "Unexpected error",
      };
      await this.store.saveSchedulerRun(failed);
      throw error;
    }
  }
  start(intervalMs: number) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) =>
        console.error(
          JSON.stringify({
            level: "error",
            event: "vacation_accrual_scheduler_failed",
            message: error instanceof Error ? error.message : "Unexpected error",
          }),
        ),
      );
    }, intervalMs);
    this.timer.unref?.();
    void this.runOnce().catch((error) =>
      console.error(
        JSON.stringify({
          level: "error",
          event: "vacation_accrual_scheduler_failed",
          message: error instanceof Error ? error.message : "Unexpected error",
        }),
      ),
    );
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
