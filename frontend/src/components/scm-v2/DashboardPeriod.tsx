// The one period control every dashboard uses (owner, 2026-10-17: "跟 Hookka
// 一样"). It follows the Hookka dashboard's rule — "This month" is the 1st to
// today, and a past month is its 1st to its last day — and adds This quarter,
// This year and a date range of your own. No half-year.
//
// The period lives in the URL (?from=&to=, or the page's own keys) so a
// dashboard link opens on the same window; with nothing in the URL a dashboard
// opens on This month.
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DateField } from "../../vendor/scm/components/DateField";
import { SELECT_CLS } from "./OverviewKit";

export interface Period { key: string; label: string; from: string; to: string }

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export type PeriodGroup = "upToToday" | "quarter" | "year" | "month";
export interface PresetPeriod extends Period { group: PeriodGroup }

/** The presets. "Up to today": this month, this quarter and this year, each
 *  from its first day to today — a window that would only repeat an earlier one
 *  (this quarter in its first month, this year in January) is left out, so
 *  choosing it can never look like nothing happened; the last whole quarter
 *  stands in until it is worth showing. Then the four whole quarters and two
 *  whole years before this one, and the eleven whole months before this one. */
export function dashboardPeriods(today: string): PresetPeriod[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const q = Math.ceil(m / 3);
  const out: PresetPeriod[] = [];
  const add = (p: PresetPeriod) => { if (!out.some((o) => o.from === p.from && o.to === p.to)) out.push(p); };
  add({ group: "upToToday", key: "month", label: `This month (${today.slice(0, 7)})`, from: `${y}-${pad(m)}-01`, to: today });
  add({ group: "upToToday", key: "quarter", label: `This quarter (Q${q} ${y})`, from: `${y}-${pad((q - 1) * 3 + 1)}-01`, to: today });
  add({ group: "upToToday", key: "year", label: `This year (${y})`, from: `${y}-01-01`, to: today });
  for (let i = 1; i <= 4; i++) {
    const qi = q - i; const yy = y + Math.floor((qi - 1) / 4); const qq = ((qi - 1) % 4 + 4) % 4 + 1;
    const m1 = (qq - 1) * 3 + 1;
    add({ group: "quarter", key: `Q${qq}-${yy}`, label: `${i === 1 ? "Last quarter · " : ""}Q${qq} ${yy}`, from: `${yy}-${pad(m1)}-01`, to: `${yy}-${pad(m1 + 2)}-${pad(lastDay(yy, m1 + 2))}` });
  }
  for (let i = 1; i <= 2; i++) add({ group: "year", key: `Y${y - i}`, label: `${i === 1 ? "Last year · " : ""}${y - i}`, from: `${y - i}-01-01`, to: `${y - i}-12-31` });
  for (let i = 1; i <= 11; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const yy = d.getUTCFullYear(); const mm = d.getUTCMonth() + 1;
    add({ group: "month", key: `${yy}-${pad(mm)}`, label: `${i === 1 ? "Last month · " : ""}${yy}-${pad(mm)}`, from: `${yy}-${pad(mm)}-01`, to: `${yy}-${pad(mm)}-${pad(lastDay(yy, mm))}` });
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The period a from / to pair names: a preset when it matches one, else a
 *  custom range; This month when either end is missing or not a date. */
export function resolvePeriod(from: string | null, to: string | null, today: string): Period {
  const presets = dashboardPeriods(today);
  if (!from || !to || !ISO.test(from) || !ISO.test(to)) return presets[0]!;
  const [a, b] = from <= to ? [from, to] : [to, from];
  return presets.find((p) => p.from === a && p.to === b) ?? { key: "custom", label: `${a} – ${b}`, from: a, to: b };
}

/** The period held in the URL under `fromKey` / `toKey`, and its setter. A
 *  change of period also clears `alsoClear` (e.g. an open drill-down that may
 *  not exist in the new window). */
export function useDashboardPeriod(today: string, fromKey: string, toKey: string, alsoClear: string[]) {
  const [params, setParams] = useSearchParams();
  const period = resolvePeriod(params.get(fromKey), params.get(toKey), today);
  const setPeriod = (from: string, to: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set(fromKey, from); next.set(toKey, to);
    for (const k of alsoClear) next.delete(k);
    return next;
  }, { replace: true });
  return [period, setPeriod] as const;
}

/** The picker: one dropdown of presets plus "Date range…", which shows the two
 *  dates beside it. */
export function DashboardPeriodPicker({ period, today, onChange }: { period: Period; today: string; onChange: (from: string, to: string) => void }) {
  const presets = dashboardPeriods(today);
  /* Choosing "Date range…" opens the two dates on the current window; until
     one is changed that window still matches a preset, so the choice is held
     here rather than read back from the URL. */
  const [rangeOpen, setRangeOpen] = useState(false);
  const custom = period.key === "custom" || rangeOpen;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={SELECT_CLS}
        aria-label="Period"
        value={custom ? "custom" : period.key}
        onChange={(e) => {
          if (e.target.value === "custom") { setRangeOpen(true); return; }
          setRangeOpen(false);
          const p = presets.find((x) => x.key === e.target.value);
          if (p) onChange(p.from, p.to);
        }}
      >
        {([["upToToday", "Up to today"], ["quarter", "Whole quarter"], ["year", "Whole year"], ["month", "Whole month"]] as const).map(([g, label]) => (
          <optgroup key={g} label={label}>
            {presets.filter((p) => p.group === g).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </optgroup>
        ))}
        <option value="custom">{period.key === "custom" ? `Date range (${period.from} – ${period.to})` : "Date range…"}</option>
      </select>
      {custom && (
        <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
          <DateField value={period.from} max={period.to} onChange={(v) => v && onChange(v, period.to)} aria-label="From"
            className="h-8 w-[118px] rounded-md border border-border bg-surface px-2 text-[12px]" />
          to
          <DateField value={period.to} min={period.from} onChange={(v) => v && onChange(period.from, v)} aria-label="To"
            className="h-8 w-[118px] rounded-md border border-border bg-surface px-2 text-[12px]" />
        </span>
      )}
    </div>
  );
}
