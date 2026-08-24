import type {
  CatalogPageQuery,
  CatalogRepository,
  HolidayPageQuery,
  HolidayRepository,
  PagedCatalog,
  PagedHolidays,
  PagedUsers,
  PolicyRepository,
  SessionRepository,
  SystemSettingRepository,
  UserPageQuery,
  UserRepository,
} from "../../../application/ports/repositories.js";
import type { CatalogItem } from "../../../domain/admin/catalog.js";
import type { Holiday } from "../../../domain/admin/holiday.js";
import type { SystemSetting } from "../../../domain/admin/settings.js";
import type { User } from "../../../domain/auth/models.js";
import type { Session } from "../../../domain/auth/session.js";
import type { LocalDate } from "../../../domain/shared/localDate.js";
import type { VacationPolicy } from "../../../domain/vacations/models.js";
import type { MemoryContext } from "./memoryContext.js";

function slice<T>(items: T[], page: number, pageSize: number): { items: T[]; total: number } {
  const total = items.length;
  const start = Math.max(0, (page - 1) * pageSize);
  return { items: items.slice(start, start + pageSize), total };
}

function normalizeSearch(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

export class MemoryAdminAuthRepository
  implements
    SessionRepository,
    CatalogRepository,
    SystemSettingRepository,
    HolidayRepository,
    UserRepository,
    PolicyRepository
{
  constructor(private readonly context: MemoryContext) {}

  async findSessionById(id: string) {
    return this.context.sessions.get(id) ?? null;
  }

  async saveSession(session: Session) {
    this.context.sessions.set(session.id, session);
  }

  async revokeSession(id: string, revokedAt: string) {
    const session = this.context.sessions.get(id);
    if (session) this.context.sessions.set(id, { ...session, revokedAt });
  }

  async listCatalog(type: string) {
    return [...this.context.catalogs.values()].filter((item) => item.type === type);
  }

  async saveCatalog(item: CatalogItem) {
    this.context.catalogs.set(item.id, item);
  }

  async listCatalogPage(query: CatalogPageQuery): Promise<PagedCatalog> {
    const needle = normalizeSearch(query.search);
    const all = [...this.context.catalogs.values()].filter((item) => {
      if (item.type !== query.type) return false;
      if (query.active !== undefined && item.active !== query.active) return false;
      if (needle && !item.name.toLowerCase().includes(needle)) return false;
      return true;
    });
    all.sort((left, right) => left.name.localeCompare(right.name, "es"));
    return slice(all, query.page, query.pageSize);
  }

  async findSystemSettingByKey(key: string) {
    return this.context.systemSettings.get(key) ?? null;
  }

  async saveSystemSetting(setting: SystemSetting) {
    this.context.systemSettings.set(setting.key, setting);
  }

  async listHolidays(year?: number) {
    return [...this.context.holidays.values()].filter(
      (holiday) => year === undefined || Number(holiday.date.slice(0, 4)) === year,
    );
  }

  async saveHoliday(holiday: Holiday) {
    this.context.holidays.set(holiday.id, holiday);
  }

  async listHolidaysPage(query: HolidayPageQuery): Promise<PagedHolidays> {
    const needle = normalizeSearch(query.search);
    const all = [...this.context.holidays.values()].filter((holiday) => {
      if (query.year !== undefined && Number(holiday.date.slice(0, 4)) !== query.year) return false;
      if (query.active !== undefined && holiday.active !== query.active) return false;
      if (needle && !holiday.name.toLowerCase().includes(needle)) return false;
      return true;
    });
    all.sort((left, right) => left.date.localeCompare(right.date));
    return slice(all, query.page, query.pageSize);
  }

  async listUsers() {
    return [...this.context.users.values()];
  }

  async findUserByUsername(username: string) {
    return [...this.context.users.values()].find((user) => user.username === username) ?? null;
  }

  async saveUser(user: User) {
    this.context.users.set(user.id, user);
  }

  async listUsersPage(query: UserPageQuery): Promise<PagedUsers> {
    const needle = normalizeSearch(query.search);
    const all = [...this.context.users.values()].filter((user) => {
      if (query.role && user.role !== query.role) return false;
      if (query.active !== undefined && user.active !== query.active) return false;
      if (needle) {
        const haystack = `${user.username} ${user.displayName} ${user.jobTitle}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    all.sort((left, right) => left.username.localeCompare(right.username, "es"));
    return slice(all, query.page, query.pageSize);
  }

  async current(_asOf: LocalDate) {
    return this.context.policy;
  }

  async savePolicy(policy: VacationPolicy) {
    this.context.policy = policy;
  }
}
