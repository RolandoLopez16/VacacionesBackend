import type { Brand } from "./branded.js";
import { BusinessRuleError, ValidationError } from "./errors.js";
import type { LocalDate } from "./localDate.js";

export type DocumentNumber = Brand<string, "DocumentNumber">;
export type MoneyCOP = Brand<number, "MoneyCOP">;

/** Normalizes a document while retaining non-numeric identifiers as uppercase text. */
export function normalizeDocumentNumber(value: string): DocumentNumber {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/\D/g, "") || trimmed.toUpperCase();
  if (normalized.length < 3) {
    throw new ValidationError("La cédula debe tener al menos 3 caracteres");
  }
  return normalized as DocumentNumber;
}

/** Ensures the end of an employment never precedes its contract date. */
export function assertEmploymentDateRange(startDate: LocalDate, endDate?: LocalDate): void {
  if (endDate && endDate < startDate) {
    throw new BusinessRuleError("Retirement date cannot precede contract date");
  }
}

/** Creates a non-negative Colombian peso amount. */
export function moneyCOP(value: number): MoneyCOP {
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError("El valor monetario debe ser un número no negativo");
  }
  return value as MoneyCOP;
}
