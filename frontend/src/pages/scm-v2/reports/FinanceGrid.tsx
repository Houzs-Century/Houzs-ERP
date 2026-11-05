// ----------------------------------------------------------------------------
// FinanceGrid — the owner's "finance table" (2026-11-05: 「当我说 finance 每次用的
// table 时，都是 header 要能调，然后要整齐，能 right click header print 啊，column
// chooser 这些」), in the statement dress of the P&L / Cash Flow (Statement.module.css):
//   • a header edge drags to resize, a double-click auto-fits; a header drags to
//     MOVE its column; widths, order, hidden columns and frozen columns are kept
//     per table in this browser (a personal preference) — "Reset layout" restores;
//   • a right-click on a header: Print, sort, freeze, auto-fit, hide, and the
//     column chooser;
//   • figure headers centred, figures right-aligned with tabular digits, money as
//     1,234.56 / (1,234.56), a % beside when asked; nothing wraps — except the
//     second line a row asks for (Setup & Dismantle's venue and dates).
// Rows are a tree: a group folds; open, its total prints on its own row below,
// folded, on the title row. A figure may open a detail under its row.
// Used by the Logistics cost views (LogisticsCost.tsx, LogisticsPnl.tsx).
// ----------------------------------------------------------------------------

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import s from './FinanceGrid.module.css';

export type GridKind = 'money' | 'int' | 'pct' | 'text' | 'center';
export type GridColumn = {
  key: string; label: string;
  /** A small line under the label (the dates). */
  sub?: string;
  /** The header over several columns (a month over its regions). */
  group?: string;
  kind: GridKind;
  width: number;
  /** A Total column: tinted. */
  total?: boolean;
  /** A rule after it. */
  edge?: boolean;
};
/** A list's own cell: what it shows, how it sorts and prints. */
export type GridNode = { node: ReactNode; sort?: number | string; text?: string; title?: string };
export type GridValue = number | null | GridNode | undefined;
export type GridRowKind = 'row' | 'group' | 'block' | 'sub' | 'strong' | 'final' | 'ratio' | 'warn' | 'check' | 'bad';
export type GridRow = {
  id: string;
  label: string;
  /** The caption beside the name — or under it with capBelow. */
  cap?: string | null;
  capBelow?: boolean;
  kind?: GridRowKind;
  cells: Record<string, GridValue>;
  /** The % beside each figure. */
  pct?: Record<string, number | null | undefined>;
  int?: boolean;
  isPct?: boolean;
  /** A zero prints as 0.00, not a dash (a Difference). */
  zeroShows?: boolean;
  kids?: GridRow[];
  totalLabel?: string;
  /** Closed at first (a fair's cost parts). */
  closedAtFirst?: boolean;
  /** The label spans the leading columns up to the first one with a cell (a list's subtotal). */
  span?: boolean;
  /** A figure opens this under the row; null = that figure opens nothing. */
  detail?: (colKey: string) => ReactNode | null;
};

const NAME = '__name';
const isNode = (v: GridValue): v is GridNode => v != null && typeof v === 'object';
const isFigure = (k: GridKind) => k === 'money' || k === 'int' || k === 'pct';

export const fmtMoney = (sen: number): string => {
  const text = (Math.abs(sen) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${text})` : text;
};
const fmtPctBeside = (p: number): string => (p < 0 ? `(${Math.abs(p).toFixed(1)}%)` : `${p.toFixed(1)}%`);

/** A cell's printed text: money, a count, a %, or a dash. */
export function cellText(v: GridValue, kind: GridKind, row: Pick<GridRow, 'int' | 'isPct' | 'zeroShows'>): string | null {
  if (isNode(v)) return v.text ?? null;
  if (v == null) return null;
  if (row.int || kind === 'int') return v.toLocaleString('en-US');
  if (row.isPct || kind === 'pct') return `${v.toFixed(1)}%`;
  if (v === 0 && !row.zeroShows) return null;
  return fmtMoney(v);
}

/* ── The layout a person keeps (localStorage: a personal preference) ── */
type Layout = { w: Record<string, number>; order: string[]; hidden: string[]; freeze: number };
const EMPTY: Layout = { w: {}, order: [], hidden: [], freeze: 0 };
const STORE = 'fin-grid-v1:';
function readLayout(key: string): Layout {
  try {
    const raw = localStorage.getItem(STORE + key);
    if (!raw) return EMPTY;
    const j = JSON.parse(raw) as Partial<Layout>;
    return { w: j.w ?? {}, order: j.order ?? [], hidden: j.hidden ?? [], freeze: j.freeze ?? 0 };
  } catch { return EMPTY; }
}
function writeLayout(key: string, l: Layout) {
  try {
    if (Object.keys(l.w).length === 0 && l.order.length === 0 && l.hidden.length === 0 && l.freeze === 0) localStorage.removeItem(STORE + key);
    else localStorage.setItem(STORE + key, JSON.stringify(l));
  } catch { /* a private window: the layout lasts this visit */ }
}

/** Siblings sorted by a column; rows that close a block (totals, checks) keep their place. */
function sortRows(rows: GridRow[], key: string, dir: 1 | -1, kindOf: (k: string) => GridKind | 'name'): GridRow[] {
  const movable = (r: GridRow) => r.kind == null || r.kind === 'row' || r.kind === 'group';
  const val = (r: GridRow): number | string => {
    if (key === NAME) return r.label.toLowerCase();
    const v = r.cells[key];
    if (isNode(v)) return v.sort ?? v.text ?? '';
    return v ?? (kindOf(key) === 'text' ? '' : Number.NEGATIVE_INFINITY);
  };
  const slots = rows.map((r, i) => (movable(r) ? i : -1)).filter((i) => i >= 0);
  const sorted = slots.map((i) => rows[i]!).sort((a, b) => {
    const x = val(a); const y = val(b);
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
  const out = [...rows];
  slots.forEach((slot, i) => { out[slot] = sorted[i]!; });
  return out.map((r) => (r.kids ? { ...r, kids: sortRows(r.kids, key, dir, kindOf) } : r));
}

type Menu = { x: number; y: number; key: string };

export function FinanceGrid({ storageKey, nameColumn, columns, rows, showPct = false, title, subtitle, ariaLabel, foot, drillKey }: {
  /** Whose layout this is — one per view and mode. */
  storageKey: string;
  /** The frozen name column of a report; null for a list. */
  nameColumn: { label: string; width: number } | null;
  columns: GridColumn[];
  rows: GridRow[];
  showPct?: boolean;
  /** What Print puts on top. */
  title: string;
  subtitle?: string;
  ariaLabel: string;
  foot?: ReactNode;
  /** An open detail closes when this changes. */
  drillKey?: string;
}) {
  const [layout, setLayout] = useState<Layout>(() => readLayout(storageKey));
  useEffect(() => { setLayout(readLayout(storageKey)); }, [storageKey]);
  const save = useCallback((next: Layout | ((l: Layout) => Layout)) => setLayout((prev) => {
    const l = typeof next === 'function' ? next(prev) : next;
    writeLayout(storageKey, l);
    return l;
  }), [storageKey]);

  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drill, setDrill] = useState<{ row: string; col: string } | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  useEffect(() => { setDrill(null); setClosed(new Set()); }, [drillKey]);
  const tableRef = useRef<HTMLTableElement>(null);
  const resizing = useRef(false);
  const dragKey = useRef<string | null>(null);

  /* The columns in the person's order, hidden ones out. */
  const ordered = useMemo(() => {
    const byKey = new Map(columns.map((c) => [c.key, c] as const));
    const known = layout.order.filter((k) => byKey.has(k));
    const rest = columns.map((c) => c.key).filter((k) => !known.includes(k));
    /* A column the saved order does not know sits where the table puts it. */
    const keys = [...known];
    for (const k of rest) {
      const i = columns.findIndex((c) => c.key === k);
      const after = columns.slice(0, i).map((c) => c.key).reverse().find((x) => keys.includes(x));
      keys.splice(after ? keys.indexOf(after) + 1 : 0, 0, k);
    }
    return keys.map((k) => byKey.get(k)!);
  }, [columns, layout.order]);
  const shown = ordered.filter((c) => !layout.hidden.includes(c.key));
  const widthOf = (key: string, fallback: number) => layout.w[key] ?? fallback;
  const kindOf = (key: string): GridKind | 'name' => (key === NAME ? 'name' : columns.find((c) => c.key === key)?.kind ?? 'text');
  const pctOn = showPct;

  /* Frozen: the name column always; then the first n shown columns the person froze. */
  const frozenKeys = shown.slice(0, layout.freeze).map((c) => c.key);
  const leftOf = new Map<string, number>();
  {
    let x = nameColumn ? widthOf(NAME, nameColumn.width) : 0;
    for (const k of frozenKeys) { leftOf.set(k, x); x += widthOf(k, columns.find((c) => c.key === k)!.width); }
  }
  const lastFrozen = frozenKeys.at(-1) ?? (nameColumn ? NAME : null);
  const frozenStyle = (key: string): { cls: string; style?: CSSProperties } => {
    if (key === NAME) return { cls: `${s.frozen} ${lastFrozen === NAME ? s.frozenLast : ''}`, style: { left: 0 } };
    if (!leftOf.has(key)) return { cls: '' };
    return { cls: `${s.frozen} ${lastFrozen === key ? s.frozenLast : ''}`, style: { left: leftOf.get(key) } };
  };

  /* ── Resize, auto-fit ── */
  const startResize = (key: string, fallback: number, e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    const startX = e.clientX;
    const startW = widthOf(key, fallback);
    const min = key === NAME ? 140 : 56;
    const before = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent) => {
      const w = Math.min(900, Math.max(min, Math.round(startW + ev.clientX - startX)));
      setLayout((l) => ({ ...l, w: { ...l.w, [key]: w } }));
    };
    const up = () => {
      document.body.style.userSelect = before;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      resizing.current = false;
      setLayout((l) => { writeLayout(storageKey, l); return l; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const fitWidth = (key: string): number | null => {
    const t = tableRef.current;
    if (!t) return null;
    let max = 0;
    t.querySelectorAll<HTMLElement>(`[data-col="${CSS.escape(key)}"] [data-fit]`).forEach((el) => { max = Math.max(max, el.scrollWidth); });
    return max > 0 ? Math.min(900, max + (key === NAME ? 34 : 22)) : null;
  };
  const autoFit = (keys: string[]) => save((l) => {
    const w = { ...l.w };
    for (const k of keys) { const px = fitWidth(k); if (px) w[k] = px; }
    return { ...l, w };
  });

  /* ── Move a column ── */
  const onDragStart = (key: string) => (e: DragEvent<HTMLTableCellElement>) => {
    if (resizing.current) { e.preventDefault(); return; }
    dragKey.current = key;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
  };
  const onDragOver = (key: string) => (e: DragEvent<HTMLTableCellElement>) => {
    if (!dragKey.current || dragKey.current === key) return;
    e.preventDefault();
    setDropAt(key);
  };
  const onDrop = (key: string) => (e: DragEvent<HTMLTableCellElement>) => {
    e.preventDefault();
    const from = dragKey.current;
    dragKey.current = null;
    setDropAt(null);
    if (!from || from === key) return;
    const keys = ordered.map((c) => c.key).filter((k) => k !== from);
    keys.splice(keys.indexOf(key), 0, from);
    save((l) => ({ ...l, order: keys }));
  };

  /* ── Print: the table as shown, on its own page ── */
  const print = () => {
    const t = tableRef.current;
    if (!t) return;
    const clone = t.cloneNode(true) as HTMLTableElement;
    const src = t.querySelectorAll<HTMLElement>('th, td');
    clone.querySelectorAll<HTMLElement>('th, td').forEach((el, i) => {
      const cs = getComputedStyle(src[i]!);
      el.setAttribute('style', `text-align:${cs.textAlign};font-weight:${cs.fontWeight};font-style:${cs.fontStyle};background:${cs.backgroundColor};padding:3px 8px;border-bottom:1px solid #e3e6e0;white-space:nowrap`);
    });
    clone.querySelectorAll('button[aria-label^="Open"], button[aria-label^="Close"], input').forEach((el) => el.remove());
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    const esc = (x: string) => x.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]!));
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      @page { size: landscape; margin: 12mm; } body { font: 11px 'IBM Plex Sans', system-ui, sans-serif; color: #11140f; }
      h1 { font-size: 15px; margin: 0 0 2px; } p { margin: 0 0 10px; color: #5f6459; }
      table { border-collapse: collapse; font-variant-numeric: tabular-nums; } colgroup { display: none; }
    </style></head><body><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}${clone.outerHTML}</body></html>`);
    doc.close();
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 1000);
  };

  /* ── The menu ── */
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && (e.target as HTMLElement).closest(`.${s.menu}`)) return;
      setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);
  const openMenu = (key: string) => (e: ReactMouseEvent) => {
    e.preventDefault();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 320), key });
  };
  const act = (f: () => void) => () => { f(); setMenu(null); };

  /* ── Rows ── */
  const tree = useMemo(() => (sort ? sortRows(rows, sort.key, sort.dir, kindOf) : rows), [rows, sort]); // eslint-disable-line react-hooks/exhaustive-deps -- kindOf reads the same columns
  const isOpen = (r: GridRow) => (r.closedAtFirst ? closed.has(r.id) : !closed.has(r.id));
  const toggle = (id: string) => setClosed((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const colCount = shown.length + (nameColumn ? 1 : 0);

  const rowClass = (k: GridRowKind | undefined): string => ({
    row: s.rowPlain, group: s.rowGroup, block: s.rowBlock, sub: s.rowSub, strong: s.rowStrong, final: s.rowFinal,
    ratio: s.rowRatio, warn: s.rowWarn, check: s.rowCheck, bad: s.rowBad,
  }[k ?? 'row']);

  const body: ReactNode[] = [];
  const line = (r: GridRow, depth: number, label: string, kind: GridRowKind | undefined, withValues: boolean, isTitle: boolean) => {
    const open = r.kids ? isOpen(r) : false;
    const nameCell = (span: number) => {
      const fz = frozenStyle(NAME);
      const two = r.capBelow && r.cap && isTitle;
      return (
        <td key={NAME} data-col={NAME} colSpan={span > 1 ? span : undefined} className={`${s.cell} ${s.name} ${fz.cls}`} style={{ ...fz.style, paddingLeft: 16 + depth * 18 }}>
          <span className={s.nameInner}>
            {r.kids && isTitle ? (
              <button type="button" className={s.chev} aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'} ${r.label}`} onClick={() => toggle(r.id)}>
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : <span className={s.leaf} />}
            <span className={`${s.nameText} ${two ? s.nameTwo : ''}`} data-fit>
              <span title={label}>{label}</span>
              {r.cap && isTitle && <span className={s.cap} title={r.cap}>{r.cap}</span>}
            </span>
          </span>
        </td>
      );
    };
    const cells: ReactNode[] = [];
    let skip = 0;
    if (nameColumn) cells.push(nameCell(1));
    else if (r.span || kind === 'block') {
      const first = kind === 'block' ? shown.length : Math.max(1, shown.findIndex((c) => r.cells[c.key] !== undefined));
      skip = first < 0 ? shown.length : first;
      cells.push(<td key="span" colSpan={skip} className={`${s.cell} ${s.cellText}`}><span className={s.inner} data-fit>{label}</span></td>);
    }
    shown.slice(skip).forEach((c) => {
      const fz = frozenStyle(c.key);
      const cls = [s.cell, c.kind === 'text' ? s.cellText : c.kind === 'center' ? s.cellCenter : '', c.total ? s.colTotal : '', c.edge ? s.colEdge : '', fz.cls].join(' ');
      const v = withValues ? r.cells[c.key] : undefined;
      let inner: ReactNode;
      if (isNode(v)) inner = <span className={s.inner} data-fit title={v.title}>{v.node}</span>;
      else {
        const text = withValues ? cellText(v, c.kind, r) : null;
        const fig = text == null ? <span className={s.dash}>-</span> : text;
        const drillable = text != null && r.detail && r.detail(c.key) != null;
        const shownFig = drillable ? (
          <button type="button" className={s.figure} aria-pressed={drill?.row === r.id && drill.col === c.key}
            onClick={() => setDrill((d) => (d?.row === r.id && d.col === c.key ? null : { row: r.id, col: c.key }))}>{fig}</button>
        ) : fig;
        const p = withValues && pctOn && isFigure(c.kind) ? r.pct?.[c.key] : undefined;
        inner = pctOn && isFigure(c.kind) ? (
          <span className={s.cv} data-fit><span>{shownFig}</span><span className={s.pct}>{p == null || text == null ? '' : fmtPctBeside(p)}</span></span>
        ) : <span className={s.inner} data-fit>{shownFig}</span>;
      }
      cells.push(<td key={c.key} data-col={c.key} className={cls} style={fz.style}>{inner}</td>);
    });
    body.push(<tr key={`${r.id}|${isTitle ? 't' : 'total'}`} className={rowClass(kind)}>{cells}</tr>);
    if (isTitle && drill?.row === r.id && r.detail) {
      const d = r.detail(drill.col);
      if (d != null) body.push(<tr key={`${r.id}|detail`} className={s.detailRow}><td colSpan={colCount}><div className={s.detail}>{d}</div></td></tr>);
    }
  };
  const walk = (list: GridRow[], depth: number) => {
    for (const r of list) {
      if (r.kids) {
        const open = isOpen(r);
        line(r, depth, r.label, depth === 0 ? (r.kind ?? 'block') : (r.kind ?? 'group'), !open, true);
        if (open) {
          walk(r.kids, depth + 1);
          line(r, depth, r.totalLabel ?? `Total ${r.label}`, depth === 0 ? 'strong' : 'sub', true, false);
        }
      } else line(r, depth, r.label, r.kind, true, true);
    }
  };
  walk(tree, 0);

  /* ── Header ── */
  const grouped = shown.some((c) => c.group);
  const headCell = (c: GridColumn, rowSpan?: number) => {
    const fz = frozenStyle(c.key);
    const cls = [s.head, c.kind === 'text' ? s.headText : '', c.total ? s.headTotal : '', c.edge ? s.colEdge : '', dropAt === c.key ? s.dropBefore : '', fz.cls].join(' ');
    return (
      <th key={c.key} data-col={c.key} rowSpan={rowSpan} className={cls} style={fz.style} draggable
        onDragStart={onDragStart(c.key)} onDragOver={onDragOver(c.key)} onDragLeave={() => setDropAt(null)} onDrop={onDrop(c.key)}
        onDragEnd={() => { dragKey.current = null; setDropAt(null); }} onContextMenu={openMenu(c.key)} title="Drag to move · right-click for more">
        <span data-fit>{c.label}{sort?.key === c.key && <span className={s.sortMark}>{sort.dir === 1 ? '▲' : '▼'}</span>}</span>
        {c.sub && <span className={s.headSub}>{c.sub}</span>}
        <span className={s.handle} aria-hidden onPointerDown={(e) => startResize(c.key, c.width, e)} onDoubleClick={() => autoFit([c.key])} />
      </th>
    );
  };
  const nameHead = nameColumn && (() => {
    const fz = frozenStyle(NAME);
    return (
      <th key={NAME} data-col={NAME} rowSpan={grouped ? 2 : undefined} className={`${s.head} ${s.headText} ${fz.cls}`} style={{ ...fz.style, paddingLeft: 16 }} onContextMenu={openMenu(NAME)}>
        <span data-fit>{nameColumn.label}{sort?.key === NAME && <span className={s.sortMark}>{sort.dir === 1 ? '▲' : '▼'}</span>}</span>
        <span className={s.handle} aria-hidden onPointerDown={(e) => startResize(NAME, nameColumn.width, e)} onDoubleClick={() => autoFit([NAME])} />
      </th>
    );
  })();
  const top: ReactNode[] = [];
  const second: ReactNode[] = [];
  if (grouped) {
    for (let i = 0; i < shown.length;) {
      const c = shown[i]!;
      if (!c.group) { top.push(headCell(c, 2)); i += 1; continue; }
      let j = i;
      while (j < shown.length && shown[j]!.group === c.group) j += 1;
      top.push(<th key={`g${i}`} colSpan={j - i} className={`${s.head} ${s.headGroup} ${s.colEdge}`}>{c.group}</th>);
      for (let k = i; k < j; k += 1) second.push(headCell(shown[k]!));
      i = j;
    }
  }

  const widths = [...(nameColumn ? [widthOf(NAME, nameColumn.width)] : []), ...shown.map((c) => widthOf(c.key, c.width))];
  const custom = Object.keys(layout.w).length > 0 || layout.order.length > 0 || layout.hidden.length > 0 || layout.freeze > 0;
  const menuCol = menu ? (menu.key === NAME ? null : columns.find((c) => c.key === menu.key) ?? null) : null;
  const menuIndex = menuCol ? shown.findIndex((c) => c.key === menuCol.key) : -1;

  return (
    <section className={s.card} aria-label={ariaLabel}>
      <div className={s.scroll}>
        <table ref={tableRef} className={s.table} style={{ width: widths.reduce((a, b) => a + b, 0) }} aria-label={ariaLabel}>
          <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
          <thead>
            {grouped ? (
              <>
                <tr>{nameHead}{top}</tr>
                <tr>{second}</tr>
              </>
            ) : <tr>{nameHead}{shown.map((c) => headCell(c))}</tr>}
          </thead>
          <tbody>{body.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</tbody>
        </table>
      </div>
      <div className={s.foot}>
        {foot}
        <span>Drag a header edge to set its width, drag a header to move it; right-click a header for print, columns, sort and freeze.</span>
        {custom && <button type="button" className={s.reset} onClick={() => save(EMPTY)}>Reset layout</button>}
      </div>

      {menu && (
        <div className={s.menu} role="menu" style={{ left: menu.x, top: menu.y }} aria-label="Column menu">
          <button type="button" role="menuitem" className={s.menuItem} onClick={act(print)}>Print table</button>
          <div className={s.menuSep} />
          <button type="button" role="menuitem" className={s.menuItem} onClick={act(() => setSort({ key: menu.key, dir: 1 }))}>Sort ascending</button>
          <button type="button" role="menuitem" className={s.menuItem} onClick={act(() => setSort({ key: menu.key, dir: -1 }))}>Sort descending</button>
          <button type="button" role="menuitem" className={s.menuItem} disabled={!sort} onClick={act(() => setSort(null))}>Clear sort</button>
          <div className={s.menuSep} />
          {menuCol && (
            <button type="button" role="menuitem" className={s.menuItem}
              onClick={act(() => save((l) => ({ ...l, freeze: l.freeze === menuIndex + 1 ? 0 : menuIndex + 1 })))}>
              {layout.freeze === menuIndex + 1 ? 'Unfreeze columns' : 'Freeze up to this column'}
            </button>
          )}
          {layout.freeze > 0 && (!menuCol || layout.freeze !== menuIndex + 1) && (
            <button type="button" role="menuitem" className={s.menuItem} onClick={act(() => save((l) => ({ ...l, freeze: 0 })))}>Unfreeze columns</button>
          )}
          <button type="button" role="menuitem" className={s.menuItem} onClick={act(() => autoFit([menu.key]))}>Auto-fit this column</button>
          <button type="button" role="menuitem" className={s.menuItem} onClick={act(() => autoFit([...(nameColumn ? [NAME] : []), ...shown.map((c) => c.key)]))}>Auto-fit all columns</button>
          {menuCol && (
            <button type="button" role="menuitem" className={s.menuItem} disabled={shown.length <= 1}
              onClick={act(() => save((l) => ({ ...l, hidden: [...l.hidden, menuCol.key] })))}>Hide this column</button>
          )}
          <div className={s.menuSep} />
          <div className={s.menuTitle}>Columns</div>
          {ordered.map((c) => {
            const on = !layout.hidden.includes(c.key);
            return (
              <label key={c.key} className={s.menuItem}>
                <input type="checkbox" className={s.menuCheck} checked={on} disabled={on && shown.length <= 1}
                  onChange={() => save((l) => ({ ...l, hidden: on ? [...l.hidden, c.key] : l.hidden.filter((k) => k !== c.key) }))} />
                {c.group ? `${c.group} · ${c.label}` : c.label}
              </label>
            );
          })}
          {custom && (
            <>
              <div className={s.menuSep} />
              <button type="button" role="menuitem" className={s.menuItem} onClick={act(() => save(EMPTY))}>Reset layout</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Pills and flags for a list's cells. */
export const gridPill = (text: string, alt = false): GridNode => ({ node: <span className={`${s.pill} ${alt ? s.pillAlt : ''}`}>{text}</span>, text, sort: text });
export const gridFlag = (text: string): GridNode => ({ node: <span className={s.flag}>{text}</span>, text, sort: text });
export const gridMuted = s.muted;
export const gridTick = s.tick;
