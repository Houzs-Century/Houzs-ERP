// ----------------------------------------------------------------------------
// Fleet Maintenance & Compliance — Phase 1 pure logic.
//
// Two pure, env-free concerns live here so they can be unit-tested without a DB
// and reused identically by the API and (via the wire payload) the frontend:
//
//   1. reminderLevel()      — the escalating compliance expiry bucketing.
//   2. deriveVehicleStatus() — the vehicle status STATE MACHINE. Status is
//      DERIVED, never a manual dropdown (the one exception is the manual
//      out-of-service flag, which is an INPUT to the machine, not the status).
//
// Phase 1 derives status from three real inputs only: compliance (expired or a
// failed PUSPAKOM => blocked), the manual out-of-service flag, and a
// mileage/date-vs-next-service field. The richer inputs — open work orders,
// active breakdown cases — arrive in later phases; deriveVehicleStatus already
// ACCEPTS them (optional) so the seam is real code, not a future rewrite. In
// Phase 1 they are simply never supplied, so only AVAILABLE / SERVICE_DUE /
// COMPLIANCE_BLOCKED / OUT_OF_SERVICE are reachable.
// ----------------------------------------------------------------------------

/** The derived status state machine. NOT a manual dropdown. */
export type VehicleStatus =
  | "AVAILABLE"
  | "SERVICE_DUE"
  | "PLANNED_MAINTENANCE"
  | "WAITING_PARTS"
  | "BREAKDOWN"
  | "COMPLIANCE_BLOCKED"
  | "OUT_OF_SERVICE";

/** The compliance document kinds Phase 1 tracks in the vault. */
export type ComplianceDocType =
  | "PUSPAKOM"
  | "ROAD_TAX"
  | "INSURANCE"
  | "APAD"
  | "CROSS_BORDER";

export const COMPLIANCE_DOC_TYPES: readonly ComplianceDocType[] = [
  "PUSPAKOM",
  "ROAD_TAX",
  "INSURANCE",
  "APAD",
  "CROSS_BORDER",
] as const;

/** Human labels for the doc types (no emoji — house rule). */
export const COMPLIANCE_DOC_LABELS: Record<ComplianceDocType, string> = {
  PUSPAKOM: "PUSPAKOM inspection",
  ROAD_TAX: "Road Tax / LKM",
  INSURANCE: "Insurance",
  APAD: "APAD permit",
  CROSS_BORDER: "Cross-border permit",
};

/** PUSPAKOM inspection result. Only PUSPAKOM documents carry one. */
export type PuspakomResult = "PASS" | "FAIL";

/**
 * The escalating reminder ladder, worst-first-readable. Ordered from most to
 * least urgent so callers can compare or rank. The owner's ladder:
 *   60d prepare / 45d amber / 30d notify / 14d red / 7/3/1d escalate.
 * "ESCALATE" is the single bucket that owns the whole <=7 tail (7, 3, 1 and
 * every day between) — a per-day reminder is a scheduling detail for the later
 * notification phase, not a distinct visual state.
 */
export type ReminderLevel =
  | "EXPIRED"
  | "ESCALATE"
  | "RED"
  | "NOTIFY"
  | "AMBER"
  | "PREPARE"
  | "OK";

export const REMINDER_THRESHOLDS = {
  /** <= this many days out and not yet expired => ESCALATE (covers 7/3/1). */
  ESCALATE: 7,
  RED: 14,
  NOTIFY: 30,
  AMBER: 45,
  PREPARE: 60,
} as const;

/** How many km of remaining service life still counts as "service due soon". */
export const SERVICE_DUE_KM_THRESHOLD = 1000;
/** How many days before a date-based next-service still counts as due soon. */
export const SERVICE_DUE_DAYS_THRESHOLD = 14;

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole days from `today` to `date`, both YYYY-MM-DD (UTC midnight so DST and
 * the server's own timezone can never shift a compliance date by a day).
 * Positive = in the future, 0 = today, negative = past. Returns null for a
 * blank/malformed date so callers can treat "no date on file" distinctly from
 * "expires today".
 */
export function daysUntil(date: string | null | undefined, today: string): number | null {
  if (!date || !ISO_DATE.test(date.slice(0, 10))) return null;
  if (!ISO_DATE.test(today.slice(0, 10))) return null;
  const a = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / MS_PER_DAY);
}

/**
 * Map days-remaining to a reminder bucket. `null` (no expiry known) is treated
 * as OK — an absent document is a data-entry gap surfaced elsewhere, not an
 * expiry alarm.
 */
export function reminderLevel(daysRemaining: number | null): ReminderLevel {
  if (daysRemaining === null) return "OK";
  if (daysRemaining < 0) return "EXPIRED";
  if (daysRemaining <= REMINDER_THRESHOLDS.ESCALATE) return "ESCALATE";
  if (daysRemaining <= REMINDER_THRESHOLDS.RED) return "RED";
  if (daysRemaining <= REMINDER_THRESHOLDS.NOTIFY) return "NOTIFY";
  if (daysRemaining <= REMINDER_THRESHOLDS.AMBER) return "AMBER";
  if (daysRemaining <= REMINDER_THRESHOLDS.PREPARE) return "PREPARE";
  return "OK";
}

/** A reminder level that the operator should act on (anything past PREPARE). */
export function isActionableReminder(level: ReminderLevel): boolean {
  return level !== "OK";
}

/** The three tone buckets the dashboard colours by. */
export function reminderTone(level: ReminderLevel): "crit" | "warn" | "ok" {
  if (level === "EXPIRED" || level === "ESCALATE" || level === "RED") return "crit";
  if (level === "NOTIFY" || level === "AMBER" || level === "PREPARE") return "warn";
  return "ok";
}

/** A single compliance document as the status machine needs to see it. */
export interface ComplianceDocInput {
  docType: ComplianceDocType;
  expiryDate: string | null;
  /** Only meaningful for PUSPAKOM. */
  result?: PuspakomResult | null;
}

/**
 * Is this document, taken as the CURRENT one for its type, blocking dispatch?
 * A document blocks when it is expired, or when it is a PUSPAKOM inspection
 * whose result is FAIL (failed inspection grounds the vehicle until a fresh
 * PASS row is appended, independent of the printed expiry).
 */
export function isComplianceBlocking(doc: ComplianceDocInput, today: string): boolean {
  if (doc.docType === "PUSPAKOM" && doc.result === "FAIL") return true;
  const d = daysUntil(doc.expiryDate, today);
  return d !== null && d < 0;
}

/**
 * Reduce an append-only history to the CURRENT document per type. Renewals are
 * new rows (never overwrites), so "current" is the latest-issued / latest-
 * expiring row for each doc type. Ties break on the later expiry, then on the
 * caller-provided order (newest first is the caller's job).
 */
export function currentDocsByType<T extends { docType: ComplianceDocType; expiryDate: string | null; issueDate?: string | null }>(
  docs: readonly T[],
): Map<ComplianceDocType, T> {
  const current = new Map<ComplianceDocType, T>();
  for (const doc of docs) {
    const held = current.get(doc.docType);
    if (!held) {
      current.set(doc.docType, doc);
      continue;
    }
    if (rank(doc) > rank(held)) current.set(doc.docType, doc);
  }
  return current;
}

function rank(doc: { expiryDate: string | null; issueDate?: string | null }): number {
  // Prefer the later expiry; fall back to issue date. Missing dates rank lowest
  // so a real dated renewal always beats a blank placeholder row.
  const e = doc.expiryDate && ISO_DATE.test(doc.expiryDate.slice(0, 10)) ? Date.parse(`${doc.expiryDate.slice(0, 10)}T00:00:00Z`) : -Infinity;
  const i = doc.issueDate && ISO_DATE.test(doc.issueDate.slice(0, 10)) ? Date.parse(`${doc.issueDate.slice(0, 10)}T00:00:00Z`) : -Infinity;
  return Math.max(e, i);
}

/** Everything the status machine consumes. Phase-1 fields are required-ish; the
 *  later-phase seams (openWorkOrder / breakdownActive) are optional and unset. */
export interface StatusInput {
  today: string;
  /** Manual "this vehicle is parked / sold / off the road" flag. */
  outOfService?: boolean;
  /** The CURRENT compliance documents (one per type — see currentDocsByType). */
  currentDocs?: readonly ComplianceDocInput[];
  currentMileageKm?: number | null;
  nextServiceKm?: number | null;
  nextServiceDate?: string | null;
  /** Phase 2: the vehicle's preventive-maintenance plans. Any active plan inside
   *  its due-soon window makes the vehicle SERVICE_DUE — the same status the
   *  legacy next-service target already produced (both paths are honoured). */
  plans?: readonly MaintenancePlanInput[];
  // ── later-phase seams (Phase 3+ inputs; unset until those modules land) ────
  /** An open work order's kind, once the work-order module lands. */
  openWorkOrder?: "PLANNED" | "WAITING_PARTS" | null;
  /** An active, unresolved breakdown case, once that module lands. */
  breakdownActive?: boolean;
}

/** Whether the vehicle is due (or overdue) for service on mileage OR date —
 *  from the legacy next-service target AND/OR any preventive-maintenance plan. */
export function isServiceDue(input: StatusInput): boolean {
  const { currentMileageKm, nextServiceKm, nextServiceDate, today } = input;
  if (
    typeof currentMileageKm === "number" &&
    typeof nextServiceKm === "number" &&
    currentMileageKm >= nextServiceKm - SERVICE_DUE_KM_THRESHOLD
  ) {
    return true;
  }
  const d = daysUntil(nextServiceDate ?? null, today);
  if (d !== null && d <= SERVICE_DUE_DAYS_THRESHOLD) return true;
  if (anyPlanDue(input.plans, currentMileageKm ?? null, today)) return true;
  return false;
}

/** Is any current compliance document blocking dispatch? */
export function isComplianceBlocked(input: StatusInput): boolean {
  return (input.currentDocs ?? []).some((doc) => isComplianceBlocking(doc, input.today));
}

/**
 * The Phase-1 status state machine. Highest-priority condition wins, in this
 * precedence:
 *
 *   OUT_OF_SERVICE      manual flag — the operator has parked it; overrides all.
 *   COMPLIANCE_BLOCKED  expired doc / failed PUSPAKOM — a legal bar on dispatch
 *                       (the owner's hard rule: expired => COMPLIANCE_BLOCKED).
 *   BREAKDOWN           (seam) active breakdown case.
 *   WAITING_PARTS       (seam) open work order stalled on parts.
 *   PLANNED_MAINTENANCE (seam) open scheduled work order.
 *   SERVICE_DUE         mileage/date within threshold of next service.
 *   AVAILABLE           none of the above.
 *
 * The three seam states are unreachable in Phase 1 (their inputs are never
 * supplied) but are wired so later phases add an INPUT, not a new branch here.
 */
export function deriveVehicleStatus(input: StatusInput): VehicleStatus {
  if (input.outOfService) return "OUT_OF_SERVICE";
  if (isComplianceBlocked(input)) return "COMPLIANCE_BLOCKED";
  if (input.breakdownActive) return "BREAKDOWN";
  if (input.openWorkOrder === "WAITING_PARTS") return "WAITING_PARTS";
  if (input.openWorkOrder === "PLANNED") return "PLANNED_MAINTENANCE";
  if (isServiceDue(input)) return "SERVICE_DUE";
  return "AVAILABLE";
}

/** A dispatch-blocked status cannot take a delivery run. */
export function canDispatch(status: VehicleStatus): boolean {
  return status === "AVAILABLE" || status === "SERVICE_DUE";
}

export const VEHICLE_STATUS_LABELS: Record<VehicleStatus, string> = {
  AVAILABLE: "Available",
  SERVICE_DUE: "Service Due Soon",
  PLANNED_MAINTENANCE: "Planned Maintenance",
  WAITING_PARTS: "Waiting Parts",
  BREAKDOWN: "Breakdown",
  COMPLIANCE_BLOCKED: "Compliance Blocked",
  OUT_OF_SERVICE: "Out of Service",
};

// ============================================================================
// Phase 2 — Preventive maintenance plans (per component) + mileage capture.
//
// Two more pure, env-free, unit-tested concerns, reused identically by the API
// and (via the wire payload) the frontend:
//
//   3. derivePlanDue()  — a plan is due on WHICHEVER comes first, km OR months.
//   4. assessMileageReading() — the daily-odometer guards (no rollback; an
//      abnormal jump is FLAGGED for review, never silently accepted).
//
// deriveVehicleStatus() now also consumes the plan set: any active plan inside
// its due-soon window makes the vehicle SERVICE_DUE, exactly as the legacy
// service-record next-service target already did (both paths still work).
// ============================================================================

/** The components a preventive-maintenance plan covers. CHECK in the migration
 *  mirrors this list; adding a component is an app change, not a schema one. */
export type PlanComponent =
  | "ENGINE_OIL"
  | "OIL_FILTER"
  | "GEARBOX_OIL"
  | "BRAKE_INSPECTION"
  | "BRAKE_PADS"
  | "TYRES"
  | "BATTERY"
  | "ALIGNMENT"
  | "AIRCON"
  | "SUSPENSION"
  | "COOLING_SYSTEM"
  | "PUSPAKOM_PREP";

export const PLAN_COMPONENTS: readonly PlanComponent[] = [
  "ENGINE_OIL",
  "OIL_FILTER",
  "GEARBOX_OIL",
  "BRAKE_INSPECTION",
  "BRAKE_PADS",
  "TYRES",
  "BATTERY",
  "ALIGNMENT",
  "AIRCON",
  "SUSPENSION",
  "COOLING_SYSTEM",
  "PUSPAKOM_PREP",
] as const;

/** Human labels for the plan components (no emoji — house rule). */
export const PLAN_COMPONENT_LABELS: Record<PlanComponent, string> = {
  ENGINE_OIL: "Engine oil",
  OIL_FILTER: "Oil + filter",
  GEARBOX_OIL: "Gearbox oil",
  BRAKE_INSPECTION: "Brake inspection",
  BRAKE_PADS: "Brake pads",
  TYRES: "Tyres",
  BATTERY: "Battery",
  ALIGNMENT: "Wheel alignment",
  AIRCON: "Air-conditioning",
  SUSPENSION: "Suspension",
  COOLING_SYSTEM: "Cooling system",
  PUSPAKOM_PREP: "PUSPAKOM prep",
};

/** The mileage reading's provenance. DAY_COMPLETE is the primary driver flow. */
export type MileageSource = "DAY_COMPLETE" | "MANUAL" | "SERVICE";
export const MILEAGE_SOURCES: readonly MileageSource[] = ["DAY_COMPLETE", "MANUAL", "SERVICE"] as const;

/**
 * A daily reading that jumps more than this many km PER DAY since the previous
 * reading is flagged for review (not rejected). A long-haul lorry runs a few
 * hundred km a day; four figures in one day is a data-entry finger-slip far more
 * often than a real distance, so it gets a human's eye before it moves a plan.
 * Per-day so a multi-day gap between readings scales the allowance.
 */
export const ABNORMAL_JUMP_KM_PER_DAY = 1500;

/** A preventive-maintenance plan as the due-derivation needs to see it. */
export interface MaintenancePlanInput {
  component: string;
  intervalKm?: number | null;
  intervalMonths?: number | null;
  lastDoneDate?: string | null;
  lastDoneKm?: number | null;
  active?: boolean | null;
}

/**
 * Add whole months to a YYYY-MM-DD date, clamping the day to the target month's
 * length so 2026-01-31 + 1 month is 2026-02-28, never a rolled-over March 3.
 * Returns null for a blank/malformed date or a non-positive month count.
 */
export function addMonths(date: string | null | undefined, months: number | null | undefined): string | null {
  if (!date || !ISO_DATE.test(date.slice(0, 10))) return null;
  if (typeof months !== "number" || !Number.isFinite(months) || months <= 0) return null;
  const [y, m, d] = date.slice(0, 10).split("-").map((n) => Number(n));
  const zeroBased = m - 1 + Math.trunc(months);
  const targetY = y + Math.floor(zeroBased / 12);
  const targetM = zeroBased % 12; // 0..11
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(targetY).padStart(4, "0")}-${String(targetM + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The next-due odometer for a plan: last-done km + interval km. Null when the
 *  plan has no km interval or was never done at a known odometer. */
export function planNextDueKm(plan: MaintenancePlanInput): number | null {
  if (typeof plan.intervalKm !== "number" || plan.intervalKm <= 0) return null;
  if (typeof plan.lastDoneKm !== "number" || plan.lastDoneKm < 0) return null;
  return plan.lastDoneKm + plan.intervalKm;
}

/** The next-due date for a plan: last-done date + interval months. Null when the
 *  plan has no month interval or was never done on a known date. */
export function planNextDueDate(plan: MaintenancePlanInput): string | null {
  return addMonths(plan.lastDoneDate ?? null, plan.intervalMonths ?? null);
}

/** The fully-derived due picture for one plan, WHICHEVER comes first (km OR
 *  months). `overdue` is past the target on either axis; `dueSoon` is within the
 *  threshold on either axis (and is therefore also true once overdue). */
export interface PlanDue {
  component: string;
  nextDueKm: number | null;
  nextDueDate: string | null;
  /** nextDueKm - currentKm; negative once past due. Null without both inputs. */
  kmRemaining: number | null;
  /** Whole days to nextDueDate; negative once past due. Null without a date. */
  daysRemaining: number | null;
  dueSoon: boolean;
  overdue: boolean;
  tone: "crit" | "warn" | "ok";
}

export function derivePlanDue(
  plan: MaintenancePlanInput,
  currentKm: number | null | undefined,
  today: string,
): PlanDue {
  const nextDueKm = planNextDueKm(plan);
  const nextDueDate = planNextDueDate(plan);
  const kmRemaining =
    nextDueKm !== null && typeof currentKm === "number" ? nextDueKm - currentKm : null;
  const daysRemaining = daysUntil(nextDueDate, today);

  const overdueKm = kmRemaining !== null && kmRemaining < 0;
  const overdueDate = daysRemaining !== null && daysRemaining < 0;
  const dueSoonKm = kmRemaining !== null && kmRemaining <= SERVICE_DUE_KM_THRESHOLD;
  const dueSoonDate = daysRemaining !== null && daysRemaining <= SERVICE_DUE_DAYS_THRESHOLD;

  const overdue = overdueKm || overdueDate;
  const dueSoon = dueSoonKm || dueSoonDate;
  return {
    component: plan.component,
    nextDueKm,
    nextDueDate,
    kmRemaining,
    daysRemaining,
    dueSoon,
    overdue,
    tone: overdue ? "crit" : dueSoon ? "warn" : "ok",
  };
}

/** Is ANY active plan within its due-soon window (or already overdue)? */
export function anyPlanDue(
  plans: readonly MaintenancePlanInput[] | undefined,
  currentKm: number | null | undefined,
  today: string,
): boolean {
  return (plans ?? []).some((p) => (p.active ?? true) && derivePlanDue(p, currentKm ?? null, today).dueSoon);
}

// ── Mileage capture guards ──────────────────────────────────────────────────

export type MileageVerdict = "OK" | "ROLLBACK" | "ABNORMAL_JUMP";

export interface MileageGuardInput {
  /** The odometer of the latest existing reading (null = first reading ever). */
  previousKm: number | null;
  /** Its date, so the abnormal-jump allowance can scale with the gap. */
  previousDate?: string | null;
  newKm: number;
  newDate: string;
  /** Override the per-day abnormal-jump allowance (defaults to the constant). */
  abnormalJumpKmPerDay?: number;
}

export interface MileageAssessment {
  verdict: MileageVerdict;
  /** ROLLBACK is rejected; OK and ABNORMAL_JUMP are accepted (the latter flagged). */
  accepted: boolean;
  /** Whether a human should review this reading (rollback or abnormal jump). */
  flagged: boolean;
  /** newKm - previousKm; null on a first-ever reading. */
  deltaKm: number | null;
  /** Whole days since the previous reading, floored at 1; null on first reading. */
  days: number | null;
}

/**
 * Classify a proposed odometer reading against the latest existing one. Rules:
 *   - A reading BELOW the previous odometer is a ROLLBACK — rejected (odometers
 *     do not run backwards; it is a wrong vehicle or a typo).
 *   - A reading that adds more than the per-day allowance (× the day gap) is an
 *     ABNORMAL_JUMP — accepted but FLAGGED for review, never silently taken.
 *   - The GPS trip distance is a separate cross-check the caller may show; it is
 *     NEVER substituted for the entered odometer here.
 */
export function assessMileageReading(input: MileageGuardInput): MileageAssessment {
  const { previousKm, newKm } = input;
  if (previousKm === null || previousKm === undefined) {
    return { verdict: "OK", accepted: true, flagged: false, deltaKm: null, days: null };
  }
  const deltaKm = newKm - previousKm;
  // Gap = newDate - previousDate. daysUntil(date, today) returns date - today,
  // so the new date is the `date` and the previous date is the `today` anchor.
  const gap = daysUntil(input.newDate, input.previousDate ?? "");
  const days = gap === null ? 1 : Math.max(1, gap);
  if (deltaKm < 0) {
    return { verdict: "ROLLBACK", accepted: false, flagged: true, deltaKm, days };
  }
  const perDay = input.abnormalJumpKmPerDay ?? ABNORMAL_JUMP_KM_PER_DAY;
  if (deltaKm > perDay * days) {
    return { verdict: "ABNORMAL_JUMP", accepted: true, flagged: true, deltaKm, days };
  }
  return { verdict: "OK", accepted: true, flagged: false, deltaKm, days };
}
