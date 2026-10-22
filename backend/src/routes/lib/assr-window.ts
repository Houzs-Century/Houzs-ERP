/* The Quality Overview's period (owner, 2026-10-17: every dashboard takes this
   month / quarter / year or a date range). ?from=&to= (YYYY-MM-DD) win when both
   are valid; otherwise the older ?since_days= (last N days, default 90) still
   works, unchanged, for any caller that sends it.

   The dates are validated against a strict pattern before they reach SQL, so
   interpolating them is safe; the column expression is always one of ours. */
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface AssrWindow {
  /** Days in the window, for the "N days" captions. */
  days: number;
  from: string | null;
  to: string | null;
  /** SQL that keeps `col` inside the window. */
  sql: (col: string) => string;
}

export function assrWindow(q: { from?: string; to?: string; since_days?: string }): AssrWindow {
  const from = q.from && ISO.test(q.from) ? q.from : null;
  const to = q.to && ISO.test(q.to) ? q.to : null;
  if (from && to && from <= to) {
    const toExcl = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const days = Math.round((Date.parse(`${toExcl}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
    return { days, from, to, sql: (col) => `${col} >= '${from}' AND ${col} < '${toExcl}'` };
  }
  const days = Math.min(730, Math.max(1, parseInt(q.since_days || "90", 10) || 90));
  return { days, from: null, to: null, sql: (col) => `${col} >= date('now', '-${days} days')` };
}
