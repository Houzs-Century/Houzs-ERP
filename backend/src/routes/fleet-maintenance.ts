// ----------------------------------------------------------------------------
// /api/fleet-maintenance — Fleet Maintenance & Compliance, Phase 1.
//
// A SELF-CONTAINED native module: a lorry master (fleet_vehicles) + a
// compliance vault with true renewal history (fleet_compliance_documents),
// surfaced as a Fleet Health dashboard. Company-scoped, gated by the flat
// fleet.read / fleet.write permissions (services/permissions.ts).
//
// The backend is the SINGLE SOURCE OF TRUTH for derived state: it runs
// services/fleet-status.ts (the same pure functions the unit tests pin) and
// returns ready-to-render status, reminder levels and KPIs, so the frontend
// never re-derives the rules (and the two can never disagree).
//
// NOT scm.lorries. See mig 0200's header — reconciling the two lorry masters is
// a deferred owner decision. This module does not read or write scm.*.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { getDb } from "../db/client";
import { fleet_vehicles, fleet_compliance_documents } from "../db/schema";
import { and, eq, inArray, desc } from "drizzle-orm";
import {
  COMPLIANCE_DOC_TYPES,
  type ComplianceDocType,
  type PuspakomResult,
  daysUntil,
  reminderLevel,
  reminderTone,
  currentDocsByType,
  deriveVehicleStatus,
  canDispatch,
  VEHICLE_STATUS_LABELS,
  type ComplianceDocInput,
} from "../services/fleet-status";

const app = new Hono<{ Bindings: Env }>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_TYPE_SET = new Set<string>(COMPLIANCE_DOC_TYPES);

/** Today's calendar date in MYT (UTC+8), where the fleet operates. Compliance
 *  expiry is a calendar-day fact; computing it in the server's UTC could shift
 *  a "due today" by a day for late-evening MYT reads. */
function todayMyt(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** Normalize a DB `date`/`timestamptz` value to a plain YYYY-MM-DD string,
 *  whether the driver hands back a string or a Date. The compliance logic keys
 *  entirely off these, and a Date leaking through would silently read as
 *  "no date on file" — so normalize at the boundary. */
function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? s : null;
}

/** Coerce a fetched compliance row's date columns to YYYY-MM-DD strings so all
 *  downstream logic (which slices/parses them as strings) is driver-agnostic. */
function normDates<T extends { issue_date: unknown; expiry_date: unknown; reinspection_deadline: unknown }>(d: T): T {
  return { ...d, issue_date: iso(d.issue_date), expiry_date: iso(d.expiry_date), reinspection_deadline: iso(d.reinspection_deadline) };
}

function dateOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? { ok: true, value: s } : { ok: false };
}

function intOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/** Shape a compliance row for the wire, with its computed reminder state. */
function shapeDoc(row: {
  id: number;
  doc_type: string;
  document_ref: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  cost_centi: number | null;
  owner: string | null;
  result: string | null;
  reinspection_deadline: string | null;
  notes: string | null;
}, today: string) {
  const expiryDate = iso(row.expiry_date);
  const days = daysUntil(expiryDate, today);
  const level = reminderLevel(days);
  return {
    id: row.id,
    docType: row.doc_type as ComplianceDocType,
    documentRef: row.document_ref,
    issueDate: iso(row.issue_date),
    expiryDate,
    costCenti: row.cost_centi,
    owner: row.owner,
    result: row.result as PuspakomResult | null,
    reinspectionDeadline: iso(row.reinspection_deadline),
    notes: row.notes,
    daysRemaining: days,
    reminderLevel: level,
    tone: reminderTone(level),
  };
}

// ── GET /dashboard — the whole Fleet Health payload ─────────────────────────
// Vehicles with derived status + current compliance per type + reminder levels,
// plus the KPI ribbon counts. One query pair, all derivation server-side.
app.get("/dashboard", requirePermission("fleet.read"), async (c) => {
  const db = getDb(c.env);
  const companyId = c.get("companyId");
  const today = todayMyt();

  const vehicles = await db
    .select()
    .from(fleet_vehicles)
    .where(
      companyId != null
        ? and(eq(fleet_vehicles.company_id, companyId), eq(fleet_vehicles.active, true))
        : eq(fleet_vehicles.active, true),
    )
    .orderBy(fleet_vehicles.plate);

  const ids = vehicles.map((v) => v.id);
  const docs = (ids.length
    ? await db
        .select()
        .from(fleet_compliance_documents)
        .where(inArray(fleet_compliance_documents.vehicle_id, ids))
        .orderBy(desc(fleet_compliance_documents.expiry_date))
    : []
  ).map(normDates);

  const docsByVehicle = new Map<number, typeof docs>();
  for (const d of docs) {
    const list = docsByVehicle.get(d.vehicle_id) ?? [];
    list.push(d);
    docsByVehicle.set(d.vehicle_id, list);
  }

  // KPI accumulators.
  let expiredDocs = 0, expiring30 = 0, expiring60 = 0, expiring90 = 0;
  let serviceDueCount = 0, breakdowns = 0, complianceBlocked = 0, cantDispatch = 0;
  const statusCounts: Record<string, number> = {};

  const rows = vehicles.map((v) => {
    const vDocs = docsByVehicle.get(v.id) ?? [];
    const current = currentDocsByType(
      vDocs.map((d) => ({ docType: d.doc_type as ComplianceDocType, expiryDate: d.expiry_date, issueDate: d.issue_date })),
    );

    // Rebuild the current doc's full shape (currentDocsByType only carries the
    // ranking fields) by finding the row it picked.
    const compliance: Record<string, ReturnType<typeof shapeDoc>> = {};
    const statusDocs: ComplianceDocInput[] = [];
    for (const type of COMPLIANCE_DOC_TYPES) {
      const picked = current.get(type);
      if (!picked) continue;
      const full = vDocs.find((d) => d.doc_type === type && d.expiry_date === picked.expiryDate && d.issue_date === picked.issueDate);
      if (!full) continue;
      compliance[type] = shapeDoc(full, today);
      statusDocs.push({ docType: type, expiryDate: full.expiry_date, result: full.result as PuspakomResult | null });
    }

    const status = deriveVehicleStatus({
      today,
      outOfService: v.out_of_service,
      currentDocs: statusDocs,
      currentMileageKm: v.current_mileage_km,
      nextServiceKm: v.next_service_km,
      nextServiceDate: iso(v.next_service_date),
    });

    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status === "SERVICE_DUE") serviceDueCount++;
    if (status === "BREAKDOWN") breakdowns++;
    if (status === "COMPLIANCE_BLOCKED") complianceBlocked++;
    if (!canDispatch(status)) cantDispatch++;

    for (const type of COMPLIANCE_DOC_TYPES) {
      const doc = compliance[type];
      if (!doc || doc.daysRemaining === null) continue;
      if (doc.daysRemaining < 0) expiredDocs++;
      else if (doc.daysRemaining <= 30) expiring30++;
      else if (doc.daysRemaining <= 60) expiring60++;
      else if (doc.daysRemaining <= 90) expiring90++;
    }

    return {
      id: v.id,
      plate: v.plate,
      region: v.region,
      driverName: v.driver_name,
      vehicleType: v.vehicle_type,
      model: v.model,
      mileageKm: v.current_mileage_km,
      nextServiceKm: v.next_service_km,
      nextServiceDate: iso(v.next_service_date),
      outOfService: v.out_of_service,
      outOfServiceReason: v.out_of_service_reason,
      notes: v.notes,
      status,
      statusLabel: VEHICLE_STATUS_LABELS[status],
      canDispatch: canDispatch(status),
      compliance,
    };
  });

  return c.json({
    today,
    kpis: {
      expiredDocs,
      expiring30,
      expiring60,
      expiring90,
      serviceDue: serviceDueCount,
      activeBreakdowns: breakdowns,
      complianceBlocked,
      cantDispatch,
      fleetSize: rows.length,
      // Phase-2 seams: repair spend + costliest vehicle come from the work-order
      // / service-cost module, not yet built. Surfaced as null so the UI shows
      // "not yet tracked" rather than a misleading RM 0.
      repairSpendThisMonthCenti: null as number | null,
      costliestVehicle: null as string | null,
    },
    statusCounts,
    vehicles: rows,
  });
});

// ── GET /vehicles/:id — one vehicle + FULL compliance history (drawer) ───────
app.get("/vehicles/:id", requirePermission("fleet.read"), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const db = getDb(c.env);
  const companyId = c.get("companyId");
  const today = todayMyt();

  const [v] = await db
    .select()
    .from(fleet_vehicles)
    .where(
      companyId != null ? and(eq(fleet_vehicles.id, id), eq(fleet_vehicles.company_id, companyId)) : eq(fleet_vehicles.id, id),
    )
    .limit(1);
  if (!v) return c.json({ error: "vehicle_not_found" }, 404);

  const history = (await db
    .select()
    .from(fleet_compliance_documents)
    .where(eq(fleet_compliance_documents.vehicle_id, id))
    .orderBy(desc(fleet_compliance_documents.issue_date), desc(fleet_compliance_documents.expiry_date))
  ).map(normDates);

  // Group full history per type (newest first), and mark the current row.
  const current = currentDocsByType(
    history.map((d) => ({ docType: d.doc_type as ComplianceDocType, expiryDate: d.expiry_date, issueDate: d.issue_date })),
  );
  const byType: Record<string, { current: number | null; history: ReturnType<typeof shapeDoc>[] }> = {};
  const statusDocs: ComplianceDocInput[] = [];
  for (const type of COMPLIANCE_DOC_TYPES) {
    const rows = history.filter((d) => d.doc_type === type).map((d) => shapeDoc(d, today));
    const picked = current.get(type);
    const currentRow = picked
      ? history.find((d) => d.doc_type === type && d.expiry_date === picked.expiryDate && d.issue_date === picked.issueDate)
      : undefined;
    byType[type] = { current: currentRow?.id ?? null, history: rows };
    if (currentRow) statusDocs.push({ docType: type, expiryDate: currentRow.expiry_date, result: currentRow.result as PuspakomResult | null });
  }

  const status = deriveVehicleStatus({
    today,
    outOfService: v.out_of_service,
    currentDocs: statusDocs,
    currentMileageKm: v.current_mileage_km,
    nextServiceKm: v.next_service_km,
    nextServiceDate: iso(v.next_service_date),
  });

  return c.json({
    vehicle: {
      id: v.id,
      plate: v.plate,
      region: v.region,
      driverName: v.driver_name,
      vehicleType: v.vehicle_type,
      model: v.model,
      mileageKm: v.current_mileage_km,
      nextServiceKm: v.next_service_km,
      nextServiceDate: iso(v.next_service_date),
      outOfService: v.out_of_service,
      outOfServiceReason: v.out_of_service_reason,
      notes: v.notes,
      status,
      statusLabel: VEHICLE_STATUS_LABELS[status],
      canDispatch: canDispatch(status),
    },
    compliance: byType,
  });
});

// ── GET /reminders — the fleet-wide actionable expiry list ───────────────────
// Every current compliance document that has passed the 60-day "prepare"
// threshold (or is expired / failed), newest-urgency first. This is the list
// the dashboard reminders panel renders; a later phase can hang the real
// notification push off the same computation.
app.get("/reminders", requirePermission("fleet.read"), async (c) => {
  const db = getDb(c.env);
  const companyId = c.get("companyId");
  const today = todayMyt();

  const vehicles = await db
    .select()
    .from(fleet_vehicles)
    .where(
      companyId != null
        ? and(eq(fleet_vehicles.company_id, companyId), eq(fleet_vehicles.active, true))
        : eq(fleet_vehicles.active, true),
    );
  const ids = vehicles.map((v) => v.id);
  const byId = new Map(vehicles.map((v) => [v.id, v]));
  const docs = (ids.length
    ? await db
        .select()
        .from(fleet_compliance_documents)
        .where(inArray(fleet_compliance_documents.vehicle_id, ids))
        .orderBy(desc(fleet_compliance_documents.expiry_date))
    : []
  ).map(normDates);

  const docsByVehicle = new Map<number, typeof docs>();
  for (const d of docs) {
    const list = docsByVehicle.get(d.vehicle_id) ?? [];
    list.push(d);
    docsByVehicle.set(d.vehicle_id, list);
  }

  const reminders: Array<{
    vehicleId: number;
    plate: string;
    region: string | null;
    docType: ComplianceDocType;
    expiryDate: string | null;
    daysRemaining: number | null;
    reminderLevel: string;
    tone: string;
    result: string | null;
  }> = [];

  for (const [vid, vDocs] of docsByVehicle) {
    const v = byId.get(vid);
    if (!v) continue;
    const current = currentDocsByType(
      vDocs.map((d) => ({ docType: d.doc_type as ComplianceDocType, expiryDate: d.expiry_date, issueDate: d.issue_date })),
    );
    for (const type of COMPLIANCE_DOC_TYPES) {
      const picked = current.get(type);
      if (!picked) continue;
      const full = vDocs.find((d) => d.doc_type === type && d.expiry_date === picked.expiryDate && d.issue_date === picked.issueDate);
      if (!full) continue;
      const shaped = shapeDoc(full, today);
      if (shaped.reminderLevel === "OK") continue;
      reminders.push({
        vehicleId: v.id,
        plate: v.plate,
        region: v.region,
        docType: type,
        expiryDate: shaped.expiryDate,
        daysRemaining: shaped.daysRemaining,
        reminderLevel: shaped.reminderLevel,
        tone: shaped.tone,
        result: shaped.result,
      });
    }
  }

  // Most urgent first: expired (most-negative) up through PREPARE.
  reminders.sort((a, b) => (a.daysRemaining ?? 1e9) - (b.daysRemaining ?? 1e9));
  return c.json({ today, reminders });
});

// ── POST /vehicles — create a lorry ─────────────────────────────────────────
app.post("/vehicles", requirePermission("fleet.write"), async (c) => {
  const companyId = c.get("companyId");
  if (companyId == null) return c.json({ error: "no_active_company" }, 409);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const plate = String(body.plate ?? "").trim();
  if (!plate) return c.json({ error: "plate_required" }, 400);

  const mileage = intOrNull(body.mileageKm);
  if (!mileage.ok) return c.json({ error: "invalid_mileage" }, 400);
  const nextKm = intOrNull(body.nextServiceKm);
  if (!nextKm.ok) return c.json({ error: "invalid_next_service_km" }, 400);
  const nextDate = dateOrNull(body.nextServiceDate);
  if (!nextDate.ok) return c.json({ error: "invalid_next_service_date" }, 400);

  const db = getDb(c.env);
  const existing = await db
    .select({ id: fleet_vehicles.id })
    .from(fleet_vehicles)
    .where(and(eq(fleet_vehicles.company_id, companyId), eq(fleet_vehicles.plate, plate)))
    .limit(1);
  if (existing.length > 0) return c.json({ error: "duplicate_plate" }, 409);

  const inserted = await db
    .insert(fleet_vehicles)
    .values({
      company_id: companyId,
      plate,
      region: (body.region as string)?.trim() || null,
      driver_name: (body.driverName as string)?.trim() || null,
      vehicle_type: (body.vehicleType as string)?.trim() || null,
      model: (body.model as string)?.trim() || null,
      current_mileage_km: mileage.value,
      next_service_km: nextKm.value,
      next_service_date: nextDate.value,
      out_of_service: body.outOfService === true,
      out_of_service_reason: (body.outOfServiceReason as string)?.trim() || null,
      notes: (body.notes as string)?.trim() || null,
      created_by: c.get("user")?.id ?? null,
    })
    .returning({ id: fleet_vehicles.id });

  return c.json({ id: inserted[0]?.id }, 201);
});

// ── PATCH /vehicles/:id — edit master fields incl. the manual OOS flag ───────
app.patch("/vehicles/:id", requirePermission("fleet.write"), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const companyId = c.get("companyId");
  if (companyId == null) return c.json({ error: "no_active_company" }, 409);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const set: Record<string, unknown> = {};
  if (body.plate !== undefined) {
    const plate = String(body.plate).trim();
    if (!plate) return c.json({ error: "plate_required" }, 400);
    set.plate = plate;
  }
  if (body.region !== undefined) set.region = (body.region as string)?.trim() || null;
  if (body.driverName !== undefined) set.driver_name = (body.driverName as string)?.trim() || null;
  if (body.vehicleType !== undefined) set.vehicle_type = (body.vehicleType as string)?.trim() || null;
  if (body.model !== undefined) set.model = (body.model as string)?.trim() || null;
  if (body.mileageKm !== undefined) {
    const v = intOrNull(body.mileageKm);
    if (!v.ok) return c.json({ error: "invalid_mileage" }, 400);
    set.current_mileage_km = v.value;
  }
  if (body.nextServiceKm !== undefined) {
    const v = intOrNull(body.nextServiceKm);
    if (!v.ok) return c.json({ error: "invalid_next_service_km" }, 400);
    set.next_service_km = v.value;
  }
  if (body.nextServiceDate !== undefined) {
    const v = dateOrNull(body.nextServiceDate);
    if (!v.ok) return c.json({ error: "invalid_next_service_date" }, 400);
    set.next_service_date = v.value;
  }
  if (body.outOfService !== undefined) set.out_of_service = Boolean(body.outOfService);
  if (body.outOfServiceReason !== undefined) set.out_of_service_reason = (body.outOfServiceReason as string)?.trim() || null;
  if (body.notes !== undefined) set.notes = (body.notes as string)?.trim() || null;
  if (body.active !== undefined) set.active = Boolean(body.active);
  if (Object.keys(set).length === 0) return c.json({ error: "no_changes" }, 400);
  set.updated_at = new Date().toISOString();

  const db = getDb(c.env);
  const existing = await db
    .select({ id: fleet_vehicles.id })
    .from(fleet_vehicles)
    .where(and(eq(fleet_vehicles.id, id), eq(fleet_vehicles.company_id, companyId)))
    .limit(1);
  if (existing.length === 0) return c.json({ error: "vehicle_not_found" }, 404);

  await db.update(fleet_vehicles).set(set).where(eq(fleet_vehicles.id, id));
  return c.json({ ok: true });
});

// ── POST /vehicles/:id/compliance — APPEND a compliance document (renewal) ───
// Renewals are new rows; the prior document stays as history. Never overwrites.
app.post("/vehicles/:id/compliance", requirePermission("fleet.write"), async (c) => {
  const vehicleId = Number(c.req.param("id"));
  if (!Number.isInteger(vehicleId)) return c.json({ error: "invalid_id" }, 400);
  const companyId = c.get("companyId");
  if (companyId == null) return c.json({ error: "no_active_company" }, 409);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const docType = String(body.docType ?? "").trim();
  if (!DOC_TYPE_SET.has(docType)) return c.json({ error: "invalid_doc_type" }, 400);

  const issue = dateOrNull(body.issueDate);
  if (!issue.ok) return c.json({ error: "invalid_issue_date" }, 400);
  const expiry = dateOrNull(body.expiryDate);
  if (!expiry.ok) return c.json({ error: "invalid_expiry_date" }, 400);
  const reinspect = dateOrNull(body.reinspectionDeadline);
  if (!reinspect.ok) return c.json({ error: "invalid_reinspection_deadline" }, 400);
  const cost = intOrNull(body.costCenti);
  if (!cost.ok) return c.json({ error: "invalid_cost" }, 400);

  let result: string | null = null;
  if (docType === "PUSPAKOM" && body.result !== undefined && body.result !== null && body.result !== "") {
    const r = String(body.result).toUpperCase();
    if (r !== "PASS" && r !== "FAIL") return c.json({ error: "invalid_result" }, 400);
    result = r;
  }

  const db = getDb(c.env);
  // Confirm the vehicle belongs to the active company before appending.
  const [v] = await db
    .select({ id: fleet_vehicles.id })
    .from(fleet_vehicles)
    .where(and(eq(fleet_vehicles.id, vehicleId), eq(fleet_vehicles.company_id, companyId)))
    .limit(1);
  if (!v) return c.json({ error: "vehicle_not_found" }, 404);

  const inserted = await db
    .insert(fleet_compliance_documents)
    .values({
      company_id: companyId,
      vehicle_id: vehicleId,
      doc_type: docType,
      document_ref: (body.documentRef as string)?.trim() || null,
      issue_date: issue.value,
      expiry_date: expiry.value,
      cost_centi: cost.value,
      owner: (body.owner as string)?.trim() || null,
      result,
      reinspection_deadline: reinspect.value,
      notes: (body.notes as string)?.trim() || null,
      created_by: c.get("user")?.id ?? null,
    })
    .returning({ id: fleet_compliance_documents.id });

  return c.json({ id: inserted[0]?.id }, 201);
});

export default app;
