import type { VacationStore } from "../../../application/ports/repositories.js";
import { MemoryAdminAuthRepository } from "./adminAuthRepository.js";
import { MemoryAlertsAuditRepository } from "./alertsAuditRepository.js";
import { MemoryImportRepository } from "./importRepository.js";
import { MemoryContext } from "./memoryContext.js";
import { MemoryPeriodRepository } from "./periodRepository.js";
import { MemoryScheduleRepository } from "./scheduleRepository.js";
import { MemorySettlementRepository } from "./settlementRepository.js";
import { MemoryTransactionRepository } from "./transactionRepository.js";
import { MemoryWorkersEmploymentsRepository } from "./workersEmploymentsRepository.js";

export class MemoryStore implements VacationStore {
  workers: MemoryContext["workers"];
  employments: MemoryContext["employments"];
  periods: MemoryContext["periods"];
  schedules: MemoryContext["schedules"];
  settlements: MemoryContext["settlements"];
  importBatches: MemoryContext["importBatches"];
  settlementImportBatches: MemoryContext["settlementImportBatches"];
  vacationPeriodClosureBatches: MemoryContext["vacationPeriodClosureBatches"];
  vacationPendingPeriodImportBatches: MemoryContext["vacationPendingPeriodImportBatches"];
  sessions: MemoryContext["sessions"];
  catalogs: MemoryContext["catalogs"];
  systemSettings: MemoryContext["systemSettings"];
  holidays: MemoryContext["holidays"];
  alerts: MemoryContext["alerts"];
  schedulerRuns: MemoryContext["schedulerRuns"];
  users: MemoryContext["users"];
  audits: MemoryContext["audits"];

  private readonly context: MemoryContext;
  private readonly workersEmployments: MemoryWorkersEmploymentsRepository;
  private readonly periodsRepository: MemoryPeriodRepository;
  private readonly schedulesRepository: MemoryScheduleRepository;
  private readonly settlementsRepository: MemorySettlementRepository;
  private readonly importsRepository: MemoryImportRepository;
  private readonly adminAuthRepository: MemoryAdminAuthRepository;
  private readonly alertsAuditRepository: MemoryAlertsAuditRepository;
  private readonly transactionsRepository: MemoryTransactionRepository;

  constructor() {
    this.context = new MemoryContext();
    this.workers = this.context.workers;
    this.employments = this.context.employments;
    this.periods = this.context.periods;
    this.schedules = this.context.schedules;
    this.settlements = this.context.settlements;
    this.importBatches = this.context.importBatches;
    this.settlementImportBatches = this.context.settlementImportBatches;
    this.vacationPeriodClosureBatches = this.context.vacationPeriodClosureBatches;
    this.vacationPendingPeriodImportBatches = this.context.vacationPendingPeriodImportBatches;
    this.sessions = this.context.sessions;
    this.catalogs = this.context.catalogs;
    this.systemSettings = this.context.systemSettings;
    this.holidays = this.context.holidays;
    this.alerts = this.context.alerts;
    this.schedulerRuns = this.context.schedulerRuns;
    this.users = this.context.users;
    this.audits = this.context.audits;
    this.workersEmployments = new MemoryWorkersEmploymentsRepository(this.context);
    this.periodsRepository = new MemoryPeriodRepository(this.context);
    this.schedulesRepository = new MemoryScheduleRepository(this.context);
    this.settlementsRepository = new MemorySettlementRepository(this.context);
    this.importsRepository = new MemoryImportRepository(this.context);
    this.adminAuthRepository = new MemoryAdminAuthRepository(this.context);
    this.alertsAuditRepository = new MemoryAlertsAuditRepository(this.context);
    this.transactionsRepository = new MemoryTransactionRepository(this.context);
  }

  get policy(): MemoryContext["policy"] {
    return this.context.policy;
  }
  set policy(policy: MemoryContext["policy"]) {
    this.context.policy = policy;
  }
  listWorkers(...args: Parameters<VacationStore["listWorkers"]>) {
    return this.workersEmployments.listWorkers(...args);
  }
  listWorkersByIds(...args: Parameters<VacationStore["listWorkersByIds"]>) {
    return this.workersEmployments.listWorkersByIds(...args);
  }
  findWorkersByNormalizedDocuments(
    ...args: Parameters<VacationStore["findWorkersByNormalizedDocuments"]>
  ) {
    return this.workersEmployments.findWorkersByNormalizedDocuments(...args);
  }
  findWorkerById(...args: Parameters<VacationStore["findWorkerById"]>) {
    return this.workersEmployments.findWorkerById(...args);
  }
  findWorkerByNormalizedDocument(
    ...args: Parameters<VacationStore["findWorkerByNormalizedDocument"]>
  ) {
    return this.workersEmployments.findWorkerByNormalizedDocument(...args);
  }
  saveWorker(...args: Parameters<VacationStore["saveWorker"]>) {
    return this.workersEmployments.saveWorker(...args);
  }
  listEmployments(...args: Parameters<VacationStore["listEmployments"]>) {
    return this.workersEmployments.listEmployments(...args);
  }
  findEmploymentsByIds(...args: Parameters<VacationStore["findEmploymentsByIds"]>) {
    return this.workersEmployments.findEmploymentsByIds(...args);
  }
  findEmploymentsByWorkerIds(...args: Parameters<VacationStore["findEmploymentsByWorkerIds"]>) {
    return this.workersEmployments.findEmploymentsByWorkerIds(...args);
  }
  listEmploymentsByFilter(...args: Parameters<VacationStore["listEmploymentsByFilter"]>) {
    return this.workersEmployments.listEmploymentsByFilter(...args);
  }
  listEmploymentPage(...args: Parameters<VacationStore["listEmploymentPage"]>) {
    return this.workersEmployments.listEmploymentPage(...args);
  }
  findEmploymentById(...args: Parameters<VacationStore["findEmploymentById"]>) {
    return this.workersEmployments.findEmploymentById(...args);
  }
  findEmploymentByWorkerAndStartDate(
    ...args: Parameters<VacationStore["findEmploymentByWorkerAndStartDate"]>
  ) {
    return this.workersEmployments.findEmploymentByWorkerAndStartDate(...args);
  }
  saveEmployment(...args: Parameters<VacationStore["saveEmployment"]>) {
    return this.workersEmployments.saveEmployment(...args);
  }
  findByEmploymentId(...args: Parameters<VacationStore["findByEmploymentId"]>) {
    return this.periodsRepository.findByEmploymentId(...args);
  }
  findByEmploymentIds(...args: Parameters<VacationStore["findByEmploymentIds"]>) {
    return this.periodsRepository.findByEmploymentIds(...args);
  }
  findPeriodById(...args: Parameters<VacationStore["findPeriodById"]>) {
    return this.periodsRepository.findPeriodById(...args);
  }
  saveMany(...args: Parameters<VacationStore["saveMany"]>) {
    return this.periodsRepository.saveMany(...args);
  }
  listSchedules(...args: Parameters<VacationStore["listSchedules"]>) {
    return this.schedulesRepository.listSchedules(...args);
  }
  listSchedulePage(...args: Parameters<VacationStore["listSchedulePage"]>) {
    return this.schedulesRepository.listSchedulePage(...args);
  }
  listAnnualScheduleReport(...args: Parameters<VacationStore["listAnnualScheduleReport"]>) {
    return this.schedulesRepository.listAnnualScheduleReport(...args);
  }
  findSchedulesByEmploymentIds(...args: Parameters<VacationStore["findSchedulesByEmploymentIds"]>) {
    return this.schedulesRepository.findSchedulesByEmploymentIds(...args);
  }
  findSchedulesByIds(...args: Parameters<VacationStore["findSchedulesByIds"]>) {
    return this.schedulesRepository.findSchedulesByIds(...args);
  }
  findScheduleById(...args: Parameters<VacationStore["findScheduleById"]>) {
    return this.schedulesRepository.findScheduleById(...args);
  }
  saveSchedule(...args: Parameters<VacationStore["saveSchedule"]>) {
    return this.schedulesRepository.saveSchedule(...args);
  }
  listSettlements(...args: Parameters<VacationStore["listSettlements"]>) {
    return this.settlementsRepository.listSettlements(...args);
  }
  listSettlementPage(...args: Parameters<VacationStore["listSettlementPage"]>) {
    return this.settlementsRepository.listSettlementPage(...args);
  }
  findSettlementsByEmploymentIds(
    ...args: Parameters<VacationStore["findSettlementsByEmploymentIds"]>
  ) {
    return this.settlementsRepository.findSettlementsByEmploymentIds(...args);
  }
  findSettlementById(...args: Parameters<VacationStore["findSettlementById"]>) {
    return this.settlementsRepository.findSettlementById(...args);
  }
  findSettlementBySourceKey(...args: Parameters<VacationStore["findSettlementBySourceKey"]>) {
    return this.settlementsRepository.findSettlementBySourceKey(...args);
  }
  saveSettlement(...args: Parameters<VacationStore["saveSettlement"]>) {
    return this.settlementsRepository.saveSettlement(...args);
  }
  findImportBatchByIdempotencyKey(
    ...args: Parameters<VacationStore["findImportBatchByIdempotencyKey"]>
  ) {
    return this.importsRepository.findImportBatchByIdempotencyKey(...args);
  }
  findImportBatchById(...args: Parameters<VacationStore["findImportBatchById"]>) {
    return this.importsRepository.findImportBatchById(...args);
  }
  claimImportBatch(...args: Parameters<VacationStore["claimImportBatch"]>) {
    return this.importsRepository.claimImportBatch(...args);
  }
  markImportBatchFailed(...args: Parameters<VacationStore["markImportBatchFailed"]>) {
    return this.importsRepository.markImportBatchFailed(...args);
  }
  saveImportBatch(...args: Parameters<VacationStore["saveImportBatch"]>) {
    return this.importsRepository.saveImportBatch(...args);
  }
  listImportBatchesPage(...args: Parameters<VacationStore["listImportBatchesPage"]>) {
    return this.importsRepository.listImportBatchesPage(...args);
  }
  findVacationSettlementImportBatch(
    ...args: Parameters<VacationStore["findVacationSettlementImportBatch"]>
  ) {
    return this.importsRepository.findVacationSettlementImportBatch(...args);
  }
  findVacationSettlementImportByFileHash(
    ...args: Parameters<VacationStore["findVacationSettlementImportByFileHash"]>
  ) {
    return this.importsRepository.findVacationSettlementImportByFileHash(...args);
  }
  saveVacationSettlementImportBatch(
    ...args: Parameters<VacationStore["saveVacationSettlementImportBatch"]>
  ) {
    return this.importsRepository.saveVacationSettlementImportBatch(...args);
  }
  findVacationPeriodClosureBatch(
    ...args: Parameters<VacationStore["findVacationPeriodClosureBatch"]>
  ) {
    return this.importsRepository.findVacationPeriodClosureBatch(...args);
  }
  findVacationPeriodClosureByFileHash(
    ...args: Parameters<VacationStore["findVacationPeriodClosureByFileHash"]>
  ) {
    return this.importsRepository.findVacationPeriodClosureByFileHash(...args);
  }
  saveVacationPeriodClosureBatch(
    ...args: Parameters<VacationStore["saveVacationPeriodClosureBatch"]>
  ) {
    return this.importsRepository.saveVacationPeriodClosureBatch(...args);
  }
  findVacationPendingPeriodImportBatch(
    ...args: Parameters<VacationStore["findVacationPendingPeriodImportBatch"]>
  ) {
    return this.importsRepository.findVacationPendingPeriodImportBatch(...args);
  }
  findVacationPendingPeriodImportByFileHash(
    ...args: Parameters<VacationStore["findVacationPendingPeriodImportByFileHash"]>
  ) {
    return this.importsRepository.findVacationPendingPeriodImportByFileHash(...args);
  }
  saveVacationPendingPeriodImportBatch(
    ...args: Parameters<VacationStore["saveVacationPendingPeriodImportBatch"]>
  ) {
    return this.importsRepository.saveVacationPendingPeriodImportBatch(...args);
  }
  findSessionById(...args: Parameters<VacationStore["findSessionById"]>) {
    return this.adminAuthRepository.findSessionById(...args);
  }
  saveSession(...args: Parameters<VacationStore["saveSession"]>) {
    return this.adminAuthRepository.saveSession(...args);
  }
  revokeSession(...args: Parameters<VacationStore["revokeSession"]>) {
    return this.adminAuthRepository.revokeSession(...args);
  }
  listCatalog(...args: Parameters<VacationStore["listCatalog"]>) {
    return this.adminAuthRepository.listCatalog(...args);
  }
  listCatalogPage(...args: Parameters<VacationStore["listCatalogPage"]>) {
    return this.adminAuthRepository.listCatalogPage(...args);
  }
  saveCatalog(...args: Parameters<VacationStore["saveCatalog"]>) {
    return this.adminAuthRepository.saveCatalog(...args);
  }
  findSystemSettingByKey(...args: Parameters<VacationStore["findSystemSettingByKey"]>) {
    return this.adminAuthRepository.findSystemSettingByKey(...args);
  }
  saveSystemSetting(...args: Parameters<VacationStore["saveSystemSetting"]>) {
    return this.adminAuthRepository.saveSystemSetting(...args);
  }
  listHolidays(...args: Parameters<VacationStore["listHolidays"]>) {
    return this.adminAuthRepository.listHolidays(...args);
  }
  listHolidaysPage(...args: Parameters<VacationStore["listHolidaysPage"]>) {
    return this.adminAuthRepository.listHolidaysPage(...args);
  }
  saveHoliday(...args: Parameters<VacationStore["saveHoliday"]>) {
    return this.adminAuthRepository.saveHoliday(...args);
  }
  listAlerts(...args: Parameters<VacationStore["listAlerts"]>) {
    return this.alertsAuditRepository.listAlerts(...args);
  }
  listAlertsPage(...args: Parameters<VacationStore["listAlertsPage"]>) {
    return this.alertsAuditRepository.listAlertsPage(...args);
  }
  saveAlert(...args: Parameters<VacationStore["saveAlert"]>) {
    return this.alertsAuditRepository.saveAlert(...args);
  }
  listSchedulerRuns(...args: Parameters<VacationStore["listSchedulerRuns"]>) {
    return this.alertsAuditRepository.listSchedulerRuns(...args);
  }
  listSchedulerRunsPage(...args: Parameters<VacationStore["listSchedulerRunsPage"]>) {
    return this.alertsAuditRepository.listSchedulerRunsPage(...args);
  }
  findSchedulerRunById(...args: Parameters<VacationStore["findSchedulerRunById"]>) {
    return this.alertsAuditRepository.findSchedulerRunById(...args);
  }
  saveSchedulerRun(...args: Parameters<VacationStore["saveSchedulerRun"]>) {
    return this.alertsAuditRepository.saveSchedulerRun(...args);
  }
  append(...args: Parameters<VacationStore["append"]>) {
    return this.alertsAuditRepository.append(...args);
  }
  listAudits(...args: Parameters<VacationStore["listAudits"]>) {
    return this.alertsAuditRepository.listAudits(...args);
  }
  listAuditsPage(...args: Parameters<VacationStore["listAuditsPage"]>) {
    return this.alertsAuditRepository.listAuditsPage(...args);
  }
  listUsers(...args: Parameters<VacationStore["listUsers"]>) {
    return this.adminAuthRepository.listUsers(...args);
  }
  listUsersPage(...args: Parameters<VacationStore["listUsersPage"]>) {
    return this.adminAuthRepository.listUsersPage(...args);
  }
  findUserByUsername(...args: Parameters<VacationStore["findUserByUsername"]>) {
    return this.adminAuthRepository.findUserByUsername(...args);
  }
  saveUser(...args: Parameters<VacationStore["saveUser"]>) {
    return this.adminAuthRepository.saveUser(...args);
  }
  current(...args: Parameters<VacationStore["current"]>) {
    return this.adminAuthRepository.current(...args);
  }
  savePolicy(...args: Parameters<VacationStore["savePolicy"]>) {
    return this.adminAuthRepository.savePolicy(...args);
  }
  saveScheduleAndAudit(...args: Parameters<VacationStore["saveScheduleAndAudit"]>) {
    return this.transactionsRepository.saveScheduleAndAudit(...args);
  }
  applyEmploymentImport(...args: Parameters<VacationStore["applyEmploymentImport"]>) {
    return this.transactionsRepository.applyEmploymentImport(...args);
  }
  completeScheduleTransaction(...args: Parameters<VacationStore["completeScheduleTransaction"]>) {
    return this.transactionsRepository.completeScheduleTransaction(...args);
  }
  closeRetiredEmploymentTransaction(
    ...args: Parameters<VacationStore["closeRetiredEmploymentTransaction"]>
  ) {
    return this.transactionsRepository.closeRetiredEmploymentTransaction(...args);
  }
  closeRetiredEmploymentsTransaction(
    ...args: Parameters<VacationStore["closeRetiredEmploymentsTransaction"]>
  ) {
    return this.transactionsRepository.closeRetiredEmploymentsTransaction(...args);
  }
  applyVacationSettlementImport(
    ...args: Parameters<VacationStore["applyVacationSettlementImport"]>
  ) {
    return this.transactionsRepository.applyVacationSettlementImport(...args);
  }
  applyVacationPeriodClosure(...args: Parameters<VacationStore["applyVacationPeriodClosure"]>) {
    return this.transactionsRepository.applyVacationPeriodClosure(...args);
  }
  applyVacationPendingPeriodImport(
    ...args: Parameters<VacationStore["applyVacationPendingPeriodImport"]>
  ) {
    return this.transactionsRepository.applyVacationPendingPeriodImport(...args);
  }
  saveSettlementAndAudit(...args: Parameters<VacationStore["saveSettlementAndAudit"]>) {
    return this.transactionsRepository.saveSettlementAndAudit(...args);
  }
  async ping() {
    return undefined;
  }
}
