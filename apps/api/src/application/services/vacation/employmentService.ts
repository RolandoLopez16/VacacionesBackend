import { parseLocalDate } from "../../../domain/shared/localDate.js";
import { ConflictError, NotFoundError } from "../../../domain/shared/errors.js";
import {
  assertEmploymentDateRange,
  normalizeDocumentNumber,
} from "../../../domain/shared/valueObjects.js";
import type { Employment } from "../../../domain/workers/models.js";
import { AccrualReadService } from "./accrualReadService.js";
import { checkVersion, type VacationServiceContext } from "./context.js";
import type { EmploymentInput } from "./types.js";

export class EmploymentService {
  constructor(
    private readonly context: VacationServiceContext,
    private readonly readService: AccrualReadService,
  ) {}

  private async workerFor(input: EmploymentInput, now: string) {
    const normalized = normalizeDocumentNumber(input.documentNumber);
    let worker = await this.context.store.findWorkerByNormalizedDocument(normalized);
    if (!worker) {
      worker = {
        id: crypto.randomUUID(),
        documentNumber: input.documentNumber,
        normalizedDocumentNumber: normalized,
        fullName: input.fullName,
        workerType: "EMPLOYEE",
        createdAt: now,
        updatedAt: now,
      };
      await this.context.store.saveWorker(worker);
      return worker;
    }
    if (worker.fullName !== input.fullName || worker.documentNumber !== input.documentNumber)
      await this.context.store.saveWorker({
        ...worker,
        documentNumber: input.documentNumber,
        fullName: input.fullName,
        updatedAt: now,
      });
    return worker;
  }

  async upsertEmployment(input: EmploymentInput, actor = "system") {
    const now = new Date().toISOString();
    const startDate = parseLocalDate(input.startDate);
    const endDate = input.endDate ? parseLocalDate(input.endDate) : undefined;
    assertEmploymentDateRange(startDate, endDate);
    const worker = await this.workerFor(input, now);
    const existing = await this.context.store.findEmploymentByWorkerAndStartDate(
      worker.id,
      startDate,
    );
    const status = endDate ? "RETIRED" : "ACTIVE";
    if (existing) {
      const updated: Employment = {
        ...existing,
        startDate,
        ...(endDate ? { endDate } : { endDate: undefined }),
        contractTypeId: input.contractTypeName.toLowerCase().replaceAll(" ", "-"),
        contractTypeName: input.contractTypeName,
        processId: input.processName.toLowerCase().replaceAll(" ", "-"),
        processName: input.processName,
        positionId: input.positionName.toLowerCase().replaceAll(" ", "-"),
        positionName: input.positionName,
        ...(input.supervisorName
          ? { supervisorName: input.supervisorName }
          : { supervisorName: undefined }),
        status,
        version: existing.version + 1,
        updatedAt: now,
      };
      await this.context.store.saveEmployment(updated);
      await this.readService.ensure(updated);
      await this.context.store.append({
        id: crypto.randomUUID(),
        actorId: actor,
        action: "EMPLOYMENT_UPDATED",
        entityType: "Employment",
        entityId: updated.id,
        metadata: { documentNumber: input.documentNumber, startDate },
        createdAt: now,
      });
      return { summary: this.readService.summary(updated), created: false };
    }
    const employment: Employment = {
      id: crypto.randomUUID(),
      workerId: worker.id,
      startDate,
      ...(endDate ? { endDate } : {}),
      contractTypeId: input.contractTypeName.toLowerCase().replaceAll(" ", "-"),
      contractTypeName: input.contractTypeName,
      processId: input.processName.toLowerCase().replaceAll(" ", "-"),
      processName: input.processName,
      positionId: input.positionName.toLowerCase().replaceAll(" ", "-"),
      positionName: input.positionName,
      ...(input.supervisorName ? { supervisorName: input.supervisorName } : {}),
      status,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.context.store.saveEmployment(employment);
    await this.readService.ensure(employment);
    await this.context.store.append({
      id: crypto.randomUUID(),
      actorId: actor,
      action: "EMPLOYMENT_CREATED",
      entityType: "Employment",
      entityId: employment.id,
      metadata: { documentNumber: input.documentNumber, startDate },
      createdAt: now,
    });
    return { summary: this.readService.summary(employment), created: true };
  }

  async createEmployment(input: EmploymentInput, actor = "system") {
    return (await this.upsertEmployment(input, actor)).summary;
  }

  async updateEmployment(
    id: string,
    input: EmploymentInput,
    expectedVersion?: number,
    actor = "system",
  ) {
    const existing = await this.context.store.findEmploymentById(id);
    if (!existing) throw new NotFoundError("Employment not found");
    checkVersion(existing.version, expectedVersion);
    const normalized = normalizeDocumentNumber(input.documentNumber);
    const worker = await this.context.store.findWorkerById(existing.workerId);
    if (!worker) throw new NotFoundError("Worker not found");
    const duplicate = await this.context.store.findWorkerByNormalizedDocument(normalized);
    if (duplicate && duplicate.id !== worker.id)
      throw new ConflictError("The document number already belongs to another worker");
    await this.context.store.saveWorker({
      ...worker,
      documentNumber: input.documentNumber,
      normalizedDocumentNumber: normalized,
      fullName: input.fullName,
      updatedAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    assertEmploymentDateRange(input.startDate, input.endDate);
    const updated: Employment = {
      ...existing,
      startDate: input.startDate,
      ...(input.endDate ? { endDate: input.endDate } : { endDate: undefined }),
      contractTypeName: input.contractTypeName,
      contractTypeId: input.contractTypeName.toLowerCase().replaceAll(" ", "-"),
      processName: input.processName,
      processId: input.processName.toLowerCase().replaceAll(" ", "-"),
      positionName: input.positionName,
      positionId: input.positionName.toLowerCase().replaceAll(" ", "-"),
      ...(input.supervisorName
        ? { supervisorName: input.supervisorName }
        : { supervisorName: undefined }),
      status: input.endDate ? "RETIRED" : "ACTIVE",
      version: existing.version + 1,
      updatedAt: now,
    };
    await this.context.store.saveEmployment(updated);
    await this.readService.ensure(updated);
    await this.context.store.append({
      id: crypto.randomUUID(),
      actorId: actor,
      action: "EMPLOYMENT_UPDATED",
      entityType: "Employment",
      entityId: id,
      metadata: { version: updated.version },
      createdAt: now,
    });
    return this.readService.summary(updated);
  }

  async seed() {
    // No se incrustan personas de ejemplo en el código. La carga inicial debe
    // venir del importador o de la administración del sistema.
  }
}
