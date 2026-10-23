// The Delivery Order list's date window (HC-0151). The column funnels on Doc
// Date / Delivery Date only see the loaded page, so Finance could not pull one
// month's DOs. This chip sends `from` / `to` / `dateBy` to the server, so the
// pager, the total and the Export all run over the whole window.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Calendar, ChevronDown } from "lucide-react";
import { fmtDate } from "@2990s/shared";
import { DateField } from "../../vendor/scm/components/DateField";
import { soTodayYmd } from "../../vendor/shared/so-list-filter-model";
import type { DoDateBy } from "../../vendor/scm/lib/delivery-order-queries";
import { cn } from "../../lib/utils";

const PANEL_W = 280;

export const DO_DATE_BY_LABEL: Record<DoDateBy, string> = { delivery: "Delivery date", do: "Doc date" };

/** First and last day of a `YYYY-MM` month, as ISO days. */
export function monthBounds(ym: string): { from: string; to: string } {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}

function shiftMonth(ym: string, by: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The last two years of months, newest first, plus `keep` when it is older. */
export function monthOptions(thisMonth: string, keep: string): string[] {
  const out = Array.from({ length: 24 }, (_, i) => shiftMonth(thisMonth, -i));
  if (keep && !out.includes(keep)) out.push(keep);
  return out;
}

export function DoDateFilter({
  from,
  to,
  dateBy,
  onChange,
}: {
  from: string;
  to: string;
  dateBy: DoDateBy;
  onChange: (next: { from: string; to: string; dateBy: DoDateBy }) => void;
}) {
  const [open, setOpen] = useState(false);
  // The chip ends the status row on desktop but starts it on a phone, so the
  // panel opens toward whichever side has room.
  const [alignRight, setAlignRight] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Re-measured on every change: a new label can wrap the chip onto its own row.
  useLayoutEffect(() => {
    const r = boxRef.current?.getBoundingClientRect();
    if (open && r) setAlignRight(r.left + PANEL_W > document.documentElement.clientWidth - 8);
  }, [open, from, to, dateBy]);

  const active = !!(from || to);
  const thisMonth = soTodayYmd(new Date()).slice(0, 7);
  // The month input shows a month only when the window is exactly one.
  const monthValue = from && to && monthBounds(from.slice(0, 7)).to === to && from.endsWith("-01") ? from.slice(0, 7) : "";
  const fmt = (d: string) => (d ? fmtDate(d) : "…");
  const setMonth = (ym: string) => { if (ym) onChange({ ...monthBounds(ym), dateBy }); };
  const quick = "rounded-md border border-border px-2 py-1 text-[11.5px] font-semibold text-ink-secondary hover:border-primary/60 hover:text-primary";

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 max-w-[320px] items-center gap-1.5 rounded-md border bg-surface px-2.5 text-[12px]",
          active ? "border-primary/50 bg-primary-soft font-semibold text-primary-ink" : "border-border text-ink-secondary",
        )}
      >
        <Calendar size={13} className="shrink-0 opacity-70" />
        <span className="truncate">
          {active ? `${DO_DATE_BY_LABEL[dateBy]}: ${fmt(from)} – ${fmt(to)}` : "All dates"}
        </span>
        <ChevronDown size={13} className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div role="dialog" aria-label="Date filter" style={{ width: PANEL_W }} className={cn("absolute top-9 z-30 rounded-md border border-border bg-surface p-3 shadow-lg", alignRight ? "right-0" : "left-0")}>
          <div className="mb-2 flex items-center justify-between border-b border-border-subtle pb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">Filter by date</span>
            {active && (
              <button type="button" onClick={() => onChange({ from: "", to: "", dateBy })} className="text-[10.5px] font-semibold text-ink-secondary hover:text-err">
                Clear
              </button>
            )}
          </div>
          <div className="mb-2.5 grid grid-cols-2 gap-1 rounded-md bg-surface-2 p-0.5" role="radiogroup" aria-label="Date to filter on">
            {(["delivery", "do"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={dateBy === k}
                onClick={() => onChange({ from, to, dateBy: k })}
                className={cn(
                  "rounded px-2 py-1 text-[11.5px] font-semibold",
                  dateBy === k ? "bg-surface text-primary-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                )}
              >
                {DO_DATE_BY_LABEL[k]}
              </button>
            ))}
          </div>
          <label className="mb-2 block text-[11px] font-semibold text-ink-secondary">
            Month
            {/* Numeric yyyy/mm, not the native month box: that spells month names. */}
            <select
              value={monthValue}
              onChange={(e) => setMonth(e.target.value)}
              className="mt-0.5 block w-full rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-ink"
            >
              <option value="">{monthValue ? "" : "Pick a month"}</option>
              {monthOptions(thisMonth, monthValue).map((ym) => (
                <option key={ym} value={ym}>{ym.replace("-", "/")}</option>
              ))}
            </select>
          </label>
          <div className="mb-2.5 flex gap-1.5">
            <button type="button" className={quick} onClick={() => setMonth(thisMonth)}>This month</button>
            <button type="button" className={quick} onClick={() => setMonth(shiftMonth(thisMonth, -1))}>Last month</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[11px] font-semibold text-ink-secondary">
              From
              <DateField
                fullWidth
                value={from}
                max={to || undefined}
                onChange={(iso) => onChange({ from: iso, to, dateBy })}
                className="mt-0.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-[12px]"
              />
            </label>
            <label className="block text-[11px] font-semibold text-ink-secondary">
              To
              <DateField
                fullWidth
                value={to}
                min={from || undefined}
                onChange={(iso) => onChange({ from, to: iso, dateBy })}
                className="mt-0.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-[12px]"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
