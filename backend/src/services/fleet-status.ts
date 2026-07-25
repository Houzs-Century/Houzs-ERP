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
  // ── later-phase seams (Phase 2+ inputs; unset in Phase 1) ──────────────────
  /** An open work order's kind, once the work-order module lands. */
  openWorkOrder?: "PLANNED" | "WAITING_PARTS" | null;
  /** An active, unresolved breakdown case, once that module lands. */
  breakdownActive?: boolean;
}

/** Whether the vehicle is due (or overdue) for service on mileage OR date. */
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
