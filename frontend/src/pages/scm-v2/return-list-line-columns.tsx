/* The Purchase Returns and Delivery Returns grids' AutoCount columns (owner
 * 2026-09-15: the list's default columns are AutoCount's Detail Listing
 * columns in AutoCount's order, and the ONE Export writes the visible ones,
 * one row per line).
 *
 * Which columns, in which order, under which label, and which are shown by
 * default is the contract in vendor/scm/lib/return-line-export-columns.ts —
 * AutoCount's own grids, read from the program. This module only turns that
 * contract plus a page's value functions into DataTable columns.
 *
 * A DOCUMENT column shows and exports one value per return (repeated on every
 * line of the file). A LINE column shows a compact value on the return's row —
 * the single value or the first and "+N" more; quantities and amounts show
 * their sum — lists every line's value in its funnel, and exports each line's
 * own value — the shared components/dataTableLineCells.tsx cells every list
 * that exports by line uses. Money is RINGGIT in the file and on screen; the
 * server sends sen and the page's value functions convert (senToRinggit). */

import type { ReactNode } from "react";
import { lineSumColumn, lineTextColumn } from "../../components/dataTableLineCells";
import { fmtDate } from "@2990s/shared";
import type { Column } from "../../components/DataTable";
import type { ExportCell } from "../../components/dataTableLineExport";
import type { ReturnLineColumn } from "../../vendor/scm/lib/return-line-export-columns";

export type ReturnColumnValues<R, L> = {
  /** A document column's value (money in ringgit). */
  doc?: (row: R) => ExportCell;
  /** A line column's value for one line (money in ringgit). A line column reads
   *  only its line — the shared line cells pass no row — so a page that needs a
   *  document fact on a line carries it on the line it hands the grid. */
  line?: (line: L) => ExportCell;
  /** Replaces the generic cell. */
  render?: (row: R) => ReactNode;
  width?: string;
  mono?: boolean;
};

const DASH = "—";

const money = (n: number): string =>
  n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rate = (n: number): string =>
  n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

const shown = (v: ExportCell, format: ReturnLineColumn["format"]): string => {
  if (v === null || v === "") return DASH;
  if (typeof v === "number") return format === "money" ? money(v) : format === "rate" ? rate(v) : String(v);
  return format === "date" ? fmtDate(v) : v;
};

/**
 * DataTable columns for a return list, in the contract's order. `values` must
 * name every contract key (a missing one is a programming error and throws, so
 * a column can never silently export blank). `alwaysVisibleKey` pins the Doc No.
 */
export function returnGridColumns<R, L>(
  contract: readonly ReturnLineColumn[],
  values: Record<string, ReturnColumnValues<R, L>>,
  linesOf: (row: R) => readonly L[],
  alwaysVisibleKey: string,
): Column<R, L>[] {
  return contract.map((spec) => {
    const v = values[spec.key] as ReturnColumnValues<R, L> | undefined;
    if (!v || (spec.level === "document" ? !v.doc : !v.line)) {
      throw new Error(`return grid: no ${spec.level} value for column "${spec.key}"`);
    }
    const numeric = spec.format === "money" || spec.format === "number" || spec.format === "rate";
    const base = {
      key: spec.key,
      label: spec.label,
      width: v.width ?? (numeric ? "120px" : "150px"),
      align: numeric ? ("right" as const) : undefined,
      defaultHidden: !spec.autoCount,
      alwaysVisible: spec.key === alwaysVisibleKey ? true : undefined,
      exportFormat: spec.format,
    };
    if (spec.level === "document") {
      const doc = v.doc!;
      return {
        ...base,
        getValue: (r: R) => doc(r),
        exportValue: (r: R) => doc(r),
        render: v.render ?? ((r: R) => (
          <span className={`block min-w-0 truncate text-ink-secondary ${v.mono ? "font-mono text-[11.5px]" : "text-[12.5px]"}`}>
            {shown(doc(r), spec.format)}
          </span>
        )),
      } satisfies Column<R, L>;
    }
    const pick = v.line!;
    const lineBase = { key: spec.key, label: spec.label, width: base.width, defaultHidden: base.defaultHidden, linesOf };
    let column: Column<R, L>;
    if (spec.format === "money" || spec.format === "number") {
      /* A quantity or an amount: the row shows the sum, the file each line's. */
      column = lineSumColumn<R, L>({
        ...lineBase,
        pick: (l) => {
          const x = pick(l);
          return typeof x === "number" ? x : null;
        },
        exportFormat: spec.format,
        format: (sum) => shown(Number(sum.toFixed(4)), spec.format),
      });
    } else {
      column = lineTextColumn<R, L>({
        ...lineBase,
        pick: (l) => {
          const x = pick(l);
          return x === null ? null : String(x);
        },
        exportFormat: spec.format === "date" ? "date" : "text",
        format: spec.format === "rate" ? (x) => rate(Number(x)) : spec.format === "date" ? (x) => fmtDate(x) : undefined,
        mono: v.mono,
      });
      /* The file keeps the typed value: a unit price stays a NUMBER (a rate). */
      column.lineValue = (_r: R, l: L) => pick(l);
      column.exportFormat = spec.format;
    }
    return { ...column, ...(v.render ? { render: v.render } : {}), align: base.align };
  });
}
