// Shared building blocks of the module Overview pages (Procurement, Logistic,
// Project): a titled panel, compact table cells, a segmented toggle, and the
// Monthly / Quarterly / Yearly period picker with its date range.
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export const Th = ({ children, left }: { children: ReactNode; left?: boolean }) => (
  <th className={cn("whitespace-nowrap border-b border-border px-2.5 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted", left ? "text-left" : "text-right")}>{children}</th>
);
export const Td = ({ children, left, className }: { children: ReactNode; left?: boolean; className?: string }) => (
  <td className={cn("whitespace-nowrap border-b border-border px-2.5 py-1.5 text-[12.5px] tabular-nums", left ? "text-left" : "text-right", className)}>{children}</td>
);
export const Panel = ({ title, hint, right, children }: { title: string; hint?: ReactNode; right?: ReactNode; children: ReactNode }) => (
  <section className="rounded-lg border border-border bg-surface">
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
      <h2 className="text-[13.5px] font-semibold text-ink">{title}</h2>
      {hint && <span className="text-[11px] text-ink-muted">{hint}</span>}
      <span className="flex-1" />{right}
    </header>
    <div className="overflow-x-auto p-3">{children}</div>
  </section>
);
export function Toggle<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <span className="inline-flex overflow-hidden rounded-md border border-border text-[12px]">
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)} aria-pressed={value === v}
          className={cn("px-2.5 py-1", value === v ? "bg-primary text-white" : "bg-surface text-ink-secondary hover:bg-surface-2")}>{l}</button>
      ))}
    </span>
  );
}
export const SELECT_CLS = "rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-ink";

export type Gran = "M" | "Q" | "Y";
/** The date range and label of the period holding `anchor` (YYYY-MM-DD). */
export function periodRange(g: Gran, anchor: string): { from: string; to: string; label: string } {
  const [y, m] = [Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7))];
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (g === "Y") return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) };
  if (g === "Q") { const q = Math.ceil(m / 3); const m1 = (q - 1) * 3 + 1; return { from: `${y}-${pad(m1)}-01`, to: `${y}-${pad(m1 + 2)}-${last(y, m1 + 2)}`, label: `Q${q} ${y}` }; }
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${last(y, m)}`, label: new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-MY", { month: "short", year: "numeric", timeZone: "UTC" }) };
}
/** The periods offered in the picker, newest first. */
export function periodAnchors(g: Gran, today: string): string[] {
  const y = Number(today.slice(0, 4)); const m = Number(today.slice(5, 7)); const out: string[] = [];
  if (g === "Y") for (let i = 0; i < 3; i++) out.push(`${y - i}-01-01`);
  else if (g === "Q") for (let i = 0; i < 6; i++) out.push(new Date(Date.UTC(y, m - 1 - i * 3, 1)).toISOString().slice(0, 10));
  else for (let i = 0; i < 12; i++) out.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 10));
  return out;
}
export function PeriodPicker({ gran, anchor, today, onChange, note }: { gran: Gran; anchor: string; today: string; onChange: (g: Gran, a: string) => void; note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Toggle value={gran} options={[["M", "Monthly"], ["Q", "Quarterly"], ["Y", "Yearly"]]} onChange={(g) => onChange(g, periodAnchors(g, today)[0]!)} />
      <select className={SELECT_CLS} value={anchor} onChange={(e) => onChange(gran, e.target.value)} aria-label="Period">
        {periodAnchors(gran, today).map((a) => <option key={a} value={a}>{periodRange(gran, a).label}</option>)}
      </select>
      {note && <span className="text-[11.5px] text-ink-muted">{note}</span>}
    </div>
  );
}
