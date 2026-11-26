import { resolveWindow, shiftMonths } from "./mcp-quick";

export type Range = { from: string; to: string };
/** A question's window, the same length just before it, and the same days one month earlier. */
export type Period = Range & { period: string; label: string; prev: Range; lastMonth: Range };

export const PERIOD_NAMES = ["today", "week", "month", "last_month", "quarter", "year", "custom"] as const;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const plus = (d: string, n: number): string => day(Date.parse(d) + n * 86_400_000);
const span = (r: Range): number => Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000);
const monthEnd = (d: string): string => {
  const [y, m] = d.split("-").map(Number);
  return day(Date.UTC(y, m, 0));
};
const quarterStart = (d: string): string => {
  const m = Number(d.slice(5, 7));
  return `${d.slice(0, 4)}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
};
const sameLengthBefore = (r: Range): Range => ({ from: plus(r.from, -(span(r) + 1)), to: plus(r.from, -1) });
const monthBack = (r: Range): Range => ({ from: shiftMonths(r.from, 1), to: shiftMonths(r.to, 1) });

/**
 * The window a period-type tool reads, ending today at the latest (the
 * dashboards' rule: "month" = the 1st to today), with two comparisons:
 * `prev` = the same days of the previous period (month to date vs the same
 * days of last month; week vs the same weekdays of last week; quarter / year
 * to date vs the same days one quarter / year back; custom = the same length
 * just before) and `lastMonth` = the same dates one month earlier.
 * Also takes the older YYYY-MM / YYYY-Qn / YYYY form. Null when unreadable.
 */
export function resolvePeriod(args: { period?: unknown; from?: unknown; to?: unknown }, today: string): Period | null {
  const p = typeof args.period === "string" ? args.period.trim().toLowerCase() : "";
  const f = typeof args.from === "string" ? args.from.trim() : "";
  const t = typeof args.to === "string" ? args.to.trim() : "";
  const make = (period: string, label: string, r: Range, prev: Range): Period => ({ period, label, ...r, prev, lastMonth: monthBack(r) });
  if (p === "custom" || (!p && (f || t))) {
    if (!YMD.test(f) || !YMD.test(t) || f > t || t > today || span({ from: f, to: t }) > 400) return null;
    const r = { from: f, to: t };
    return make("custom", `${f}..${t}`, r, sameLengthBefore(r));
  }
  switch (p || "month") {
    case "today":
      return make("today", today, { from: today, to: today }, { from: plus(today, -1), to: plus(today, -1) });
    case "week": {
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
      const r = { from: plus(today, -dow), to: today };
      return make("week", `week from ${r.from}`, r, { from: plus(r.from, -7), to: plus(r.to, -7) });
    }
    case "month": {
      const r = { from: `${today.slice(0, 7)}-01`, to: today };
      return make("month", `${today.slice(0, 7)} to date`, r, monthBack(r));
    }
    case "last_month": {
      const from = shiftMonths(`${today.slice(0, 7)}-01`, 1);
      const r = { from, to: monthEnd(from) };
      const pf = shiftMonths(from, 1);
      return make("last_month", from.slice(0, 7), r, { from: pf, to: monthEnd(pf) });
    }
    case "quarter": {
      const r = { from: quarterStart(today), to: today };
      return make("quarter", `quarter from ${r.from} to date`, r, { from: shiftMonths(r.from, 3), to: shiftMonths(today, 3) });
    }
    case "year": {
      const r = { from: `${today.slice(0, 4)}-01-01`, to: today };
      return make("year", `${today.slice(0, 4)} to date`, r, { from: shiftMonths(r.from, 12), to: shiftMonths(today, 12) });
    }
    default: {
      const w = resolveWindow({ period: p.toUpperCase() }, today);
      if (!w) return null;
      return make(p.toUpperCase(), w.label, { from: w.from, to: w.to }, w.prev);
    }
  }
}

export const BAD_PERIOD = "Give period as today, week, month, last_month, quarter or year (or YYYY-MM / YYYY-Qn / YYYY), or period custom with from and to as YYYY-MM-DD (not in the future, at most 400 days).";

/** The JSON-schema properties every period-type tool takes. */
export const PERIOD_SCHEMA = {
  period: { type: "string", description: "today | week | month (default, the 1st to today) | last_month | quarter | year | custom (with from / to). YYYY-MM, YYYY-Qn or YYYY also work." },
  from: { type: "string", description: "YYYY-MM-DD, with period custom" },
  to: { type: "string", description: "YYYY-MM-DD, with period custom" },
};

/** Percent change, 1 dp; null when there is nothing to compare with. */
export function change(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}
