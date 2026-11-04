// ----------------------------------------------------------------------------
// useColumnWidths — the resizable columns of a Finance grid that is not a
// DataTable (the owner's redesign, batch 6 §1.3: Journal entries, General
// ledger, Merchant charges, Collection). Every row of the grid is a CSS grid on
// the same track list; a header edge is dragged to resize its column, and a
// double-click fits it to what it holds. Columns marked `fit` (numbers, dates,
// entry numbers) are never dragged narrower than their contents. The widths a
// person sets are theirs: localStorage `fin-<kind>-cw`, cleared by "Reset
// column widths". A personal preference, so localStorage (repo rule).
//
// The grid's markup carries three attributes the hook measures by:
// `data-cw-root` on the box that holds every row, `data-cw-row` on each row,
// and `data-cw-lbl` on a header's label; a cell spanning columns says so in
// its inline `gridColumn: 'span N'`.
// ----------------------------------------------------------------------------

import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';

export type ColumnWidthSpec = {
  /** The track each column opens at: '78px', 'minmax(200px,1fr)'. */
  defaults: readonly string[];
  /** No column is dragged narrower than this, in px. */
  min: readonly number[];
  /** Columns that never go narrower than what they hold. */
  fit?: readonly boolean[];
  /** The grid's column gap in px — counted into its minimum width. */
  gap?: number;
};

type Widths = Array<number | null>;

/** Widest a drag may make a column, and a double-click's fit. */
const DRAG_MAX = 720;
const FIT_MAX = 480;
/** The rows' left and right padding, counted into the minimum width. */
const ROW_PADDING = 30;

export const columnWidthsKey = (kind: string): string => `fin-${kind}-cw`;

function readWidths(kind: string, n: number): Widths | null {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(columnWidthsKey(kind)) ?? 'null');
    if (Array.isArray(v) && v.length === n && v.every((x) => x === null || (typeof x === 'number' && x > 0))) return v as Widths;
  } catch { /* private mode or a stale value — the defaults */ }
  return null;
}

/** The grid-template-columns: a set width in px, else the column's default. A
    grid with no flexible track left gets a filler, so the rows still span. */
export function gridTemplate(defaults: readonly string[], widths: Widths | null): string {
  const parts = defaults.map((d, i) => (widths?.[i] != null ? `${widths[i]}px` : d));
  return parts.join(' ') + (parts.some((p) => p.includes('fr')) ? '' : ' minmax(0,1fr)');
}

/** The narrowest the grid may get before it scrolls sideways. */
export function gridMinWidth(defaults: readonly string[], widths: Widths | null, gap: number): number {
  const px = defaults.map((d, i) => {
    const w = widths?.[i];
    if (w != null) return w;
    const m = /(\d+)px/.exec(d);
    return m ? Number(m[1]) : 60;
  });
  return px.reduce((a, b) => a + b, 0) + (px.length - 1) * gap + ROW_PADDING;
}

/** How wide column `i`'s widest single-column cell is, in layout px. */
function contentWidth(root: HTMLElement, i: number, scale: number): number {
  let w = 0;
  root.querySelectorAll<HTMLElement>('[data-cw-row]').forEach((row) => {
    let col = 0;
    for (const ch of Array.from(row.children) as HTMLElement[]) {
      const m = /span\s+(\d+)/.exec(ch.style.gridColumn);
      const span = m ? Number(m[1]) : 1;
      if (col === i && span === 1) {
        const target = ch.querySelector<HTMLElement>('[data-cw-lbl]') ?? ch;
        try {
          const range = document.createRange();
          range.selectNodeContents(target);
          const cw = range.getBoundingClientRect().width / scale;
          if (cw > w) w = cw;
        } catch { /* no layout (tests) */ }
      }
      col += span;
      if (col > i) break;
    }
  });
  return Math.ceil(w) + 2;
}

export function useColumnWidths(kind: string, spec: ColumnWidthSpec) {
  const n = spec.defaults.length;
  const gap = spec.gap ?? 8;
  const [widths, setWidths] = useState<Widths | null>(() => readWidths(kind, n));

  const save = useCallback((next: Widths | null) => {
    const clean = next && next.some((x) => x != null) ? next : null;
    setWidths(clean);
    try {
      if (clean) window.localStorage.setItem(columnWidthsKey(kind), JSON.stringify(clean));
      else window.localStorage.removeItem(columnWidthsKey(kind));
    } catch { /* private mode — the widths last this visit */ }
  }, [kind]);

  const current = useCallback((): Widths => (widths ? [...widths] : Array.from({ length: n }, () => null)), [widths, n]);

  const startResize = (i: number) => (ev: ReactMouseEvent<HTMLElement>) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const root = ev.currentTarget.closest<HTMLElement>('[data-cw-root]');
    if (!root) return;
    const scale = root.getBoundingClientRect().width / (root.offsetWidth || 1) || 1;
    const cell = root.querySelector<HTMLElement>(`[data-cw-cell="${i}"]`);
    const startW = cell ? cell.getBoundingClientRect().width / scale : 80;
    const lo = spec.fit?.[i] ? Math.max(spec.min[i] ?? 40, contentWidth(root, i, scale)) : (spec.min[i] ?? 40);
    const base = current();
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-cw-row]'));
    const x0 = ev.clientX;
    let last: Widths | null = null;
    /* Live while dragging — straight onto the rows, no re-render per pixel. */
    const move = (e: MouseEvent) => {
      const w = Math.max(lo, Math.min(DRAG_MAX, Math.round(startW + (e.clientX - x0) / scale)));
      const next = [...base];
      next[i] = w;
      last = next;
      const tpl = gridTemplate(spec.defaults, next);
      rows.forEach((r) => { r.style.gridTemplateColumns = tpl; });
      root.style.minWidth = `${gridMinWidth(spec.defaults, next, gap)}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (last) save(last);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const fitColumn = (i: number) => (ev: ReactMouseEvent<HTMLElement>) => {
    ev.preventDefault();
    ev.stopPropagation();
    const root = ev.currentTarget.closest<HTMLElement>('[data-cw-root]');
    if (!root) return;
    const scale = root.getBoundingClientRect().width / (root.offsetWidth || 1) || 1;
    const next = current();
    next[i] = Math.min(FIT_MAX, Math.max(spec.min[i] ?? 40, contentWidth(root, i, scale)));
    save(next);
  };

  return {
    /** grid-template-columns for every row. */
    template: gridTemplate(spec.defaults, widths),
    /** The root's min-width, px. */
    minWidth: gridMinWidth(spec.defaults, widths, gap),
    /** True once a width was set — "Reset column widths" shows then. */
    custom: widths != null,
    reset: () => save(null),
    /** The props of column `i`'s resize handle. */
    handle: (i: number) => ({
      onMouseDown: startResize(i),
      onDoubleClick: fitColumn(i),
      title: 'Drag to resize · double-click to fit',
    }),
  };
}
