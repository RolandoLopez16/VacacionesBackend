import type { Express } from "express";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/outbound/memory/memoryRepositories.js";
import { AuthService } from "../src/application/services/authService.js";
import { createApp } from "../src/bootstrap/app.js";

const password = "Http-test-password!";
const employment = {
  documentNumber: "HTTP-9001",
  fullName: "Empleado HTTP",
  startDate: "2024-01-01",
  contractTypeName: "Indefinido",
  processName: "Operaciones",
  positionName: "Analista",
  supervisorName: "Supervisión HTTP",
};

describe("HTTP integration", () => {
  let app: Express;
  let store: MemoryStore;

  beforeAll(async () => {
    store = new MemoryStore();
    const auth = new AuthService(
      store,
      {
        jwtSecret: "a".repeat(40),
        refreshSecret: "b".repeat(40),
        accessExpiresIn: "15m",
        refreshExpiresIn: "7d",
      },
      store,
    );
    await auth.ensureAdmin("http-admin", password);
    await auth.createUser("http-viewer", password, "VIEWER");
    app = await createApp(store, false, auth);
  });

  it("exposes health and protects authenticated routes", async () => {
    const health = await request(app).get("/api/v1/health").expect(200);
    expect(health.body).toMatchObject({ status: "ok", service: "vaca-efa-api" });
    expect(health.headers["x-request-id"]).toBeTypeOf("string");

    const unauthorized = await request(app).get("/api/v1/employments").expect(401);
    expect(unauthorized.body).toMatchObject({ code: "UNAUTHORIZED" });
    await request(app)
      .get("/api/v1/dashboard/employments?kind=ACTIVE&page=1&pageSize=10")
      .expect(401);
  }, 30_000);

  it("exposes public vacation stats without a session and matches the dashboard", async () => {
    const stats = await request(app).get("/api/v1/public/vacation-stats").expect(200);
    expect(stats.body).toMatchObject({ asOf: expect.any(String) });
    expect(stats.body.upcoming90Days).toBeTypeOf("number");

    const admin = request.agent(app);
    await admin
      .post("/api/v1/auth/login")
      .send({ username: "http-admin", password })
      .expect(200);
    const dashboard = await admin.get("/api/v1/dashboard").expect(200);
    expect(stats.body.upcoming90Days).toBe(dashboard.body.upcoming90Days);
  }, 30_000);

  it("returns 403 when a read-only role invokes a mutation", async () => {
    const viewer = request.agent(app);
    await viewer.post("/api/v1/auth/login").send({ username: "http-viewer", password }).expect(200);
    const forbidden = await viewer.post("/api/v1/workers").send({
      documentNumber: "9002",
      fullName: "Sin permiso",
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ code: "FORBIDDEN" });
    await viewer.get("/api/v1/dashboard/employments?kind=ACTIVE&page=1&pageSize=10").expect(200);
    await viewer.get("/api/v1/dashboard/employments?kind=HEALTH&page=1&pageSize=10").expect(400);
  }, 30_000);

  it("completes a cookie-authenticated flow and maps 400, 404, 409 and 422", async () => {
    const admin = request.agent(app);
    const login = await admin
      .post("/api/v1/auth/login")
      .send({ username: "http-admin", password })
      .expect(200);
    const setCookie = login.headers["set-cookie"];
    expect(Array.isArray(setCookie) ? setCookie.join(";") : setCookie).toContain("HttpOnly");

    const created = await admin.post("/api/v1/employments").send(employment).expect(201);
    expect(created.body).toMatchObject({ documentNumber: employment.documentNumber });
    const employmentId = created.body.id as string;
    await admin.get(`/api/v1/employments/${employmentId}`).expect(200);

    const updatedInput = { ...employment, fullName: "Empleado HTTP actualizado" };
    await admin
      .patch(`/api/v1/employments/${employmentId}`)
      .set("If-Match", "1")
      .send(updatedInput)
      .expect(200);
    const conflict = await admin
      .patch(`/api/v1/employments/${employmentId}`)
      .set("If-Match", "1")
      .send(updatedInput)
      .expect(409);
    expect(conflict.body).toMatchObject({ code: "CONFLICT" });

    const invalidQuery = await admin.get("/api/v1/employments?asOf=not-a-date").expect(400);
    expect(invalidQuery.body).toMatchObject({ code: "VALIDATION_ERROR" });

    const missing = await admin.get("/api/v1/route-that-does-not-exist").expect(404);
    expect(missing.body).toMatchObject({ code: "NOT_FOUND" });

    const businessRule = await admin
      .patch(`/api/v1/admin/users/${login.body.user.id as string}`)
      .send({ active: false })
      .expect(422);
    expect(businessRule.body).toMatchObject({ code: "BUSINESS_RULE_VIOLATION" });

    const schedules = await admin.get("/api/v1/schedules").expect(200);
    const scheduleAlias = await admin.get("/api/v1/vacation-schedules").expect(200);
    expect(schedules.body).not.toHaveProperty("data");
    expect(scheduleAlias.body).toMatchObject({ data: [], items: [] });

    const settlements = await admin.get("/api/v1/settlements").expect(200);
    const settlementAlias = await admin.get("/api/v1/vacation-settlements").expect(200);
    expect(settlements.body).not.toHaveProperty("data");
    expect(settlementAlias.body).toMatchObject({ data: [], items: [] });
  }, 30_000);

  it("returns 207 metrics for partial employment imports and protects retry", async () => {
    const rows = [
      { ...employment, documentNumber: "HTTP-IMPORT-9003" },
      {
        ...employment,
        documentNumber: "x",
        startDate: "not-a-date",
      },
    ];
    await request(app).post("/api/v1/worker-imports/missing/retry").send({ rows }).expect(401);
    const viewer = request.agent(app);
    await viewer.post("/api/v1/auth/login").send({ username: "http-viewer", password }).expect(200);
    await viewer.post("/api/v1/worker-imports/missing/retry").send({ rows }).expect(403);

    const admin = request.agent(app);
    await admin.post("/api/v1/auth/login").send({ username: "http-admin", password }).expect(200);
    const preview = await admin
      .post("/api/v1/worker-imports/preview")
      .send({
        content: [
          "Cédula,Nombre,Fecha contrato,Fecha de retiro,Tipo de contrato,Proceso,Cargo",
          "990001,Empleado válido,01/01/2024,,Indefinido,Operaciones,Analista",
          "990002,Empleado inválido,01/01/2024,31/12/2023,Indefinido,Operaciones,Analista",
        ].join("\n"),
      })
      .expect(200);
    expect(preview.body).toMatchObject({
      totalRows: 2,
      validRows: 1,
      invalidRows: 1,
      validatedRows: [
        { row: 2, valid: true, data: { documentNumber: "990001" } },
        { row: 3, valid: false },
      ],
      errors: [{ row: 3 }],
    });
    expect(preview.body.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    const imported = await admin
      .post("/api/v1/import/employments")
      .set("Idempotency-Key", "http-bulk-import-001")
      .send({ rows })
      .expect(207);
    expect(imported.body).toMatchObject({
      created: 1,
      updated: 0,
      invalidRows: 1,
      batch: { status: "COMPLETED_WITH_ERRORS", processedRows: 2 },
      metrics: { processedRows: 2 },
    });
    expect(imported.body.metrics.durationMs).toBeTypeOf("number");
    expect(imported.body.metrics.databaseOperations).toBeGreaterThan(0);
    expect(imported.body.metrics.chunks).toBeGreaterThan(0);

    const batchId = imported.body.batch.id as string;
    await admin.get(`/api/v1/worker-imports/${batchId}`).expect(200);
    const replayed = await admin
      .post(`/api/v1/worker-imports/${batchId}/retry`)
      .send({ rows })
      .expect(200);
    expect(replayed.body).toMatchObject({ replayed: true, batch: { id: batchId } });
    expect(store.employments.size).toBeGreaterThan(0);
  }, 30_000);

  it("validates and persists the closure cutoff setting", async () => {
    await request(app).get("/api/v1/admin/settings/VACATION_CLOSURE_FROM_DATE").expect(401);
    const admin = request.agent(app);
    await admin.post("/api/v1/auth/login").send({ username: "http-admin", password }).expect(200);
    await admin
      .patch("/api/v1/admin/settings/VACATION_CLOSURE_FROM_DATE")
      .send({ value: "no-es-fecha" })
      .expect(400);
    await admin
      .patch("/api/v1/admin/settings/VACATION_CLOSURE_FROM_DATE")
      .send({ value: "2024-06-01" })
      .expect(200);
    const read = await admin.get("/api/v1/admin/settings/VACATION_CLOSURE_FROM_DATE").expect(200);
    expect(read.body.value).toBe("2024-06-01");
    await admin.get("/api/v1/admin/settings/OTRA_CLAVE").expect(404);
  }, 30_000);
});
