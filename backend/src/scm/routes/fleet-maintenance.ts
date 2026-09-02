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
import { nextCode, CODE_PREFIX } from "../lib/fleet-code-mint";
import { activeCompanyId, scopeToCompany, scopeToCompanyIdOrOpen } from "../lib/companyScope";
import { todayMyt } from "../lib/my-time";
import {
  dateOrNull, floatOrNull, intOrNull, iso, normPlate, numOrNull, refsOrNull, tsOrNull,
} from "../lib/fleet-coerce";
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
  PLAN_COMPONENTS,
  PLAN_COMPONENT_LABELS,
  type PlanComponent,
  type MaintenancePlanInput,
  derivePlanDue,
  MILEAGE_SOURCES,
  type MileageSource,
  assessMileageReading,
  // Phase 3
  BREAKDOWN_SEVERITIES,
  BREAKDOWN_STATUSES,
  type BreakdownStatus,
  isBreakdownActive,
  isCaseGrounding,
  breakdownDowntimeHours,
  WORK_ORDER_STATES,
  WORK_ORDER_STATE_LABELS,
  type WorkOrderState,
  canTransitionWorkOrder,
  isWorkOrderOpen,
  workOrderSeam,
  workOrderTotalSen,
  workOrderLineSen,
  type WorkOrderLineInput,
  COMPONENT_TYPES,
  type ComponentType,
  COMPONENT_POSITIONS,
  type ComponentPosition,
  COMPONENT_TYPE_LABELS,
  COMPONENT_POSITION_LABELS,
  COMPONENT_EVENT_TYPES,
  type ComponentEventType,
  deriveComponentLife,
} from "../../services/fleet-status";
import { postPersonalNotice } from "../../services/personalNotice";
import { uplineUserIds } from "../../services/orgScope";

export const fleetMaintenance = new Hono<{ Bindings: Env; Variables: Variables }>();
fleetMaintenance.use("*", supabaseAuth);

const BREAKDOWN_SEVERITY_SET = new Set<string>(BREAKDOWN_SEVERITIES);
const BREAKDOWN_STATUS_SET = new Set<string>(BREAKDOWN_STATUSES);
const WORK_ORDER_STATE_SET = new Set<string>(WORK_ORDER_STATES);
const COMPONENT_TYPE_SET = new Set<string>(COMPONENT_TYPES);
const COMPONENT_POSITION_SET = new Set<string>(COMPONENT_POSITIONS);
const COMPONENT_EVENT_TYPE_SET = new Set<string>(COMPONENT_EVENT_TYPES);

const DOC_TYPE_SET = new Set<string>(COMPLIANCE_DOC_TYPES);
const PLAN_COMPONENT_SET = new Set<string>(PLAN_COMPONENTS);
const MILEAGE_SOURCE_SET = new Set<string>(MILEAGE_SOURCES);
// doc_type -> the denormalized "current" flat column on scm.lorries (mig 0121).
// APAD / CROSS_BORDER are vault-only (no flat column).
const FLAT_COL: Partial<Record<ComplianceDocType, "road_tax_expiry" | "insurance_expiry" | "puspakom_expiry">> = {
  ROAD_TAX: "road_tax_expiry",
  INSURANCE: "insurance_expiry",
  PUSPAKOM: "puspakom_expiry",
};

/** Today's calendar date in MYT (UTC+8), where the fleet operates. */

type VaultRow = {
  id: string;
  lorry_id: string;
  doc_type: string;
  document_ref: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  cost_sen: number | null;
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
    costSen: row.cost_sen,
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
    costSen: null,
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

/* Fleet Health is the IN-HOUSE board. Owner, 2026-08-02: "Fleet Health 只看我们
   in-house 的罗里而已，outsource 的我们是不看的" — a 3PL's road tax, PUSPAKOM,
   servicing and breakdowns are that carrier's paperwork and that carrier's cost,
   and counting them made every fleet KPI (fleet size, cannot-dispatch, monthly
   spend) answer a question nobody asked.

   The three-state predicate is DEFENSIVE PARITY, not a rescue of legacy rows:
   scm.lorries.is_internal is `BOOLEAN NOT NULL DEFAULT true` (0053:54), so no
   NULL exists today and .eq("is_internal", true) would behave identically. The
   reason to write it this way anyway is that every DISPLAY path in this module
   reads three-state — `is_internal !== false` (the dashboard's isInternal,
   FleetHealth's MissingComplianceNote) — so if the NOT NULL is ever dropped, the
   filter and the label still agree instead of silently disagreeing.

   Scope: the LIST surfaces only (dashboard + reminders). GET /vehicles/:id is
   deliberately not filtered, so an existing link to an outsourced lorry still
   opens rather than 404ing. */
const inHouseLorries = (sb: { from: (t: string) => { select: (cols: string) => any } }, cols: string) =>
  sb.from("lorries").select(cols).eq("active", true).or("is_internal.is.null,is_internal.eq.true");

/* company-scope-file: UNIFIED FLEET — nothing here scopes a row to the company; the
   `// company-scope:` annotations on the by-id writers below point at this note.

   The authority is the migration header plus the READ path, NOT the column list.
   company_id EXISTS on these tables (mig 0083 stamps it), but migs 0202, 0203,
   0204 and 0238 each say it is "STAMPED on insert for provenance but NOT used to
   scope reads" — "one shared lorry fleet across ALL companies". GET /dashboard
   matches, reading every row with no predicate, so scoping only the WRITERS
   would leave the dashboard listing a row that PATCH/DELETE then 404s. The gate
   that IS real is requireHouzsPerm("fleet.write").

   EXCEPTION: scm.workshops IS per-company (mig 0241) and its handlers DO filter
   on activeCompanyId. */

type Lorry = {
  id: string;
  plate: string;
  type: string | null;
  is_internal: boolean | null;
  capacity_m3?: number | null;
  length_ft?: number | null;
  width_ft?: number | null;
  height_ft?: number | null;
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

type PlanRow = {
  id: string;
  lorry_id: string;
  component: string;
  interval_km: number | null;
  interval_months: number | null;
  last_done_date: string | null;
  last_done_km: number | null;
  workshop: string | null;
  est_cost_sen: number | null;
  notes: string | null;
  active: boolean | null;
};

type MileageRow = {
  id: string;
  lorry_id: string;
  reading_date: string | null;
  odometer_km: number | null;
  source: string | null;
  photo_ref: string | null;
  flagged: boolean | null;
  note: string | null;
};

/** A plan as the wire needs it: raw fields + the derived due picture. */
function shapePlan(row: PlanRow, currentKm: number | null, today: string) {
  const plan: MaintenancePlanInput = {
    component: row.component,
    intervalKm: row.interval_km,
    intervalMonths: row.interval_months,
    lastDoneDate: iso(row.last_done_date),
    lastDoneKm: row.last_done_km,
    active: row.active ?? true,
  };
  const due = derivePlanDue(plan, currentKm, today);
  return {
    id: row.id,
    component: row.component as PlanComponent,
    componentLabel: PLAN_COMPONENT_LABELS[row.component as PlanComponent] ?? row.component,
    intervalKm: row.interval_km,
    intervalMonths: row.interval_months,
    lastDoneDate: iso(row.last_done_date),
    lastDoneKm: row.last_done_km,
    workshop: row.workshop,
    estCostSen: row.est_cost_sen,
    notes: row.notes,
    active: row.active ?? true,
    nextDueKm: due.nextDueKm,
    nextDueDate: due.nextDueDate,
    kmRemaining: due.kmRemaining,
    daysRemaining: due.daysRemaining,
    dueSoon: due.dueSoon,
    overdue: due.overdue,
    tone: due.tone,
  };
}

/** The plan-status inputs the state machine needs (active plans only). */
function planInputs(rows: PlanRow[]): MaintenancePlanInput[] {
  return rows.map((r) => ({
    component: r.component,
    intervalKm: r.interval_km,
    intervalMonths: r.interval_months,
    lastDoneDate: iso(r.last_done_date),
    lastDoneKm: r.last_done_km,
    active: r.active ?? true,
  }));
}

// ── Phase 3 row types + shapers ─────────────────────────────────────────────
type BreakdownRow = {
  id: string;
  lorry_id: string;
  case_no?: string | null;
  occurred_at: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  fault_type: string | null;
  severity: string;
  still_drivable: boolean | null;
  media_refs: string[] | null;
  driver_description: string | null;
  towing_company: string | null;
  towing_cost_sen: number | null;
  workshop: string | null;
  breakdown_start: string | null;
  recovery_time: string | null;
  affected_trip_id: string | null;
  status: string;
  notes: string | null;
};

function shapeBreakdown(row: BreakdownRow, nowIso: string) {
  return {
    id: row.id,
    caseNo: row.case_no ?? null,
    occurredAt: row.occurred_at,
    gpsLat: row.gps_lat,
    gpsLng: row.gps_lng,
    faultType: row.fault_type,
    severity: row.severity,
    stillDrivable: row.still_drivable ?? true,
    mediaRefs: row.media_refs ?? [],
    driverDescription: row.driver_description,
    towingCompany: row.towing_company,
    towingCostSen: row.towing_cost_sen,
    workshop: row.workshop,
    breakdownStart: row.breakdown_start,
    recoveryTime: row.recovery_time,
    affectedTripId: row.affected_trip_id,
    status: row.status as BreakdownStatus,
    grounding: isCaseGrounding({ severity: row.severity, status: row.status }),
    downtimeHours: breakdownDowntimeHours(
      { breakdownStart: row.breakdown_start, occurredAt: row.occurred_at, recoveryTime: row.recovery_time },
      nowIso,
    ),
    notes: row.notes,
  };
}

type WorkOrderRow = {
  id: string;
  lorry_id: string;
  status: string;
  problem: string | null;
  diagnosis: string | null;
  workshop: string | null;
  workshop_id?: string | null;
  quotation_no?: string | null;
  invoice_no?: string | null;
  advisor?: string | null;
  document_date?: string | null;
  labour_sen: number | null;
  outside_service_sen: number | null;
  towing_sen: number | null;
  tax_sen: number | null;
  warranty_until: string | null;
  invoice_refs: string[] | null;
  quote_refs: string[] | null;
  photo_refs: string[] | null;
  reported_at: string | null;
  est_complete: string | null;
  actual_complete: string | null;
  approved_by: number | null;
  verified_by: number | null;
  breakdown_case_id: string | null;
  component_id: string | null;
  notes: string | null;
  wo_no?: string | null;
};

type WorkOrderPartRow = {
  id: string;
  work_order_id: string;
  section?: string | null;
  name: string;
  part_no: string | null;
  uom?: string | null;
  qty: number | null;
  unit_price_sen: number | null;
  discount_pct?: number | null;
  amount_sen?: number | null;
  line_no?: number | null;
  serial: string | null;
};

/** Every column the line model needs, in ONE place — the dashboard and the
 *  vehicle detail both read this table and must not drift apart. */
const WO_PART_COLS =
  "id, work_order_id, section, name, part_no, uom, qty, unit_price_sen, discount_pct, amount_sen, line_no, serial";

/** DB row -> the calculator's line shape. The single conversion point, so a
 *  discount can never be dropped on one read path and honoured on another. */
const partToLine = (p: WorkOrderPartRow): WorkOrderLineInput => ({
  qty: p.qty,
  unitPriceSen: p.unit_price_sen,
  discountPct: p.discount_pct,
  amountSen: p.amount_sen,
});

function shapeWorkOrder(row: WorkOrderRow, parts: WorkOrderPartRow[]) {
  const shapedParts = parts.map((p) => ({
    id: p.id,
    section: (p.section ?? "PART") as "PART" | "LABOUR",
    name: p.name,
    partNo: p.part_no,
    uom: p.uom ?? null,
    qty: p.qty ?? 0,
    unitPriceSen: p.unit_price_sen ?? 0,
    discountPct: p.discount_pct ?? 0,
    lineNo: p.line_no ?? null,
    /* The printed amount when the document had one, else qty x unit x (1-disc).
       This used to be a bare qty x unit, which silently overcharged every
       discounted line — 14 of the 19 on the invoice that prompted mig 0241. */
    lineSen: workOrderLineSen(partToLine(p)),
    serial: p.serial,
  }));
  const state = row.status as WorkOrderState;
  return {
    id: row.id,
    /* OURS (mig 0248). quotationNo below is the WORKSHOP'S number, off their
       document — it is not unique across vendors and a repair with no document
       has none, so it cannot be the record's identity. */
    woNo: row.wo_no ?? null,
    status: state,
    statusLabel: WORK_ORDER_STATE_LABELS[state] ?? row.status,
    open: isWorkOrderOpen(state),
    nextStates: WORK_ORDER_STATES.filter((s) => canTransitionWorkOrder(state, s)),
    problem: row.problem,
    diagnosis: row.diagnosis,
    workshop: row.workshop,
    workshopId: row.workshop_id ?? null,
    quotationNo: row.quotation_no ?? null,
    invoiceNo: row.invoice_no ?? null,
    advisor: row.advisor ?? null,
    documentDate: iso(row.document_date ?? null),
    labourSen: row.labour_sen ?? 0,
    outsideServiceSen: row.outside_service_sen ?? 0,
    towingSen: row.towing_sen ?? 0,
    taxSen: row.tax_sen ?? 0,
    totalSen: workOrderTotalSen({
      labourSen: row.labour_sen,
      outsideServiceSen: row.outside_service_sen,
      towingSen: row.towing_sen,
      taxSen: row.tax_sen,
      parts: parts.map(partToLine),
    }),
    warrantyUntil: iso(row.warranty_until),
    invoiceRefs: row.invoice_refs ?? [],
    quoteRefs: row.quote_refs ?? [],
    photoRefs: row.photo_refs ?? [],
    reportedAt: row.reported_at,
    estComplete: row.est_complete,
    actualComplete: row.actual_complete,
    breakdownCaseId: row.breakdown_case_id,
    componentId: row.component_id,
    notes: row.notes,
    parts: shapedParts,
  };
}

type ComponentRow = {
  id: string;
  lorry_id: string;
  component_type: string;
  position: string;
  brand: string | null;
  model: string | null;
  size: string | null;
  serial: string | null;
  fitted_date: string | null;
  fitted_km: number | null;
  purchase_price_sen: number | null;
  tread_depth: number | null;
  removed_date: string | null;
  removed_km: number | null;
  warranty_until: string | null;
  status: string;
  notes: string | null;
};

type ComponentEventRow = {
  id: string;
  component_id: string;
  event_type: string;
  event_date: string | null;
  odometer_km: number | null;
  to_position: string | null;
  cost_sen: number | null;
  note: string | null;
};

function shapeComponent(row: ComponentRow, currentKm: number | null, today: string, events: ComponentEventRow[]) {
  const life = deriveComponentLife(
    {
      status: row.status,
      fittedKm: row.fitted_km,
      removedKm: row.removed_km,
      purchasePriceSen: row.purchase_price_sen,
      warrantyUntil: iso(row.warranty_until),
    },
    currentKm,
    today,
  );
  return {
    id: row.id,
    componentType: row.component_type as ComponentType,
    componentTypeLabel: COMPONENT_TYPE_LABELS[row.component_type as ComponentType] ?? row.component_type,
    position: row.position as ComponentPosition,
    positionLabel: COMPONENT_POSITION_LABELS[row.position as ComponentPosition] ?? row.position,
    brand: row.brand,
    model: row.model,
    size: row.size,
    serial: row.serial,
    fittedDate: iso(row.fitted_date),
    fittedKm: row.fitted_km,
    purchasePriceSen: row.purchase_price_sen,
    treadDepth: row.tread_depth,
    removedDate: iso(row.removed_date),
    removedKm: row.removed_km,
    warrantyUntil: iso(row.warranty_until),
    status: row.status,
    notes: row.notes,
    kmUsed: life.kmUsed,
    costPerKmSen: life.costPerKmSen,
    underWarranty: life.underWarranty,
    events: events.map((e) => ({
      id: e.id,
      eventType: e.event_type as ComponentEventType,
      eventDate: iso(e.event_date),
      odometerKm: e.odometer_km,
      toPosition: e.to_position,
      costSen: e.cost_sen,
      note: e.note,
    })),
  };
}

// ── GET /dashboard ──────────────────────────────────────────────────────────
fleetMaintenance.get("/dashboard", requireHouzsPerm("fleet.read"), async (c) => {
  const sb = c.get("supabase");
  const today = todayMyt();
  const monthStart = today.slice(0, 8) + "01";

  const nowIso = new Date().toISOString();
  const [lorriesR, whR, driversR, vaultR, maintR, svcR, plansR, mileageR, breakdownR, woR, woPartsR] = await Promise.all([
    inHouseLorries(sb, "id, plate, type, is_internal, warehouse_id, active, model, road_tax_expiry, insurance_expiry, puspakom_expiry, notes").order("plate"),
    sb.from("warehouses").select("id, code, name"),
    sb.from("drivers").select("vehicle, name").eq("active", true),
    sb.from("lorry_compliance_documents").select("*"),
    sb.from("lorry_maintenance").select("lorry_id, unavailable_from, unavailable_to, reason").lte("unavailable_from", today).gte("unavailable_to", today),
    sb.from("lorry_service_records").select("lorry_id, service_date, odometer_km, next_service_km, next_service_date, cost_sen").order("service_date", { ascending: false }),
    sb.from("lorry_maintenance_plans").select("*").eq("active", true),
    sb.from("lorry_mileage_readings").select("lorry_id, reading_date, odometer_km, source, flagged").order("reading_date", { ascending: false }).order("created_at", { ascending: false }),
    // Phase 3: active (non-resolved) breakdown cases feed the BREAKDOWN seam + downtime.
    sb.from("lorry_breakdown_cases").select("*").neq("status", "RESOLVED").order("occurred_at", { ascending: false }),
    // All work orders: open ones feed the WO seam; those completed this month feed spend.
    sb.from("lorry_work_orders").select("*"),
    sb.from("lorry_work_order_parts").select(WO_PART_COLS),
  ]);
  const firstErr = lorriesR.error || whR.error || driversR.error || vaultR.error || maintR.error || svcR.error || plansR.error || mileageR.error || breakdownR.error || woR.error || woPartsR.error;
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
    if (iso(s.service_date) && iso(s.service_date)! >= monthStart) monthSpend.set(lid, (monthSpend.get(lid) ?? 0) + Number(s.cost_sen ?? 0));
  }
  // Active preventive-maintenance plans per lorry.
  const plansByLorry = new Map<string, PlanRow[]>();
  for (const p of (plansR.data ?? []) as PlanRow[]) {
    const list = plansByLorry.get(p.lorry_id) ?? [];
    list.push(p);
    plansByLorry.set(p.lorry_id, list);
  }
  // Latest odometer reading per lorry (rows already newest-first).
  const latestMileage = new Map<string, { odometer_km: number | null; reading_date: string | null; flagged: boolean }>();
  for (const m of (mileageR.data ?? []) as MileageRow[]) {
    if (!latestMileage.has(m.lorry_id)) latestMileage.set(m.lorry_id, { odometer_km: m.odometer_km, reading_date: iso(m.reading_date), flagged: !!m.flagged });
  }
  // Phase 3: active breakdown cases per lorry (already non-resolved, newest-first).
  const breakdownByLorry = new Map<string, BreakdownRow[]>();
  for (const b of (breakdownR.data ?? []) as BreakdownRow[]) {
    const list = breakdownByLorry.get(b.lorry_id) ?? [];
    list.push(b);
    breakdownByLorry.set(b.lorry_id, list);
  }
  // Work-order parts grouped by work order (for the derived total).
  const partsByWo = new Map<string, WorkOrderPartRow[]>();
  for (const p of (woPartsR.data ?? []) as WorkOrderPartRow[]) {
    const list = partsByWo.get(p.work_order_id) ?? [];
    list.push(p);
    partsByWo.set(p.work_order_id, list);
  }
  // Work orders per lorry + this-month WO repair spend (actual_complete in month).
  const woByLorry = new Map<string, WorkOrderRow[]>();
  const woMonthSpend = new Map<string, number>();
  for (const w of (woR.data ?? []) as WorkOrderRow[]) {
    const list = woByLorry.get(w.lorry_id) ?? [];
    list.push(w);
    woByLorry.set(w.lorry_id, list);
    const done = iso(w.actual_complete);
    if (done && done >= monthStart) {
      const total = workOrderTotalSen({
        labourSen: w.labour_sen,
        outsideServiceSen: w.outside_service_sen,
        towingSen: w.towing_sen,
        taxSen: w.tax_sen,
        parts: (partsByWo.get(w.id) ?? []).map(partToLine),
      });
      woMonthSpend.set(w.lorry_id, (woMonthSpend.get(w.lorry_id) ?? 0) + total);
    }
  }

  let expiredDocs = 0, expiring30 = 0, expiring60 = 0, expiring90 = 0;
  let serviceDueCount = 0, serviceOverdueCount = 0, breakdowns = 0, complianceBlocked = 0, cantDispatch = 0;
  let openWorkOrders = 0;
  const statusCounts: Record<string, number> = {};

  const rows = lorries.map((l) => {
    const { compliance, statusDocs } = currentByType(l, vaultByLorry.get(l.id) ?? [], today);
    const svc = latestSvc.get(l.id);
    // The odometer the plans measure against: latest MILEAGE reading first (the
    // Phase-2 primary), else the latest service record's odometer.
    const mileage = latestMileage.get(l.id);
    const currentMileageKm = mileage?.odometer_km ?? svc?.odometer_km ?? null;
    const planRows = plansByLorry.get(l.id) ?? [];
    const plans = planInputs(planRows);
    const shapedPlans = planRows.map((p) => shapePlan(p, currentMileageKm, today)).sort((a, b) => (a.daysRemaining ?? 1e9) - (b.daysRemaining ?? 1e9));
    const plansOverdue = shapedPlans.filter((p) => p.overdue).length;
    const plansDueSoon = shapedPlans.filter((p) => p.dueSoon && !p.overdue).length;
    // The single most-urgent plan drives the board's "next service" cell.
    const nextPlan = shapedPlans.find((p) => p.nextDueKm !== null || p.nextDueDate !== null) ?? null;
    // Phase 3 seams: an active CRITICAL breakdown grounds the lorry; an open work
    // order in IN_REPAIR / WAITING_PARTS feeds the maintenance states.
    const lorryBreakdowns = breakdownByLorry.get(l.id) ?? [];
    const breakdownActive = isBreakdownActive(lorryBreakdowns.map((b) => ({ severity: b.severity, status: b.status })));
    const lorryWos = woByLorry.get(l.id) ?? [];
    const openWos = lorryWos.filter((w) => isWorkOrderOpen(w.status as WorkOrderState));
    const openWorkOrder = workOrderSeam(lorryWos.map((w) => ({ status: w.status })));
    const status = deriveVehicleStatus({
      today,
      outOfService: oosByLorry.has(l.id),
      currentDocs: statusDocs,
      currentMileageKm,
      nextServiceKm: svc?.next_service_km ?? null,
      nextServiceDate: svc?.next_service_date ?? null,
      plans,
      breakdownActive,
      openWorkOrder,
    });
    // Longest current downtime across active grounding breakdowns.
    const downtimeHours = lorryBreakdowns
      .map((b) => breakdownDowntimeHours({ breakdownStart: b.breakdown_start, occurredAt: b.occurred_at, recoveryTime: b.recovery_time }, nowIso))
      .filter((h): h is number => h !== null)
      .reduce((max, h) => Math.max(max, h), 0);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status === "SERVICE_DUE") serviceDueCount++;
    if (plansOverdue > 0) serviceOverdueCount++;
    if (breakdownActive) breakdowns++;
    if (status === "COMPLIANCE_BLOCKED") complianceBlocked++;
    openWorkOrders += openWos.length;
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
      mileageKm: currentMileageKm,
      mileageDate: mileage?.reading_date ?? null,
      mileageSource: mileage ? "reading" : svc?.odometer_km != null ? "service" : null,
      mileageFlagged: mileage?.flagged ?? false,
      nextServiceKm: svc?.next_service_km ?? null,
      nextServiceDate: svc?.next_service_date ?? null,
      outOfService: oosByLorry.has(l.id),
      outOfServiceReason: oosByLorry.get(l.id) ?? null,
      notes: l.notes,
      status,
      statusLabel: VEHICLE_STATUS_LABELS[status],
      canDispatch: canDispatch(status),
      compliance,
      planCount: shapedPlans.length,
      plansOverdue,
      plansDueSoon,
      nextPlan: nextPlan
        ? {
            component: nextPlan.component,
            componentLabel: nextPlan.componentLabel,
            nextDueKm: nextPlan.nextDueKm,
            nextDueDate: nextPlan.nextDueDate,
            kmRemaining: nextPlan.kmRemaining,
            daysRemaining: nextPlan.daysRemaining,
            tone: nextPlan.tone,
            overdue: nextPlan.overdue,
          }
        : null,
      // Phase 3 board columns.
      breakdownActive,
      openBreakdowns: lorryBreakdowns.length,
      openWorkOrders: openWos.length,
      downtimeHours: downtimeHours > 0 ? Math.round(downtimeHours * 10) / 10 : null,
      openProblem: openProblemFor(status, lorryBreakdowns, openWos),
    };
  });

  // Costliest vehicle this month: combine service records + work-order totals.
  const combinedSpend = new Map<string, number>();
  for (const [lid, v] of monthSpend) combinedSpend.set(lid, (combinedSpend.get(lid) ?? 0) + v);
  for (const [lid, v] of woMonthSpend) combinedSpend.set(lid, (combinedSpend.get(lid) ?? 0) + v);
  let costliestVehicle: string | null = null;
  let costliestSen = 0;
  const plateById = new Map(lorries.map((l) => [l.id, l.plate]));
  for (const [lid, spent] of combinedSpend) if (spent > costliestSen) { costliestSen = spent; costliestVehicle = plateById.get(lid) ?? null; }
  const repairSpendThisMonthSen = [...combinedSpend.values()].reduce((a, b) => a + b, 0);

  return c.json({
    today,
    kpis: {
      expiredDocs, expiring30, expiring60, expiring90,
      serviceDue: serviceDueCount, serviceOverdue: serviceOverdueCount,
      activeBreakdowns: breakdowns, complianceBlocked, cantDispatch,
      openWorkOrders,
      fleetSize: rows.length,
      repairSpendThisMonthSen: combinedSpend.size ? repairSpendThisMonthSen : null,
      costliestVehicle,
      costliestVehicleSen: costliestVehicle ? costliestSen : null,
    },
    statusCounts,
    vehicles: rows,
  });
});

/** The one-line "what is wrong right now" summary for the board's Open-problem
 *  column, derived from status + open breakdowns/work orders. */
function openProblemFor(status: string, breakdowns: BreakdownRow[], openWos: WorkOrderRow[]): string | null {
  const grounding = breakdowns.find((b) => isCaseGrounding({ severity: b.severity, status: b.status }));
  if (grounding) return grounding.fault_type ? `Breakdown: ${grounding.fault_type}` : "Critical breakdown";
  const waiting = openWos.find((w) => w.status === "WAITING_PARTS");
  if (waiting) return waiting.problem ? `Waiting parts: ${waiting.problem}` : "Waiting parts";
  const inRepair = openWos.find((w) => w.status === "IN_REPAIR");
  if (inRepair) return inRepair.problem ? `In repair: ${inRepair.problem}` : "In repair";
  if (breakdowns.length > 0) return breakdowns[0].fault_type ? `Incident: ${breakdowns[0].fault_type}` : "Open incident";
  if (openWos.length > 0) return openWos[0].problem ? `WO: ${openWos[0].problem}` : "Open work order";
  return null;
}

// ── GET /vehicles/:id — one lorry + full compliance history + windows ────────
fleetMaintenance.get("/vehicles/:id", requireHouzsPerm("fleet.read"), async (c) => {
  const id = c.req.param("id");
  const sb = c.get("supabase");
  const today = todayMyt();

  const { data: l, error } = await sb
    .from("lorries")
    .select("id, plate, type, is_internal, warehouse_id, active, model, road_tax_expiry, insurance_expiry, puspakom_expiry, notes, capacity_m3, length_ft, width_ft, height_ft, manufacture_date, registration_date, in_service_date, purchase_date, purchase_price_sen")
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: "load_failed", reason: error.message }, 500);
  if (!l) return c.json({ error: "vehicle_not_found" }, 404);
  const lorry = l as Lorry;

  const nowIso = new Date().toISOString();
  const [whR, driversR, vaultR, attachR, maintR, svcR, plansR, mileageR, breakdownR, woR, woPartsR, componentsR, compEventsR] = await Promise.all([
    lorry.warehouse_id ? sb.from("warehouses").select("code, name").eq("id", lorry.warehouse_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    sb.from("drivers").select("vehicle, name").eq("active", true),
    sb.from("lorry_compliance_documents").select("*").eq("lorry_id", id).order("issue_date", { ascending: false }).order("expiry_date", { ascending: false }),
    /* mig 0238 — the vault's FILES. Read by lorry through the join column so one
       query covers every document; a failure degrades to "no files", never a 500
       on the whole drawer. */
    sb.from("lorry_compliance_attachments").select("id, document_id, r2_key, file_name, mime_type, size_bytes, created_at").order("created_at"),
    sb.from("lorry_maintenance").select("unavailable_from, unavailable_to, reason").eq("lorry_id", id).order("unavailable_from", { ascending: false }),
    sb.from("lorry_service_records").select("service_date, odometer_km, next_service_km, next_service_date, cost_sen, workshop, description").eq("lorry_id", id).order("service_date", { ascending: false }).limit(1),
    sb.from("lorry_maintenance_plans").select("*").eq("lorry_id", id),
    sb.from("lorry_mileage_readings").select("id, lorry_id, reading_date, odometer_km, source, photo_ref, flagged, note").eq("lorry_id", id).order("reading_date", { ascending: false }).order("created_at", { ascending: false }).limit(30),
    sb.from("lorry_breakdown_cases").select("*").eq("lorry_id", id).order("occurred_at", { ascending: false }).limit(50),
    sb.from("lorry_work_orders").select("*").eq("lorry_id", id).order("reported_at", { ascending: false }).limit(50),
    sb.from("lorry_work_order_parts").select(WO_PART_COLS),
    sb.from("lorry_components").select("*").eq("lorry_id", id).order("status").order("component_type"),
    sb.from("lorry_component_events").select("*").order("event_date", { ascending: false }),
  ]);

  const vaultRows = (vaultR.data ?? []) as VaultRow[];
  const { statusDocs } = currentByType(lorry, vaultRows, today);
  const currentVault = currentDocsByType(vaultRows.map((d) => ({ docType: d.doc_type as ComplianceDocType, expiryDate: d.expiry_date, issueDate: d.issue_date })));
  /* mig 0238 — attach each renewal's FILES to its history row. Grouped once here
     rather than per type, so the drawer never has to join two arrays itself. */
  type AttachRow = { id: string; document_id?: string; documentId?: string; r2_key?: string; r2Key?: string; file_name?: string | null; fileName?: string | null; mime_type?: string | null; mimeType?: string | null; size_bytes?: number | null; sizeBytes?: number | null };
  const filesByDoc = new Map<string, Array<{ id: string; r2Key: string; fileName: string | null; mimeType: string | null; sizeBytes: number | null }>>();
  for (const a of ((attachR.data ?? []) as AttachRow[])) {
    const docId = String(a.documentId ?? a.document_id ?? '');
    if (!docId) continue;
    const list = filesByDoc.get(docId) ?? [];
    list.push({
      id: a.id,
      r2Key: String(a.r2Key ?? a.r2_key ?? ''),
      fileName: a.fileName ?? a.file_name ?? null,
      mimeType: a.mimeType ?? a.mime_type ?? null,
      sizeBytes: (a.sizeBytes ?? a.size_bytes ?? null) as number | null,
    });
    filesByDoc.set(docId, list);
  }
  const withFiles = (d: ReturnType<typeof shapeDoc>) => ({ ...d, files: filesByDoc.get(d.id) ?? [] });

  const byType: Record<string, { currentId: string | null; flatExpiry: string | null; history: Array<ReturnType<typeof shapeDoc> & { files: Array<{ id: string; r2Key: string; fileName: string | null; mimeType: string | null; sizeBytes: number | null }> }> }> = {};
  for (const type of COMPLIANCE_DOC_TYPES) {
    const picked = currentVault.get(type);
    const currentRow = picked
      ? vaultRows.find((d) => d.doc_type === type && iso(d.expiry_date) === iso(picked.expiryDate) && iso(d.issue_date) === iso(picked.issueDate))
      : undefined;
    const col = FLAT_COL[type];
    byType[type] = {
      currentId: currentRow?.id ?? null,
      flatExpiry: col ? iso(lorry[col]) : null,
      history: vaultRows.filter((d) => d.doc_type === type).map((d) => withFiles(shapeDoc(d, today))),
    };
  }

  const svc = (svcR.data ?? [])[0] as { odometer_km: number | null; next_service_km: number | null; next_service_date: string | null; workshop: string | null; description: string | null } | undefined;
  const mileageRows = (mileageR.data ?? []) as MileageRow[];
  const latestReading = mileageRows[0];
  const currentMileageKm = latestReading?.odometer_km ?? svc?.odometer_km ?? null;
  const planRows = (plansR.data ?? []) as PlanRow[];
  const plans = planInputs(planRows.filter((p) => p.active ?? true));
  const shapedPlans = planRows
    .map((p) => shapePlan(p, currentMileageKm, today))
    .sort((a, b) => Number(b.active) - Number(a.active) || (a.daysRemaining ?? 1e9) - (b.daysRemaining ?? 1e9));
  const oosNow = (maintR.data ?? []).some((m) => iso(m.unavailable_from)! <= today && iso(m.unavailable_to)! >= today);

  // Phase 3: breakdowns, work orders (+ parts), components (+ events).
  const breakdownRows = (breakdownR.data ?? []) as BreakdownRow[];
  const woRows = (woR.data ?? []) as WorkOrderRow[];
  const woIds = new Set(woRows.map((w) => w.id));
  const partsByWo = new Map<string, WorkOrderPartRow[]>();
  for (const p of (woPartsR.data ?? []) as WorkOrderPartRow[]) {
    if (!woIds.has(p.work_order_id)) continue;
    const list = partsByWo.get(p.work_order_id) ?? [];
    list.push(p);
    partsByWo.set(p.work_order_id, list);
  }
  const componentRows = (componentsR.data ?? []) as ComponentRow[];
  const compIds = new Set(componentRows.map((cp) => cp.id));
  const eventsByComp = new Map<string, ComponentEventRow[]>();
  for (const e of (compEventsR.data ?? []) as ComponentEventRow[]) {
    if (!compIds.has(e.component_id)) continue;
    const list = eventsByComp.get(e.component_id) ?? [];
    list.push(e);
    eventsByComp.set(e.component_id, list);
  }
  const breakdownActive = isBreakdownActive(breakdownRows.map((b) => ({ severity: b.severity, status: b.status })));
  const openWorkOrder = workOrderSeam(woRows.map((w) => ({ status: w.status })));

  const status = deriveVehicleStatus({
    today,
    outOfService: oosNow,
    currentDocs: statusDocs,
    currentMileageKm,
    nextServiceKm: svc?.next_service_km ?? null,
    nextServiceDate: iso(svc?.next_service_date),
    plans,
    breakdownActive,
    openWorkOrder,
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
      mileageKm: currentMileageKm,
      mileageDate: iso(latestReading?.reading_date) ?? null,
      mileageSource: latestReading ? "reading" : svc?.odometer_km != null ? "service" : null,
      mileageFlagged: !!latestReading?.flagged,
      nextServiceKm: svc?.next_service_km ?? null,
      nextServiceDate: iso(svc?.next_service_date),
      lastServiceWorkshop: svc?.workshop ?? null,
      outOfService: oosNow,
      outOfServiceReason: (maintR.data ?? []).find((m) => iso(m.unavailable_from)! <= today && iso(m.unavailable_to)! >= today)?.reason ?? null,
      notes: lorry.notes,
      status,
      statusLabel: VEHICLE_STATUS_LABELS[status],
      canDispatch: canDispatch(status),
      /* WS3 (mig 0209) has stored the box since it shipped; the drawer never
         showed it. capacity_m3 is DERIVED from L x W x H by the lorries route. */
      isInternal: lorry.is_internal !== false,
      /* Mig 0245 — the lorry's own lifecycle, distinct from purchase_date.
         Surfaced on the full record page, not the quick-look drawer. */
      manufactureDate: iso((lorry as Record<string, unknown>).manufacture_date as string | null),
      registrationDate: iso((lorry as Record<string, unknown>).registration_date as string | null),
      inServiceDate: iso((lorry as Record<string, unknown>).in_service_date as string | null),
      purchaseDate: iso((lorry as Record<string, unknown>).purchase_date as string | null),
      purchasePriceSen: ((lorry as Record<string, unknown>).purchase_price_sen as number | null) ?? null,
      capacityM3: lorry.capacity_m3 ?? null,
      lengthFt: lorry.length_ft ?? null,
      widthFt: lorry.width_ft ?? null,
      heightFt: lorry.height_ft ?? null,
    },
    compliance: byType,
    plans: shapedPlans,
    /* The components a plan may cover, served rather than mirrored. The list and
       its labels live in fleet-status.ts and the migration's CHECK mirrors them;
       a THIRD copy in the frontend would be the one nobody updates. */
    planComponents: PLAN_COMPONENTS.map((value) => ({ value, label: PLAN_COMPONENT_LABELS[value] })),
    mileage: mileageRows.map((m) => ({
      id: m.id,
      readingDate: iso(m.reading_date),
      odometerKm: m.odometer_km,
      source: m.source,
      photoRef: m.photo_ref,
      flagged: !!m.flagged,
      note: m.note,
    })),
    maintenanceWindows: (maintR.data ?? []).map((m) => ({ from: iso(m.unavailable_from), to: iso(m.unavailable_to), reason: m.reason ?? null })),
    breakdowns: breakdownRows.map((b) => shapeBreakdown(b, nowIso)),
    workOrders: woRows.map((w) => shapeWorkOrder(w, partsByWo.get(w.id) ?? [])),
    components: componentRows.map((cp) => shapeComponent(cp, currentMileageKm, today, eventsByComp.get(cp.id) ?? [])),
  });
});

// ── GET /reminders — fleet-wide actionable expiries, most urgent first ───────
// The computation is EXPORTED for the daily push job
// (services/pushFleetReminders.ts) — the module guide has always called this
// endpoint "the seam a future notification job calls". One computation, two
// consumers; the route stays the single place the rules live.
export type FleetReminderItem = {
  vehicleId: string;
  plate: string;
  docType: ComplianceDocType;
  expiryDate: string | null;
  daysRemaining: number | null;
  reminderLevel: string;
  tone: string;
  result: unknown;
};

export async function computeFleetReminders(
  sb: { from: (t: string) => { select: (cols: string) => any } },
): Promise<{ ok: true; today: string; reminders: FleetReminderItem[] } | { ok: false; reason: string }> {
  const today = todayMyt();
  const [lorriesR, vaultR] = await Promise.all([
    inHouseLorries(sb, "id, plate, warehouse_id, active, road_tax_expiry, insurance_expiry, puspakom_expiry, type, is_internal, model, notes"),
    sb.from("lorry_compliance_documents").select("*"),
  ]);
  if (lorriesR.error || vaultR.error) return { ok: false, reason: (lorriesR.error || vaultR.error)?.message ?? "load_failed" };
  const lorries = (lorriesR.data ?? []) as Lorry[];
  const vaultByLorry = new Map<string, VaultRow[]>();
  for (const v of (vaultR.data ?? []) as VaultRow[]) {
    const list = vaultByLorry.get(v.lorry_id) ?? [];
    list.push(v);
    vaultByLorry.set(v.lorry_id, list);
  }
  const reminders: FleetReminderItem[] = [];
  for (const l of lorries) {
    const { compliance } = currentByType(l, vaultByLorry.get(l.id) ?? [], today);
    for (const type of COMPLIANCE_DOC_TYPES) {
      const d = compliance[type];
      if (!d || d.reminderLevel === "OK") continue;
      reminders.push({ vehicleId: l.id, plate: l.plate, docType: type, expiryDate: d.expiryDate, daysRemaining: d.daysRemaining, reminderLevel: d.reminderLevel, tone: d.tone, result: d.result });
    }
  }
  reminders.sort((a, b) => (a.daysRemaining ?? 1e9) - (b.daysRemaining ?? 1e9));
  return { ok: true, today, reminders };
}

fleetMaintenance.get("/reminders", requireHouzsPerm("fleet.read"), async (c) => {
  const r = await computeFleetReminders(c.get("supabase"));
  if (!r.ok) return c.json({ error: "load_failed", reason: r.reason }, 500);
  return c.json({ today: r.today, reminders: r.reminders });
});

// ── POST /vehicles/:id/compliance — APPEND a vault renewal (never overwrite) ─
// Also SYNCS the denormalized flat expiry column on scm.lorries from the latest
// vault row of that type, so the existing Fleet compliance strip keeps working.
fleetMaintenance.post("/vehicles/:id/compliance", requireHouzsPerm("fleet.write"), async (c) => {
  /* company-scope: unified fleet — see the UNIFIED FLEET note above
     inHouseLorries. This stamp can disagree with the parent lorry's and it does
     not matter: none of the 7 read sites of lorry_compliance_documents selects,
     filters or groups on company_id — every one keys on lorry_id — and
     cost_sen is never rolled up per company. A predicate here would hide a
     HOUZS-registered lorry's road tax from the 2990 dispatcher driving it. */
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
  const cost = intOrNull(body.costSen);
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
      cost_sen: cost.value,
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

// ── Compliance ATTACHMENTS (mig 0238) ────────────────────────────────────────
// The vault stored a reference NUMBER and no file, and the drawer had no way to
// add one - owner, 2026-08-01: "为什么我的 Compliance、Road Tax 这些都是不能 Upload
// 的呢？". These three endpoints are the missing half. Contract copied from the
// house pattern (projects.ts /:id/attachments): PUT raw binary with ?ext=&name=,
// server-minted R2 key, POD_BUCKET, and a streamer for reading it back.

const COMPLIANCE_FILE_EXT = new Set(["pdf", "jpg", "jpeg", "png", "webp", "heic"]);
const COMPLIANCE_FILE_MAX = 15 * 1024 * 1024; // 15 MB - a scanned road tax, not a video
const COMPLIANCE_MIME: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg",
  png: "image/png", webp: "image/webp", heic: "image/heic",
};

// PUT /vehicles/:id/compliance/:docId/attachments?ext=pdf&name=roadtax.pdf
fleetMaintenance.put("/vehicles/:id/compliance/:docId/attachments", requireHouzsPerm("fleet.write"), async (c) => {
  const lorryId = c.req.param("id");
  const docId = c.req.param("docId");
  const sb = c.get("supabase");

  const ext = (c.req.query("ext") || "").toLowerCase();
  if (!COMPLIANCE_FILE_EXT.has(ext)) {
    return c.json({ error: "bad_extension", reason: `Attach a PDF or an image (got '${ext || "nothing"}').` }, 400);
  }
  const fileName = c.req.query("name") || null;

  /* The document must exist AND belong to the lorry in the path - otherwise a
     known docId would let a caller hang a file off another lorry's renewal.
     Scoped as well as owner-checked: the lorry master is unified across
     companies (see the vehicle-exists checks below), so "same lorry" alone does
     not mean "same books" - the renewal record itself is per-company. */
  const { data: doc, error: docErr } = await scopeToCompany(sb
    .from("lorry_compliance_documents").select("id, lorry_id").eq("id", docId), c).maybeSingle();
  if (docErr) return c.json({ error: "load_failed", reason: docErr.message }, 500);
  if (!doc) return c.json({ error: "document_not_found" }, 404);
  const owner = String((doc as Record<string, unknown>).lorryId ?? (doc as Record<string, unknown>).lorry_id ?? "");
  if (owner !== lorryId) return c.json({ error: "document_not_on_vehicle" }, 404);

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: "empty_file" }, 400);
  if (body.byteLength > COMPLIANCE_FILE_MAX) {
    return c.json({ error: "file_too_large", reason: "Max 15MB." }, 400);
  }

  const contentType = COMPLIANCE_MIME[ext] ?? "application/octet-stream";
  /* Server-minted: the client never supplies a key, so it cannot point a row at
     an arbitrary bucket object. */
  const key = `fleet/compliance/${lorryId}/${docId}/${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });

  const { data: inserted, error } = await sb.from("lorry_compliance_attachments").insert({
    company_id: activeCompanyId(c) ?? null,
    document_id: docId,
    r2_key: key,
    file_name: fileName,
    mime_type: contentType,
    size_bytes: body.byteLength,
    uploaded_by: c.get("houzsUser")?.id ?? null,
  }).select("id").single();
  if (error) return c.json({ error: "insert_failed", reason: error.message }, 500);

  return c.json({ id: inserted?.id, r2Key: key, fileName, mimeType: contentType, sizeBytes: body.byteLength }, 201);
});

// DELETE /compliance-attachments/:attId - drops the row AND the R2 object.
fleetMaintenance.delete("/compliance-attachments/:attId", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - see the UNIFIED FLEET note above inHouseLorries.
  const attId = c.req.param("attId");
  const sb = c.get("supabase");

  const { data: row, error: loadErr } = await scopeToCompany(sb
    .from("lorry_compliance_attachments").select("id, r2_key").eq("id", attId), c).maybeSingle();
  if (loadErr) return c.json({ error: "load_failed", reason: loadErr.message }, 500);
  if (!row) return c.json({ error: "attachment_not_found" }, 404);

  /* Scoped on the DELETE itself, not only on the load above: the client is
     service-role, so RLS re-checks nothing between the two statements. */
  const { error } = await scopeToCompany(sb.from("lorry_compliance_attachments").delete().eq("id", attId), c);
  if (error) return c.json({ error: "delete_failed", reason: error.message }, 500);

  /* Row first, object second. If the object delete fails the bucket keeps an
     unreferenced blob, which is harmless; the reverse order could leave a row
     pointing at nothing, which the drawer would render as a broken file. */
  const key = String((row as Record<string, unknown>).r2Key ?? (row as Record<string, unknown>).r2_key ?? "");
  if (key) { try { await c.env.POD_BUCKET.delete(key); } catch { /* see above */ } }

  return c.json({ ok: true });
});

// GET /compliance-attachments/:key{.+} - stream it back. The area guard and
// fleet.read have already run; {.+} captures the slashes in the key.
fleetMaintenance.get("/compliance-attachments/:key{.+}", requireHouzsPerm("fleet.read"), async (c) => {
  const key = c.req.param("key");
  if (!key.startsWith("fleet/compliance/")) return c.json({ error: "not_found" }, 404);
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

// ── POST /vehicles/:id/plans — create OR update the plan for one component ───
// One plan per (lorry, component) — the unique index enforces it, and this route
// UPSERTs on that pair so re-submitting the same component edits rather than
// duplicates. next_due_* is never written (it is derived); only the raw interval
// + last-done facts are stored.
fleetMaintenance.post("/vehicles/:id/plans", requireHouzsPerm("fleet.write"), async (c) => {
  const lorryId = c.req.param("id");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const component = String(body.component ?? "").trim().toUpperCase();
  if (!PLAN_COMPONENT_SET.has(component)) return c.json({ error: "invalid_component" }, 400);
  const intervalKm = intOrNull(body.intervalKm);
  if (!intervalKm.ok || (intervalKm.value !== null && intervalKm.value <= 0)) return c.json({ error: "invalid_interval_km" }, 400);
  const intervalMonths = intOrNull(body.intervalMonths);
  if (!intervalMonths.ok || (intervalMonths.value !== null && intervalMonths.value <= 0)) return c.json({ error: "invalid_interval_months" }, 400);
  if (intervalKm.value === null && intervalMonths.value === null) return c.json({ error: "interval_required" }, 400);
  const lastDoneDate = dateOrNull(body.lastDoneDate);
  if (!lastDoneDate.ok) return c.json({ error: "invalid_last_done_date" }, 400);
  const lastDoneKm = intOrNull(body.lastDoneKm);
  if (!lastDoneKm.ok) return c.json({ error: "invalid_last_done_km" }, 400);
  const estCost = intOrNull(body.estCostSen);
  if (!estCost.ok) return c.json({ error: "invalid_est_cost" }, 400);
  const active = body.active === undefined ? true : Boolean(body.active);

  const { data: lorry, error: lorryErr } = await sb.from("lorries").select("id").eq("id", lorryId).maybeSingle();
  if (lorryErr) return c.json({ error: "load_failed", reason: lorryErr.message }, 500);
  if (!lorry) return c.json({ error: "vehicle_not_found" }, 404);

  const payload = {
    company_id: activeCompanyId(c) ?? null,
    lorry_id: lorryId,
    component,
    interval_km: intervalKm.value,
    interval_months: intervalMonths.value,
    last_done_date: lastDoneDate.value,
    last_done_km: lastDoneKm.value,
    workshop: (body.workshop as string)?.trim() || null,
    est_cost_sen: estCost.value,
    notes: (body.notes as string)?.trim() || null,
    active,
    updated_at: new Date().toISOString(),
    created_by: c.get("houzsUser")?.id ?? null,
  };
  const { data: up, error } = await sb
    .from("lorry_maintenance_plans")
    .upsert(payload, { onConflict: "lorry_id,component" })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23503") return c.json({ error: "vehicle_not_found" }, 404);
    return c.json({ error: "upsert_failed", reason: error.message }, 500);
  }
  return c.json({ id: up?.id }, 201);
});

// ── PATCH /plans/:planId — edit an existing plan (partial) ────────────────────
fleetMaintenance.patch("/plans/:planId", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - see the UNIFIED FLEET note above inHouseLorries.
  const planId = c.req.param("planId");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("intervalKm" in body) {
    const v = intOrNull(body.intervalKm);
    if (!v.ok || (v.value !== null && v.value <= 0)) return c.json({ error: "invalid_interval_km" }, 400);
    patch.interval_km = v.value;
  }
  if ("intervalMonths" in body) {
    const v = intOrNull(body.intervalMonths);
    if (!v.ok || (v.value !== null && v.value <= 0)) return c.json({ error: "invalid_interval_months" }, 400);
    patch.interval_months = v.value;
  }
  if ("lastDoneDate" in body) {
    const v = dateOrNull(body.lastDoneDate);
    if (!v.ok) return c.json({ error: "invalid_last_done_date" }, 400);
    patch.last_done_date = v.value;
  }
  if ("lastDoneKm" in body) {
    const v = intOrNull(body.lastDoneKm);
    if (!v.ok) return c.json({ error: "invalid_last_done_km" }, 400);
    patch.last_done_km = v.value;
  }
  if ("estCostSen" in body) {
    const v = intOrNull(body.estCostSen);
    if (!v.ok) return c.json({ error: "invalid_est_cost" }, 400);
    patch.est_cost_sen = v.value;
  }
  if ("workshop" in body) patch.workshop = (body.workshop as string)?.trim() || null;
  if ("notes" in body) patch.notes = (body.notes as string)?.trim() || null;
  if ("active" in body) patch.active = Boolean(body.active);

  const { data: updated, error } = await scopeToCompany(sb
    .from("lorry_maintenance_plans")
    .update(patch)
    .eq("id", planId), c)
    .select("id")
    .maybeSingle();
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);
  if (!updated) return c.json({ error: "plan_not_found" }, 404);
  return c.json({ id: updated.id });
});

// ── POST /vehicles/:id/mileage — capture a daily odometer reading ────────────
// The primary flow is the driver marking the day "fully complete" and entering
// the odometer + a dashboard photo (source = DAY_COMPLETE). Guards (pure, in
// services/fleet-status.ts): a reading BELOW the latest is a rollback and is
// REJECTED; an abnormal one-day jump is ACCEPTED but flagged for review. GPS
// distance is never written as the odometer.
fleetMaintenance.post("/vehicles/:id/mileage", requireHouzsPerm("fleet.write"), async (c) => {
  const lorryId = c.req.param("id");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const odo = intOrNull(body.odometerKm);
  if (!odo.ok || odo.value === null) return c.json({ error: "invalid_odometer" }, 400);
  const readingDateInput = dateOrNull(body.readingDate);
  if (!readingDateInput.ok) return c.json({ error: "invalid_reading_date" }, 400);
  const readingDate = readingDateInput.value ?? todayMyt();
  const sourceRaw = body.source === undefined || body.source === "" ? "DAY_COMPLETE" : String(body.source).toUpperCase();
  if (!MILEAGE_SOURCE_SET.has(sourceRaw)) return c.json({ error: "invalid_source" }, 400);
  const source = sourceRaw as MileageSource;
  const photoRef = (body.photoRef as string)?.trim() || null;
  const note = (body.note as string)?.trim() || null;

  const { data: lorry, error: lorryErr } = await sb.from("lorries").select("id").eq("id", lorryId).maybeSingle();
  if (lorryErr) return c.json({ error: "load_failed", reason: lorryErr.message }, 500);
  if (!lorry) return c.json({ error: "vehicle_not_found" }, 404);

  // Latest existing reading is the previous odometer the guards compare against.
  const { data: prevRows, error: prevErr } = await sb
    .from("lorry_mileage_readings")
    .select("odometer_km, reading_date")
    .eq("lorry_id", lorryId)
    .order("reading_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  if (prevErr) return c.json({ error: "load_failed", reason: prevErr.message }, 500);
  const prev = (prevRows ?? [])[0] as { odometer_km: number | null; reading_date: string | null } | undefined;

  const assessment = assessMileageReading({
    previousKm: prev?.odometer_km ?? null,
    previousDate: iso(prev?.reading_date),
    newKm: odo.value,
    newDate: readingDate,
  });
  // A rollback is rejected — the client can resubmit a corrected value. The GPS
  // cross-check the client may show is advisory only and never lands here.
  if (assessment.verdict === "ROLLBACK") {
    return c.json({ error: "odometer_rollback", previousKm: prev?.odometer_km ?? null, deltaKm: assessment.deltaKm }, 409);
  }

  const { data: inserted, error } = await sb
    .from("lorry_mileage_readings")
    .insert({
      company_id: activeCompanyId(c) ?? null,
      lorry_id: lorryId,
      reading_date: readingDate,
      odometer_km: odo.value,
      source,
      photo_ref: photoRef,
      flagged: assessment.flagged,
      note,
      entered_by: c.get("houzsUser")?.id ?? null,
    })
    .select("id")
    .single();
  if (error) {
    // The one-DAY_COMPLETE-per-day unique index: a second day-complete entry.
    if (error.code === "23505") return c.json({ error: "already_captured_today" }, 409);
    if (error.code === "23503") return c.json({ error: "vehicle_not_found" }, 404);
    return c.json({ error: "insert_failed", reason: error.message }, 500);
  }
  return c.json({ id: inserted?.id, verdict: assessment.verdict, flagged: assessment.flagged, deltaKm: assessment.deltaKm }, 201);
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 3 write surface — breakdown cases, work orders (+ state machine + parts),
// tyre/component lifecycle (+ events). All gated fleet.write.
// ════════════════════════════════════════════════════════════════════════════

/** Confirm the lorry exists (unified fleet — no company scope on the master). */
async function lorryExists(sb: Variables["supabase"], lorryId: string): Promise<boolean | "error"> {
  const { data, error } = await sb.from("lorries").select("id").eq("id", lorryId).maybeSingle();
  if (error) return "error";
  return !!data;
}

// ── POST /vehicles/:id/breakdowns — driver/office logs a breakdown ───────────
// A CRITICAL case grounds the lorry (feeds breakdownActive → BREAKDOWN). We find
// the affected trip(s), suggest replacement lorries / 3PL, and notify the
// reporter's reporting line through the EXISTING announcements mechanism.
fleetMaintenance.post("/vehicles/:id/breakdowns", requireHouzsPerm("fleet.write"), async (c) => {
  const lorryId = c.req.param("id");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const severity = String(body.severity ?? "MINOR").trim().toUpperCase();
  if (!BREAKDOWN_SEVERITY_SET.has(severity)) return c.json({ error: "invalid_severity" }, 400);
  const statusIn = body.status === undefined || body.status === "" ? "OPEN" : String(body.status).toUpperCase();
  if (!BREAKDOWN_STATUS_SET.has(statusIn)) return c.json({ error: "invalid_status" }, 400);
  const occurredAt = tsOrNull(body.occurredAt);
  if (!occurredAt.ok) return c.json({ error: "invalid_occurred_at" }, 400);
  const lat = floatOrNull(body.gpsLat);
  if (!lat.ok) return c.json({ error: "invalid_gps_lat" }, 400);
  const lng = floatOrNull(body.gpsLng);
  if (!lng.ok) return c.json({ error: "invalid_gps_lng" }, 400);
  const towingCost = numOrNull(body.towingCostSen);
  if (!towingCost.ok) return c.json({ error: "invalid_towing_cost" }, 400);
  const breakdownStart = tsOrNull(body.breakdownStart);
  if (!breakdownStart.ok) return c.json({ error: "invalid_breakdown_start" }, 400);
  const recoveryTime = tsOrNull(body.recoveryTime);
  if (!recoveryTime.ok) return c.json({ error: "invalid_recovery_time" }, 400);
  const media = refsOrNull(body.mediaRefs);
  if (!media.ok) return c.json({ error: "invalid_media_refs" }, 400);
  const affectedTripId = (body.affectedTripId as string)?.trim() || null;

  const exists = await lorryExists(sb, lorryId);
  if (exists === "error") return c.json({ error: "load_failed" }, 500);
  if (!exists) return c.json({ error: "vehicle_not_found" }, 404);

  const { data: inserted, error } = await sb
    .from("lorry_breakdown_cases")
    .insert({
      company_id: activeCompanyId(c) ?? null,
      lorry_id: lorryId,
      case_no: await mintRecordNo(sb, "lorry_breakdown_cases", "case_no", CODE_PREFIX.BREAKDOWN, activeCompanyId(c) ?? null),
      occurred_at: occurredAt.value ?? new Date().toISOString(),
      gps_lat: lat.value,
      gps_lng: lng.value,
      fault_type: (body.faultType as string)?.trim() || null,
      severity,
      still_drivable: body.stillDrivable === undefined ? true : Boolean(body.stillDrivable),
      media_refs: media.value,
      driver_description: (body.driverDescription as string)?.trim() || null,
      towing_company: (body.towingCompany as string)?.trim() || null,
      towing_cost_sen: towingCost.value,
      workshop: (body.workshop as string)?.trim() || null,
      breakdown_start: breakdownStart.value,
      recovery_time: recoveryTime.value,
      affected_trip_id: affectedTripId,
      status: statusIn,
      notes: (body.notes as string)?.trim() || null,
      created_by: c.get("houzsUser")?.id ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23503") return c.json({ error: "vehicle_not_found" }, 404);
    return c.json({ error: "insert_failed", reason: error.message }, 500);
  }

  // If this case grounds the lorry, surface the dispatch impact + suggestions.
  const grounding = isCaseGrounding({ severity, status: statusIn });
  let affectedTrips: Array<{ id: string; tripNo: string | null; tripDate: string | null; status: string | null }> = [];
  let replacementSuggestions: Array<{ id: string; plate: string; region: string | null }> = [];
  if (grounding) {
    // Trips today+future on this lorry that are not yet finished.
    const { data: trips } = await sb
      .from("trips")
      .select("id, trip_no, trip_date, status, warehouse_id")
      .eq("lorry_id", lorryId)
      .gte("trip_date", todayMyt())
      .neq("status", "COMPLETED")
      .order("trip_date");
    affectedTrips = (trips ?? []).map((t) => ({ id: t.id as string, tripNo: (t.trip_no as string) ?? null, tripDate: iso(t.trip_date), status: (t.status as string) ?? null }));

    // Replacement suggestion: available lorries in the same warehouse, minus this one.
    const sameWh = (trips ?? [])[0]?.warehouse_id ?? null;
    const { data: cand } = await sb
      .from("lorries")
      .select("id, plate, warehouse_id")
      .eq("active", true)
      .neq("id", lorryId)
      .limit(200);
    replacementSuggestions = (cand ?? [])
      .filter((x) => (sameWh ? x.warehouse_id === sameWh : true))
      .slice(0, 6)
      .map((x) => ({ id: x.id as string, plate: x.plate as string, region: null }));

    // Notify the reporter's reporting line via the existing announcements path.
    const reporterId = Number(c.get("houzsUser")?.id ?? NaN);
    if (Number.isFinite(reporterId) && reporterId > 0) {
      try {
        const { data: lorryRow } = await sb.from("lorries").select("plate").eq("id", lorryId).maybeSingle();
        const plate = (lorryRow?.plate as string) ?? "a lorry";
        const targets = await uplineUserIds(c.env, reporterId);
        const explicit = Array.isArray(body.notifyUserIds) ? (body.notifyUserIds as unknown[]).map((v) => Number(v)) : [];
        await postPersonalNotice(c.env, {
          userIds: [...new Set([...targets, ...explicit])],
          category: "WARNING",
          title: `Breakdown: ${plate} grounded`,
          body: `${plate} has a critical breakdown${body.faultType ? ` (${String(body.faultType).trim()})` : ""} and cannot dispatch. ${affectedTrips.length} trip(s) affected. Assign a replacement lorry or 3PL.`,
          source: "fleet_breakdown",
        });
      } catch (e) {
        console.error("[fleet-breakdown] notify failed:", (e as Error).message);
      }
    }
  }

  return c.json({ id: inserted?.id, grounding, affectedTrips, replacementSuggestions }, 201);
});

// ── PATCH /breakdowns/:id — update / resolve a breakdown case ─────────────────
fleetMaintenance.patch("/breakdowns/:caseId", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - see the UNIFIED FLEET note above inHouseLorries.
  const caseId = c.req.param("caseId");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("severity" in body) {
    const s = String(body.severity).toUpperCase();
    if (!BREAKDOWN_SEVERITY_SET.has(s)) return c.json({ error: "invalid_severity" }, 400);
    patch.severity = s;
  }
  if ("status" in body) {
    const s = String(body.status).toUpperCase();
    if (!BREAKDOWN_STATUS_SET.has(s)) return c.json({ error: "invalid_status" }, 400);
    patch.status = s;
  }
  if ("faultType" in body) patch.fault_type = (body.faultType as string)?.trim() || null;
  if ("stillDrivable" in body) patch.still_drivable = Boolean(body.stillDrivable);
  if ("towingCompany" in body) patch.towing_company = (body.towingCompany as string)?.trim() || null;
  if ("workshop" in body) patch.workshop = (body.workshop as string)?.trim() || null;
  if ("notes" in body) patch.notes = (body.notes as string)?.trim() || null;
  if ("driverDescription" in body) patch.driver_description = (body.driverDescription as string)?.trim() || null;
  if ("towingCostSen" in body) {
    const v = numOrNull(body.towingCostSen);
    if (!v.ok) return c.json({ error: "invalid_towing_cost" }, 400);
    patch.towing_cost_sen = v.value;
  }
  if ("breakdownStart" in body) {
    const v = tsOrNull(body.breakdownStart);
    if (!v.ok) return c.json({ error: "invalid_breakdown_start" }, 400);
    patch.breakdown_start = v.value;
  }
  if ("recoveryTime" in body) {
    const v = tsOrNull(body.recoveryTime);
    if (!v.ok) return c.json({ error: "invalid_recovery_time" }, 400);
    patch.recovery_time = v.value;
  }

  const { data: updated, error } = await scopeToCompany(sb.from("lorry_breakdown_cases").update(patch).eq("id", caseId), c).select("id").maybeSingle();
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);
  if (!updated) return c.json({ error: "case_not_found" }, 404);
  return c.json({ id: updated.id });
});

// ── POST /vehicles/:id/work-orders — open a maintenance work order ───────────
fleetMaintenance.post("/vehicles/:id/work-orders", requireHouzsPerm("fleet.write"), async (c) => {
  const lorryId = c.req.param("id");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const money: Record<string, number> = {};
  for (const [k, col] of [["labourSen", "labour_sen"], ["outsideServiceSen", "outside_service_sen"], ["towingSen", "towing_sen"], ["taxSen", "tax_sen"]] as const) {
    const v = numOrNull(body[k]);
    if (!v.ok) return c.json({ error: `invalid_${col}` }, 400);
    money[col] = v.value ?? 0;
  }
  const warranty = dateOrNull(body.warrantyUntil);
  if (!warranty.ok) return c.json({ error: "invalid_warranty_until" }, 400);
  const est = tsOrNull(body.estComplete);
  if (!est.ok) return c.json({ error: "invalid_est_complete" }, 400);
  const docDate = dateOrNull(body.documentDate);
  if (!docDate.ok) return c.json({ error: "invalid_document_date" }, 400);
  const invoiceRefs = refsOrNull(body.invoiceRefs);
  const quoteRefs = refsOrNull(body.quoteRefs);
  const photoRefs = refsOrNull(body.photoRefs);
  if (!invoiceRefs.ok || !quoteRefs.ok || !photoRefs.ok) return c.json({ error: "invalid_refs" }, 400);

  const exists = await lorryExists(sb, lorryId);
  if (exists === "error") return c.json({ error: "load_failed" }, 500);
  if (!exists) return c.json({ error: "vehicle_not_found" }, 404);

  const { data: inserted, error } = await sb
    .from("lorry_work_orders")
    .insert({
      company_id: activeCompanyId(c) ?? null,
      lorry_id: lorryId,
      wo_no: await mintRecordNo(sb, "lorry_work_orders", "wo_no", CODE_PREFIX.WORK_ORDER, activeCompanyId(c) ?? null),
      status: "REPORTED",
      problem: (body.problem as string)?.trim() || null,
      diagnosis: (body.diagnosis as string)?.trim() || null,
      /* `workshop` (free text) and `workshop_id` (the 0241 master) coexist on
         purpose: every pre-0241 row has only the string, and the string is also
         what an OCR pass produces before anyone has matched it to a master row.
         The master link is the one that aggregates spend. */
      workshop: (body.workshop as string)?.trim() || null,
      workshop_id: (body.workshopId as string)?.trim() || null,
      quotation_no: (body.quotationNo as string)?.trim() || null,
      invoice_no: (body.invoiceNo as string)?.trim() || null,
      advisor: (body.advisor as string)?.trim() || null,
      document_date: docDate.value,
      labour_sen: money.labour_sen,
      outside_service_sen: money.outside_service_sen,
      towing_sen: money.towing_sen,
      tax_sen: money.tax_sen,
      warranty_until: warranty.value,
      invoice_refs: invoiceRefs.value,
      quote_refs: quoteRefs.value,
      photo_refs: photoRefs.value,
      est_complete: est.value,
      breakdown_case_id: (body.breakdownCaseId as string)?.trim() || null,
      component_id: (body.componentId as string)?.trim() || null,
      notes: (body.notes as string)?.trim() || null,
      created_by: c.get("houzsUser")?.id ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23503") return c.json({ error: "vehicle_not_found" }, 404);
    return c.json({ error: "insert_failed", reason: error.message }, 500);
  }
  return c.json({ id: inserted?.id, status: "REPORTED" }, 201);
});

// ── PATCH /work-orders/:id — edit fields (NOT status — use /transition) ───────
fleetMaintenance.patch("/work-orders/:woId", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - see the UNIFIED FLEET note above inHouseLorries.
  const woId = c.req.param("woId");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, col] of [["labourSen", "labour_sen"], ["outsideServiceSen", "outside_service_sen"], ["towingSen", "towing_sen"], ["taxSen", "tax_sen"]] as const) {
    if (k in body) {
      const v = numOrNull(body[k]);
      if (!v.ok) return c.json({ error: `invalid_${col}` }, 400);
      patch[col] = v.value ?? 0;
    }
  }
  if ("problem" in body) patch.problem = (body.problem as string)?.trim() || null;
  if ("diagnosis" in body) patch.diagnosis = (body.diagnosis as string)?.trim() || null;
  if ("workshop" in body) patch.workshop = (body.workshop as string)?.trim() || null;
  if ("workshopId" in body) patch.workshop_id = (body.workshopId as string)?.trim() || null;
  if ("quotationNo" in body) patch.quotation_no = (body.quotationNo as string)?.trim() || null;
  if ("invoiceNo" in body) patch.invoice_no = (body.invoiceNo as string)?.trim() || null;
  if ("advisor" in body) patch.advisor = (body.advisor as string)?.trim() || null;
  if ("documentDate" in body) {
    const v = dateOrNull(body.documentDate);
    if (!v.ok) return c.json({ error: "invalid_document_date" }, 400);
    patch.document_date = v.value;
  }
  if ("notes" in body) patch.notes = (body.notes as string)?.trim() || null;
  if ("warrantyUntil" in body) {
    const v = dateOrNull(body.warrantyUntil);
    if (!v.ok) return c.json({ error: "invalid_warranty_until" }, 400);
    patch.warranty_until = v.value;
  }
  if ("estComplete" in body) {
    const v = tsOrNull(body.estComplete);
    if (!v.ok) return c.json({ error: "invalid_est_complete" }, 400);
    patch.est_complete = v.value;
  }
  for (const [k, col] of [["invoiceRefs", "invoice_refs"], ["quoteRefs", "quote_refs"], ["photoRefs", "photo_refs"]] as const) {
    if (k in body) {
      const v = refsOrNull(body[k]);
      if (!v.ok) return c.json({ error: `invalid_${col}` }, 400);
      patch[col] = v.value;
    }
  }
  if ("componentId" in body) patch.component_id = (body.componentId as string)?.trim() || null;

  const { data: updated, error } = await scopeToCompany(sb.from("lorry_work_orders").update(patch).eq("id", woId), c).select("id").maybeSingle();
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);
  if (!updated) return c.json({ error: "work_order_not_found" }, 404);
  return c.json({ id: updated.id });
});

// ── POST /work-orders/:id/transition — advance the state machine ──────────────
// The ONLY path that changes a work order's status: it validates the transition
// against WORK_ORDER_TRANSITIONS so an illegal jump (e.g. Reported → Verified)
// is a 409, never a silent write.
fleetMaintenance.post("/work-orders/:woId/transition", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - see the UNIFIED FLEET note above inHouseLorries.
  const woId = c.req.param("woId");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const to = String(body.to ?? "").trim().toUpperCase();
  if (!WORK_ORDER_STATE_SET.has(to)) return c.json({ error: "invalid_target_state" }, 400);

  const { data: cur, error: curErr } = await scopeToCompany(sb.from("lorry_work_orders").select("id, status").eq("id", woId), c).maybeSingle();
  if (curErr) return c.json({ error: "load_failed", reason: curErr.message }, 500);
  if (!cur) return c.json({ error: "work_order_not_found" }, 404);
  const from = cur.status as WorkOrderState;
  if (!canTransitionWorkOrder(from, to as WorkOrderState)) {
    return c.json({ error: "illegal_transition", from, to }, 409);
  }

  const patch: Record<string, unknown> = { status: to, updated_at: new Date().toISOString() };
  if (to === "APPROVED") patch.approved_by = c.get("houzsUser")?.id ?? null;
  if (to === "VERIFIED") patch.verified_by = c.get("houzsUser")?.id ?? null;
  if (to === "COMPLETED") patch.actual_complete = new Date().toISOString();

  const { data: updated, error } = await scopeToCompany(sb.from("lorry_work_orders").update(patch).eq("id", woId), c).select("id").maybeSingle();
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);
  if (!updated) return c.json({ error: "work_order_not_found" }, 404);
  return c.json({ id: updated.id, status: to });
});

// ── POST /work-orders/:id/parts — add a part line ────────────────────────────
fleetMaintenance.post("/work-orders/:woId/parts", requireHouzsPerm("fleet.write"), async (c) => {
  const woId = c.req.param("woId");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const name = (body.name as string)?.trim();
  if (!name) return c.json({ error: "name_required" }, 400);
  const qty = numOrNull(body.qty);
  if (!qty.ok || (qty.value !== null && qty.value <= 0)) return c.json({ error: "invalid_qty" }, 400);
  const unit = numOrNull(body.unitPriceSen);
  if (!unit.ok) return c.json({ error: "invalid_unit_price" }, 400);
  /* A workshop invoice discounts PER LINE, not per document, and prints its own
     line total. Both are optional: a line with neither is the pre-0241 shape and
     still prices as qty x unit. */
  const discount = numOrNull(body.discountPct);
  if (!discount.ok || (discount.value !== null && (discount.value < 0 || discount.value > 100))) {
    return c.json({ error: "invalid_discount_pct" }, 400);
  }
  const amount = numOrNull(body.amountSen);
  if (!amount.ok || (amount.value !== null && amount.value < 0)) return c.json({ error: "invalid_amount" }, 400);
  const lineNo = numOrNull(body.lineNo);
  if (!lineNo.ok) return c.json({ error: "invalid_line_no" }, 400);
  const section = String(body.section ?? "PART").toUpperCase();
  if (section !== "PART" && section !== "LABOUR") return c.json({ error: "invalid_section" }, 400);

  const { data: wo, error: woErr } = await scopeToCompany(sb.from("lorry_work_orders").select("id, labour_sen").eq("id", woId), c).maybeSingle();
  if (woErr) return c.json({ error: "load_failed", reason: woErr.message }, 500);
  if (!wo) return c.json({ error: "work_order_not_found" }, 404);

  /* The one rule the DB cannot express (mig 0241): labour lives EITHER in the
     header scalar OR in LABOUR-section lines, never both, or the total counts
     it twice. The route is the single writer, so it is enforced here. */
  if (section === "LABOUR" && Number(wo.labour_sen ?? 0) > 0) {
    return c.json({
      error: "labour_already_on_header",
      reason: "This record already carries labour in labourSen. Clear it before adding labour lines, or keep using the header figure.",
    }, 409);
  }

  const { data: inserted, error } = await sb
    .from("lorry_work_order_parts")
    .insert({
      company_id: activeCompanyId(c) ?? null,
      work_order_id: woId,
      section,
      name,
      part_no: (body.partNo as string)?.trim() || null,
      uom: (body.uom as string)?.trim()?.toUpperCase() || null,
      qty: qty.value ?? 1,
      unit_price_sen: unit.value ?? 0,
      discount_pct: discount.value ?? 0,
      amount_sen: amount.value,
      line_no: lineNo.value,
      serial: (body.serial as string)?.trim() || null,
      created_by: c.get("houzsUser")?.id ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23503") return c.json({ error: "work_order_not_found" }, 404);
    return c.json({ error: "insert_failed", reason: error.message }, 500);
  }
  return c.json({ id: inserted?.id }, 201);
});

// ── DELETE /work-orders/:id/parts/:partId — remove a part line ────────────────
fleetMaintenance.delete("/work-orders/:woId/parts/:partId", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - see the UNIFIED FLEET note above inHouseLorries.
  const sb = c.get("supabase");
  const { data: deleted, error } = await scopeToCompany(sb
    .from("lorry_work_order_parts")
    .delete()
    .eq("id", c.req.param("partId"))
    .eq("work_order_id", c.req.param("woId")), c)
    .select("id")
    .maybeSingle();
  if (error) return c.json({ error: "delete_failed", reason: error.message }, 500);
  if (!deleted) return c.json({ error: "part_not_found" }, 404);
  return c.json({ id: deleted.id });
});

// ── POST /vehicles/:id/components — fit a component (tyre/battery/…) ──────────
fleetMaintenance.post("/vehicles/:id/components", requireHouzsPerm("fleet.write"), async (c) => {
  const lorryId = c.req.param("id");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const componentType = String(body.componentType ?? "").trim().toUpperCase();
  if (!COMPONENT_TYPE_SET.has(componentType)) return c.json({ error: "invalid_component_type" }, 400);
  const position = body.position === undefined || body.position === "" ? "NA" : String(body.position).toUpperCase();
  if (!COMPONENT_POSITION_SET.has(position)) return c.json({ error: "invalid_position" }, 400);
  const fittedDate = dateOrNull(body.fittedDate);
  if (!fittedDate.ok) return c.json({ error: "invalid_fitted_date" }, 400);
  const fittedKm = intOrNull(body.fittedKm);
  if (!fittedKm.ok) return c.json({ error: "invalid_fitted_km" }, 400);
  const price = numOrNull(body.purchasePriceSen);
  if (!price.ok) return c.json({ error: "invalid_purchase_price" }, 400);
  const tread = numOrNull(body.treadDepth);
  if (!tread.ok) return c.json({ error: "invalid_tread_depth" }, 400);
  const warranty = dateOrNull(body.warrantyUntil);
  if (!warranty.ok) return c.json({ error: "invalid_warranty_until" }, 400);

  const exists = await lorryExists(sb, lorryId);
  if (exists === "error") return c.json({ error: "load_failed" }, 500);
  if (!exists) return c.json({ error: "vehicle_not_found" }, 404);

  const { data: inserted, error } = await sb
    .from("lorry_components")
    .insert({
      company_id: activeCompanyId(c) ?? null,
      lorry_id: lorryId,
      component_type: componentType,
      position,
      brand: (body.brand as string)?.trim() || null,
      model: (body.model as string)?.trim() || null,
      size: (body.size as string)?.trim() || null,
      serial: (body.serial as string)?.trim() || null,
      fitted_date: fittedDate.value,
      fitted_km: fittedKm.value,
      purchase_price_sen: price.value,
      tread_depth: tread.value,
      warranty_until: warranty.value,
      status: "ACTIVE",
      notes: (body.notes as string)?.trim() || null,
      created_by: c.get("houzsUser")?.id ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return c.json({ error: "position_occupied" }, 409);
    if (error.code === "23503") return c.json({ error: "vehicle_not_found" }, 404);
    return c.json({ error: "insert_failed", reason: error.message }, 500);
  }
  return c.json({ id: inserted?.id }, 201);
});

// ── PATCH /components/:id — update / remove a component ───────────────────────
fleetMaintenance.patch("/components/:componentId", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - see the UNIFIED FLEET note above inHouseLorries.
  const componentId = c.req.param("componentId");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("status" in body) {
    const s = String(body.status).toUpperCase();
    if (s !== "ACTIVE" && s !== "REMOVED") return c.json({ error: "invalid_status" }, 400);
    patch.status = s;
  }
  if ("treadDepth" in body) {
    const v = numOrNull(body.treadDepth);
    if (!v.ok) return c.json({ error: "invalid_tread_depth" }, 400);
    patch.tread_depth = v.value;
  }
  if ("removedDate" in body) {
    const v = dateOrNull(body.removedDate);
    if (!v.ok) return c.json({ error: "invalid_removed_date" }, 400);
    patch.removed_date = v.value;
  }
  if ("removedKm" in body) {
    const v = intOrNull(body.removedKm);
    if (!v.ok) return c.json({ error: "invalid_removed_km" }, 400);
    patch.removed_km = v.value;
  }
  if ("position" in body) {
    const p = String(body.position).toUpperCase();
    if (!COMPONENT_POSITION_SET.has(p)) return c.json({ error: "invalid_position" }, 400);
    patch.position = p;
  }
  if ("warrantyUntil" in body) {
    const v = dateOrNull(body.warrantyUntil);
    if (!v.ok) return c.json({ error: "invalid_warranty_until" }, 400);
    patch.warranty_until = v.value;
  }
  if ("brand" in body) patch.brand = (body.brand as string)?.trim() || null;
  if ("model" in body) patch.model = (body.model as string)?.trim() || null;
  if ("size" in body) patch.size = (body.size as string)?.trim() || null;
  if ("serial" in body) patch.serial = (body.serial as string)?.trim() || null;
  if ("notes" in body) patch.notes = (body.notes as string)?.trim() || null;

  const { data: updated, error } = await scopeToCompany(sb.from("lorry_components").update(patch).eq("id", componentId), c).select("id").maybeSingle();
  if (error) {
    if (error.code === "23505") return c.json({ error: "position_occupied" }, 409);
    return c.json({ error: "update_failed", reason: error.message }, 500);
  }
  if (!updated) return c.json({ error: "component_not_found" }, 404);
  return c.json({ id: updated.id });
});

// ── POST /components/:id/events — log rotation/puncture/repair/inspection ──────
fleetMaintenance.post("/components/:componentId/events", requireHouzsPerm("fleet.write"), async (c) => {
  const componentId = c.req.param("componentId");
  const sb = c.get("supabase");

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const eventType = String(body.eventType ?? "").trim().toUpperCase();
  if (!COMPONENT_EVENT_TYPE_SET.has(eventType)) return c.json({ error: "invalid_event_type" }, 400);
  const eventDate = dateOrNull(body.eventDate);
  if (!eventDate.ok) return c.json({ error: "invalid_event_date" }, 400);
  const odo = intOrNull(body.odometerKm);
  if (!odo.ok) return c.json({ error: "invalid_odometer" }, 400);
  const cost = numOrNull(body.costSen);
  if (!cost.ok) return c.json({ error: "invalid_cost" }, 400);
  let toPosition: string | null = null;
  if (body.toPosition != null && body.toPosition !== "") {
    toPosition = String(body.toPosition).toUpperCase();
    if (!COMPONENT_POSITION_SET.has(toPosition)) return c.json({ error: "invalid_to_position" }, 400);
  }

  const { data: comp, error: compErr } = await scopeToCompany(sb.from("lorry_components").select("id").eq("id", componentId), c).maybeSingle();
  if (compErr) return c.json({ error: "load_failed", reason: compErr.message }, 500);
  if (!comp) return c.json({ error: "component_not_found" }, 404);

  const { data: inserted, error } = await sb
    .from("lorry_component_events")
    .insert({
      company_id: activeCompanyId(c) ?? null,
      component_id: componentId,
      event_type: eventType,
      event_date: eventDate.value ?? todayMyt(),
      odometer_km: odo.value,
      to_position: toPosition,
      cost_sen: cost.value,
      note: (body.note as string)?.trim() || null,
      created_by: c.get("houzsUser")?.id ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23503") return c.json({ error: "component_not_found" }, 404);
    return c.json({ error: "insert_failed", reason: error.message }, 500);
  }
  return c.json({ id: inserted?.id }, 201);
});

// ── Workshops (mig 0241) ─────────────────────────────────────────────────────
// The repair vendor as a MASTER ROW rather than a free-text string on four
// unrelated tables. Owner, 2026-08-02: a repair record must carry "维修商信息：
// 地址、Email、SSM 注册号". None of that has anywhere to live in a TEXT column,
// and neither does "what did we spend at this workshop".

/** Mint the next WS-#### for a company. Owner: codes are generated, never typed
 *  — the driver roster is what hand-typed codes look like after a year
 *  (DRV-001..007 alongside DRV-05/DRV-050, same person three times).
 *
 *  Highest-existing + 1 rather than a sequence, because the code is per COMPANY
 *  and a Postgres sequence is global. The UNIQUE (company_id, code) index is the
 *  real guard: two racing creates collide there and the loser retries. */
async function mintWorkshopCode(sb: any, companyId: number | null): Promise<string> {
  /* Reads EVERY code, not the top 50 by string order: "WS-9" sorts above
     "WS-10" as text, so an ordered LIMIT would eventually mint a duplicate.
     nextCode (scm/lib/fleet-code-mint) is the one parser every minted code in
     this system shares — it reads any padding, which is what stops a second
     numbering scheme forming the way DRV-05 formed beside DRV-050. */
  /* The comment above is about not minting a duplicate, and `.eq("company_id",
     null)` — a malformed filter that matches nothing — is the fastest way to
     mint one: zero codes read, sequence restarts at 1. scopeToCompanyIdOrOpen
     falls OPEN instead, so the mint sees more codes and skips past them. */
  const { data } = await scopeToCompanyIdOrOpen(sb.from("workshops").select("code"), companyId);
  return nextCode(CODE_PREFIX.WORKSHOP, ((data ?? []) as Array<{ code?: string | null }>).map((r) => r.code));
}

/** BD-#### / WO-#### (mig 0248). Same shape as mintWorkshopCode and for the
 *  same reasons: read EVERY number (string order puts WO-9 above WO-10), let the
 *  shared parser decide what comes next, and let the partial UNIQUE index be the
 *  real guard so two racing creates cannot both win. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mintRecordNo(sb: any, table: string, column: string, prefix: string, companyId: number | null): Promise<string> {
  /* `.eq("company_id", null)` is a MALFORMED filter, not "no company": PostgREST
     renders `company_id=eq.null`, which matches nothing. On a mint that is the
     dangerous direction — reading zero existing codes restarts the sequence at 1
     and issues a DUPLICATE. scopeToCompanyIdOrOpen (companyScope.ts:136) exists
     for exactly this call shape and falls OPEN on an unresolved company, so the
     mint sees MORE codes and skips past them rather than colliding. */
  const { data } = await scopeToCompanyIdOrOpen(sb.from(table).select(column), companyId);
  return nextCode(prefix, ((data ?? []) as Array<Record<string, string | null>>).map((r) => r[column]));
}

fleetMaintenance.get("/workshops", requireHouzsPerm("fleet.read"), async (c) => {
  const sb = c.get("supabase");
  const q = sb
    .from("workshops")
    .select("id, code, name, registration_no, contact_name, contact_phone, office_phone, email, address, notes, is_active");
  /* scopeToCompany, not `.eq("company_id", activeCompanyId(c) ?? null)`. The raw
     form renders `company_id=eq.null` on an unresolved company — a malformed
     filter that matches NOTHING, so the page showed an empty workshop list
     instead of either the rows or an honest refusal. The helper fails closed
     when the context is resolved and open only in the legacy state. */
  const { data, error } = await scopeToCompany(q, c).order("name");
  if (error) return c.json({ error: "load_failed", reason: error.message }, 500);
  return c.json({
    workshops: (data ?? []).map((w: Record<string, unknown>) => ({
      id: w.id,
      code: w.code,
      name: w.name,
      registrationNo: w.registration_no ?? null,
      contactName: w.contact_name ?? null,
      contactPhone: w.contact_phone ?? null,
      officePhone: w.office_phone ?? null,
      email: w.email ?? null,
      address: w.address ?? null,
      notes: w.notes ?? null,
      isActive: w.is_active !== false,
    })),
  });
});

fleetMaintenance.post("/workshops", requireHouzsPerm("fleet.write"), async (c) => {
  const sb = c.get("supabase");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const name = String(body.name ?? "").trim();
  if (!name) return c.json({ error: "name_required" }, 400);

  const companyId = activeCompanyId(c) ?? null;
  const row = {
    company_id: companyId,
    name,
    registration_no: (body.registrationNo as string)?.trim() || null,
    contact_name: (body.contactName as string)?.trim() || null,
    contact_phone: (body.contactPhone as string)?.trim() || null,
    office_phone: (body.officePhone as string)?.trim() || null,
    email: (body.email as string)?.trim() || null,
    address: (body.address as string)?.trim() || null,
    notes: (body.notes as string)?.trim() || null,
  };

  /* Retry the MINT, not the whole create: the only thing that can race is the
     code, and re-reading the highest is exactly what resolves it. */
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = await mintWorkshopCode(sb, companyId);
    const { data, error } = await sb.from("workshops").insert({ ...row, code }).select("id, code").single();
    if (!error) return c.json({ id: data?.id, code: data?.code }, 201);
    if (error.code !== "23505") return c.json({ error: "insert_failed", reason: error.message }, 500);
    /* 23505 on the NAME or the SSM is the caller's problem, not a race — only a
       code collision is worth retrying. */
    if (!String(error.message ?? "").includes("workshops_code_uq")) {
      return c.json({ error: "duplicate_workshop", reason: error.message }, 409);
    }
  }
  return c.json({ error: "code_mint_failed", reason: "could not allocate a workshop code" }, 500);
});

fleetMaintenance.patch("/workshops/:id", requireHouzsPerm("fleet.write"), async (c) => {
  const sb = c.get("supabase");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, col] of [
    ["name", "name"], ["registrationNo", "registration_no"], ["contactName", "contact_name"],
    ["contactPhone", "contact_phone"], ["officePhone", "office_phone"], ["email", "email"],
    ["address", "address"], ["notes", "notes"],
  ] as const) {
    if (k in body) patch[col] = (body[k] as string)?.trim() || null;
  }
  if ("isActive" in body) patch.is_active = Boolean(body.isActive);
  /* `code` is minted, never edited — the whole point of generating it. */
  if (patch.name === null) return c.json({ error: "name_required" }, 400);

  /* Same malformed-filter fix as the list above: `.eq("company_id", null)`
     matched nothing, so an unresolved company turned every edit into a phantom
     "workshop_not_found" 404 over a row that exists. */
  const { data, error } = await scopeToCompany(
    sb.from("workshops").update(patch).eq("id", c.req.param("id")), c,
  ).select("id").maybeSingle();
  if (error) {
    if (error.code === "23505") return c.json({ error: "duplicate_workshop", reason: error.message }, 409);
    return c.json({ error: "update_failed", reason: error.message }, 500);
  }
  if (!data) return c.json({ error: "workshop_not_found" }, 404);
  return c.json({ id: data.id });
});

export default fleetMaintenance;
