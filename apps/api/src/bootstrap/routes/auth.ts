import { Router } from "express";
import { authorizeRoute } from "../middleware/auth.js";
import { changePasswordInputSchema, loginInputSchema } from "../schemas/auth.js";
import { clearAuthCookies, cookie, setAuthCookies } from "../lib/cookies.js";
import { parseBody } from "../lib/http.js";
import type { RouteDependencies } from "./types.js";

export function authRoutes({ auth }: RouteDependencies): Router {
  const router = Router();

  router.post("/api/v1/auth/login", async (req, res) => {
    const input = parseBody(loginInputSchema, req);
    const tokens = await auth.login(input.username, input.password);
    if (!tokens) {
      return res.status(401).json({
        code: "INVALID_CREDENTIALS",
        message: "Usuario o contraseña inválidos",
      });
    }
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    return res.json({ user: tokens.user });
  });

  router.post("/api/v1/auth/refresh", async (req, res) => {
    const tokens = await auth.refresh(cookie(req, "vaca_refresh") ?? "");
    if (!tokens) {
      clearAuthCookies(res);
      return res.status(401).json({
        code: "INVALID_REFRESH_TOKEN",
        message: "La sesión de actualización expiró",
      });
    }
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    return res.json({ user: tokens.user });
  });

  router.post("/api/v1/auth/logout", async (req, res) => {
    await auth.revokeRefreshToken(cookie(req, "vaca_refresh") ?? "");
    clearAuthCookies(res);
    res.status(204).end();
  });

  router.get("/api/v1/auth/me", authorizeRoute("GET", "/api/v1/auth/me"), async (req, res) => {
    const session = auth.verifyAccess(cookie(req, "vaca_access") ?? "");
    if (!session) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const user = await auth.currentUser(session.username);
    if (!user) return res.status(401).json({ code: "UNAUTHORIZED", message: "User inactive" });
    return res.json({ user });
  });

  router.post(
    "/api/v1/auth/change-password",
    authorizeRoute("POST", "/api/v1/auth/change-password"),
    async (req, res) => {
      const session = auth.verifyAccess(cookie(req, "vaca_access") ?? "");
      if (!session) {
        return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
      }
      const input = parseBody(changePasswordInputSchema, req);
      const changed = await auth.changePassword(
        session.username,
        input.currentPassword,
        input.newPassword,
      );
      if (!changed) {
        return res.status(400).json({
          code: "INVALID_PASSWORD",
          message: "La contraseña actual no es válida",
        });
      }
      clearAuthCookies(res);
      return res.status(204).end();
    },
  );

  return router;
}
