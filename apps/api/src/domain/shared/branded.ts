declare const brand: unique symbol;

/** Distinguishes semantically different primitive values at compile time. */
export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type WorkerId = Brand<string, "WorkerId">;
export type EmploymentId = Brand<string, "EmploymentId">;
export type VacationPeriodId = Brand<string, "VacationPeriodId">;
export type VacationScheduleId = Brand<string, "VacationScheduleId">;
export type VacationSettlementId = Brand<string, "VacationSettlementId">;
