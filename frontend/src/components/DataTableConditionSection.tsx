import { useState } from "react";
import { cn } from "../lib/utils";
import { DATE_PRESETS, type Condition } from "./dataTableConditionFilters";

/**
 * The top of a date or number column's funnel: presets and a from/to range for
 * dates, a min/max for numbers. One condition per column; the value checklist
 * below still narrows further (both must hold).
 */
export function DataTableConditionSection({
  filterType,
  current,
  onChange,
}: {
  filterType: "date" | "number";
  current: Condition | null;
  onChange: (next: Condition | null) => void;
}) {
  const range = current?.kind === "dateRange" ? current : null;
  const num = current?.kind === "numRange" ? current : null;
  const [from, setFrom] = useState(range?.from ?? "");
  const [to, setTo] = useState(range?.to ?? "");
  const [min, setMin] = useState(num?.min != null ? String(num.min) : "");
  const [max, setMax] = useState(num?.max != null ? String(num.max) : "");

  const input =
    "w-full min-w-0 rounded border border-border bg-bg px-1.5 py-1 text-[12px] outline-none focus:border-primary";
  const applyBtn =
    "shrink-0 rounded bg-primary px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-40";

  if (filterType === "number") {
    const parsed = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
    const lo = parsed(min);
    const hi = parsed(max);
    return (
      <div className="shrink-0 border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-1.5">
          <input aria-label="Minimum" inputMode="decimal" placeholder="Min" value={min}
            onChange={(e) => setMin(e.target.value)} className={input} />
          <span className="text-[11px] text-ink-muted">to</span>
          <input aria-label="Maximum" inputMode="decimal" placeholder="Max" value={max}
            onChange={(e) => setMax(e.target.value)} className={input} />
          <button type="button" className={applyBtn} disabled={lo == null && hi == null}
            onClick={() => onChange({ kind: "numRange", min: lo, max: hi })}>
            Apply
          </button>
        </div>
      </div>
    );
  }

  const preset = current?.kind === "preset" ? current.preset : null;
  return (
    <div className="shrink-0 border-b border-border-subtle px-3 py-2">
      <div className="grid grid-cols-3 gap-1">
        {DATE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={preset === p.key}
            onClick={() => onChange(preset === p.key ? null : { kind: "preset", preset: p.key })}
            className={cn(
              "rounded border px-1 py-1 text-[11px] font-semibold transition-colors",
              preset === p.key
                ? "border-primary bg-primary text-white"
                : "border-border text-ink-secondary hover:border-primary/40 hover:text-primary",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} />
        <span className="text-[11px] text-ink-muted">to</span>
        <input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} className={input} />
      </div>
      <button type="button" className={cn(applyBtn, "mt-1.5 w-full")} disabled={!from && !to}
        onClick={() => onChange({ kind: "dateRange", from: from || null, to: to || null })}>
        Apply Range
      </button>
    </div>
  );
}
