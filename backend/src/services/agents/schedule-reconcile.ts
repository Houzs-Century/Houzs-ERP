
export interface SchedEvent {
  venue: string;
  startDate: string | null;
  endDate: string | null;
  status?: string | null;
}
export interface SchedExtract {
  organizer: string;
  events: SchedEvent[];
}
export interface ProjRow {
  id: number;
  code: string;
  name: string;
  venue: string;
  startDate: string | null;
  endDate: string | null;
  stage: string;
}
export type ReconcileStatus = "MATCH" | "DATE_CHANGED" | "NEW" | "MISSING";
export interface ReconcileRow {
  venue: string;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  scheduleStatus: string | null;
  status: ReconcileStatus;
  project: ProjRow | null;
}

/** Normalise a date to YYYY-MM-DD. Accepts YYYY-MM-DD, DD/MM/YYYY, D/M/YY(YY).
 *  Returns null when unparseable / blank. Deterministic, no clock. */
export function normDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const s = String(d).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

const canon = (v: string | null | undefined): string =>
  String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Venue names match when one canonicalised name contains the other (photos and
 *  masters truncate/abbreviate differently). Empty never matches. */
export function venueMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = canon(a), y = canon(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

const DONE_STAGES = new Set(["cancelled", "closed", "teardown"]);

/** Diff an organizer's OCR'd schedule against its projects. `projects` must
 *  already be scoped to the same organizer + company by the caller. */
export function reconcileSchedule(extract: SchedExtract, projects: readonly ProjRow[]): ReconcileRow[] {
  const used = new Set<number>();
  const rows: ReconcileRow[] = [];

  for (const ev of extract.events) {
    const sStart = normDate(ev.startDate);
    const sEnd = normDate(ev.endDate);
    const cand = projects.find((p) => !used.has(p.id) && venueMatch(p.venue, ev.venue)) ?? null;
    if (!cand) {
      rows.push({ venue: ev.venue, scheduleStart: sStart, scheduleEnd: sEnd, scheduleStatus: ev.status ?? null, status: "NEW", project: null });
      continue;
    }
    used.add(cand.id);
    const pStart = normDate(cand.startDate);
    const pEnd = normDate(cand.endDate);
    const changed = (!!sStart && sStart !== pStart) || (!!sEnd && sEnd !== pEnd);
    rows.push({
      venue: ev.venue, scheduleStart: sStart, scheduleEnd: sEnd, scheduleStatus: ev.status ?? null,
      status: changed ? "DATE_CHANGED" : "MATCH", project: cand,
    });
  }

  for (const p of projects) {
    if (used.has(p.id)) continue;
    if (DONE_STAGES.has(String(p.stage).toLowerCase())) continue;
    rows.push({ venue: p.venue, scheduleStart: null, scheduleEnd: null, scheduleStatus: null, status: "MISSING", project: p });
  }

  return rows;
}
