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
import { type MongoContext, strip } from "./mongoContext.js";

export class MongoAdminAuthRepository
  implements
    SessionRepository,
    CatalogRepository,
    SystemSettingRepository,
    HolidayRepository,
    UserRepository,
    PolicyRepository
{
  constructor(private readonly context: MongoContext) {}

  async findSessionById(id: string) {
    const document = await this.context.collection<Session>("sessions").findOne({ id });
    return document ? strip(document) : null;
  }

  async saveSession(session: Session) {
    await this.context.collection<Session>("sessions").replaceOne({ id: session.id }, session, {
      upsert: true,
    });
  }

  async revokeSession(id: string, revokedAt: string) {
    await this.context.collection<Session>("sessions").updateOne({ id }, { $set: { revokedAt } });
  }

  async listCatalog(type: string) {
    return (
      await this.context
        .collection<CatalogItem>("catalogItems")
        .find({ type, active: true })
        .sort({ name: 1 })
        .toArray()
    ).map(strip);
  }

  async saveCatalog(item: CatalogItem) {
    await this.context.collection<CatalogItem>("catalogItems").replaceOne({ id: item.id }, item, {
      upsert: true,
    });
  }

  async listCatalogPage(query: CatalogPageQuery): Promise<PagedCatalog> {
    const filter: Record<string, unknown> = { type: query.type };
    if (query.active !== undefined) filter.active = query.active;
    if (query.search) filter.name = { $regex: escapeRegex(query.search), $options: "i" };
    const skip = (query.page - 1) * query.pageSize;
    const [facet] = await this.context
      .collection<CatalogItem>("catalogItems")
      .aggregate([
        { $match: filter },
        { $sort: { name: 1 } },
        {
          $facet: {
            items: [{ $skip: skip }, { $limit: query.pageSize }],
            meta: [{ $count: "value" }],
          },
        },
      ])
      .toArray();
    const items = ((facet?.items as CatalogItem[]) ?? []).map(strip);
    const total = (facet?.meta as Array<{ value: number }> | undefined)?.[0]?.value ?? 0;
    return { items, total };
  }

  async findSystemSettingByKey(key: string) {
    const document = await this.context
      .collection<SystemSetting>("systemSettings")
      .findOne({ key });
    return document ? strip(document) : null;
  }

  async saveSystemSetting(setting: SystemSetting) {
    await this.context
      .collection<SystemSetting>("systemSettings")
      .replaceOne({ key: setting.key }, setting, { upsert: true });
  }

  async listHolidays(year?: number) {
    const start = `${year}-01-01` as Holiday["date"];
    const end = `${(year ?? 0) + 1}-01-01` as Holiday["date"];
    const filter = year === undefined ? {} : { date: { $gte: start, $lt: end } };
    return (
      await this.context.collection<Holiday>("holidays").find(filter).sort({ date: 1 }).toArray()
    ).map(strip);
  }

  async saveHoliday(holiday: Holiday) {
    await this.context.collection<Holiday>("holidays").replaceOne({ id: holiday.id }, holiday, {
      upsert: true,
    });
  }

  async listHolidaysPage(query: HolidayPageQuery): Promise<PagedHolidays> {
    const filter: Record<string, unknown> = {};
    if (query.year !== undefined) {
      filter.date = {
        $gte: `${query.year}-01-01`,
        $lt: `${query.year + 1}-01-01`,
      };
    }
    if (query.active !== undefined) filter.active = query.active;
    if (query.search) filter.name = { $regex: escapeRegex(query.search), $options: "i" };
    const skip = (query.page - 1) * query.pageSize;
    const [facet] = await this.context
      .collection<Holiday>("holidays")
      .aggregate([
        { $match: filter },
        { $sort: { date: 1 } },
        {
          $facet: {
            items: [{ $skip: skip }, { $limit: query.pageSize }],
            meta: [{ $count: "value" }],
          },
        },
      ])
      .toArray();
    const items = ((facet?.items as Holiday[]) ?? []).map(strip);
    const total = (facet?.meta as Array<{ value: number }> | undefined)?.[0]?.value ?? 0;
    return { items, total };
  }

  async listUsers() {
    return (
      await this.context.collection<User>("users").find({}).sort({ username: 1 }).toArray()
    ).map(strip);
  }

  async findUserByUsername(username: string) {
    const document = await this.context.collection<User>("users").findOne({ username });
    return document ? strip(document) : null;
  }

  async saveUser(user: User) {
    await this.context
      .collection<User>("users")
      .replaceOne({ id: user.id }, user, { upsert: true });
  }

  async listUsersPage(query: UserPageQuery): Promise<PagedUsers> {
    const filter: Record<string, unknown> = {};
    if (query.role) filter.role = query.role;
    if (query.active !== undefined) filter.active = query.active;
    if (query.search) {
      const safe = escapeRegex(query.search);
      filter.$or = [
        { username: { $regex: safe, $options: "i" } },
        { displayName: { $regex: safe, $options: "i" } },
        { jobTitle: { $regex: safe, $options: "i" } },
      ];
    }
    const skip = (query.page - 1) * query.pageSize;
    const [facet] = await this.context
      .collection<User>("users")
      .aggregate([
        { $match: filter },
        { $sort: { username: 1 } },
        {
          $facet: {
            items: [{ $skip: skip }, { $limit: query.pageSize }],
            meta: [{ $count: "value" }],
          },
        },
      ])
      .toArray();
    const items = ((facet?.items as User[]) ?? []).map(strip);
    const total = (facet?.meta as Array<{ value: number }> | undefined)?.[0]?.value ?? 0;
    return { items, total };
  }

  async current(asOf: LocalDate) {
    const policy = await this.context
      .collection<VacationPolicy>("vacationPolicies")
      .findOne({ active: true, effectiveFrom: { $lte: asOf } }, { sort: { effectiveFrom: -1 } });
    if (policy) return strip(policy);
    const initial: VacationPolicy = {
      id: "default",
      effectiveFrom: "2026-01-01",
      daysPerCompletedYear: 15,
      overdueAfterMonths: 12,
      upcomingAccrualAlerts: [30, 60, 90],
      active: true,
    };
    await this.context.collection<VacationPolicy>("vacationPolicies").insertOne(initial);
    return initial;
  }

  async savePolicy(policy: VacationPolicy) {
    await this.context
      .collection<VacationPolicy>("vacationPolicies")
      .replaceOne({ id: policy.id }, policy, { upsert: true });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
