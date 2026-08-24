import { describe, expect, it } from "vitest";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
  isDomainError,
} from "../src/domain/shared/errors.js";
import { parseLocalDate } from "../src/domain/shared/localDate.js";
import {
  assertEmploymentDateRange,
  moneyCOP,
  normalizeDocumentNumber,
} from "../src/domain/shared/valueObjects.js";

describe("domain errors", () => {
  it.each([
    [new ValidationError("invalid"), 400, "VALIDATION_ERROR"],
    [new NotFoundError("missing"), 404, "NOT_FOUND"],
    [new ConflictError("stale"), 409, "CONFLICT"],
    [new BusinessRuleError("rule"), 422, "BUSINESS_RULE_VIOLATION"],
  ] as const)("exposes status and code", (error, status, code) => {
    expect(isDomainError(error)).toBe(true);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
  });
});

describe("shared value objects", () => {
  it("normalizes numeric and text documents", () => {
    expect(normalizeDocumentNumber(" 1.234-56 ")).toBe("123456");
    expect(normalizeDocumentNumber(" ce-abc ")).toBe("CE-ABC");
  });

  it("rejects short documents", () => {
    expect(() => normalizeDocumentNumber("12")).toThrow(ValidationError);
  });

  it("rejects an employment end date before its start", () => {
    expect(() =>
      assertEmploymentDateRange(parseLocalDate("2026-02-01"), parseLocalDate("2026-01-31")),
    ).toThrow(BusinessRuleError);
  });

  it("accepts non-negative COP amounts", () => {
    expect(moneyCOP(0)).toBe(0);
    expect(() => moneyCOP(-1)).toThrow(ValidationError);
  });
});
