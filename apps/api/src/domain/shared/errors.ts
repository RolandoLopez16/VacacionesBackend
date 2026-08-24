export type DomainErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BUSINESS_RULE_VIOLATION"
  | "INTERNAL_ERROR";

/**
 * Base class for every error the domain and application layers raise.
 * Carries the HTTP status and a stable machine-readable code so the HTTP
 * layer can translate it without inspecting message strings.
 */
export class DomainError extends Error {
  readonly status: number;
  readonly code: DomainErrorCode;
  readonly metadata?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code: DomainErrorCode,
    metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    if (metadata !== undefined) this.metadata = metadata;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, 400, "VALIDATION_ERROR", metadata);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Sesión requerida", metadata?: Record<string, unknown>) {
    super(message, 401, "UNAUTHORIZED", metadata);
  }
}

export class ForbiddenError extends DomainError {
  constructor(
    message = "No tienes permisos para esta operación",
    metadata?: Record<string, unknown>,
  ) {
    super(message, 403, "FORBIDDEN", metadata);
  }
}

export class NotFoundError extends DomainError {
  constructor(message = "Recurso no encontrado", metadata?: Record<string, unknown>) {
    super(message, 404, "NOT_FOUND", metadata);
  }
}

export class ConflictError extends DomainError {
  constructor(message = "Conflicto de concurrencia", metadata?: Record<string, unknown>) {
    super(message, 409, "CONFLICT", metadata);
  }
}

export class BusinessRuleError extends DomainError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, 422, "BUSINESS_RULE_VIOLATION", metadata);
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError;
