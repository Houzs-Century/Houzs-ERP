// ----------------------------------------------------------------------------
// /api/fleet-maintenance — Fleet Maintenance & Compliance, Phase 1.
//
// Builds ON the EXISTING SCM fleet foundation — it does NOT create a parallel
// master (mig 0055 already dropped a duplicate public.lorries once). The lorry
// master is scm.lorries; people come from scm.drivers (drivers.vehicle holds
// the plate); region from scm.warehouses; out-of-service from the existing
// scm.lorry_maintenance windows; mileage + next service from the latest
// scm.lorry_service_records row. The ONE genuinely-new table is the compliance
// VAULT (scm.lorry_compliance_documents, mig 0202) with true renewal history.
//
// Mounted at TOP LEVEL (outside /api/scm) so the gate is the flat fleet.read /
// fleet.write permission alone, not the coarse scm.access. It uses the SCM
// supabase client via supabaseAuth (same as the sibling lorry routes) and gates
// on the REAL Houzs caller via requireHouzsPerm.
//
// The backend is the SINGLE SOURCE OF TRUTH for derived state: it runs the pure,
// unit-tested services/fleet-status.ts and returns ready-to-render status,
// reminder levels and KPIs, so the frontend never re-derives the rules.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import { requireHouzsPerm } from "../lib/houzs-perms";
import { activeCompanyId } from "../lib/companyScope";
import type { Env, Variables } from "../env";
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
} from "../../services/fleet-status";

export const fleetMaintenance = new Hono<{ Bindings: Env; Variables: Variables }>();
fleetMaintenance.use("*", supabaseAuth);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_TYPE_SET = new Set<string>(COMPLIANCE_DOC_TYPES);
// doc_type -> the denormalized "current" flat column on scm.lorries (mig 0121).
// APAD / CROSS_BORDER are vault-only (no flat column).
const FLAT_COL: Partial<Record<ComplianceDocType, "road_tax_expiry" | "insurance_expiry" | "puspakom_expiry">> = {
  ROAD_TAX: "road_tax_expiry",
  INSURANCE: "insurance_expiry",
  PUSPAKOM: "puspakom_expiry",
};

/** Today's calendar date in MYT (UTC+8), where the fleet operates. */
function todayMyt(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}
function iso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? s : null;
}
function normPlate(p: string | null | undefined): string {
  return (p ?? "").replace(/\s+/g, "").toUpperCase();
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

type VaultRow = {
  id: string;
  lorry_id: string;
  doc_type: string;
  document_ref: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  cost_centi: number | null;
  owner: string | null;
  result: string | null;
  reinspection_deadline: string | null;
  notes: string | null;
};

function shapeDoc(row: VaultRow, today: string) {
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
    source: "vault" as const,
  };
}

/** A synthetic "current" doc built from a scm.lorries flat expiry column, used
 *  when the vault has no row of that type yet (existing lorries keep working). */
function flatDoc(docType: ComplianceDocType, expiry: string | null, today: string) {
  const expiryDate = iso(expiry);
  const days = daysUntil(expiryDate, today);
  const level = reminderLevel(days);
  return {
    id: null as string | null,
    docType,
    documentRef: null,
    issueDate: null,
    expiryDate,
    costCenti: null,
    owner: null,
    result: null as PuspakomResult | null,
    reinspectionDeadline: null,
    notes: null,
    daysRemaining: days,
    reminderLevel: level,
    tone: reminderTone(level),
    source: "flat" as const,
  };
}

type DocView = ReturnType<typeof shapeDoc> | ReturnType<typeof flatDoc>;

type Lorry = {
  id: string;
  plate: string;
  type: string | null;
  is_internal: boolean | null;
  warehouse_id: string | null;
  active: boolean | null;
  model: string | null;
  road_tax_expiry: string | null;
  insurance_expiry: string | null;
  puspakom_expiry: string | null;
  notes: string | null;
};

/** The current document per type for a lorry: the latest-expiring VAULT row if
 *  present, otherwise a synthetic doc from the scm.lorries flat column. */
function currentByType(lorry: Lorry, vaultRows: VaultRow[], today: string) {
  const currentVault = currentDocsByType(
    vaultRows.map((d) => ({ docType: d.doc_type as ComplianceDocType, expiryDate: d.expiry_date, issueDate: d.issue_date })),
  );
  const out: Partial<Record<ComplianceDocType, DocView>> = {};
  const statusDocs: ComplianceDocInput[] = [];
  for (const type of COMPLIANCE_DOC_TYPES) {
    const picked = currentVault.get(type);
    if (picked) {
      const full = vaultRows.find(
        (d) => d.doc_type === type && iso(d.expiry_date) === iso(picked.expiryDate) && iso(d.issue_date) === iso(picked.issueDate),
      );
      if (full) {
        out[type] = shapeDoc(full, today);
        statusDocs.push({ docType: type, expiryDate: iso(full.expiry_date), result: full.result as PuspakomResult | null });
        continue;
      }
    }
    // Fallback to the flat column (only the three that have one).
    const col = FLAT_COL[type];
    if (col && lorry[col]) {
      out[type] = flatDoc(type, lorry[col], today);
      statusDocs.push({ docType: type, expiryDate: iso(lorry[col]), result: null });
    }
  }
  return { compliance: out, statusDocs };
}

// ── GET /dashboard ──────────────────────────────────────────────────────────
fleetMaintenance.get("/dashboard", requireHouzsPerm("fleet.read"), async (c) => {
  const sb = c.get("supabase");
  const today = todayMyt();
  const monthStart = today.slice(0, 8) + "01";

  const [lorriesR, whR, driversR, vaultR, maintR, svcR] = await Promise.all([
    sb.from("lorries").select("id, plate, type, is_internal, warehouse_id, active, model, road_tax_expiry, insurance_expiry, puspakom_expiry, notes").eq("active", true).order("plate"),
    sb.from("warehouses").select("id, code, name"),
    sb.from("drivers").select("vehicle, name").eq("active", true),
    sb.from("lorry_compliance_documents").select("*"),
    sb.from("lorry_maintenance").select("lorry_id, unavailable_from, unavailable_to, reason").lte("unavailable_from", today).gte("unavailable_to", today),
    sb.from("lorry_service_records").select("lorry_id, service_date, odometer_km, next_service_km, next_service_date, cost_centi").order("service_date", { ascending: false }),
  ]);
  const firstErr = lorriesR.error || whR.error || driversR.error || vaultR.error || maintR.error || svcR.error;
  if (firstErr) return c.json({ error: "load_failed", reason: firstErr.message }, 500);

  const lorries = (lorriesR.data ?? []) as Lorry[];
  const whCode = new Map<string, string>();
  for (const w of whR.data ?? []) whCode.set(w.id as string, (w.code as string) ?? (w.name as string) ?? "");
  const driverByPlate = new Map<string, string>();
  for (const d of driversR.data ?? []) {
    const key = normPlate(d.vehicle as string | null);
    if (key && !driverByPlate.has(key)) driverByPlate.set(key, d.name as string);
  }
  const vaultByLorry = new Map<string, VaultRow[]>();
  for (const v of (vaultR.data ?? []) as VaultRow[]) {
    const list = vaultByLorry.get(v.lorry_id) ?? [];
    list.push(v);
    vaultByLorry.set(v.lorry_id, list);
  }
  const oosByLorry = new Map<string, string | null>();
  for (const m of maintR.data ?? []) if (!oosByLorry.has(m.lorry_id as string)) oosByLorry.set(m.lorry_id as string, (m.reason as string) ?? null);
  // latest service record per lorry (rows already newest-first) + this-month spend.
  const latestSvc = new Map<string, { odometer_km: number | null; next_service_km: number | null; next_service_date: string | null }>();
  const monthSpend = new Map<string, number>();
  for (const s of svcR.data ?? []) {
    const lid = s.lorry_id as string;
    if (!latestSvc.has(lid)) latestSvc.set(lid, { odometer_km: s.odometer_km as number | null, next_service_km: s.next_service_km as number | null, next_service_date: iso(s.next_service_date) });
    if (iso(s.service_date) && iso(s.service_date)! >= monthStart) monthSpend.set(lid, (monthSpend.get(lid) ?? 0) + Number(s.cost_centi ?? 0));
  }

  let expiredDocs = 0, expiring30 = 0, expiring60 = 0, expiring90 = 0;
  let serviceDueCount = 0, breakdowns = 0, complianceBlocked = 0, cantDispatch = 0;
  const statusCounts: Record<string, number> = {};

  const rows = lorries.map((l) => {
    const { compliance, statusDocs } = currentByType(l, vaultByLorry.get(l.id) ?? [], today);
    const svc = latestSvc.get(l.id);
    const status = deriveVehicleStatus({
      today,
      outOfService: oosByLorry.has(l.id),
      currentDocs: statusDocs,
      currentMileageKm: svc?.odometer_km ?? null,
      nextServiceKm: svc?.next_service_km ?? null,
      nextServiceDate: svc?.next_service_date ?? null,
    });
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status === "SERVICE_DUE") serviceDueCount++;
    if (status === "BREAKDOWN") breakdowns++;
    if (status === "COMPLIANCE_BLOCKED") complianceBlocked++;
    if (!canDispatch(status)) cantDispatch++;
    for (const type of COMPLIANCE_DOC_TYPES) {
      const d = compliance[type];
      if (!d || d.daysRemaining === null) continue;
      if (d.daysRemaining < 0) expiredDocs++;
      else if (d.daysRemaining <= 30) expiring30++;
      else if (d.daysRemaining <= 60) expiring60++;
      else if (d.daysRemaining <= 90) expiring90++;
    }
    return {
      id: l.id,
      plate: l.plate,
      region: l.warehouse_id ? whCode.get(l.warehouse_id) ?? null : null,
      driverName: driverByPlate.get(normPlate(l.plate)) ?? null,
      vehicleType: l.type,
      model: l.model,
      mileageKm: svc?.odometer_km ?? null,
      nextServiceKm: svc?.next_service_km ?? null,
      nextServiceDate: svc?.next_service_date ?? null,
      outOfService: oosByLorry.has(l.id),
      outOfServiceReason: oosByLorry.get(l.id) ?? null,
      notes: l.notes,
      status,
      statusLabel: VEHICLE_STATUS_LABELS[status],
      canDispatch: canDispatch(status),
      compliance,
    };
  });

  // Costliest vehicle this month (from scm.lorry_service_records).
  let costliestVehicle: string | null = null;
  let costliestCenti = 0;
  const plateById = new Map(lorries.map((l) => [l.id, l.plate]));
  for (const [lid, spent] of monthSpend) if (spent > costliestCenti) { costliestCenti = spent; costliestVehicle = plateById.get(lid) ?? null; }
  const repairSpendThisMonthCenti = [...monthSpend.values()].reduce((a, b) => a + b, 0);

  return c.json({
    today,
    kpis: {
      expiredDocs, expiring30, expiring60, expiring90,
      serviceDue: serviceDueCount, activeBreakdowns: breakdowns, complianceBlocked, cantDispatch,
      fleetSize: rows.length,
      repairSpendThisMonthCenti: monthSpend.size ? repairSpendThisMonthCenti : null,
      costliestVehicle,
      costliestVehicleCenti: costliestVehicle ? costliestCenti : null,
    },
    statusCounts,
    vehicles: rows,
  });
});

// ── GET /vehicles/:id — one lorry + full compliance history + windows ────────
fleetMaintenance.get("/vehicles/:id", requireHouzsPerm("fleet.read"), async (c) => {
  const id = c.req.param("id");
  const sb = c.get("supabase");
  const today = todayMyt();

  const { data: l, error } = await sb
    .from("lorries")
    .select("id, plate, type, is_internal, warehouse_id, active, model, road_tax_expiry, insurance_expiry, puspakom_expiry, notes")
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: "load_failed", reason: error.message }, 500);
  if (!l) return c.json({ error: "vehicle_not_found" }, 404);
  const lorry = l as Lorry;

  const [whR, driversR, vaultR, maintR, svcR] = await Promise.all([
    lorry.warehouse_id ? sb.from("warehouses").select("code, name").eq("id", lorry.warehouse_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    sb.from("drivers").select("vehicle, name").eq("active", true),
    sb.from("lorry_compliance_documents").select("*").eq("lorry_id", id).order("issue_date", { ascending: false }).order("expiry_date", { ascending: false }),
    sb.from("lorry_maintenance").select("unavailable_from, unavailable_to, reason").eq("lorry_id", id).order("unavailable_from", { ascending: false }),
    sb.from("lorry_service_records").select("service_date, odometer_km, next_service_km, next_service_date, cost_centi, workshop, description").eq("lorry_id", id).order("service_date", { ascending: false }).limit(1),
  ]);

  const vaultRows = (vaultR.data ?? []) as VaultRow[];
  const { statusDocs } = currentByType(lorry, vaultRows, today);
  const currentVault = currentDocsByType(vaultRows.map((d) => ({ docType: d.doc_type as ComplianceDocType, expiryDate: d.expiry_date, issueDate: d.issue_date })));
  const byType: Record<string, { currentId: string | null; flatExpiry: string | null; history: ReturnType<typeof shapeDoc>[] }> = {};
  for (const type of COMPLIANCE_DOC_TYPES) {
    const picked = currentVault.get(type);
    const currentRow = picked
      ? vaultRows.find((d) => d.doc_type === type && iso(d.expiry_date) === iso(picked.expiryDate) && iso(d.issue_date) === iso(picked.issueDate))
      : undefined;
    const col = FLAT_COL[type];
    byType[type] = {
      currentId: currentRow?.id ?? null,
      flatExpiry: col ? iso(lorry[col]) : null,
      history: vaultRows.filter((d) => d.doc_type === type).map((d) => shapeDoc(d, today)),
    };
  }

  const svc = (svcR.data ?? [])[0] as { odometer_km: number | null; next_service_km: number | null; next_service_date: string | null; workshop: string | null; description: string | null } | undefined;
  const oosNow = (maintR.data ?? []).some((m) => iso(m.unavailable_from)! <= today && iso(m.unavailable_to)! >= today);
  const status = deriveVehicleStatus({
    today,
    outOfService: oosNow,
    currentDocs: statusDocs,
    currentMileageKm: svc?.odometer_km ?? null,
    nextServiceKm: svc?.next_service_km ?? null,
    nextServiceDate: iso(svc?.next_service_date),
  });

  const wh = (whR as { data: { code?: string; name?: string } | null }).data;
  return c.json({
    vehicle: {
      id: lorry.id,
      plate: lorry.plate,
      region: wh?.code ?? wh?.name ?? null,
      driverName: (driversR.data ?? []).find((d) => normPlate(d.vehicle as string) === normPlate(lorry.plate))?.name ?? null,
      vehicleType: lorry.type,
      model: lorry.model,
      mileageKm: svc?.odometer_km ?? null,
      nextServiceKm: svc?.next_service_km ?? null,
      nextServiceDate: iso(svc?.next_service_date),
      lastServiceWorkshop: svc?.workshop ?? null,
      outOfService: oosNow,
      outOfServiceReason: (maintR.data ?? []).find((m) => iso(m.unavailable_from)! <= today && iso(m.unavailable_to)! >= today)?.reason ?? null,
      notes: lorry.notes,
      status,
      statusLabel: VEHICLE_STATUS_LABELS[status],
      canDispatch: canDispatch(status),
    },
    compliance: byType,
    maintenanceWindows: (maintR.data ?? []).map((m) => ({ from: iso(m.unavailable_from), to: iso(m.unavailable_to), reason: m.reason ?? null })),
  });
});

// ── GET /reminders — fleet-wide actionable expiries, most urgent first ───────
fleetMaintenance.get("/reminders", requireHouzsPerm("fleet.read"), async (c) => {
  const sb = c.get("supabase");
  const today = todayMyt();
  const [lorriesR, vaultR] = await Promise.all([
    sb.from("lorries").select("id, plate, warehouse_id, active, road_tax_expiry, insurance_expiry, puspakom_expiry, type, is_internal, model, notes").eq("active", true),
    sb.from("lorry_compliance_documents").select("*"),
  ]);
  if (lorriesR.error || vaultR.error) return c.json({ error: "load_failed", reason: (lorriesR.error || vaultR.error)?.message }, 500);
  const lorries = (lorriesR.data ?? []) as Lorry[];
  const vaultByLorry = new Map<string, VaultRow[]>();
  for (const v of (vaultR.data ?? []) as VaultRow[]) {
    const list = vaultByLorry.get(v.lorry_id) ?? [];
    list.push(v);
    vaultByLorry.set(v.lorry_id, list);
  }
  const reminders: Array<Record<string, unknown>> = [];
  for (const l of lorries) {
    const { compliance } = currentByType(l, vaultByLorry.get(l.id) ?? [], today);
    for (const type of COMPLIANCE_DOC_TYPES) {
      const d = compliance[type];
      if (!d || d.reminderLevel === "OK") continue;
      reminders.push({ vehicleId: l.id, plate: l.plate, docType: type, expiryDate: d.expiryDate, daysRemaining: d.daysRemaining, reminderLevel: d.reminderLevel, tone: d.tone, result: d.result });
    }
  }
  reminders.sort((a, b) => ((a.daysRemaining as number | null) ?? 1e9) - ((b.daysRemaining as number | null) ?? 1e9));
  return c.json({ today, reminders });
});

// ── POST /vehicles/:id/compliance — APPEND a vault renewal (never overwrite) ─
// Also SYNCS the denormalized flat expiry column on scm.lorries from the latest
// vault row of that type, so the existing Fleet compliance strip keeps working.
fleetMaintenance.post("/vehicles/:id/compliance", requireHouzsPerm("fleet.write"), async (c) => {
  const lorryId = c.req.param("id");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

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
  if (docType === "PUSPAKOM" && body.result != null && body.result !== "") {
    const r = String(body.result).toUpperCase();
    if (r !== "PASS" && r !== "FAIL") return c.json({ error: "invalid_result" }, 400);
    result = r;
  }

  // Confirm the lorry exists (unified fleet — no company scope on the master).
  const { data: lorry, error: lorryErr } = await sb.from("lorries").select("id").eq("id", lorryId).maybeSingle();
  if (lorryErr) return c.json({ error: "load_failed", reason: lorryErr.message }, 500);
  if (!lorry) return c.json({ error: "vehicle_not_found" }, 404);

  const { data: inserted, error } = await sb
    .from("lorry_compliance_documents")
    .insert({
      company_id: activeCompanyId(c) ?? null,
      lorry_id: lorryId,
      doc_type: docType,
      document_ref: (body.documentRef as string)?.trim() || null,
      issue_date: issue.value,
      expiry_date: expiry.value,
      cost_centi: cost.value,
      owner: (body.owner as string)?.trim() || null,
      result,
      reinspection_deadline: reinspect.value,
      notes: (body.notes as string)?.trim() || null,
      created_by: c.get("houzsUser")?.id ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23503") return c.json({ error: "vehicle_not_found" }, 404);
    return c.json({ error: "insert_failed", reason: error.message }, 500);
  }

  // Sync the denormalized flat column to the latest vault expiry for this type.
  const flatCol = FLAT_COL[docType as ComplianceDocType];
  if (flatCol) {
    const { data: all } = await sb.from("lorry_compliance_documents").select("expiry_date").eq("lorry_id", lorryId).eq("doc_type", docType);
    let latest: string | null = null;
    for (const r of all ?? []) {
      const e = iso(r.expiry_date);
      if (e && (latest === null || e > latest)) latest = e;
    }
    await sb.from("lorries").update({ [flatCol]: latest, updated_at: new Date().toISOString() }).eq("id", lorryId);
  }

  return c.json({ id: inserted?.id }, 201);
});

export default fleetMaintenance;
