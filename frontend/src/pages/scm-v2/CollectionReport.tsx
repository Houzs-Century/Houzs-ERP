// ----------------------------------------------------------------------------
// CollectionReport — the Collection tab (owner 2026-09-12: collection report …
// salesman 开了多少单，deposit 收了多少%，overall 的，filter date，below 50% 的我
// 也需要知道; then: 分主要看两个，deposit / sales order amount，一个是看 balance
// paid). Two views over the orders opened in a period (by SO date):
//   DEPOSIT — per salesman: orders, order value, deposit collected, deposit %,
//             and how many orders sit under the threshold (default 50%);
//   BALANCE — of the delivered (or invoiced) orders: balance due after
//             deposit, balance collected, balance %, outstanding — measured
//             against the FINAL INVOICE's total when one exists (docs/bugs/
//             0831), the order's otherwise.
// A salesman opens to the orders behind the figures; "only below" narrows to
// the orders under the line.
//
// In the owner's Claude Design (batch 6 step 13, §5.7): the report shell, the
// shared range read as the SO date, View / Salesman / Threshold (10%–90% or
// Other…, any whole %) / Orders in the toolbar, the tiles of the view, the
// grid with resizable columns, an order opening its sales order, Excel / PDF /
// Print as shown and the CSV under ⋯.
// ----------------------------------------------------------------------------

import { guardFormula } from '../../lib/csv';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  useCollectionReport, type CollectionOrder, type CollectionReport, type CollectionRow,
} from '../../vendor/scm/lib/collection-report-queries';
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import { AMOUNT_COLUMN, PCT_COLUMN, type ReportSheet, type SheetColumn, type SheetRow } from '../../vendor/scm/lib/report-sheet';
import { fmtDate, fmtDateOrDash, fmtSenPlain } from '../../vendor/shared/format';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { useColumnWidths, type ColumnWidthSpec } from './finance/useColumnWidths';
import { FinanceDateRange } from './reports/FinanceDateRange';
import { useReportRange } from './reports/useReportRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportMore, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import co from './reports/Collection.module.css';

export const fmtRm = (sen: number): string => fmtSenPlain(sen);
const fmtPct = (pct: number): string => `${pct.toFixed(1)}%`;
const statusWord = (s: string): string => s.replace(/_/g, ' ').toLowerCase();

type View = 'deposit' | 'balance';
const VIEWS: ReadonlyArray<{ value: View; label: string }> = [{ value: 'deposit', label: 'Deposit' }, { value: 'balance', label: 'Balance' }];
/** The threshold's usual choices; any other whole % is Other…. */
const THRESHOLDS = [10, 20, 30, 40, 50, 60, 70, 80, 90] as const;

/* The CSV of the open view — one line per salesman, then one per order. */
export const collectionCsv = (r: CollectionReport, view: View, onlyBelow: boolean): string => {
  const esc = (v: string | number | null) => `"${guardFormula(String(v ?? '')).replace(/"/g, '""')}"`;
  const lines: string[] = [];
  if (view === 'deposit') {
    lines.push(['Salesman', 'Orders', 'Order value', 'Deposit', 'Deposit %', `Below ${r.thresholdPct}%`].map(esc).join(','));
    for (const row of [...r.rows, r.totals]) lines.push([row.salesperson, row.orders, fmtRm(row.totalSen), fmtRm(row.depositSen), fmtPct(row.depositPct), row.belowCount].map(esc).join(','));
    lines.push('');
    lines.push(['Salesman', 'SO', 'Customer', 'SO date', 'Status', 'Order value', 'Deposit', 'Deposit %', 'Outstanding'].map(esc).join(','));
    for (const row of r.rows) for (const o of row.sos.filter((x) => !onlyBelow || x.belowThreshold)) {
      lines.push([row.salesperson, o.docNo, o.customer, o.soDate, o.status, fmtRm(o.totalSen), fmtRm(o.depositSen), fmtPct(o.depositPct), fmtRm(o.outstandingSen)].map(esc).join(','));
    }
  } else {
    lines.push(['Salesman', 'Delivered orders', 'Invoiced value', 'Deposit', 'Balance due', 'Balance paid', 'Balance %', 'Outstanding'].map(esc).join(','));
    for (const row of [...r.rows, r.totals]) {
      const d = row.delivered;
      lines.push([row.salesperson, d.orders, fmtRm(d.billedSen), fmtRm(d.depositSen), fmtRm(d.balanceDueSen), fmtRm(d.balancePaidSen), fmtPct(d.balancePct), fmtRm(d.outstandingSen)].map(esc).join(','));
    }
    lines.push('');
    lines.push(['Salesman', 'SO', 'Invoice', 'Customer', 'SO date', 'Status', 'Invoiced value', 'Deposit', 'Balance due', 'Balance paid', 'Balance %', 'Outstanding'].map(esc).join(','));
    for (const row of r.rows) for (const o of row.sos.filter((x) => x.delivered)) {
      lines.push([row.salesperson, o.docNo, o.invoiceNumber ?? '', o.customer, o.soDate, o.status, fmtRm(o.billedSen), fmtRm(o.depositSen), fmtRm(o.balanceDueSen), fmtRm(o.balancePaidSen), fmtPct(o.balancePct), fmtRm(o.outstandingSen)].map(esc).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
};

const downloadText = (name: string, text: string) => {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

/** A view's grid: its heads, widths and the figures of a salesman, an order and the total. */
type ViewGrid = {
  heads: string[];
  widths: ColumnWidthSpec;
  seller: (row: CollectionRow, thresholdPct: number) => Cell[];
  order: (o: CollectionOrder) => Cell[];
  total: (row: CollectionRow) => Cell[];
  /** The orders a salesman opens to. */
  orders: (row: CollectionRow, onlyBelow: boolean) => CollectionOrder[];
  none: string;
};
type Cell = { text: string; under?: boolean; sheet: number | string | null };

const DEPOSIT: ViewGrid = {
  heads: ['Salesman / order', 'Orders', 'Order value', 'Deposit', 'Deposit %', 'Below N%'],
  widths: { defaults: ['minmax(240px,1fr)', '72px', '120px', '120px', '84px', '84px'], min: [180, 52, 90, 90, 64, 64], fit: [false, true, true, true, true, true] },
  seller: (row, t) => [
    { text: String(row.orders), sheet: String(row.orders) },
    { text: fmtRm(row.totalSen), sheet: row.totalSen },
    { text: fmtRm(row.depositSen), sheet: row.depositSen },
    { text: fmtPct(row.depositPct), under: row.depositPct < t, sheet: row.depositPct },
    { text: String(row.belowCount), under: row.belowCount > 0, sheet: String(row.belowCount) },
  ],
  order: (o) => [
    { text: '', sheet: null },
    { text: fmtRm(o.totalSen), sheet: o.totalSen },
    { text: fmtRm(o.depositSen), sheet: o.depositSen },
    { text: fmtPct(o.depositPct), under: o.belowThreshold, sheet: o.depositPct },
    { text: o.belowThreshold ? 'below' : '', under: o.belowThreshold, sheet: o.belowThreshold ? 'below' : null },
  ],
  total: (row) => [
    { text: String(row.orders), sheet: String(row.orders) },
    { text: fmtRm(row.totalSen), sheet: row.totalSen },
    { text: fmtRm(row.depositSen), sheet: row.depositSen },
    { text: fmtPct(row.depositPct), sheet: row.depositPct },
    { text: String(row.belowCount), sheet: String(row.belowCount) },
  ],
  orders: (row, onlyBelow) => row.sos.filter((o) => !onlyBelow || o.belowThreshold),
  none: 'No order under the line.',
};

const BALANCE: ViewGrid = {
  heads: ['Salesman / order', 'Delivered', 'Invoiced value', 'Deposit', 'Balance due', 'Balance paid', 'Balance %', 'Outstanding'],
  widths: { defaults: ['minmax(240px,1fr)', '80px', '120px', '112px', '112px', '112px', '84px', '112px'], min: [180, 56, 90, 80, 80, 80, 64, 80], fit: [false, true, true, true, true, true, true, true] },
  seller: (row) => {
    const d = row.delivered;
    return [
      { text: String(d.orders), sheet: String(d.orders) },
      { text: fmtRm(d.billedSen), sheet: d.billedSen },
      { text: fmtRm(d.depositSen), sheet: d.depositSen },
      { text: fmtRm(d.balanceDueSen), sheet: d.balanceDueSen },
      { text: fmtRm(d.balancePaidSen), sheet: d.balancePaidSen },
      { text: fmtPct(d.balancePct), sheet: d.balancePct },
      { text: fmtRm(d.outstandingSen), under: d.outstandingSen > 0, sheet: d.outstandingSen },
    ];
  },
  order: (o) => [
    { text: '', sheet: null },
    { text: fmtRm(o.billedSen), sheet: o.billedSen },
    { text: fmtRm(o.depositSen), sheet: o.depositSen },
    { text: fmtRm(o.balanceDueSen), sheet: o.balanceDueSen },
    { text: fmtRm(o.balancePaidSen), sheet: o.balancePaidSen },
    { text: fmtPct(o.balancePct), sheet: o.balancePct },
    { text: fmtRm(o.outstandingSen), under: o.outstandingSen > 0, sheet: o.outstandingSen },
  ],
  total: (row) => {
    const d = row.delivered;
    return [
      { text: String(d.orders), sheet: String(d.orders) },
      { text: fmtRm(d.totalSen), sheet: d.totalSen },
      { text: fmtRm(d.depositSen), sheet: d.depositSen },
      { text: fmtRm(d.balanceDueSen), sheet: d.balanceDueSen },
      { text: fmtRm(d.balancePaidSen), sheet: d.balancePaidSen },
      { text: fmtPct(d.balancePct), sheet: d.balancePct },
      { text: fmtRm(d.outstandingSen), sheet: d.outstandingSen },
    ];
  },
  orders: (row) => row.sos.filter((o) => o.delivered),
  none: 'No delivered order in the period.',
};
const GRIDS: Record<View, ViewGrid> = { deposit: DEPOSIT, balance: BALANCE };
const headOf = (h: string, thresholdPct: number): string => (h === 'Below N%' ? `Below ${thresholdPct}%` : h);

/** An order's line as the grid and the sheet name it. */
const orderName = (o: CollectionOrder): string =>
  `${o.docNo}${o.invoiceNumber ? ` · ${o.invoiceNumber}` : ''} · ${o.customer ?? '—'} · ${fmtDateOrDash(o.soDate)} · ${statusWord(o.status)}`;

/** The tiles of a view — the report's own totals. */
export function collectionTiles(r: CollectionReport, view: View, period: string): ReportTile[] {
  const t = r.totals;
  if (view === 'deposit') {
    return [
      { key: 'orders', label: 'Orders', value: String(t.orders), sub: `Opened ${period}` },
      { key: 'value', label: 'Order value', value: fmtRm(t.totalSen), sub: 'By SO date' },
      { key: 'deposit', label: 'Deposit collected', value: fmtRm(t.depositSen), sub: `${fmtPct(t.depositPct)} of order value` },
      { key: 'below', label: `Below ${r.thresholdPct}%`, value: String(t.belowCount), sub: 'orders under the line', tone: t.belowCount > 0 ? 'late' : 'plain' },
    ];
  }
  const d = t.delivered;
  return [
    { key: 'delivered', label: 'Delivered orders', value: String(d.orders), sub: 'Delivered or invoiced' },
    { key: 'invoiced', label: 'Invoiced value', value: fmtRm(d.billedSen), sub: 'Against the final invoice' },
    { key: 'paid', label: 'Balance paid', value: fmtRm(d.balancePaidSen), sub: `${fmtPct(d.balancePct)} of ${fmtRm(d.balanceDueSen)} due` },
    { key: 'outstanding', label: 'Outstanding', value: fmtRm(d.outstandingSen), sub: 'Balance still to come in', tone: d.outstandingSen > 0 ? 'late' : 'plain' },
  ];
}

const NOTES: Record<View, string> = {
  deposit: 'Deposit collected against order value, for the orders opened in the period. A salesman opens to the orders; an order opens its sales order.',
  balance: 'Of the delivered or invoiced orders: the balance after deposit and how much of it has come in — against the final invoice when there is one.',
};

/** The view as the screen shows it — the opened salesmen's orders included — for Excel and PDF. */
export function collectionSheet(r: CollectionReport, view: View, onlyBelow: boolean, open: ReadonlySet<string>, subtitle: string): ReportSheet {
  const g = GRIDS[view];
  const cols: SheetColumn[] = g.heads.slice(1).map((h) => {
    const label = headOf(h, r.thresholdPct);
    return /%$/.test(h) && h !== 'Below N%' ? PCT_COLUMN(label) : ['Orders', 'Delivered', 'Below N%'].includes(h) ? { label, kind: 'text' } : AMOUNT_COLUMN(label);
  });
  const rows: SheetRow[] = [];
  for (const row of r.rows) {
    rows.push({ kind: 'row', depth: 0, label: row.salesperson, cells: g.seller(row, r.thresholdPct).map((c) => c.sheet) });
    if (!open.has(sellerKey(row))) continue;
    for (const o of g.orders(row, onlyBelow)) rows.push({ kind: 'memo', depth: 1, label: orderName(o), cells: g.order(o).map((c) => c.sheet) });
  }
  rows.push({ kind: 'total', depth: 0, label: `Total · ${r.rows.length} salesm${r.rows.length === 1 ? 'an' : 'en'}`, cells: g.total(r.totals).map((c) => c.sheet) });
  return {
    title: `Collection · ${view === 'deposit' ? 'Deposit' : 'Balance'}`,
    subtitle,
    meta: [{ label: 'SO dates', value: `${fmtDate(r.from)} – ${fmtDate(r.to)}` }, { label: 'Threshold', value: `${r.thresholdPct}%` }],
    tables: [{ columns: cols, rows }],
    notes: [NOTES[view]],
  };
}

const sellerKey = (row: CollectionRow): string => row.salespersonId ?? `agent:${row.salesperson}`;

export const CollectionTab = () => {
  const r = useReportRange();
  const [threshold, setThreshold] = useState(50);
  const [other, setOther] = useState(false);
  const [view, setView] = useState<View>('deposit');
  const [onlyBelow, setOnlyBelow] = useState(false);
  const [salesperson, setSalesperson] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const q = useCollectionReport(r.usable ? r.from : '', r.usable ? r.to : '', threshold, salesperson);
  const d = q.data;
  const g = GRIDS[view];
  const deposit = useColumnWidths('cod', DEPOSIT.widths);
  const balance = useColumnWidths('cob', BALANCE.widths);
  const cw = view === 'deposit' ? deposit : balance;

  /* The salesmen the period had, for the filter — read off an unfiltered
     answer so picking one does not empty the list. */
  const [sellers, setSellers] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (d && salesperson == null) setSellers(d.rows.filter((x) => x.salespersonId).map((x) => ({ id: x.salespersonId as string, name: x.salesperson })));
  }, [d, salesperson]);

  const toggle = (row: CollectionRow) => setOpen((prev) => {
    const next = new Set(prev);
    const k = sellerKey(row);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const period = `${fmtDate(r.from)} – ${fmtDate(r.to)}`;
  const subtitle = r.usable
    ? `${period} · orders by SO date · ${view === 'deposit' ? `deposit against order value, below ${threshold}% marked` : 'balance against the final invoice'}`
    : 'Pick dates.';
  useReportSubtitle(subtitle);

  const thresholdChoice = other || !(THRESHOLDS as readonly number[]).includes(threshold) ? 'other' : String(threshold);

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={() => (d ? collectionSheet(d, view, onlyBelow, open, subtitle) : null)} fileBase={`collection-${view}-${r.from}-${r.to}`} />
        <ReportMore items={[{ label: 'CSV', disabled: !d, onClick: () => { if (d) downloadText(`collection-${view}-${r.from}-${r.to}.csv`, collectionCsv(d, view, onlyBelow)); } }]} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange />
        <ReportTool label="View"><Segmented options={VIEWS} value={view} onChange={setView} label="View" /></ReportTool>
        <ReportTool label="Salesman">
          <select className={co.select} value={salesperson ?? ''} onChange={(e) => setSalesperson(e.target.value || null)} aria-label="Salesman">
            <option value="">Every salesman</option>
            {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </ReportTool>
        <ReportTool label="Threshold">
          <select className={co.select} value={thresholdChoice} aria-label="Threshold"
            onChange={(e) => {
              if (e.target.value === 'other') { setOther(true); return; }
              setOther(false);
              setThreshold(Number(e.target.value));
            }}>
            {THRESHOLDS.map((t) => <option key={t} value={String(t)}>{t}%</option>)}
            <option value="other">Other…</option>
          </select>
          {thresholdChoice === 'other' && (
            <NumberInput sign="unsigned" decimal={false} value={threshold} aria-label="Deposit threshold percent" className={`${co.select} ${co.other}`}
              onValueChange={(n) => { if (n != null && n > 0 && n <= 100) setThreshold(n); }} />
          )}
        </ReportTool>
        {view === 'deposit' && (
          <ReportTool label="Orders">
            <Segmented options={[{ value: 'all', label: 'All' }, { value: 'below', label: `Only below ${threshold}%` }]} value={onlyBelow ? 'below' : 'all'}
              onChange={(v) => setOnlyBelow(v === 'below')} label="Orders" />
          </ReportTool>
        )}
      </ReportToolbar>
      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {r.usable && q.isError && <ReportMessage tone="error">The report did not load — adjust the dates to retry.</ReportMessage>}
      {r.usable && !q.isError && (
        <ReportTiles label="Collection figures" tiles={d ? collectionTiles(d, view, period) : collectionTiles(EMPTY, view, period).map((t) => ({ ...t, value: '' }))} pending={!d} />
      )}
      {r.usable && q.isLoading && <div className={`skeleton ${co.card}`} style={{ height: 240 }} aria-busy="true" aria-label="Working the period out" />}
      {d && (
        <>
          <div className={co.card}>
            <div data-cw-root={view === 'deposit' ? 'cod' : 'cob'} className={co.grid} style={{ minWidth: cw.minWidth }} role="table" aria-label={`Collection · ${view === 'deposit' ? 'Deposit' : 'Balance'}`}>
              <div data-cw-row="" className={`${co.row} ${co.head}`} style={{ gridTemplateColumns: cw.template }} role="row">
                {g.heads.map((h, i) => (
                  <div key={h} data-cw-cell={i} role="columnheader" className={`${co.headCell} ${i > 0 ? co.num : ''}`}>
                    <span data-cw-lbl="">{headOf(h, d.thresholdPct)}</span>
                    <span className={co.resize} {...cw.handle(i)}><span className={co.resizeLine} /></span>
                  </div>
                ))}
              </div>
              {d.rows.length === 0 && <p className={co.empty}>No order in the period.</p>}
              {d.rows.map((row) => {
                const isOpen = open.has(sellerKey(row));
                const orders = g.orders(row, onlyBelow);
                return (
                  <Fragment key={sellerKey(row)}>
                    <Line template={cw.template} className={`${co.seller} ${isOpen ? co.sellerOpen : ''}`} cells={g.seller(row, d.thresholdPct)} name={(
                      <button type="button" className={co.toggle} onClick={() => toggle(row)} aria-expanded={isOpen}
                        aria-label={`${isOpen ? 'Hide' : 'Show'} the orders of ${row.salesperson}`}>
                        {isOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
                        <span>{row.salesperson}</span>
                      </button>
                    )} />
                    {isOpen && orders.length === 0 && <div className={co.none} role="row"><span role="cell">{g.none}</span></div>}
                    {isOpen && orders.map((o) => (
                      <Line key={o.docNo} template={cw.template} className={co.order} cells={g.order(o)} data={{ 'data-order': o.docNo }} name={(
                        <span className={co.orderName}>
                          <FinanceDocLink to={`/scm/sales-orders/${encodeURIComponent(o.docNo)}`}>{o.docNo}</FinanceDocLink>
                          <span className={co.sub}>{o.invoiceNumber ? ` · ${o.invoiceNumber}` : ''} · {o.customer ?? '—'} · {fmtDateOrDash(o.soDate)} · {statusWord(o.status)}</span>
                        </span>
                      )} />
                    ))}
                  </Fragment>
                );
              })}
              {d.rows.length > 0 && (
                <Line template={cw.template} className={co.total} cells={g.total(d.totals)} name={`Total · ${d.rows.length} salesm${d.rows.length === 1 ? 'an' : 'en'}`} />
              )}
            </div>
          </div>
          <div className={co.foot}>
            <p className={co.note}>{NOTES[view]}</p>
            {cw.custom && <button type="button" className={co.reset} onClick={cw.reset}>Reset column widths</button>}
          </div>
        </>
      )}
    </>
  );
};

/** The skeleton's tiles: the view's labels before the figures. */
const EMPTY: CollectionReport = {
  from: '', to: '', thresholdPct: 50, rows: [],
  totals: {
    salespersonId: null, salesperson: '', orders: 0, totalSen: 0, depositSen: 0, depositPct: 0, belowCount: 0, sos: [],
    delivered: { orders: 0, totalSen: 0, billedSen: 0, depositSen: 0, balanceDueSen: 0, balancePaidSen: 0, balancePct: 0, outstandingSen: 0 },
  },
};

/** One line of the grid: its name, then the view's figures. */
function Line({ template, className, name, cells, data }: {
  template: string; className: string; name: ReactNode; cells: Cell[]; data?: Record<string, string>;
}) {
  return (
    <div data-cw-row="" className={`${co.row} ${className}`} style={{ gridTemplateColumns: template }} role="row" {...data}>
      <div role="cell" className={co.cell}>{name}</div>
      {cells.map((c, i) => (
        <div key={i} role="cell" className={`${co.cell} ${co.num} ${c.under ? co.under : ''}`}><span data-cw-lbl="">{c.text}</span></div>
      ))}
    </div>
  );
}
