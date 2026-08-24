import { Router } from "express";
import { buildAnnualSchedulePdf } from "../../infrastructure/reports/annualSchedulePdf.js";
import { actor, parseQuery, pathParam } from "../lib/http.js";
import { csvEscape, sendReport } from "../lib/reports.js";
import { authorizeRoute } from "../middleware/auth.js";
import {
  annualScheduleReportQuerySchema,
  balancesReportQuerySchema,
  datedReportQuerySchema,
  settlementReportQuerySchema,
  upcomingReportQuerySchema,
} from "../schemas/reports.js";
import type { RouteDependencies } from "./types.js";

export function reportRoutes({ store, service, auth }: RouteDependencies): Router {
  const router = Router();
  const read = authorizeRoute("GET", "/api/v1/reports");

  router.get("/api/v1/reports/balances", read, async (req, res) => {
    const query = parseQuery(balancesReportQuerySchema, req);
    const items = await service.list(query.search ?? "", undefined, query.asOf);
    const rows = [
      [
        "Cédula",
        "Nombre",
        "Proceso",
        "Cargo",
        "Estado",
        "Días pendientes",
        "Disponible para programar",
        "Próxima causación",
      ],
      ...items.map((item) => [
        item.documentNumber,
        item.fullName,
        item.processName,
        item.positionName,
        item.status,
        item.pendingDays,
        item.availableForScheduling,
        item.nextAccrualDate,
      ]),
    ];
    if (sendReport(res, query.format, "saldos-vacaciones", rows)) return;
    res.json({
      generatedAt: new Date().toISOString(),
      totals: {
        employees: items.length,
        active: items.filter((item) => item.status === "ACTIVE").length,
        pendingDays: items.reduce((total, item) => total + item.pendingDays, 0),
        availableForScheduling: items.reduce(
          (total, item) => total + item.availableForScheduling,
          0,
        ),
      },
      items,
    });
  });

  router.get("/api/v1/reports/balances.csv", read, async (req, res) => {
    const query = parseQuery(datedReportQuerySchema, req);
    const items = await service.list("", undefined, query.asOf);
    const lines = [
      [
        "Cédula",
        "Nombre",
        "Proceso",
        "Cargo",
        "Estado",
        "Días pendientes",
        "Disponible para programar",
        "Próxima causación",
      ]
        .map(csvEscape)
        .join(","),
      ...items.map((item) =>
        [
          item.documentNumber,
          item.fullName,
          item.processName,
          item.positionName,
          item.status,
          item.pendingDays,
          item.availableForScheduling,
          item.nextAccrualDate,
        ]
          .map(csvEscape)
          .join(","),
      ),
    ];
    res
      .type("text/csv")
      .set("Content-Disposition", 'attachment; filename="saldos-vacaciones.csv"')
      .send(lines.join("\n"));
  });

  router.get("/api/v1/reports/upcoming", read, async (req, res) => {
    const query = parseQuery(upcomingReportQuerySchema, req);
    const items = await service.list("", query.days, query.asOf);
    res.json({ days: query.days, items });
  });

  router.get("/api/v1/reports/workers", read, async (req, res) => {
    const query = parseQuery(datedReportQuerySchema, req);
    const data = await store.listWorkers();
    const rows = [
      ["Cédula", "Nombre", "Tipo"],
      ...data.map((item) => [item.documentNumber, item.fullName, item.workerType]),
    ];
    if (sendReport(res, query.format, "trabajadores", rows)) return;
    res.json({ data, items: data });
  });

  router.get("/api/v1/reports/pending-periods", read, async (req, res) => {
    const query = parseQuery(datedReportQuerySchema, req);
    const data = (await service.list("", undefined, query.asOf)).filter(
      (item) => item.pendingDays > 0,
    );
    const rows = [
      ["Cédula", "Nombre", "Pendientes", "Atrasados"],
      ...data.map((item) => [
        item.documentNumber,
        item.fullName,
        item.pendingDays,
        item.overduePeriods,
      ]),
    ];
    if (sendReport(res, query.format, "periodos-pendientes", rows)) return;
    res.json({ data, items: data });
  });

  router.get("/api/v1/reports/upcoming-accruals", read, async (req, res) => {
    const query = parseQuery(upcomingReportQuerySchema, req);
    const data = await service.list("", query.days, query.asOf);
    const rows = [
      ["Cédula", "Nombre", "Próxima causación", "Días restantes"],
      ...data.map((item) => [
        item.documentNumber,
        item.fullName,
        item.nextAccrualDate,
        item.daysUntilAccrual,
      ]),
    ];
    if (sendReport(res, query.format, "proximas-causaciones", rows)) return;
    res.json({ data, items: data });
  });

  router.get("/api/v1/reports/settlements", read, async (req, res) => {
    const query = parseQuery(settlementReportQuerySchema, req);
    const data = await service.settlementReport({
      ...(query.search ? { search: query.search } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
    const rows = [
      [
        "Empleado",
        "Cédula",
        "Proceso",
        "Cargo",
        "Supervisor",
        "Inicio disfrute",
        "Fin disfrute",
        "Fecha fin período",
        "Días tomados",
        "Días compensados",
        "Total calendario",
        "Valor total",
        "Documento de liquidación",
        "Estado",
      ],
      ...data.map((item) => [
        item.employeeName ?? "Empleado no identificado",
        item.employeeDocumentNumber ?? item.employmentId,
        item.processName ?? "",
        item.positionName ?? "",
        item.supervisorName ?? "",
        item.enjoymentStartDate,
        item.enjoymentEndDate,
        item.periodEndDate,
        item.enjoyedDays,
        item.compensatedDays,
        item.calendarDays,
        item.amountCOP,
        item.accountingDocument,
        item.status,
      ]),
    ];
    if (sendReport(res, query.format, "liquidaciones", rows)) return;
    res.json({ data, items: data });
  });

  router.get("/api/v1/reports/compensations", read, async (req, res) => {
    const query = parseQuery(datedReportQuerySchema, req);
    const data = (await store.listSettlements()).filter((item) => item.compensatedDays > 0);
    const rows = [
      ["Vínculo", "Días compensados", "Valor", "Documento"],
      ...data.map((item) => [
        item.employmentId,
        item.compensatedDays,
        item.amountCOP,
        item.accountingDocument,
      ]),
    ];
    if (sendReport(res, query.format, "compensaciones", rows)) return;
    res.json({ data, items: data });
  });

  router.get("/api/v1/reports/schedules/annual", read, async (req, res) => {
    const query = parseQuery(annualScheduleReportQuerySchema, req);
    const baseReport = await service.annualScheduleReport({
      ...(query.year !== undefined ? { year: query.year } : {}),
      ...(query.from ? { fromDate: query.from } : {}),
      ...(query.to ? { toDate: query.to } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { search: query.search } : {}),
    });
    const currentUser = await auth.currentUser(actor(req));
    const gerente = await store.findSystemSettingByKey("GERENTE");
    const report = {
      ...baseReport,
      preparedBy: currentUser?.displayName?.trim() || currentUser?.username || actor(req),
      approvedBy: gerente?.value?.trim() || "Sin configurar",
    };
    if (query.format === "json") return res.json(report);
    await store.append({
      id: crypto.randomUUID(),
      actorId: actor(req),
      action: "SCHEDULE_ANNUAL_REPORT_EXPORTED",
      entityType: "VacationScheduleReport",
      entityId: report.rangeLabel,
      metadata: {
        fromDate: query.from ?? "",
        toDate: query.to ?? "",
        year: query.year ?? null,
        status: query.status ?? "ALL",
        search: query.search ?? "",
        totalEmployees: report.totalEmployees,
        totalSchedules: report.totalSchedules,
        totalDays: report.totalDays,
        preparedBy: report.preparedBy,
        approvedBy: report.approvedBy,
      },
      createdAt: new Date().toISOString(),
    });
    const pdf = await buildAnnualSchedulePdf(report);
    const fileSuffix =
      query.year !== undefined
        ? String(query.year)
        : query.from && query.to
          ? `${query.from}_a_${query.to}`
          : "completo";
    return res
      .type("application/pdf")
      .set(
        "Content-Disposition",
        `attachment; filename="programacion-vacaciones-${fileSuffix}.pdf"`,
      )
      .send(pdf);
  });

  router.get("/api/v1/reports/schedules", read, async (req, res) => {
    const query = parseQuery(datedReportQuerySchema, req);
    const data = await store.listSchedules();
    const rows = [
      ["Vínculo", "Inicio", "Fin", "Días", "Estado"],
      ...data.map((item) => [
        item.employmentId,
        item.startDate,
        item.endDate,
        item.scheduledDays,
        item.status,
      ]),
    ];
    if (sendReport(res, query.format, "cronograma", rows)) return;
    res.json({ data, items: data });
  });

  router.get("/api/v1/reports/workers/:id/history", read, async (req, res) => {
    const query = parseQuery(datedReportQuerySchema, req);
    const employments = (await store.listEmployments()).filter(
      (item) => item.workerId === pathParam(req, "id"),
    );
    const data = [];
    for (const employment of employments) {
      data.push(await service.detail(employment.id, query.asOf));
    }
    res.json({ data, items: data });
  });

  return router;
}
