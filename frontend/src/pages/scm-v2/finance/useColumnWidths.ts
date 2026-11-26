
import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';

export type ColumnWidthSpec = {
  defaults: readonly string[];
  min: readonly number[];
  fit?: readonly boolean[];
  gap?: number;
};

type Widths = Array<number | null>;

const DRAG_MAX = 720;
const FIT_MAX = 480;
const ROW_PADDING = 30;

export const columnWidthsKey = (kind: string): string => `fin-${kind}-cw`;

function readWidths(kind: string, n: number): Widths | null {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(columnWidthsKey(kind)) ?? 'null');
    if (Array.isArray(v) && v.length === n && v.every((x) => x === null || (typeof x === 'number' && x > 0))) return v as Widths;
  } catch { }
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

function inputTextWidth(el: HTMLInputElement): number {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return 0;
  const cs = window.getComputedStyle(el);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const text = el.value ? (cs.textTransform === 'uppercase' ? el.value.toUpperCase() : el.value) : el.placeholder;
  const px = (v: string) => parseFloat(v) || 0;
  return ctx.measureText(text).width + px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
}

function contentWidth(root: HTMLElement, i: number, scale: number): number {
  let w = 0;
  root.querySelectorAll<HTMLElement>('[data-cw-row]').forEach((row) => {
    let col = 0;
    for (const ch of Array.from(row.children) as HTMLElement[]) {
      const m = /span\s+(\d+)/.exec(ch.style.gridColumn);
      const span = m ? Number(m[1]) : 1;
      if (col === i && span === 1) {
        const target = ch.querySelector<HTMLElement>('[data-cw-lbl]') ?? ch;
        const box = target.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
        if (box) {
          w = Math.max(w, inputTextWidth(box));
        } else {
          try {
            const range = document.createRange();
            range.selectNodeContents(target);
            const cw = range.getBoundingClientRect().width / scale;
            if (cw > w) w = cw;
          } catch { }
        }
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
    } catch { }
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
    template: gridTemplate(spec.defaults, widths),
    minWidth: gridMinWidth(spec.defaults, widths, gap),
    custom: widths != null,
    reset: () => save(null),
    handle: (i: number) => ({
      onMouseDown: startResize(i),
      onDoubleClick: fitColumn(i),
      title: 'Drag to resize · double-click to fit',
    }),
  };
}
