import type { Request, Response } from "express";
import { env } from "../../infrastructure/config/env.js";

export function cookie(req: Request, name: string): string | undefined {
  return req.headers.cookie
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const secure = env.NODE_ENV === "production";
  const flags = `HttpOnly; SameSite=Lax; Path=/${secure ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", [
    `vaca_access=${accessToken}; Max-Age=900; ${flags}`,
    `vaca_refresh=${refreshToken}; Max-Age=604800; ${flags}`,
  ]);
}

export function clearAuthCookies(res: Response): void {
  res.setHeader("Set-Cookie", [
    "vaca_access=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/",
    "vaca_refresh=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/",
  ]);
}
