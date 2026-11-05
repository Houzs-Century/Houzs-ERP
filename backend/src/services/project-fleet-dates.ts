// A confirmed PMS project only reaches the Delivery Planning board once it has a
// setup / dismantle date (that is the fleet commitment the board mirrors). Owner
// 2026-10-31: on confirm, derive those from the event window so the project shows
// without re-keying the dates — setup = event start - 1 day, dismantle = event
// end + 1 day (the dominant convention in the existing data: ~253 projects at -1
// and ~203 at +1). Pure + fill-only + confirmed-only, so it mirrors exactly what
// the board shows and never fights a hand-set date.
import type { Env } from "../types";

/** Shift a YYYY-MM-DD (or YYYY-MM-DDThh:mm) date string by `days`, returning
 *  YYYY-MM-DD, or null when the input is empty / unparseable. UTC math so a plain
 *  calendar date never drifts a day across a timezone. */
export function shiftYmd(value: string | null | undefined, days: number): string | null {
  if (!value) return null;
  const ymd = String(value).slice(0, 10);
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

export type ProjectFleetDateInput = {
  status: string | null;
  archived_at: string | null;
  start_date: string | null;
  end_date: string | null;
  setup_start_at: string | null;
  dismantle_start_at: string | null;
};

/** The setup / dismantle dates a project should be given from its event window,
 *  or an empty object when there is nothing to fill. Only a CONFIRMED, non-archived
 *  project qualifies (a pending or cancelled one gets nothing, matching the board),
 *  and each date is filled only when it is empty and its source date exists — a
 *  value the operator set by hand is never overwritten. */
export function deriveProjectFleetDates(p: ProjectFleetDateInput): {
  setup_start_at?: string;
  dismantle_start_at?: string;
} {
  const out: { setup_start_at?: string; dismantle_start_at?: string } = {};
  if (p.status !== 'confirmed' || p.archived_at) return out;
  if (!p.setup_start_at) {
    const d = shiftYmd(p.start_date, -1);
    if (d) out.setup_start_at = d;
  }
  if (!p.dismantle_start_at) {
    const d = shiftYmd(p.end_date, 1);
    if (d) out.dismantle_start_at = d;
  }
  return out;
}

/** Read a project back and, when confirming has made it eligible, fill its setup /
 *  dismantle dates from the event window (see deriveProjectFleetDates). A no-op
 *  when there is nothing to fill. Called from patchProject after the main write,
 *  only when the patch touched status / start_date / end_date. */
export async function applyProjectFleetDates(env: Env, id: number): Promise<void> {
  const cur = await env.DB.prepare(
    `SELECT status, archived_at, start_date, end_date, setup_start_at, dismantle_start_at
       FROM projects WHERE id = ?`
  )
    .bind(id)
    .first<ProjectFleetDateInput>();
  const fill = cur ? deriveProjectFleetDates(cur) : {};
  const cols = Object.keys(fill) as Array<keyof typeof fill>;
  if (!cols.length) return;
  await env.DB.prepare(
    `UPDATE projects SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(...cols.map((k) => fill[k]), id)
    .run();
}
