import type { ErrorRequestHandler, RequestHandler } from "express";
import { isDomainError } from "../../domain/shared/errors.js";
import type { RequestContext } from "../lib/http.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    code: "NOT_FOUND",
    message: `Ruta no encontrada: ${req.method} ${req.path}`,
  });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  const domainError = isDomainError(error) ? error : undefined;
  const status = domainError
    ? domainError.status
    : typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number"
      ? error.status
      : 500;
  const message = error instanceof Error ? error.message : "Unexpected error";
  const code = domainError
    ? domainError.code
    : status === 401
      ? "UNAUTHORIZED"
      : status === 403
        ? "FORBIDDEN"
        : status === 404
          ? "NOT_FOUND"
          : status === 409
            ? "CONFLICT"
            : status === 422
              ? "BUSINESS_RULE_VIOLATION"
              : status === 500
                ? "INTERNAL_ERROR"
                : "VALIDATION_ERROR";
  const requestId = (req as RequestContext).requestId;
  if (status >= 500) console.error(JSON.stringify({ requestId, message }));
  res.status(status).json({
    code,
    message,
    ...(domainError?.metadata ? { details: domainError.metadata } : {}),
    requestId,
  });
};
