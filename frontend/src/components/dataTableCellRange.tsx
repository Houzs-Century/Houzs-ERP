import { useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Column } from "./dataTableTypes";
import { useDragAutoScroll } from "./useDragAutoScroll";

/* Excel-style cell range (HC-0164, Syu: "drag over the cells" to see the total
   of the bills she picked). Pressing on a NUMBER cell and dragging marks a
   rectangle and a status pill adds it up, like Excel's status bar; Shift+click
   stretches the last range. Only a number cell starts it, so a drag anywhere
   else still moves the row (row reorder) or selects text as before. The cells
   themselves are memoised, so the mark is one generated <style> rule over the
   row / column keys, which also survives the virtual scroll. */

type Cell = { row: string; col: string };
export type CellRange = { anchor: Cell; focus: Cell };

export function cellNumber<T, L>(c: Column<T, L>, row: T): number | null {
  const v = c.numberValue ? c.numberValue(row) : c.exportValue?.(row);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function cellRangeStats<T, L>(
  rows: readonly T[],
  columns: readonly Column<T, L>[],
  getRowKey: (row: T) => string | number,
  range: CellRange,
) {
  const keys = rows.map((r) => String(getRowKey(r)));
  const r1 = keys.indexOf(range.anchor.row);
  const r2 = keys.indexOf(range.focus.row);
  const c1 = columns.findIndex((c) => c.key === range.anchor.col);
  const c2 = columns.findIndex((c) => c.key === range.focus.col);
  if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return null;
  const pickedRows = rows.slice(Math.min(r1, r2), Math.max(r1, r2) + 1);
  const pickedCols = columns.slice(Math.min(c1, c2), Math.max(c1, c2) + 1);
  let count = 0;
  let sum = 0;
  for (const r of pickedRows) {
    for (const c of pickedCols) {
      const n = cellNumber(c, r);
      if (n == null) continue;
      count += 1;
      sum += n;
    }
  }
  return {
    rowKeys: keys.slice(Math.min(r1, r2), Math.max(r1, r2) + 1),
    colKeys: pickedCols.map((c) => c.key),
    cells: pickedRows.length * pickedCols.length,
    count,
    sum,
  };
}

const fmtNum = (n: number) =>
  n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quote = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;
const INTERACTIVE = "input, button, select, textarea, a, label, [role='button'], [contenteditable='true']";

export function useCellRange<T, L>({
  enabled,
  scrollRef,
  rows,
  columns,
  getRowKey,
}: {
  enabled: boolean;
  scrollRef: React.RefObject<HTMLElement | null>;
  rows: readonly T[];
  columns: readonly Column<T, L>[];
  getRowKey: (row: T) => string | number;
}) {
  const [range, setRange] = useState<CellRange | null>(null);
  const [dragging, setDragging] = useState(false);
  const anchorRef = useRef<Cell | null>(null);
  const movedRef = useRef(false);
  const swallowClickRef = useRef(false);
  const autoScroll = useDragAutoScroll(() => scrollRef.current);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const stats = useMemo(
    () => (enabled && range ? cellRangeStats(rows, columns, getRowKey, range) : null),
    [enabled, range, rows, columns, getRowKey],
  );
  const shown = stats != null && stats.cells > 1;

  const cellAt = (el: Element | null): Cell | null => {
    const td = el?.closest<HTMLElement>("td[data-col-key]");
    const tr = td?.closest<HTMLElement>("tr[data-rowkey]");
    if (!td || !tr || !scrollRef.current?.contains(tr)) return null;
    return { row: tr.dataset.rowkey ?? "", col: td.dataset.colKey ?? "" };
  };
  const cellAtRef = useRef(cellAt);
  cellAtRef.current = cellAt;

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      autoScrollRef.current.at(e.clientY);
      const cell = cellAtRef.current(document.elementFromPoint(e.clientX, e.clientY));
      const anchor = anchorRef.current;
      if (!cell || !anchor) return;
      if (cell.row !== anchor.row || cell.col !== anchor.col) movedRef.current = true;
      setRange((r) => (r && r.focus.row === cell.row && r.focus.col === cell.col ? r : { anchor, focus: cell }));
    };
    const up = () => {
      autoScrollRef.current.stop();
      setDragging(false);
      if (movedRef.current) swallowClickRef.current = true;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragging]);

  useEffect(() => {
    if (!shown) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setRange(null); };
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!scrollRef.current?.contains(t) && !document.getElementById(`crange-${id}`)?.contains(t)) setRange(null);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", down);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", down);
    };
  }, [shown, scrollRef, id]);

  const onMouseDown = (e: ReactMouseEvent) => {
    if (!enabled || e.button !== 0) return;
    swallowClickRef.current = false;
    const target = e.target as HTMLElement;
    const cell = target.closest(INTERACTIVE) ? null : cellAt(target);
    const row = cell ? rows.find((r) => String(getRowKey(r)) === cell.row) : undefined;
    const col = cell ? columns.find((c) => c.key === cell.col) : undefined;
    if (!cell || row === undefined || !col || cellNumber(col, row) == null) {
      setRange(null);
      return;
    }
    // No text selection and no native row drag from a number cell; an open
    // editor elsewhere still has to blur so it saves.
    e.preventDefault();
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    if (e.shiftKey && range) {
      setRange({ anchor: range.anchor, focus: cell });
      swallowClickRef.current = true;
      return;
    }
    anchorRef.current = cell;
    movedRef.current = false;
    setRange({ anchor: cell, focus: cell });
    setDragging(true);
  };
  // A drag or Shift+click picks cells; it must not also open the row.
  const onClickCapture = (e: ReactMouseEvent) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    e.stopPropagation();
  };

  const css = shown
    ? `[data-crange="${id}"] tr:is(${stats.rowKeys.map((k) => `[data-rowkey=${quote(k)}]`).join(",")}) > td:is(${stats.colKeys.map((k) => `[data-col-key=${quote(k)}]`).join(",")}){background-color:rgba(47,93,79,.18)!important;}`
    : "";

  const overlay = shown ? (
    <>
      <style>{css}</style>
      <div
        id={`crange-${id}`}
        role="status"
        className="fixed bottom-[88px] right-4 z-[45] flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-ink-muted shadow-stone"
      >
        <span>Sum <span className="font-mono font-semibold text-ink">{fmtNum(stats.sum)}</span></span>
        <span>Count <span className="font-mono font-semibold text-ink">{stats.count}</span></span>
        {stats.count > 0 && (
          <span>Average <span className="font-mono font-semibold text-ink">{fmtNum(stats.sum / stats.count)}</span></span>
        )}
        <button type="button" aria-label="Clear the picked cells" className="px-1 text-ink-muted hover:text-ink" onClick={() => setRange(null)}>
          x
        </button>
      </div>
    </>
  ) : null;

  return {
    wrapProps: enabled ? { "data-crange": id, onMouseDown, onClickCapture } : {},
    overlay,
  };
}
