import { Fragment, memo, type CSSProperties, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { parsePxWidth } from "./dataTableHelpers";
import type { Column } from "./dataTableTypes";

/* One mark for "nothing here" in every table (owner 2026-09-25): a cell that
   renders nothing reads as a dash, not as a blank a user might think failed. */
const showDash = (node: ReactNode): ReactNode =>
  node == null || node === "" || node === false ? <span className="text-ink-muted">—</span> : node;

export interface CellPlacement {
  widths: Record<string, number>;
  stickyLeft: Array<number | undefined>;
  stickyRight: Array<number | undefined>;
  stickyCount: number;
}

export function dataCellStyle<T>(
  column: Column<T>,
  index: number,
  placement: CellPlacement,
  stickyBg: string,
): CSSProperties {
  const cellStyle: CSSProperties = {};
  const userWidth = placement.widths[column.key];
  if (typeof userWidth === "number") {
    cellStyle.width = userWidth;
    cellStyle.minWidth = userWidth;
    cellStyle.maxWidth = userWidth;
  } else if (column.width) {
    cellStyle.width = column.width;
    const px = parsePxWidth(column.width);
    if (px != null) cellStyle.maxWidth = px;
  }
  const stickyRightOffset = placement.stickyRight[index];
  if (index < placement.stickyCount) {
    Object.assign(cellStyle, { position: "sticky", left: placement.stickyLeft[index], zIndex: 20, background: stickyBg });
  } else if (stickyRightOffset !== undefined) {
    Object.assign(cellStyle, { position: "sticky", right: stickyRightOffset, zIndex: 20, background: stickyBg });
  }
  return cellStyle;
}

/* SCROLL PERF (owner 2026-10-21 "滚动变顺" step 2): the DATA cells of one row.
   The <tr>, its selection checkbox, expand chevron, click/drag handlers and
   selected/hover classes stay in the parent (DataTable) — those are cheap and
   depend on per-row state (selected / expanded / drag) that changes often. The
   35-odd data cells (which include the crew pickers and every formatted value)
   are the EXPENSIVE part, and they are a pure function of (row, columns, layout):
   calling the same column render fns on the same row yields the same cells. So
   they live in this memoised component whose props are exactly those inputs — all
   referentially stable in the parent (row object stable until a refetch; columns
   / widths / sticky arrays are useMemo'd; the rest are primitives). A scroll-window
   change re-renders DataTable, but every row whose data and the table's
   columns/layout are unchanged now SKIPS re-rendering its cells — the
   Google-Sheet-smooth win. Output is byte-identical to rendering inline: memoising
   on exactly the inputs the cells read introduces no staleness (any pre-existing
   staleness from a caller's incomplete columns-memo deps is preserved exactly,
   since an unchanged columns identity means the same closures).

   Lives in its own module so the already-large DataTable.tsx does not grow past
   its file-size ceiling. */
function DataRowCellsInner<T>({
  row, columns, widths, stickyLeft, stickyRight, stickyCount, stickyRightCount,
  cellPad, wrapOn, fillerAt, fillerCount, stickyBg, firstColGutter,
}: {
  row: T;
  columns: Column<T>[];
  widths: Record<string, number>;
  stickyLeft: Array<number | undefined>;
  stickyRight: Array<number | undefined>;
  stickyCount: number;
  stickyRightCount: number;
  cellPad: string;
  wrapOn: boolean;
  fillerAt: number;
  fillerCount: number;
  stickyBg: string;
  firstColGutter: boolean;
}) {
  return (
    <>
      {columns.map((c, i) => {
        const isSticky = i < stickyCount;
        const isLastSticky = isSticky && i === stickyCount - 1;
        const isStickyRight = stickyRight[i] !== undefined;
        const isFirstStickyRight =
          isStickyRight && i === columns.length - stickyRightCount;
        const cellStyle = dataCellStyle(c, i, { widths, stickyLeft, stickyRight, stickyCount }, stickyBg);
        const rawVal = c.getValue?.(row);
        const cellTitle =
          typeof rawVal === "string" && rawVal !== "" ? rawVal : undefined;
        return (
          <Fragment key={c.key}>
            {i === fillerAt && fillerCount > 0 && <td aria-hidden className="border-b border-border-subtle p-0 group-hover:bg-[#3f6b53]/25" />}
            <td
              data-col-key={c.key}
              style={cellStyle}
              title={cellTitle}
              className={cn(
                "border-b border-border-subtle text-[13px] text-ink transition-colors",
                cellPad,
                wrapOn
                  ? "whitespace-normal break-words align-top"
                  : "overflow-hidden text-ellipsis whitespace-nowrap",
                "group-hover:bg-[#3f6b53]/25",
                c.align === "right" && "text-right",
                c.align === "center" && "text-center",
                i === 0 && firstColGutter && "pl-5",
                i === columns.length - 1 && "pr-5",
                isLastSticky && "border-r border-border",
                isFirstStickyRight && "border-l border-border",
                c.className
              )}
            >
              {showDash(c.render(row))}
            </td>
          </Fragment>
        );
      })}
      {fillerAt === columns.length && fillerCount > 0 && (
        <td aria-hidden className="border-b border-border-subtle p-0 group-hover:bg-[#3f6b53]/25" />
      )}
    </>
  );
}
export const DataRowCells = memo(DataRowCellsInner) as typeof DataRowCellsInner;
