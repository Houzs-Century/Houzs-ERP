/* How a LINE column looks on a grid that shows one row per DOCUMENT (owner
 * 2026-09-15). Every list that adopts DataTable `exportLines` renders its line
 * columns through here, so they read the same everywhere:
 *
 *   one distinct value      -> the value
 *   several distinct values -> the first value, then "+N" (N more), every value
 *                              in the cell's tooltip
 *   no value                -> "—"
 *
 * `lineTextColumn` builds the whole column (compact cell, the funnel over every
 * line's value, the per-line export cell); `lineSumColumn` shows a quantity or an
 * amount as the SUM over the document's lines. */

import type { ReactNode } from "react";
import type { Column } from "./DataTable";
import type { ExportCell, ExportFormat } from "./dataTableLineExport";

export type LineCellValue = string | number | null | undefined;

/** Distinct, non-blank values in line order. */
export function distinctLineValues(values: readonly LineCellValue[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (s.trim() === "" || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

export function compactLineValues(values: readonly LineCellValue[]): { first: string | null; more: number; all: string[] } {
  const all = distinctLineValues(values);
  return { first: all[0] ?? null, more: Math.max(0, all.length - 1), all };
}

export function LineValuesCell({
  values,
  format,
  mono,
}: {
  values: readonly LineCellValue[];
  /** Display form of one value (a date shown dd/mm/yyyy, money with RM). */
  format?: (v: string) => ReactNode;
  mono?: boolean;
}) {
  const { first, more, all } = compactLineValues(values);
  if (first === null) return <span className="text-[12.5px] text-ink-muted">—</span>;
  const show = (v: string) => (format ? format(v) : v);
  return (
    <span
      title={all.map((v) => String(show(v))).join("\n")}
      className={`block min-w-0 truncate text-ink-secondary ${mono ? "font-mono text-[11.5px]" : "text-[12.5px]"}`}
    >
      {show(first)}
      {more > 0 && <span className="text-ink-muted">{` +${more}`}</span>}
    </span>
  );
}

type LineColumnBase = { key: string; label: string; width?: string; defaultHidden?: boolean; group?: string };

/** A text / date / code line column: compact on screen, one cell per line in the file. */
export function lineTextColumn<T, L>(
  spec: LineColumnBase & {
    linesOf: (row: T) => readonly L[];
    pick: (line: L) => string | null;
    exportFormat?: Extract<ExportFormat, "text" | "date">;
    format?: (v: string) => ReactNode;
    mono?: boolean;
  },
): Column<T, L> {
  const values = (r: T) => distinctLineValues(spec.linesOf(r).map(spec.pick));
  return {
    key: spec.key,
    label: spec.label,
    width: spec.width ?? "150px",
    group: spec.group,
    disableSort: true,
    defaultHidden: spec.defaultHidden,
    getValue: (r) => values(r)[0] ?? "",
    getFilterValues: (r) => values(r),
    lineValue: (_r, l) => spec.pick(l),
    exportFormat: spec.exportFormat ?? "text",
    render: (r) => <LineValuesCell values={spec.linesOf(r).map(spec.pick)} format={spec.format} mono={spec.mono} />,
  };
}

/** A quantity or amount line column: the row shows the SUM over its lines; the
 *  file carries each line's own value (`toExport` converts, e.g. sen to ringgit). */
export function lineSumColumn<T, L>(
  spec: LineColumnBase & {
    linesOf: (row: T) => readonly L[];
    pick: (line: L) => number | null;
    exportFormat: Extract<ExportFormat, "number" | "money" | "rate">;
    toExport?: (v: number) => ExportCell;
    format?: (sum: number) => ReactNode;
  },
): Column<T, L> {
  const sum = (r: T) => spec.linesOf(r).reduce((a, l) => a + (spec.pick(l) ?? 0), 0);
  const out = (v: number | null): ExportCell => (v === null ? null : spec.toExport ? spec.toExport(v) : v);
  return {
    key: spec.key,
    label: spec.label,
    width: spec.width ?? "120px",
    group: spec.group,
    align: "right",
    disableSort: true,
    defaultHidden: spec.defaultHidden,
    getValue: (r) => sum(r),
    getFilterValues: (r) => distinctLineValues(spec.linesOf(r).map((l) => out(spec.pick(l)))),
    lineValue: (_r, l) => out(spec.pick(l)),
    exportFormat: spec.exportFormat,
    render: (r) =>
      spec.linesOf(r).length === 0
        ? <span className="text-[12.5px] text-ink-muted">—</span>
        : <span className="font-money text-[12.5px] text-ink">{spec.format ? spec.format(sum(r)) : sum(r)}</span>,
  };
}
