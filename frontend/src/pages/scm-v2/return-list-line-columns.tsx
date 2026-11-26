
import type { ReactNode } from "react";
import { lineSumColumn, lineTextColumn } from "../../components/dataTableLineCells";
import { fmtDate, fmtQty } from "@2990s/shared";
import { formatCurrency } from "../../lib/utils";
import type { Column } from "../../components/DataTable";
import type { ExportCell } from "../../components/dataTableLineExport";
import type { ReturnLineColumn } from "../../vendor/scm/lib/return-line-export-columns";

export type ReturnColumnValues<R, L> = {
  doc?: (row: R) => ExportCell;
  line?: (line: L) => ExportCell;
  render?: (row: R) => ReactNode;
  width?: string;
  mono?: boolean;
};

const DASH = "—";

const rate = (n: number): string =>
  n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

const shown = (v: ExportCell, format: ReturnLineColumn["format"]): string => {
  if (v === null || v === "") return DASH;
  if (typeof v === "number") return format === "money" ? formatCurrency(v) : format === "rate" ? rate(v) : format === "number" ? fmtQty(v) : String(v);
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
      column.lineValue = (_r: R, l: L) => pick(l);
      column.exportFormat = spec.format;
    }
    return { ...column, ...(v.render ? { render: v.render } : {}), align: base.align };
  });
}
