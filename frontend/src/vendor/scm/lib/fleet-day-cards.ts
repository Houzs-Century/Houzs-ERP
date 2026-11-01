// ----------------------------------------------------------------------------
// fleet-day-cards — the PURE view-model for the redesigned office Last Mile
// Delivery page (FleetDay.tsx, the lorry-card board). Everything the cards, the
// stat strip, the filter row and the late pill derive is here so it is testable
// without a browser and cannot drift between desktop and mobile.
//
// (Named -cards to sit beside the older fleet-day-model.ts, which owns the day
// MAP's route/label helpers — a separate concern.)
//
// A lorry card = one run + the drops whose trip_id points at it, each drop's
// live status taken from the SHARED stop-status rule (delivery-stop-status.ts),
// never re-derived here. "Late" is exactly that rule's `overdue` state — the
// owner's non-ETA definition (2026-11-01): not delivered AND (past its slot end,
// or not yet out and its day has passed). The ETA-based clauses wait for a live
// ETA + planned-departure column (phase 2/3); see fleet-day-cards.test.ts.
// ----------------------------------------------------------------------------
import type { StopStatus } from './delivery-stop-status';

/* ── Time slot ────────────────────────────────────────────────────────────
   The DO's `time_range` is free text. The owner's canonical windows are
   AM 9:00–12:00 and PM 2:00–6:00; anything else the dispatcher typed (e.g.
   "10 AM–1 PM") is a CUSTOM slot shown verbatim. null when no slot is set. */
export type SlotKind = 'AM' | 'PM' | 'CUSTOM';

const AM_END = 12 * 60; // 12:00
const PM_START = 12 * 60; // 12:00 — a window that STARTS at/after noon is PM.

/** Minutes-after-midnight for one clock token ("9", "09:00", "2pm", "13.30"),
 *  carrying an am/pm hint from elsewhere in the range when the token has none. */
function clockMinutes(token: string, apHint: 'am' | 'pm' | null): number | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(token.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3] || apHint;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Split a free-text range into its start/end minute pair (null end for a
 *  one-sided value like "3pm"). */
export function slotMinutes(timeRange: string | null | undefined): { start: number | null; end: number | null } {
  if (!timeRange) return { start: null, end: null };
  const s = timeRange.toLowerCase();
  const parts = s.split(/\s*(?:-|–|—|to)\s*/).filter(Boolean);
  const apOf = (str: string): 'am' | 'pm' | null => (/(am|pm)/.exec(str)?.[1] as 'am' | 'pm' | undefined) ?? null;
  const hint = apOf(s);
  const start = parts.length > 0 ? clockMinutes(parts[0]!, hint) : null;
  const end = parts.length > 1 ? clockMinutes(parts[parts.length - 1]!, hint) : null;
  return { start, end };
}

/** Which slot bucket a `time_range` falls in — the AM/PM segmented filter's key.
 *  null when no slot is set. A slot that resolves to neither canonical window
 *  (or that cannot be parsed but is non-empty) is CUSTOM. */
export function slotKindOf(timeRange: string | null | undefined): SlotKind | null {
  if (!timeRange || !timeRange.trim()) return null;
  const t = timeRange.trim().toLowerCase();
  if (t === 'am') return 'AM';
  if (t === 'pm') return 'PM';
  const { start, end } = slotMinutes(timeRange);
  // AM only for an ascending morning window (so an ambiguous "11-2" — read as
  // 11:00 then 2:00 — is not mislabelled AM; it falls through to CUSTOM).
  if (end != null && end <= AM_END && (start == null || start < end)) return 'AM';
  if (start != null && start >= PM_START) return 'PM';
  return 'CUSTOM';
}

/** The short tag the doc row shows: "AM" / "PM" / the raw custom window. "" when
 *  no slot is set. */
export function slotLabelOf(timeRange: string | null | undefined): string {
  const kind = slotKindOf(timeRange);
  if (kind == null) return '';
  if (kind === 'CUSTOM') return (timeRange ?? '').trim();
  return kind;
}

/* ── Lorry run status ─────────────────────────────────────────────────────
   Not departed = no stop started · On the way = any stop started, not all done
   · Completed = every drop delivered. A "started" stop is the stop-status rule's
   `active` or `done`. An empty run (a trip with no drops yet) is Not departed. */
export type RunStatus = 'NOT_DEPARTED' | 'ON_THE_WAY' | 'COMPLETED';

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  NOT_DEPARTED: 'Not departed',
  ON_THE_WAY: 'On the way',
  COMPLETED: 'Completed',
};

export function runStatusOf(stopStatuses: readonly StopStatus[]): RunStatus {
  if (stopStatuses.length === 0) return 'NOT_DEPARTED';
  if (stopStatuses.every((s) => s === 'done')) return 'COMPLETED';
  if (stopStatuses.some((s) => s === 'active' || s === 'done')) return 'ON_THE_WAY';
  return 'NOT_DEPARTED';
}

/* ── Late ──────────────────────────────────────────────────────────────────
   A drop is late exactly when the shared stop-status rule says `overdue` — the
   owner's non-ETA definition. The pill needs a short reason. */
export function isLate(status: StopStatus): boolean {
  return status === 'overdue';
}

/** A one-line reason for the late pill, or null when the drop is not late.
 *  `day`/`today` are YYYY-MM-DD; `slotEnd` is minutes-after-midnight (null when
 *  the slot has no readable end). */
export function lateReason(
  status: StopStatus,
  when: { day: string; today: string; slotEnd: number | null },
): string | null {
  if (status !== 'overdue') return null;
  if (when.day < when.today) return 'Not delivered — its day has passed';
  if (when.slotEnd != null) {
    const hh = Math.floor(when.slotEnd / 60);
    const mm = when.slotEnd % 60;
    const ap = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh + 11) % 12) + 1;
    return `Past its ${h12}:${String(mm).padStart(2, '0')} ${ap} slot`;
  }
  return 'Past its delivery window';
}

/* ── Stat strip ────────────────────────────────────────────────────────────
   The day KPIs. POD rate = delivered drops with real POD evidence ÷ all drops;
   the per-run `with_pod` already counts only real evidence, so pass it through. */
export type DayStats = {
  lorries: number;
  drops: number;
  delivered: number;
  onTheWay: number;
  late: number;
  totalSen: number;
  withPod: number;
  /** 0–100, rounded; null when there are no drops (nothing to rate). */
  podRatePct: number | null;
};

export type RunRollup = {
  drops: number;
  delivered: number;
  onTheWay: number;
  late: number;
  totalSen: number;
  withPod: number;
};

/** Fold a run's drop statuses + a POD count into its rollup. */
export function rollupRun(
  stopStatuses: readonly StopStatus[],
  totalSen: number,
  withPod: number,
): RunRollup {
  let delivered = 0; let onTheWay = 0; let late = 0;
  for (const s of stopStatuses) {
    if (s === 'done') delivered += 1;
    else if (s === 'active') onTheWay += 1;
    else if (s === 'overdue') late += 1;
  }
  return { drops: stopStatuses.length, delivered, onTheWay, late, totalSen, withPod };
}

/** Sum run rollups into the day's stat strip. */
export function dayStatsFrom(runs: readonly RunRollup[]): DayStats {
  const z: DayStats = { lorries: runs.length, drops: 0, delivered: 0, onTheWay: 0, late: 0, totalSen: 0, withPod: 0, podRatePct: null };
  for (const r of runs) {
    z.drops += r.drops; z.delivered += r.delivered; z.onTheWay += r.onTheWay;
    z.late += r.late; z.totalSen += r.totalSen; z.withPod += r.withPod;
  }
  z.podRatePct = z.drops > 0 ? Math.round((z.withPod / z.drops) * 100) : null;
  return z;
}

/* ── Progress bar ──────────────────────────────────────────────────────────*/
export function progressPct(delivered: number, drops: number): number {
  if (drops <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((delivered / drops) * 100)));
}

/* ── Departure delay (phase 2) ─────────────────────────────────────────────
   Planned departure (trips.planned_depart_at) vs actual (clock_in_at, falling
   back to the first drop's on-the-way stamp). A run that left more than 15 min
   after its planned time is flagged red (owner 2026-11-01). Both ISO; the delta
   is whole minutes, positive = late; null when either side is missing. */
export const DEPART_LATE_MIN = 15;

export function departureDeltaMin(plannedIso: string | null | undefined, actualIso: string | null | undefined): number | null {
  if (!plannedIso || !actualIso) return null;
  const p = Date.parse(plannedIso);
  const a = Date.parse(actualIso);
  if (Number.isNaN(p) || Number.isNaN(a)) return null;
  return Math.round((a - p) / 60000);
}

export function isDepartLate(deltaMin: number | null): boolean {
  return deltaMin != null && deltaMin > DEPART_LATE_MIN;
}
