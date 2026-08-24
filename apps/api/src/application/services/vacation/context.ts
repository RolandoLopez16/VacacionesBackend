import { ConflictError } from "../../../domain/shared/errors.js";
import type { LocalDate } from "../../../domain/shared/localDate.js";
import type { VacationStore } from "../../ports/repositories.js";

export interface VacationServiceContext {
  store: VacationStore;
  clock: () => LocalDate;
}

export function checkVersion(actual: number, expected?: number) {
  if (expected !== undefined && actual !== expected)
    throw new ConflictError(`Conflict: version ${expected} is stale`);
}
