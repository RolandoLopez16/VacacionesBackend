import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/outbound/memory/memoryRepositories.js";
import { parseLocalDate } from "../src/domain/shared/localDate.js";
import type { AuditEvent } from "../src/application/ports/repositories.js";

function audit(id: string, action: string, createdAt: string): AuditEvent {
  return {
    id,
    actorId: "system",
    action,
    entityType: "Worker",
    entityId: id,
    metadata: {},
    createdAt,
  };
}

describe("MemoryStore paginated repositories", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  describe("listAuditsPage", () => {
    it("returns the requested slice and the total count", async () => {
      for (let index = 0; index < 25; index += 1) {
        await store.append(
          audit(
            `evt-${index}`,
            "CREATE",
            `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
          ),
        );
      }
      const page1 = await store.listAuditsPage({ page: 1, pageSize: 10 });
      const page2 = await store.listAuditsPage({ page: 2, pageSize: 10 });
      const page3 = await store.listAuditsPage({ page: 3, pageSize: 10 });
      expect(page1.total).toBe(25);
      expect(page1.items).toHaveLength(10);
      expect(page2.items).toHaveLength(10);
      expect(page3.items).toHaveLength(5);
      const ids = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
      expect(new Set(ids).size).toBe(25);
    });

    it("filters by actorId, action and date range", async () => {
      await store.append(audit("a", "CREATE", "2026-01-01T08:00:00.000Z"));
      await store.append(audit("b", "CREATE", "2026-01-15T08:00:00.000Z"));
      await store.append(audit("c", "UPDATE", "2026-02-01T08:00:00.000Z"));
      await store.append({
        id: "d",
        actorId: "admin",
        action: "CREATE",
        entityType: "Worker",
        entityId: "d",
        metadata: {},
        createdAt: "2026-02-15T08:00:00.000Z",
      });
      const filtered = await store.listAuditsPage({
        page: 1,
        pageSize: 50,
        actorId: "admin",
        action: "CREATE",
        fromDate: parseLocalDate("2026-02-01"),
      });
      expect(filtered.total).toBe(1);
      expect(filtered.items[0]?.id).toBe("d");
    });
  });

  describe("listHolidaysPage", () => {
    it("paginates by year and active flag", async () => {
      for (let year = 2020; year <= 2024; year += 1) {
        for (let month = 1; month <= 6; month += 1) {
          const day = String(month).padStart(2, "0");
          await store.saveHoliday({
            id: `h-${year}-${month}`,
            date: parseLocalDate(`${year}-${day}-01`),
            name: `Festivo ${year}-${month}`,
            country: "CO",
            active: year % 2 === 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        }
      }
      const all = await store.listHolidaysPage({ page: 1, pageSize: 100 });
      expect(all.total).toBe(30);
      const year2024 = await store.listHolidaysPage({
        page: 1,
        pageSize: 100,
        year: 2024,
        active: true,
      });
      expect(year2024.total).toBe(6);
    });
  });

  describe("listUsersPage", () => {
    it("filters by role, active and search", async () => {
      const fixtures: Array<{ username: string; role: "ADMIN" | "HR"; active: boolean }> = [
        { username: "alice", role: "ADMIN", active: true },
        { username: "bob", role: "HR", active: true },
        { username: "carol", role: "HR", active: false },
        { username: "andres", role: "ADMIN", active: false },
      ];
      for (const [index, fixture] of fixtures.entries()) {
        await store.saveUser({
          id: `user-${index}`,
          username: fixture.username,
          displayName: fixture.username.toUpperCase(),
          jobTitle: fixture.role,
          passwordHash: "hash",
          passwordSalt: "salt",
          role: fixture.role,
          active: fixture.active,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      const admins = await store.listUsersPage({ page: 1, pageSize: 10, role: "ADMIN" });
      expect(admins.items.map((user) => user.username)).toEqual(["alice", "andres"]);
      const activeSearch = await store.listUsersPage({
        page: 1,
        pageSize: 10,
        active: true,
        search: "a",
      });
      expect(activeSearch.items.map((user) => user.username)).toEqual(["alice"]);
    });
  });
});
