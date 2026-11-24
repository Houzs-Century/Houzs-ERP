/* HR · Leave calendar — a month wall-calendar of who is on leave, for the Leave
 * page's Calendar view. Built from the leave read the page already has (approved
 * team + own leave, plus pending shown dashed), so there is no extra fetch and
 * no backend change. Approved leave is what payroll acts on; pending is a
 * preview until a supervisor reviews it. */
import { useMemo, useState } from "react";
import { todayMY } from "../../vendor/shared/format";

export type CalEntry = { id: number; name: string; type: string; startDate: string; endDate: string; status: string };
type LeaveType = { value: string; label: string; paid: boolean };

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const pad2 = (n: number) => String(n).padStart(2, "0");
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TONE = new Map<string, string>([["ANNUAL_LEAVE", "bg-synced"], ["MEDICAL_LEAVE", "bg-time"], ["UNPAID_LEAVE", "bg-ink-muted"]]);
const SHORT = new Map<string, string>([["ANNUAL_LEAVE", "AL"], ["MEDICAL_LEAVE", "ML"], ["UNPAID_LEAVE", "UL"]]);
const toneOf = (t: string) => TONE.get(t) ?? "bg-ink-muted";
const shortOf = (t: string) => SHORT.get(t) ?? t;

export function LeaveCalendar({ entries, types }: { entries: CalEntry[]; types: LeaveType[] }) {
  const today = todayMY().slice(0, 10);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const todayDay = month === today.slice(0, 7) ? Number(today.slice(8, 10)) : -1;

  const byDay = useMemo(() => {
    const map = new Map<number, CalEntry[]>();
    for (const e of entries) {
      const cur = new Date(`${e.startDate}T00:00:00Z`);
      const end = new Date(`${e.endDate}T00:00:00Z`);
      while (cur <= end) {
        const iso = cur.toISOString().slice(0, 10);
        if (iso.slice(0, 7) === month) {
          const day = Number(iso.slice(8, 10));
          const arr = map.get(day) ?? [];
          arr.push(e);
          map.set(day, arr);
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }
    return map;
  }, [entries, month]);

  const shiftMonth = (by: number) => {
    const idx = y * 12 + (m - 1) + by;
    setMonth(`${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`);
  };

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const btn = "flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 disabled:opacity-40";

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-3 py-2.5">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => shiftMonth(-1)} className={btn} aria-label="Previous month">‹</button>
          <span className="min-w-[90px] text-center font-mono text-[13px] font-semibold text-ink">{month}</span>
          <button type="button" onClick={() => shiftMonth(1)} className={btn} aria-label="Next month">›</button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-[11px] text-ink-muted">
          {types.map((t) => <span key={t.value} className="flex items-center gap-1"><span className={cx("h-2.5 w-2.5 rounded-full", toneOf(t.value))} />{t.label}</span>)}
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full border border-dashed border-ink-muted" />Pending</span>
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-border-subtle bg-surface-2/50">
        {WD.map((w) => <div key={w} className="px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wide text-ink-muted">{w}</div>)}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          const list = d ? byDay.get(d) ?? [] : [];
          return (
            <div key={i} className={cx("min-h-[86px] border-b border-r border-border-subtle p-1.5", i % 7 === 6 && "border-r-0", !d && "bg-surface-2/30")}>
              {d && (
                <>
                  <div className={cx("mb-1 flex items-center gap-1 text-[11px] font-semibold", d === todayDay ? "text-primary-ink" : "text-ink-secondary")}>
                    {d}
                    {d === todayDay && <span className="rounded bg-primary-soft px-1 text-[9px] font-bold text-primary-ink">today</span>}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {list.slice(0, 4).map((e, j) => (
                      <span key={j} className={cx("flex items-center gap-1 truncate rounded px-1 py-0.5 text-[10px]", e.status === "PENDING" ? "border border-dashed border-border text-ink-muted" : "bg-bg text-ink")} title={`${e.name} · ${shortOf(e.type)}${e.status === "PENDING" ? " (pending)" : ""}`}>
                        <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", toneOf(e.type))} />
                        <span className="truncate">{e.name}</span>
                      </span>
                    ))}
                    {list.length > 4 && <span className="pl-1 text-[9px] text-ink-muted">+{list.length - 4} more</span>}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {entries.length === 0 && <div className="px-4 py-8 text-center text-[12px] text-ink-muted">No leave to show on the calendar yet.</div>}
    </section>
  );
}
