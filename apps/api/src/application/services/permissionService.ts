import type { UserRole } from "../../domain/auth/models.js";

export type Permission =
  | "worker.read"
  | "worker.create"
  | "worker.update"
  | "employment.create"
  | "employment.update"
  | "employment.retire"
  | "vacation.read"
  | "vacation.create"
  | "vacation.update"
  | "schedule.create"
  | "schedule.update"
  | "schedule.cancel"
  | "report.read"
  | "report.export"
  | "user.manage"
  | "settings.manage"
  | "audit.read";
const readOnly: Permission[] = ["worker.read", "vacation.read", "report.read", "audit.read"];
const hr: Permission[] = [
  ...readOnly,
  "worker.create",
  "worker.update",
  "employment.create",
  "employment.update",
  "employment.retire",
  "vacation.create",
  "vacation.update",
  "schedule.create",
  "schedule.update",
  "schedule.cancel",
  "report.export",
];
const all: Permission[] = [...hr, "user.manage", "settings.manage"];
export function can(role: UserRole, permission: Permission) {
  if (role === "ADMIN") return all.includes(permission);
  if (role === "HR") return hr.includes(permission);
  return readOnly.includes(permission);
}
export function permissionFor(method: string, path: string): Permission | undefined {
  if (method === "GET")
    return path.includes("/audit")
      ? "audit.read"
      : path.includes("/reports")
        ? "report.read"
        : path.includes("/admin")
          ? "settings.manage"
          : "vacation.read";
  if (path.includes("/auth/")) return undefined;
  if (path.includes("/admin/users")) return "user.manage";
  if (path.includes("/admin/")) return "settings.manage";
  if (path.includes("/import") || path.includes("/worker-imports")) return "employment.create";
  if (path.includes("/workers")) return method === "POST" ? "worker.create" : "worker.update";
  if (path.includes("/employments"))
    return path.endsWith("/retire")
      ? "employment.retire"
      : method === "POST"
        ? "employment.create"
        : "employment.update";
  if (path.includes("schedule"))
    return path.endsWith("/cancel")
      ? "schedule.cancel"
      : method === "POST"
        ? "schedule.create"
        : "schedule.update";
  if (path.includes("settlement")) return method === "POST" ? "vacation.create" : "vacation.update";
  return undefined;
}
