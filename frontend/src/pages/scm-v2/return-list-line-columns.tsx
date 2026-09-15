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
 * own value. Money is RINGGIT in the file and on screen; the server sends sen
 * and the page's value functions convert (senToRinggit). */

import type { ReactNode } from "react";
import { fmtDate } from "@2990s/shared";
import type { Column } from "../../components/DataTable";
import type { ExportCell } from "../../components/dataTableLineExport";
import type { ReturnLineColumn } from "../../vendor/scm/lib/return-line-export-columns";

export type ReturnColumnValues<R, L> = {
  /** A document column's value (money in ringgit). */
  doc?: (row: R) => ExportCell;
  /** A line column's value for one line (money in ringgit). */
  line?: (row: R, line: L) => ExportCell;
  /** Replaces the generic cell. */
  render?: (row: R) => ReactNode;
  width?: string;
  mono?: boolean;
};

const muted = (content: ReactNode, title?: string, mono = false) => (
  <span title={title} className={`block min-w-0 truncate text-[12.5px] text-ink-secondary${mono ? " font-mono text-[11.5px]" : ""}`}>
    {content}
  </span>
);

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

const distinct = (values: ExportCell[]): Array<string | number> => {
  const out: Array<string | number> = [];
  for (const v of values) if (v !== null && v !== "" && !out.includes(v)) out.push(v);
  return out;
};

const isNumeric = (format: ReturnLineColumn["format"]) => format === "money" || format === "number";

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
    const v = values[spec.key];
    if (!v || (spec.level === "document" ? !v.doc : !v.line)) {
      throw new Error(`return grid: no ${spec.level} value for column "${spec.key}"`);
    }
    const numeric = isNumeric(spec.format) || spec.format === "rate";
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
        render: v.render ?? ((r: R) => muted(shown(doc(r), spec.format), undefined, v.mono)),
      } satisfies Column<R, L>;
    }
    const pick = v.line!;
    const cells = (r: R): ExportCell[] => linesOf(r).map((l) => pick(r, l));
    const sum = (r: R): number | null => {
      const nums = cells(r).filter((c): c is number => typeof c === "number");
      return nums.length ? Number(nums.reduce((a, b) => a + b, 0).toFixed(4)) : null;
    };
    return {
      ...base,
      disableSort: true,
      getValue: (r: R) => (isNumeric(spec.format) ? sum(r) : distinct(cells(r))[0] ?? null),
      getFilterValues: (r: R) => distinct(cells(r)),
      lineValue: (r: R, l: L) => pick(r, l),
      render: v.render ?? ((r: R) => {
        if (isNumeric(spec.format)) {
          const s = sum(r);
          return <span className="font-money text-[12.5px] text-ink">{s === null ? DASH : shown(s, spec.format)}</span>;
        }
        const vs = distinct(cells(r));
        if (vs.length === 0) return muted(DASH);
        const all = vs.map((x) => shown(x, spec.format)).join("\n");
        return (
          <span title={all} className={`block min-w-0 truncate text-[12.5px] text-ink-secondary${v.mono ? " font-mono text-[11.5px]" : ""}`}>
            {shown(vs[0]!, spec.format)}
            {vs.length > 1 && <span className="text-ink-muted">{` +${vs.length - 1}`}</span>}
          </span>
        );
      }),
    } satisfies Column<R, L>;
  });
}
