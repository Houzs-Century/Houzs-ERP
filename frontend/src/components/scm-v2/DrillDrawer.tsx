// The second layer of every Overview (owner, 2026-10-18: "click a figure and
// dig into the data behind it"): a figure opens this slide-over with the rows
// that make it up — searchable, totalled, each row opening its document.
import { useMemo, useState, type ReactNode } from "react";
import { ResizableDrawer } from "../ResizableDrawer";
import { Th, Td } from "./OverviewKit";
import { cn } from "../../lib/utils";

export interface DrillColumn<R> {
  label: string;
  left: boolean;
  render: (row: R) => ReactNode;
  /** Text the search box matches; null = not searchable. */
  text: ((row: R) => string) | null;
  /** Summed into the total row when given. */
  sum: ((row: R) => number) | null;
  format: ((n: number) => string) | null;
}

export interface Drill<R> {
  title: string;
  subtitle: string;
  rows: R[];
  columns: Array<DrillColumn<R>>;
  rowKey: (row: R) => string;
  onRow: ((row: R) => void) | null;
}

/** Show `drill` when set; `onClose` clears it. */
export function DrillDrawer<R>({ drill, onClose }: { drill: Drill<R> | null; onClose: () => void }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    if (!drill) return [];
    const s = q.trim().toLowerCase();
    if (!s) return drill.rows;
    return drill.rows.filter((r) => drill.columns.some((c) => c.text?.(r).toLowerCase().includes(s)));
  }, [drill, q]);
  if (!drill) return null;
  const sums = drill.columns.map((c) => (c.sum ? shown.reduce((a, r) => a + (c.sum as (row: R) => number)(r), 0) : null));
  return (
    <ResizableDrawer onClose={() => { setQ(""); onClose(); }} title={drill.title} subtitle={`${drill.subtitle} · ${shown.length} of ${drill.rows.length}`}
      storageKey="overview-drill-width" defaultWidth={760} ariaLabel={drill.title}>
      <div className="p-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search these rows" autoFocus
          className="mb-2 h-8 w-full rounded-md border border-border bg-surface px-2 text-[12.5px]" />
        {drill.rows.length === 0 ? <p className="py-6 text-center text-[12.5px] text-ink-muted">Nothing behind this figure.</p> : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr>{drill.columns.map((c) => <Th key={c.label} left={c.left}>{c.label}</Th>)}</tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={drill.rowKey(r)} onClick={drill.onRow ? () => (drill.onRow as (row: R) => void)(r) : undefined}
                  className={cn(drill.onRow && "cursor-pointer hover:bg-surface-2/60")}>
                  {drill.columns.map((c) => <Td key={c.label} left={c.left} className={c.left ? "max-w-[260px] truncate" : ""}>{c.render(r)}</Td>)}
                </tr>
              ))}
              {sums.some((x) => x != null) && (
                <tr className="font-semibold">
                  {drill.columns.map((c, i) => <Td key={c.label} left={c.left}>{i === 0 ? "Total" : sums[i] != null ? (c.format ? c.format(sums[i] as number) : (sums[i] as number).toLocaleString()) : ""}</Td>)}
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </ResizableDrawer>
  );
}

/** A column: label, left-aligned, how a cell reads, what search sees, what sums. */
export function col<R>(label: string, left: boolean, render: (row: R) => ReactNode, text: ((row: R) => string) | null, sum: ((row: R) => number) | null, format: ((n: number) => string) | null): DrillColumn<R> {
  return { label, left, render, text, sum, format };
}
