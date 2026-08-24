import type { Request, RequestHandler } from "express";
import type { AuthService } from "../../application/services/authService.js";
import { can, permissionFor } from "../../application/services/permissionService.js";
import { ForbiddenError, UnauthorizedError } from "../../domain/shared/errors.js";
import { cookie } from "../lib/cookies.js";
import type { RequestContext } from "../lib/http.js";

function isPublicPath(req: Request): boolean {
  const path = req.originalUrl.split("?")[0] ?? req.path;
  return (
    path.startsWith("/api/v1/health") ||
    path.startsWith("/health") ||
    path.endsWith("/auth/login") ||
    path.endsWith("/auth/refresh") ||
    path.endsWith("/auth/logout")
  );
}

export function requireSession(auth: AuthService): RequestHandler {
  return (req, _res, next) => {
    if (isPublicPath(req)) return next();
    const session = auth.verifyAccess(cookie(req, "vaca_access") ?? "");
    if (!session) return next(new UnauthorizedError("Authentication required"));
    const context = req as RequestContext;
    context.actorId = session.username;
    context.actorRole = session.role;
    return next();
  };
}

export function authorizeRoute(method: string, path: string): RequestHandler {
  const permission = permissionFor(method, path);
  return (req, _res, next) => {
    if (!permission) return next();
    const role = (req as RequestContext).actorRole;
    if (!role) return next(new UnauthorizedError("Authentication required"));
    if (!can(role, permission)) return next(new ForbiddenError("Insufficient permissions"));
    return next();
  };
}
