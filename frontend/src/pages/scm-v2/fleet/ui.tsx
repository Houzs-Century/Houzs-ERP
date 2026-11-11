// Coverage & Fleet: the small pieces every tab shares (owner 2026-11-07, the design), so
// Drivers, Helpers, Residence rules, Regions and Places read as one page with Lorries.
import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { downloadCSV, toCSV, type CSVColumn } from "../../../lib/csv";

export const inputCls = "min-h-[40px] w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink";
export const labelCls = "block text-[11px] font-semibold uppercase tracking-wide text-ink-muted";
export const primaryBtn = "min-h-[40px] rounded-md bg-primary px-4 text-[13px] font-semibold text-white disabled:opacity-50";
export const secondaryBtn = "min-h-[40px] rounded-md border border-border bg-surface px-3 text-[12.5px] font-semibold text-ink disabled:opacity-50";
export const dangerBtn = "min-h-[40px] rounded-md border border-[#e3b4b4] px-3 text-[12.5px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)] disabled:opacity-50";

const TONES = {
  green: "bg-[color:var(--hz-dk-synced-bg,#dcebe3)] text-[#1f5c43]",
  orange: "bg-[color:var(--hz-dk-warning-bg,#f6e6d4)] text-[#80501c]",
  amber: "bg-[color:var(--hz-dk-warning-bg,#f6ecd4)] text-[#7a5000]",
  blue: "bg-[color:var(--hz-dk-surface-2,#e7eef6)] text-[#1f4f75]",
  grey: "bg-surface-2 text-ink-muted",
} as const;
export type Tone = keyof typeof TONES;

export const Chip = ({ tone, children }: { tone: Tone; children: ReactNode }) => (
  <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold", TONES[tone])}>{children}</span>
);

/** An on/off switch. The caller confirms before flipping when the change matters. */
export const Switch = ({ on, label, onClick, disabled }: { on: boolean; label: string; onClick: () => void; disabled: boolean }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    className={cn("flex h-[30px] w-[52px] flex-none items-center rounded-full p-[3px] disabled:opacity-50", on ? "justify-end bg-primary" : "justify-start bg-[#c9c4b8]")}>
    <span className="h-6 w-6 rounded-full bg-surface shadow" />
  </button>
);

export const Card = ({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) => (
  <section className="rounded-xl border border-border bg-surface p-4">
    {(title || action) && <div className="mb-3 flex items-center justify-between gap-2">{title && <h3 className="text-[13px] font-semibold text-ink">{title}</h3>}{action}</div>}
    {children}
  </section>
);

/** Label / value rows inside a read view. */
export const ReadRows = ({ rows }: { rows: Array<[string, ReactNode]> }) => (
  <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2.5 text-[13px]">
    {rows.map(([k, v]) => [<dt key={`${k}-k`} className="text-ink-muted">{k}</dt>, <dd key={`${k}-v`} className="min-w-0 whitespace-pre-line break-words text-ink">{v}</dd>])}
  </dl>
);

export const Field = ({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) => (
  <label className={cn(labelCls, wide && "col-span-2")}><span className="mb-1 block">{label}</span>{children}</label>
);

/** Search, the tab's own filters, a count, Export and the New button: one row over every list. */
export function ListToolbar({ search, onSearch, placeholder, filters, shown, total, onExport, newLabel, onNew }: {
  search: string; onSearch: (v: string) => void; placeholder: string; filters?: ReactNode;
  shown: number; total: number; onExport: () => void; newLabel: string; onNew: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder={placeholder} aria-label={placeholder}
          className="min-h-[40px] min-w-[200px] flex-1 rounded-md border border-border bg-surface px-3 text-[13px]" />
        {filters}
        <span className="ml-auto flex gap-2">
          <button type="button" onClick={onExport} className={secondaryBtn}>Export</button>
          <button type="button" onClick={onNew} className={primaryBtn}>{newLabel}</button>
        </span>
      </div>
      <p className="text-[12px] text-ink-muted">Showing {shown} of {total}</p>
    </div>
  );
}

/** The segmented filter the Lorries tab uses. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-lg bg-surface-2 p-0.5">
      {options.map(([k, text]) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}
          className={cn("min-h-[34px] rounded-md px-3 text-[12.5px] font-semibold", value === k ? "bg-surface text-ink shadow-sm" : "text-ink-muted")}>{text}</button>
      ))}
    </div>
  );
}

/** What a list shows when nothing came back: what it looked for, and a way out. */
export const NoMatch = ({ text, onClear }: { text: string; onClear: (() => void) | null }) => (
  <div className="rounded-xl border border-dashed border-border p-6 text-center text-[13px] text-ink-muted">
    {text}{onClear && <> <button type="button" className="font-semibold text-primary" onClick={onClear}>Clear search</button></>}
  </div>
);

export const exportCsv = <T,>(file: string, rows: T[], cols: CSVColumn<T>[]) => downloadCSV(file, toCSV(rows, cols));

export const PencilIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" />
  </svg>
);

export const IconBtn = ({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) => (
  <button type="button" aria-label={label} onClick={(e) => { e.stopPropagation(); onClick(); }}
    className="grid h-9 w-9 flex-none place-items-center rounded-[10px] bg-surface-2 text-ink-secondary hover:text-ink">{children}</button>
);
