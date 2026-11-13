// ----------------------------------------------------------------------------
// EventCommission — the Event Commission tab (owner 2026-10-20). For any range,
// two ways to look (「我要两个都看，一个是by fair，一个是by sales order 日期」):
//   · BY FAIR — the fairs that START in it, each with its orders' goods (its
//     Total Sales) and what its orders have earned; then what happened in the
//     range to orders of EARLIER fairs;
//   · BY SO DATE — the orders OPENED in it (their SO date), one row each; then
//     what happened in the range to orders opened EARLIER.
// An order earns its goods × the fair's brand rate once 30% of it is paid. The
// rules are the server's (backend/src/scm/lib/event-commission.ts); the sums,
// the brand filter and the exports are eventCommissionModel.ts.
//
// THE LAYOUT (owner 2026-10-21, 10-25, 10-26): the system's DataTable for every
// table (headings move and widen, columns hide, each person's layout kept), a
// column each for brand, organizer, venue and state, the earlier orders once
// per order, the upsales / drop sales in a table of their own, a fair opening to
// its orders in the page under it, every table as tall as the screen allows.
//
// Closing a month (owner 2026-10-26, 关月, Finance): a closed month is shown as
// it was closed; what later moves its orders' commission is paid in the first
// open month as that month's adjustment, one row per order.
//
// ROUND 3 (owner 2026-11-12, 做):
//   · the tiles are the export's summary lines — fair commission, upsales /
//     drop sales, late bills (补开单), earlier orders, the closed months'
//     adjustments, what last month moved here — and add up to the total;
//   · a fair's Total Sales is its orders' goods; the event page's typed figure is
//     a hidden column; fairs at one place and time sort together;
//   · By SO date is a list of orders, one row each, the fair as columns;
//   · the orders under 30% in a card of their own (「below deposit 另外分开」);
//   · Ref No., SO date, status and customer in every order table's Columns;
//   · an order number is a real link: a right-click opens a browser tab;
//   · the open fairs, the view and the brand are kept when you come back;
//   · Finance's two buttons on an order (「1个这张单不要算，1个是这个算下个月」),
//     on a whole open month, each asking for an optional reason, each undoable.
// LATER THAT DAY (owner, 做):
//   · the Upsales / Drop sales table has its own button (「这边不能按不count 吗？」
//     → 「只是改价不算」): Don't count change leaves the order's upsales / drop
//     sales of the month out — the order still earns on its original amount;
//   · the SO list shows the fair's full name beside its brand (「要有 fair full
//     name」) and the order's Sales — its total — before its Goods (「我也要看到
//     sales, 然后 goods」); a fair's own orders show Sales too.
// AND (owner, 「全部列出来，没有展会的标 No fair，要算佣金」): By SO date lists every
// order opened in the range; one with no fair sits under "No fair" with the
// venue typed on it, earning at its own brand's rate, and has a line of its own
// in the summary — Finance presses Don't count on the ones that should not earn.
// THEN (owner, 做): the earlier orders table lists only an order that reached
// 30% or was cancelled in the range (「earlier order 我只想显示reached 30% 和
// cancelled」); its price changes are the Upsales / Drop sales table's alone, so
// no change is shown twice.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Lock } from 'lucide-react';
import {
  useAddCommissionLine, useCloseCommissionMonth, useEventCommission, useMarkCommissionOrder, useRemoveCommissionLine, useReopenCommissionMonth,
  useUnmarkCommissionOrder,
  type CommissionBasis, type CommissionChange, type CommissionChangedOrder, type CommissionDeferredIn, type CommissionEarlierOrder,
  type CommissionFairRow, type CommissionManualLine, type CommissionMarkedOrder, type CommissionMarkInfo, type CommissionMarkKind, type CommissionMonthAdjustment,
  type CommissionSoRow, type EventCommission,
} from '../../vendor/scm/lib/event-queries';
import { useConfirm, usePrompt } from '../../vendor/scm/components/ConfirmDialog';
import { fmtDateOrDash, fmtDayMonthRange } from '../../vendor/shared/format';
import { DataTable, type Column } from '../../components/DataTable';
import { cn } from '../../lib/utils';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { FinanceDateRange } from './reports/FinanceDateRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportMore, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { periodLabel } from './reports/statementColumns';
import { useReportRange } from './reports/useReportRange';
import {
  BASIS_WORDS, LEFT_OUT_NOTE, NOT_COUNTED, RULE_NOTE, SUMMARY_HINT, SUMMARY_LABEL, amt, amtRm, belowDepositOf, brandsOf, changedOf, deferredInOf, isNoFair,
  earlierOf, earlierShownOf, eventCommissionCsv, eventCommissionSheet, fairPlace, fairSortKey, fmtRm, forBrand, lateOf, manualOf, markWords, markedOf, monthAdjOf,
  markMonthOf, monthLabel, monthOf, myt, nextMonthOf, sum, summaryOf, whatOf, wholeMonthOf, type BelowDepositRow,
} from './eventCommissionModel';
import ec from './EventCommission.module.css';

const downloadText = (name: string, text: string) => {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

const num = (text: string) => <span className="tabular-nums">{text}</span>;

/** An order number opens the sales order (owner 2026-11-12: 不能 right click 开新
    视窗): a plain click in the app's own tab strip, with Back; a right-click,
    middle-click or Ctrl-click is the browser's own — a new browser tab. */
const soHref = (docNo: string): string => `/scm/sales-orders/${encodeURIComponent(docNo)}`;
const OrderLink = ({ docNo }: { docNo: string }) => {
  const open = useOpenDocInTab();
  const href = soHref(docNo);
  return (
    <a href={href} className={ec.docLink} title={`Open ${docNo}`}
      onClick={(e) => {
        e.stopPropagation();
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        open(href);
      }}>{docNo}</a>
  );
};

/* ── Finance's two buttons ──────────────────────────────────────────────────── */

type MarkCtl = {
  /** One month, whole or so far, that is not closed: the buttons show. */
  canMark: boolean;
  month: string | null;
  busy: boolean;
  mark: (docNo: string, kind: CommissionMarkKind) => void;
  undo: (m: CommissionMarkInfo) => void;
};

/** Why and by whom, for a mark's hover. */
const markNote = (mark: CommissionMarkInfo): string | undefined =>
  [mark.reason, mark.markedBy ? `by ${mark.markedBy}` : null].filter(Boolean).join(' · ') || undefined;

/** The order's mark with Undo, or the two buttons; a dash when neither applies. */
const MarkCell = ({ docNo, mark, ctl }: { docNo: string; mark?: CommissionMarkInfo; ctl: MarkCtl }) => {
  if (mark) {
    return (
      <span className={ec.markTag} title={markNote(mark)}>
        {markWords(mark)}
        <button type="button" className={ec.markBtn} disabled={ctl.busy} onClick={(e) => { e.stopPropagation(); ctl.undo(mark); }}>Undo</button>
      </span>
    );
  }
  if (!ctl.canMark || !ctl.month) return <span className="text-ink-muted">–</span>;
  return (
    <span className={ec.markBtns}>
      <button type="button" className={ec.markBtn} disabled={ctl.busy} title="Do not count this order's commission"
        onClick={(e) => { e.stopPropagation(); ctl.mark(docNo, 'exclude'); }}>Don&apos;t count</button>
      <button type="button" className={ec.markBtn} disabled={ctl.busy} title={`Pay what it earns in ${monthLabel(ctl.month)} in ${monthLabel(nextMonthOf(ctl.month))}`}
        onClick={(e) => { e.stopPropagation(); ctl.mark(docNo, 'defer'); }}>Next month</button>
    </span>
  );
};
const markColumn = <R extends { docNo: string; mark?: CommissionMarkInfo }>(ctl: MarkCtl): Column<R> => ({
  key: 'actions', label: 'Actions', width: '210px', description: "Don't count this order, or pay it next month (Finance).",
  render: (r) => <MarkCell docNo={r.docNo} mark={r.mark} ctl={ctl} />, getValue: (r) => (r.mark ? markWords(r.mark) : ''),
});

/** A changed order's price change (owner 2026-11-12: 「只是改价不算」): Undo once
    it is left out (its effect cell says "not counted") — or the button that
    leaves it out. An order not counted at all has nothing more to leave out. */
const ChangeMarkCell = ({ row, ctl }: { row: CommissionChangedOrder; ctl: MarkCtl }) => {
  const left = row.changeMark;
  if (left) {
    return (
      <button type="button" className={ec.markBtn} disabled={ctl.busy} title={[markWords(left), markNote(left)].filter(Boolean).join(' · ')}
        onClick={(e) => { e.stopPropagation(); ctl.undo(left); }}>Undo</button>
    );
  }
  if (row.mark?.kind === 'exclude' || !ctl.canMark || !ctl.month) return <span className="text-ink-muted">–</span>;
  return (
    <button type="button" className={ec.markBtn} disabled={ctl.busy}
      title={`Leave its upsales / drop sales of ${monthLabel(ctl.month)} out of the commission — the order's original amount still counts`}
      onClick={(e) => { e.stopPropagation(); ctl.mark(row.docNo, 'exclude_change'); }}>Don&apos;t count change</button>
  );
};
const changeMarkColumn = (ctl: MarkCtl): Column<CommissionChangedOrder> => ({
  key: 'actions', label: 'Actions', width: '145px',
  description: "Leave this order's upsales / drop sales of the month out of the commission; its original amount still counts (Finance).",
  render: (o) => <ChangeMarkCell row={o} ctl={ctl} />, getValue: (o) => (o.changeMark ? markWords(o.changeMark) : ''),
});

/* ── Columns ──────────────────────────────────────────────────────────────── */

/* Brand, organizer, venue and state as columns (owner 2026-10-26). */
const placeColumns = <R,>(placeOf: (row: R) => ReturnType<typeof fairPlace>, w: { brand: string; organizer: string; venue: string; state: string }, dim?: (row: R) => boolean): Column<R>[] => [
  {
    key: 'brand', label: 'Brand', width: w.brand,
    render: (r) => <span className={cn('font-semibold', dim?.(r) ? 'text-ink-secondary' : 'text-ink')}>{placeOf(r).brand ?? '—'}</span>,
    getValue: (r) => placeOf(r).brand,
  },
  { key: 'organizer', label: 'Organizer', width: w.organizer, render: (r) => placeOf(r).organizer ?? '—', getValue: (r) => placeOf(r).organizer },
  { key: 'venue', label: 'Venue', width: w.venue, render: (r) => placeOf(r).venue ?? '—', getValue: (r) => placeOf(r).venue },
  { key: 'state', label: 'State', width: w.state, render: (r) => placeOf(r).state ?? '—', getValue: (r) => placeOf(r).state },
];
const hideState = <R,>(cols: Column<R>[]): Column<R>[] => cols.map((c) => (c.key === 'state' ? { ...c, defaultHidden: true } : c));

/* More of the order in the Columns (owner 2026-11-12): Ref No., SO date, status, customer. */
const refColumn = <R extends { ref?: string | null }>(hidden = false): Column<R> => ({
  key: 'ref', label: 'Ref No.', width: '105px', defaultHidden: hidden, render: (r) => r.ref ?? '—', getValue: (r) => r.ref ?? null,
});
const soDateColumn = <R extends { soDate?: string | null }>(hidden: boolean): Column<R> => ({
  key: 'soDate', label: 'SO date', width: '95px', defaultHidden: hidden,
  render: (r) => <span className="whitespace-nowrap">{fmtDateOrDash(r.soDate ?? null)}</span>, getValue: (r) => r.soDate ?? null,
});
const statusColumn = <R extends { status?: string }>(): Column<R> => ({
  key: 'status', label: 'Status', width: '110px', defaultHidden: true, render: (r) => r.status ?? '—', getValue: (r) => r.status ?? null,
});
const customerColumn = <R extends { customer: string | null }>(): Column<R> => ({
  key: 'customer', label: 'Customer', width: '140px', defaultHidden: true, render: (r) => r.customer ?? '—', getValue: (r) => r.customer,
});

/** A fair's goods (its Total Sales on this page) and those × the rate — from the
    server, or summed here for a report from before 2026-11-12. */
const goodsOf = (f: CommissionFairRow): number => f.goodsSen ?? sum(f.sos, (s) => s.goodsSen);
const estimateOf = (f: CommissionFairRow): number => f.estimateSen ?? (f.ratePct == null ? 0 : Math.round((goodsOf(f) * f.ratePct) / 100));

const fairColumns = (): Column<CommissionFairRow>[] => [
  ...placeColumns<CommissionFairRow>((f) => fairPlace(f), { brand: '100px', organizer: '150px', venue: '200px', state: '110px' }, (f) => f.sos.length === 0),
  { key: 'fair', label: 'Fair (full name)', width: '260px', defaultHidden: true, render: (f) => f.name, getValue: (f) => f.name },
  {
    key: 'dates', label: 'Dates', width: '100px',
    render: (f) => <span className="whitespace-nowrap">{fmtDayMonthRange(f.startDate, f.endDate)}</span>,
    getValue: (f) => f.startDate, sortValue: fairSortKey, exportValue: (f) => fmtDayMonthRange(f.startDate, f.endDate),
  },
  {
    key: 'rate', label: 'Rate', align: 'right', width: '70px',
    render: (f) => (f.ratePct == null ? <span className="text-ink-muted">no rate card</span> : num(`${f.ratePct}%`)),
    getValue: (f) => f.ratePct,
  },
  {
    key: 'totalSales', label: 'Total sales', align: 'right', width: '120px', description: "Its orders' goods (no delivery or service), every order that is not a draft, held or cancelled.",
    render: (f) => num(amt(goodsOf(f))), getValue: (f) => goodsOf(f), exportValue: (f) => goodsOf(f) / 100,
    total: (rows) => num(amt(sum(rows, goodsOf))),
  },
  {
    key: 'estimate', label: 'Estimate', align: 'right', width: '110px', description: 'Total sales × the rate.',
    render: (f) => num(amt(estimateOf(f))), getValue: (f) => estimateOf(f), exportValue: (f) => estimateOf(f) / 100,
    total: (rows) => num(amt(sum(rows, estimateOf))),
  },
  {
    key: 'eventSales', label: 'Event page total sales', align: 'right', width: '120px', defaultHidden: true, description: "The Total Sales typed on the event page.",
    render: (f) => num(amtRm(f.totalSalesRm)), getValue: (f) => f.totalSalesRm,
  },
  {
    key: 'orders', label: 'Orders', align: 'right', width: '70px',
    render: (f) => num(f.sos.length ? String(f.sos.length) : '–'), getValue: (f) => f.sos.length,
    total: (rows) => num(String(sum(rows, (f) => f.sos.length))),
  },
  {
    key: 'commission', label: 'Commission', align: 'right', width: '120px', description: 'What its orders earned: goods × rate, once 30% of the order is paid.',
    render: (f) => <span className="font-semibold tabular-nums">{amt(f.payableSen)}</span>, getValue: (f) => f.payableSen,
    exportValue: (f) => f.payableSen / 100,
    total: (rows) => num(fmtRm(sum(rows, (f) => f.payableSen))),
  },
];

/** Each upsale / drop sale on its own line: + in green, − in red, the day and
    how it came in after it; one that does not count is grey and says why. */
const Changes = ({ changes }: { changes: CommissionChange[] }) => (changes.length === 0
  ? <span className="text-ink-muted">—</span>
  : (
    <div className="space-y-0.5">
      {changes.map((ch, i) => (
        <div key={`${ch.date}-${i}`} className="whitespace-nowrap">
          <span className={cn('font-medium tabular-nums', ch.notCounted || ch.uncounted ? 'text-ink-muted' : ch.kind === 'upsale' ? 'text-synced' : 'text-err')}>
            {ch.kind === 'upsale' ? '+' : '−'}RM {fmtRm(Math.abs(ch.deltaGoodsSen))}
          </span>
          <span className="text-ink-muted">
            {' · '}{fmtDateOrDash(ch.date)}{ch.source === 'amendment' ? ' · amendment' : ''}
            {ch.notCounted ? ` · ${NOT_COUNTED[ch.notCounted]}` : ch.uncounted ? ` · ${LEFT_OUT_NOTE}` : ''}
          </span>
        </div>
      ))}
    </div>
  ));

/* An order's own columns — the fair's orders and the By SO date list share them. */
const orderMoneyColumns = <R extends CommissionSoRow>(): Column<R>[] => [
  {
    key: 'sales', label: 'Sales', align: 'right', description: 'The order total: its goods plus delivery and service. Paid % is of this.',
    render: (s) => num(fmtRm(s.totalSen)), getValue: (s) => s.totalSen,
    exportValue: (s) => s.totalSen / 100, total: (rows) => num(fmtRm(sum(rows, (s) => s.totalSen))),
  },
  {
    key: 'goods', label: 'Goods', align: 'right', description: 'What earns commission: the order without delivery or service.',
    render: (s) => num(fmtRm(s.goodsSen)), getValue: (s) => s.goodsSen,
    exportValue: (s) => s.goodsSen / 100, total: (rows) => num(fmtRm(sum(rows, (s) => s.goodsSen))),
  },
  {
    key: 'paid', label: 'Paid', align: 'right', render: (s) => num(fmtRm(s.paidSen)), getValue: (s) => s.paidSen,
    exportValue: (s) => s.paidSen / 100, total: (rows) => num(fmtRm(sum(rows, (s) => s.paidSen))),
  },
  {
    key: 'paidPct', label: 'Paid · % of order', align: 'right', description: 'Paid ÷ the order total. Commission is earned once it reaches 30%.',
    render: (s) => <span className={cn('tabular-nums', s.paidPct < 30 && 'text-ink-muted')}>{s.paidPct}%</span>, getValue: (s) => s.paidPct,
    total: (rows) => {
      const total = sum(rows, (s) => s.totalSen);
      return num(total > 0 ? `${(Math.round((sum(rows, (s) => s.paidSen) / total) * 1000) / 10).toFixed(1)}%` : '–');
    },
  },
  {
    key: 'reached', label: '30% reached',
    render: (s) => (s.reachedOn ? <span className="whitespace-nowrap">{fmtDateOrDash(s.reachedOn)}</span> : <span className="text-ink-muted">not yet</span>),
    getValue: (s) => s.reachedOn ?? '',
  },
  {
    key: 'commission', label: 'Commission', align: 'right',
    /* Less than goods × rate when a price change is left out: the hover says by how much. */
    render: (s) => (
      <span className="font-semibold tabular-nums" title={s.uncountedSen ? `A price change is left out: RM ${fmtRm(s.uncountedSen)} not counted` : undefined}>
        {amt(s.commissionSen)}
      </span>
    ),
    getValue: (s) => s.commissionSen,
    exportValue: (s) => s.commissionSen / 100, total: (rows) => num(fmtRm(sum(rows, (s) => s.commissionSen))),
  },
];
/* Last, after the mark: a wide cell that would push the mark off the screen. */
const changesColumn = <R extends CommissionSoRow>(): Column<R> => ({
  key: 'changes', label: 'Upsales / drop sales', render: (s) => <Changes changes={s.changes} />,
  getValue: (s) => sum(s.changes.filter((ch) => !ch.notCounted && !ch.uncounted), (ch) => ch.deltaGoodsSen),
  exportValue: (s) => s.changes.map((ch) => `${ch.kind === 'upsale' ? '+' : '-'}${fmtRm(Math.abs(ch.deltaGoodsSen))} ${ch.date}${ch.notCounted || ch.uncounted ? ' (not counted)' : ''}`).join('; '),
});

const orderColumns = (ctl: MarkCtl): Column<CommissionSoRow>[] => [
  { key: 'order', label: 'Order', render: (o) => <OrderLink docNo={o.docNo} />, getValue: (o) => o.docNo },
  refColumn<CommissionSoRow>(),
  { key: 'soDate', label: 'SO date', render: (s) => <span className="whitespace-nowrap">{fmtDateOrDash(s.soDate)}</span>, getValue: (s) => s.soDate },
  { key: 'salesperson', label: 'Salesperson', render: (s) => s.salesperson ?? '—', getValue: (s) => s.salesperson },
  { key: 'customer', label: 'Customer', render: (s) => s.customer ?? '—', getValue: (s) => s.customer },
  statusColumn<CommissionSoRow>(),
  ...orderMoneyColumns<CommissionSoRow>(),
  markColumn<CommissionSoRow>(ctl),
  changesColumn<CommissionSoRow>(),
];

/** A fair opened: one line on what its orders came to, then the orders. */
const FairOrders = ({ fair, ctl }: { fair: CommissionFairRow; ctl: MarkCtl }) => {
  const columns = useMemo(() => orderColumns(ctl), [ctl]);
  if (fair.sos.length === 0) return <div className="pl-6 text-[12px] text-ink-muted">No orders at this fair yet.</div>;
  const reached = fair.sos.filter((s) => s.reachedOn).length;
  return (
    <div className="space-y-2 pl-6">
      <div className="text-[12px] text-ink-secondary">
        <span className="font-semibold text-ink">{fair.sos.length} order{fair.sos.length === 1 ? '' : 's'}</span>
        {' · '}{reached} reached 30%{' · '}commission <span className="font-semibold tabular-nums text-ink">RM {fmtRm(fair.payableSen)}</span>
      </div>
      <DataTable<CommissionSoRow> tableId="event-commission-orders" embedded freezeHeight="off" columns={columns} rows={fair.sos} getRowKey={(s) => s.docNo} />
    </div>
  );
};

/* By SO date: one row per order, its fair as columns (owner 2026-11-12: 「by SO
   date 应该是 SO list，不要分 by fair」). */
type SoListRow = CommissionSoRow & { fair: CommissionFairRow };
const soListColumns = (ctl: MarkCtl): Column<SoListRow>[] => {
  /* "No fair": its own brand, the venue typed on the order. */
  const placeOf = (o: SoListRow) => (isNoFair(o.fair) ? { brand: o.fair.brand?.toUpperCase() ?? null, organizer: null, venue: o.venue ?? null, state: null } : fairPlace(o.fair));
  const [brand, ...place] = hideState(placeColumns<SoListRow>(placeOf, { brand: '85px', organizer: '115px', venue: '150px', state: '100px' }));
  return [
    { key: 'order', label: 'Order', width: '140px', render: (o) => <OrderLink docNo={o.docNo} />, getValue: (o) => o.docNo },
    refColumn<SoListRow>(),
    soDateColumn<SoListRow>(false),
    brand!,
    /* The fair's whole name beside its brand (owner 2026-11-12: 「要有 fair full name」). */
    { key: 'fair', label: 'Fair (full name)', width: '260px', render: (o) => <span title={o.fair.name}>{o.fair.name}</span>, getValue: (o) => o.fair.name },
    ...place,
    {
      key: 'fairDates', label: 'Fair dates', width: '100px', defaultHidden: true,
      render: (o) => <span className="whitespace-nowrap">{fmtDayMonthRange(o.fair.startDate, o.fair.endDate)}</span>,
      getValue: (o) => o.fair.startDate, exportValue: (o) => fmtDayMonthRange(o.fair.startDate, o.fair.endDate),
    },
    { key: 'salesperson', label: 'Salesperson', width: '100px', render: (s) => s.salesperson ?? '—', getValue: (s) => s.salesperson },
    customerColumn<SoListRow>(),
    statusColumn<SoListRow>(),
    ...orderMoneyColumns<SoListRow>(),
    markColumn<SoListRow>(ctl),
    changesColumn<SoListRow>(),
  ];
};

/** Original → Latest and the difference: + in green, − in red. */
const amendedCell = (sen: number) => (sen === 0
  ? <span className="text-ink-muted">–</span>
  : <span className={cn('font-medium tabular-nums', sen > 0 ? 'text-synced' : 'text-err')}>{sen > 0 ? '+' : '−'}{fmtRm(Math.abs(sen))}</span>);
const historyTag = (on: boolean) => (on ? <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-ink-muted" title="Back-filled from the order's modification history (1 September – 19 October 2026)">from history</span> : null);
const orderPlace = (o: { fairName: string; brand: string | null; organizer: string | null; venue: string | null; state: string | null }) =>
  fairPlace({ name: o.fairName, brand: o.brand, organizer: o.organizer, venue: o.venue, state: o.state });
const moneyColumns = <R extends { originalSen: number; latestSen: number; amendedSen: number }>(): Column<R>[] => [
  { key: 'original', label: 'Original', align: 'right', width: '95px', description: 'The order before the range\'s upsales / drop sales.', render: (o) => num(fmtRm(o.originalSen)), getValue: (o) => o.originalSen, exportValue: (o) => o.originalSen / 100 },
  { key: 'latest', label: 'Latest', align: 'right', width: '95px', description: 'The order at the end of the range.', render: (o) => num(fmtRm(o.latestSen)), getValue: (o) => o.latestSen, exportValue: (o) => o.latestSen / 100 },
  {
    key: 'amended', label: 'Amended', align: 'right', width: '95px', description: 'Latest − Original.',
    render: (o) => amendedCell(o.amendedSen), getValue: (o) => o.amendedSen, exportValue: (o) => o.amendedSen / 100,
    total: (rows) => amendedCell(sum(rows, (o) => o.amendedSen)),
  },
];

const earlierColumns = (ctl: MarkCtl): Column<CommissionEarlierOrder>[] => [
  { key: 'date', label: 'Date', width: '85px', render: (o) => <span className="whitespace-nowrap">{fmtDateOrDash(o.lastDate)}</span>, getValue: (o) => o.lastDate },
  { key: 'what', label: 'What', width: '150px', render: (o) => <span className="whitespace-normal">{whatOf(o)}</span>, getValue: (o) => whatOf(o) },
  { key: 'order', label: 'Order', width: '140px', render: (o) => <OrderLink docNo={o.docNo} />, getValue: (o) => o.docNo },
  refColumn<CommissionEarlierOrder>(true),
  soDateColumn<CommissionEarlierOrder>(true),
  ...hideState(placeColumns<CommissionEarlierOrder>(orderPlace, { brand: '85px', organizer: '115px', venue: '150px', state: '100px' })),
  { key: 'salesperson', label: 'Salesperson', width: '100px', render: (o) => o.salesperson ?? '—', getValue: (o) => o.salesperson },
  customerColumn<CommissionEarlierOrder>(),
  statusColumn<CommissionEarlierOrder>(),
  {
    key: 'original', label: 'Original', align: 'right', width: '95px',
    description: 'The order before the range\'s upsales / drop sales — what reaching 30% earns on, or what a cancellation takes back. Its price changes are in the Upsales / Drop sales table.',
    render: (o) => num(fmtRm(o.originalSen)), getValue: (o) => o.originalSen, exportValue: (o) => o.originalSen / 100,
  },
  { key: 'rate', label: 'Rate', align: 'right', width: '60px', render: (o) => (o.ratePct == null ? <span className="text-ink-muted">–</span> : num(`${o.ratePct}%`)), getValue: (o) => o.ratePct },
  {
    key: 'commission', label: 'Commission', align: 'right', width: '105px', description: 'Reaching 30% here: the original amount × the rate. Cancelled here: − what it had earned. Its upsales / drop sales are not in it — they are in the Upsales / Drop sales table.',
    render: (o) => <span className={cn('font-semibold tabular-nums', o.commissionSen < 0 && 'text-err')}>{fmtRm(o.commissionSen)}</span>,
    getValue: (o) => o.commissionSen, exportValue: (o) => o.commissionSen / 100,
    total: (rows) => num(fmtRm(sum(rows, (o) => o.commissionSen))),
  },
  markColumn<CommissionEarlierOrder>(ctl),
];

const changedColumns = (ctl: MarkCtl): Column<CommissionChangedOrder>[] => [
  { key: 'lastChange', label: 'Last change', width: '90px', render: (o) => <span className="whitespace-nowrap">{fmtDateOrDash(o.lastChange)}{historyTag(o.fromHistory)}</span>, getValue: (o) => o.lastChange },
  { key: 'order', label: 'Order', width: '140px', render: (o) => <OrderLink docNo={o.docNo} />, getValue: (o) => o.docNo },
  refColumn<CommissionChangedOrder>(),
  soDateColumn<CommissionChangedOrder>(true),
  ...hideState(placeColumns<CommissionChangedOrder>(orderPlace, { brand: '85px', organizer: '115px', venue: '150px', state: '100px' })),
  { key: 'salesperson', label: 'Salesperson', width: '100px', render: (o) => o.salesperson ?? '—', getValue: (o) => o.salesperson },
  customerColumn<CommissionChangedOrder>(),
  statusColumn<CommissionChangedOrder>(),
  ...moneyColumns<CommissionChangedOrder>(),
  { key: 'rate', label: 'Rate', align: 'right', width: '60px', render: (o) => (o.ratePct == null ? <span className="text-ink-muted">–</span> : num(`${o.ratePct}%`)), getValue: (o) => o.ratePct },
  {
    key: 'effect', label: 'Commission effect', align: 'right', width: '120px',
    description: 'Amended × the fair\'s brand rate, once the order has 30% paid; an old order with no fair (opened before October 2026): always. An order opened in the range: already inside its commission above, not added again.',
    render: (o) => (o.mark
      ? <span className="text-ink-muted">{markWords(o.mark)}</span>
      : o.reachedOn == null && !o.oldOrder
        ? <span className="text-ink-muted">not yet 30%</span>
        : o.changeMark && o.effectSen === 0
          ? <span className="text-ink-muted">not counted</span>
          : <span className={cn('tabular-nums', o.effectSen < 0 && 'text-err')}>{fmtRm(o.effectSen)}</span>),
    getValue: (o) => o.effectSen, exportValue: (o) => o.effectSen / 100,
    total: (rows) => num(fmtRm(sum(rows, (o) => o.effectSen))),
  },
  changeMarkColumn(ctl),
];

const MONTH_ADJ_COLUMNS: Column<CommissionMonthAdjustment>[] = [
  { key: 'month', label: 'Month', width: '85px', description: 'The closed month this belongs to.', render: (a) => <span className="whitespace-nowrap">{monthLabel(a.month)}</span>, getValue: (a) => a.month },
  { key: 'order', label: 'Order', width: '140px', render: (a) => <OrderLink docNo={a.docNo} />, getValue: (a) => a.docNo },
  /* Ref No. here too, as on every other order table (owner 2026-11-12: 「这个没有reference no. 吗？」). */
  refColumn<CommissionMonthAdjustment>(),
  soDateColumn<CommissionMonthAdjustment>(true),
  ...hideState(placeColumns<CommissionMonthAdjustment>((a) => fairPlace({ name: a.fairName, brand: a.brand }), { brand: '85px', organizer: '115px', venue: '150px', state: '100px' })),
  { key: 'salesperson', label: 'Salesperson', width: '100px', render: (a) => a.salesperson ?? '—', getValue: (a) => a.salesperson },
  customerColumn<CommissionMonthAdjustment>(),
  statusColumn<CommissionMonthAdjustment>(),
  {
    key: 'was', label: 'Paid', align: 'right', width: '95px', description: 'What that month paid for the order: as it was closed, plus adjustments paid since.',
    render: (a) => num(amt(a.wasSen)), getValue: (a) => a.wasSen, exportValue: (a) => a.wasSen / 100,
  },
  {
    key: 'now', label: 'Now', align: 'right', width: '95px', description: 'That month recalculated today.',
    render: (a) => num(amt(a.nowSen)), getValue: (a) => a.nowSen, exportValue: (a) => a.nowSen / 100,
  },
  {
    key: 'adjustment', label: 'Adjustment', align: 'right', width: '110px', description: 'Now − Paid: paid in this month.',
    render: (a) => amendedCell(a.adjustmentSen), getValue: (a) => a.adjustmentSen, exportValue: (a) => a.adjustmentSen / 100,
    total: (rows) => amendedCell(sum(rows, (a) => a.adjustmentSen)),
  },
];

const DEFERRED_COLUMNS: Column<CommissionDeferredIn>[] = [
  { key: 'month', label: 'From month', width: '90px', render: (d) => monthLabel(d.fromMonth), getValue: (d) => d.fromMonth },
  { key: 'order', label: 'Order', width: '140px', render: (d) => <OrderLink docNo={d.docNo} />, getValue: (d) => d.docNo },
  refColumn<CommissionDeferredIn>(),
  ...hideState(placeColumns<CommissionDeferredIn>(orderPlace, { brand: '85px', organizer: '115px', venue: '150px', state: '100px' })),
  { key: 'salesperson', label: 'Salesperson', width: '100px', render: (d) => d.salesperson ?? '—', getValue: (d) => d.salesperson },
  { key: 'reason', label: 'Reason', width: '180px', render: (d) => d.mark.reason ?? '—', getValue: (d) => d.mark.reason },
  {
    key: 'commission', label: 'Commission', align: 'right', width: '110px',
    render: (d) => (d.markedAgain ? <span className="text-ink-muted">{markWords(d.markedAgain)}</span> : <span className="font-semibold tabular-nums">{fmtRm(d.commissionSen)}</span>),
    getValue: (d) => d.commissionSen, exportValue: (d) => d.commissionSen / 100, total: (rows) => num(fmtRm(sum(rows, (d) => d.commissionSen))),
  },
];

const BELOW_COLUMNS: Column<BelowDepositRow>[] = [
  { key: 'order', label: 'Order', width: '140px', render: (o) => <OrderLink docNo={o.docNo} />, getValue: (o) => o.docNo },
  refColumn<BelowDepositRow>(),
  soDateColumn<BelowDepositRow>(true),
  ...hideState(placeColumns<BelowDepositRow>((o) => fairPlace(o.fair), { brand: '85px', organizer: '115px', venue: '150px', state: '100px' })),
  { key: 'salesperson', label: 'Salesperson', width: '100px', render: (o) => o.salesperson ?? '—', getValue: (o) => o.salesperson },
  customerColumn<BelowDepositRow>(),
  {
    key: 'goods', label: 'Goods', align: 'right', width: '100px', render: (o) => num(fmtRm(o.goodsSen)), getValue: (o) => o.goodsSen,
    exportValue: (o) => o.goodsSen / 100, total: (rows) => num(fmtRm(sum(rows, (o) => o.goodsSen))),
  },
  {
    key: 'total', label: 'Order total', align: 'right', width: '100px', render: (o) => num(fmtRm(o.totalSen)), getValue: (o) => o.totalSen,
    exportValue: (o) => o.totalSen / 100, total: (rows) => num(fmtRm(sum(rows, (o) => o.totalSen))),
  },
  {
    key: 'paid', label: 'Paid', align: 'right', width: '95px', render: (o) => num(fmtRm(o.paidSen)), getValue: (o) => o.paidSen,
    exportValue: (o) => o.paidSen / 100, total: (rows) => num(fmtRm(sum(rows, (o) => o.paidSen))),
  },
  { key: 'paidPct', label: 'Paid · % of order', align: 'right', width: '90px', render: (o) => num(`${o.paidPct}%`), getValue: (o) => o.paidPct },
  {
    key: 'owed', label: 'Owed for 30%', align: 'right', width: '105px', description: 'What is still to be paid before the order reaches 30% of its total.',
    render: (o) => <span className="font-semibold tabular-nums">{fmtRm(o.neededSen)}</span>, getValue: (o) => o.neededSen,
    exportValue: (o) => o.neededSen / 100, total: (rows) => num(fmtRm(sum(rows, (o) => o.neededSen))),
  },
];

const markedColumns = (ctl: MarkCtl): Column<CommissionMarkedOrder>[] => [
  { key: 'kind', label: 'Mark', width: '185px', render: (m) => markWords(m.mark), getValue: (m) => markWords(m.mark) },
  { key: 'order', label: 'Order', width: '140px', render: (m) => <OrderLink docNo={m.docNo} />, getValue: (m) => m.docNo },
  refColumn<CommissionMarkedOrder>(),
  ...hideState(placeColumns<CommissionMarkedOrder>(orderPlace, { brand: '85px', organizer: '115px', venue: '150px', state: '100px' })),
  { key: 'salesperson', label: 'Salesperson', width: '100px', render: (m) => m.salesperson ?? '—', getValue: (m) => m.salesperson },
  { key: 'reason', label: 'Reason', width: '180px', render: (m) => m.mark.reason ?? '—', getValue: (m) => m.mark.reason },
  { key: 'by', label: 'Marked by', width: '110px', render: (m) => m.mark.markedBy ?? '—', getValue: (m) => m.mark.markedBy },
  {
    key: 'commission', label: 'Not paid here', align: 'right', width: '110px', description: 'What the mark took out of this range: what the order would have earned, or what the price change left out would have moved.',
    render: (m) => num(amt(m.commissionSen)), getValue: (m) => m.commissionSen, exportValue: (m) => m.commissionSen / 100,
    total: (rows) => num(fmtRm(sum(rows, (m) => m.commissionSen))),
  },
  {
    key: 'actions', label: 'Actions', width: '90px',
    render: (m) => <button type="button" className={ec.markBtn} disabled={ctl.busy} onClick={(e) => { e.stopPropagation(); ctl.undo(m.mark); }}>Undo</button>,
  },
];

/* ── Finance's own lines (owner 2026-11-13, 「做」) ──────────────────────────── */

type LineCtl = {
  /** One month, whole or so far, that is not closed: a line can be typed and taken away. */
  canEdit: boolean;
  month: string | null;
  busy: boolean;
  remove: (m: CommissionManualLine) => void;
};

const manualColumns = (ctl: LineCtl): Column<CommissionManualLine>[] => [
  { key: 'order', label: 'Order', width: '135px', render: (m) => <OrderLink docNo={m.docNo} />, getValue: (m) => m.docNo },
  refColumn<CommissionManualLine>(),
  /* The organizer is in the Columns: a typed line reads by its order, its amount and its reason, and Remove stays in sight. */
  ...hideState(placeColumns<CommissionManualLine>(orderPlace, { brand: '85px', organizer: '115px', venue: '130px', state: '100px' }))
    .map((c) => (c.key === 'organizer' ? { ...c, defaultHidden: true } : c)),
  { key: 'salesperson', label: 'Salesperson', width: '100px', render: (m) => m.salesperson ?? '—', getValue: (m) => m.salesperson },
  {
    key: 'goods', label: 'Goods', align: 'right', width: '105px', description: 'The amount Finance typed: more than 0 adds commission, less than 0 takes it back.',
    render: (m) => <span className={cn('tabular-nums', m.goodsSen < 0 && 'text-err')}>{fmtRm(m.goodsSen)}</span>, getValue: (m) => m.goodsSen,
    exportValue: (m) => m.goodsSen / 100, total: (rows) => num(fmtRm(sum(rows, (m) => m.goodsSen))),
  },
  { key: 'rate', label: 'Rate', align: 'right', width: '60px', render: (m) => (m.ratePct == null ? <span className="text-ink-muted">–</span> : num(`${m.ratePct}%`)), getValue: (m) => m.ratePct },
  {
    key: 'commission', label: 'Commission', align: 'right', width: '105px', description: 'Goods × the order\'s own rate: its fair\'s brand, or with no fair its own brand\'s card.',
    render: (m) => <span className={cn('font-semibold tabular-nums', m.commissionSen < 0 && 'text-err')}>{fmtRm(m.commissionSen)}</span>, getValue: (m) => m.commissionSen,
    exportValue: (m) => m.commissionSen / 100, total: (rows) => num(fmtRm(sum(rows, (m) => m.commissionSen))),
  },
  { key: 'reason', label: 'Reason', width: '210px', render: (m) => m.line.reason ?? '—', getValue: (m) => m.line.reason },
  { key: 'by', label: 'Added by', width: '105px', render: (m) => m.line.addedBy ?? '—', getValue: (m) => m.line.addedBy },
  {
    key: 'actions', label: 'Actions', width: '90px',
    render: (m) => (ctl.canEdit && ctl.month === m.line.month
      ? <button type="button" className={ec.markBtn} disabled={ctl.busy} onClick={(e) => { e.stopPropagation(); ctl.remove(m); }}>Remove</button>
      : <span className="text-ink-muted">–</span>),
  },
];

/** Finance types a line: the order, an amount of goods (less than 0 takes back) and why. */
const AddLineForm = ({ month, busy, onAdd, onCancel }: {
  month: string; busy: boolean; onAdd: (line: { docNo: string; goodsSen: number; reason: string }) => void; onCancel: () => void;
}) => {
  const [docNo, setDocNo] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const goodsSen = Math.round(Number(amount.replace(/,/g, '').trim()) * 100);
  const ready = docNo.trim() !== '' && amount.trim() !== '' && Number.isFinite(goodsSen) && goodsSen !== 0 && reason.trim() !== '';
  /* The card sits far down the page, and the header's menu opens the form from
     the top of it: the press looked as if it had done nothing (owner 2026-11-13,
     「我要如何add?」). The form comes into view and the cursor waits in its first box. */
  const formRef = useRef<HTMLFormElement>(null);
  const orderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = formRef.current;
    /* jsdom has no scrollIntoView: asked for, not assumed. */
    if (form && 'scrollIntoView' in form) form.scrollIntoView({ block: 'center' });
    orderRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <form ref={formRef} className={ec.lineForm} aria-label={`Add a line for ${monthLabel(month)}`}
      onSubmit={(e) => { e.preventDefault(); if (ready && !busy) onAdd({ docNo: docNo.trim().toUpperCase(), goodsSen, reason: reason.trim() }); }}>
      <label className={ec.field}>
        <span className={ec.fieldLabel}>Order</span>
        <input ref={orderRef} className={ec.input} value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="HC-SO-…" autoComplete="off" />
      </label>
      <label className={ec.field}>
        <span className={ec.fieldLabel}>Goods (RM)</span>
        <input className={ec.input} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="800.00 · -800.00 takes back" autoComplete="off" />
      </label>
      <label className={cn(ec.field, ec.fieldWide)}>
        <span className={ec.fieldLabel}>Reason</span>
        <input className={ec.input} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. raised before the order came into the ERP" autoComplete="off" />
      </label>
      <div className={ec.formBtns}>
        <button type="submit" className={ec.closeBtn} disabled={!ready || busy}>{busy ? 'Adding…' : `Add to ${monthLabel(month)}`}</button>
        <button type="button" className={ec.markBtn} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
};

/* ── Closing a month ──────────────────────────────────────────────────────── */

/** Where the range stands on closing (owner 2026-10-26, 关月): the months closed,
    the latest of them, and whether the range is the whole month next in line
    and has ended (Close) or the latest closed month (Reopen). Finance only —
    the server refuses anyone else. */
function closeState(r: EventCommission, range: { from: string; to: string }) {
  const months = r.closes?.months ?? [];
  const latest = months.length > 0 ? months[months.length - 1]! : null;
  const whole = wholeMonthOf(range);
  const overlap = months.filter((m) => `${m}-01` <= range.to && monthOf(`${m}-01`).to >= range.from);
  const nextUp = latest ? monthOf(`${latest}-01`, 1).from.slice(0, 7) : whole;
  return {
    latest, overlap,
    closeMonth: !r.closed && whole != null && whole === nextUp && monthOf(`${whole}-01`).to < myt() ? whole : null,
    reopenMonth: r.closed && latest === r.closed.month ? r.closed.month : null,
  };
}

/** The month close's line under the toolbar: a closed month as closed, else which months are. */
const MonthCloseNote = ({ r, range }: { r: EventCommission; range: { from: string; to: string } }) => {
  const st = closeState(r, range);
  if (r.closed) {
    const next = monthOf(`${r.closed.month}-01`, 1).from.slice(0, 7);
    return (
      <div className={`${ec.closeNote} ${ec.closeNoteClosed}`}>
        <Lock size={14} strokeWidth={1.75} className={ec.closeIcon} aria-hidden />
        <span><span className={ec.strong}>{monthLabel(r.closed.month)} is closed</span>
          {' — '}{fmtDateOrDash(new Date(Date.parse(r.closed.closedAt) + 8 * 3600_000).toISOString().slice(0, 10))}{r.closed.closedBy ? ` by ${r.closed.closedBy}` : ''}.
          {' '}These are its figures as closed; what changes for its orders later is paid in {monthLabel(next)}.</span>
      </div>
    );
  }
  return (
    <div className={ec.closeNote}>
      <Lock size={13} strokeWidth={1.75} aria-hidden />
      <span>{st.latest ? `Closed up to ${monthLabel(st.latest)}.` : 'No month closed yet.'}</span>
      {st.overlap.length > 0 && <span>This range takes in {st.overlap.map(monthLabel).join(', ')} — recalculated here, not as closed.</span>}
    </div>
  );
};

/** Close / Reopen, in the header before Excel (the redesign keeps the month close where Finance reaches it). */
const MonthCloseAction = ({ r, range }: { r: EventCommission; range: { from: string; to: string } }) => {
  const askConfirm = useConfirm();
  const close = useCloseCommissionMonth();
  const reopen = useReopenCommissionMonth();
  const st = closeState(r, range);
  if (st.reopenMonth) {
    const month = st.reopenMonth;
    const next = monthOf(`${month}-01`, 1).from.slice(0, 7);
    return (
      <button type="button" className={ec.closeBtn} disabled={reopen.isPending} onClick={() => {
        void askConfirm({
          title: `Reopen ${monthLabel(month)}?`,
          body: `It is recalculated from today's data again, and ${monthLabel(next)} stops carrying its adjustments until it is closed again.`,
          confirmLabel: 'Reopen',
        }).then((ok) => { if (ok) reopen.mutate(month); });
      }}>
        <Lock size={14} strokeWidth={1.75} aria-hidden />{reopen.isPending ? 'Reopening…' : `Reopen ${monthLabel(month)}`}
      </button>
    );
  }
  if (!st.closeMonth) return null;
  const month = st.closeMonth;
  return (
    <button type="button" className={ec.closeBtn} disabled={close.isPending} onClick={() => {
      void askConfirm({
        title: `Close ${monthLabel(month)}?`,
        body: `Its commission is kept as it stands now — RM ${fmtRm(r.totals.totalSen)} on this view. From then on it never changes: what changes for its orders later is paid in the next month as an adjustment.`,
        confirmLabel: `Close ${monthLabel(month)}`,
      }).then((ok) => { if (ok) close.mutate(month); });
    }}>
      <Lock size={14} strokeWidth={1.75} aria-hidden />{close.isPending ? 'Closing…' : `Close ${monthLabel(month)}`}
    </button>
  );
};

/** A part of the report as a card: its title, a grey hint, then the table. */
const Card = ({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) => (
  <section className={ec.card} aria-label={title}>
    <div className={ec.cardHead}><h3 className={ec.cardTitle}>{title}</h3>{hint && <span className={ec.cardHint}>{hint}</span>}</div>
    <div className={ec.cardBody}>{children}</div>
  </section>
);

/* ── What is kept when you come back (owner 2026-11-12: 打开后返回会关掉原本打开的) ── */

/** sessionStorage, this browser tab only (lib/browserStorageRegistry.ts): the view,
    the brand, the folded fairs and which fairs are open, per range and view. */
const VIEW_KEY = 'houzs.eventCommission.v1';
type SavedView = { basis?: CommissionBasis; brand?: string; showIdle?: boolean; open?: Record<string, string[]> };
const readView = (): SavedView => {
  try {
    const raw = sessionStorage.getItem(VIEW_KEY);
    return raw ? (JSON.parse(raw) as SavedView) : {};
  } catch {
    return {};
  }
};
const writeView = (v: SavedView) => {
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    /* Storage refused (private window): the page still works, it just forgets. */
  }
};

const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export const EventCommissionTab = () => {
  const range = useReportRange();
  const [saved] = useState(readView);
  const [basis, setBasis] = useState<CommissionBasis>(saved.basis ?? 'fair');
  const [brand, setBrand] = useState(saved.brand ?? '');
  const [openByRange, setOpenByRange] = useState<Record<string, string[]>>(saved.open ?? {});
  const [showIdle, setShowIdle] = useState(saved.showIdle ?? false);
  useEffect(() => { writeView({ basis, brand, showIdle, open: openByRange }); }, [basis, brand, showIdle, openByRange]);
  const viewKey = `${range.from}|${range.to}|${basis}`;
  const open = useMemo(() => new Set(openByRange[viewKey] ?? []), [openByRange, viewKey]);
  const setOpen = (next: Set<string>) => setOpenByRange((prev) => ({ ...prev, [viewKey]: [...next] }));
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOpen(next);
  };

  const q = useEventCommission(range.from, range.to, basis);
  const full = q.data;
  const brands = useMemo(() => brandsOf(full), [full]);
  const brandNow = brands.includes(brand) ? brand : '';
  /* One filtered report feeds the tiles, every table and the exports. */
  const r = useMemo(() => (full ? forBrand(full, brandNow) : undefined), [full, brandNow]);
  const words = BASIS_WORDS[basis];
  const byFair = basis === 'fair';

  /* Finance's two buttons: on one month (whole, or so far) that is not closed. */
  const askReason = usePrompt();
  const askConfirm = useConfirm();
  const { mutate: markMutate, isPending: marking } = useMarkCommissionOrder();
  const { mutate: unmarkMutate, isPending: unmarking } = useUnmarkCommissionOrder();
  const { mutate: addLine, isPending: adding } = useAddCommissionLine();
  const { mutate: removeLine, isPending: removing } = useRemoveCommissionLine();
  const [addOpen, setAddOpen] = useState(false);
  const month = range.usable ? markMonthOf(range) : null;
  const canMark = month != null && full != null && !full.closed && !(full.closes?.months ?? []).includes(month);
  const busy = marking || unmarking;
  const ctl = useMemo<MarkCtl>(() => ({
    canMark, month, busy,
    mark: (docNo, kind) => {
      if (!month) return;
      const next = monthLabel(nextMonthOf(month));
      const ask = kind === 'exclude'
        ? { title: `Don't count ${docNo}?`, body: 'It earns no commission in any month until the mark is taken away. Its row stays, marked.', confirmLabel: "Don't count" }
        : kind === 'defer'
          ? { title: `Pay ${docNo} in ${next}?`, body: `What it earns in ${monthLabel(month)} is paid in ${next} instead.`, confirmLabel: `Pay in ${next}` }
          : {
            title: `Don't count the price change of ${docNo}?`,
            body: `Its upsales and drop sales of ${monthLabel(month)} move no commission, now or later. The order's original amount still counts.`,
            confirmLabel: "Don't count change",
          };
      void askReason({ ...ask, input: { label: 'Reason (optional)', placeholder: 'e.g. price to check with the salesperson' } }).then((reason) => {
        if (reason == null) return;
        markMutate({ docNo, kind, ...(kind === 'exclude' ? {} : { month }), reason: reason.trim() || null });
      });
    },
    undo: (m) => {
      void askConfirm({
        title: `Take away "${markWords(m)}"?`,
        body: m.kind === 'exclude_change' ? 'The price change counts again, in the month it was made.' : 'The order counts again in the month it belongs to.',
        confirmLabel: 'Take away',
      }).then((ok) => { if (ok) unmarkMutate(m.id); });
    },
  }), [canMark, month, busy, askReason, askConfirm, markMutate, unmarkMutate]);

  const active = r ? r.fairs.filter((f) => f.sos.length > 0) : [];
  const idle = r ? r.fairs.filter((f) => f.sos.length === 0) : [];
  const fairCols = useMemo(() => fairColumns(), []);
  const soListCols = useMemo(() => soListColumns(ctl), [ctl]);
  const earlierCols = useMemo(() => earlierColumns(ctl), [ctl]);
  const changedCols = useMemo(() => changedColumns(ctl), [ctl]);
  const markedCols = useMemo(() => markedColumns(ctl), [ctl]);
  /* Finance's own lines: typed and taken away on the month the marks act on. */
  const lineCtl = useMemo<LineCtl>(() => ({
    canEdit: canMark, month, busy: adding || removing,
    remove: (m) => {
      void askConfirm({
        title: `Take the line on ${m.docNo} away?`,
        body: `Goods ${fmtRm(m.goodsSen)} for ${monthLabel(m.line.month)} is no longer paid.`,
        confirmLabel: 'Take away',
      }).then((ok) => { if (ok) removeLine(m.line.id); });
    },
  }), [canMark, month, adding, removing, askConfirm, removeLine]);
  const manualCols = useMemo(() => manualColumns(lineCtl), [lineCtl]);
  const soList = useMemo<SoListRow[]>(() => (r ? r.fairs.flatMap((f) => f.sos.map((s) => ({ ...s, fair: f }))) : []), [r]);
  const earlierRows = r ? earlierShownOf(r) : [];
  const changedRows = r ? changedOf(r) : [];
  const monthAdjRows = r ? monthAdjOf(r) : [];
  const deferredRows = r ? deferredInOf(r) : [];
  const markedRows = r ? markedOf(r) : [];
  const manualRows = r ? manualOf(r) : [];
  const belowRows = useMemo(() => (r ? belowDepositOf(r) : []), [r]);
  const summary = useMemo(() => (r ? summaryOf(r) : null), [r]);
  const noFairCount = soList.filter((s) => isNoFair(s.fair)).length;
  const lateCount = useMemo(() => {
    if (!r) return 0;
    const late = lateOf(r);
    return new Set([...soList, ...earlierOf(r)].map((o) => o.docNo).filter((d) => late.has(d))).size;
  }, [r, soList]);
  const period = range.usable ? periodLabel(range.from, range.to) : '';
  useReportSubtitle(range.usable ? `${period} · ${words.toggle.toLowerCase()} · ${brandNow || 'all brands'}` : 'Pick dates.');
  const fileBase = `event-commission-${byFair ? 'by-fair' : 'by-so-date'}${brandNow ? `-${brandNow.toLowerCase()}` : ''}-${range.from}-${range.to}`;

  const tiles: ReportTile[] = r && summary ? [
    { key: 'total', label: 'Total commission', value: fmtRm(r.totals.totalSen), sub: brandNow || 'all brands', tone: 'good' },
    { key: 'fair', label: SUMMARY_LABEL.fair, value: fmtRm(summary.fair), sub: n(soList.filter((s) => !isNoFair(s.fair)).length, 'order') },
    ...(noFairCount > 0 ? [{ key: 'noFair', label: SUMMARY_LABEL.noFair, value: fmtRm(summary.noFair), sub: n(noFairCount, 'order') }] : []),
    { key: 'changes', label: SUMMARY_LABEL.changes, value: fmtRm(summary.changes), sub: n(changedRows.length, 'order') },
    { key: 'late', label: SUMMARY_LABEL.late, value: fmtRm(summary.late), sub: n(lateCount, 'order') },
    { key: 'earlier', label: words.earlier, value: fmtRm(summary.earlier), sub: n(earlierRows.length, 'order') },
    ...(monthAdjRows.length > 0 ? [{
      key: 'monthAdj', label: 'Closed months — adjustments', value: fmtRm(summary.monthAdj),
      sub: `${n(monthAdjRows.length, 'order')} · ${[...new Set(monthAdjRows.map((a) => monthLabel(a.month)))].join(', ')}`,
    }] : []),
    ...(deferredRows.length > 0 ? [{ key: 'deferredIn', label: SUMMARY_LABEL.deferredIn, value: fmtRm(summary.deferredIn), sub: n(deferredRows.length, 'order') }] : []),
    ...(manualRows.length > 0 ? [{ key: 'manual', label: SUMMARY_LABEL.manual, value: fmtRm(summary.manual ?? 0), sub: n(manualRows.length, 'line') }] : []),
  ] : [];

  return (
    <>
      <ReportHeaderActions>
        {full && range.usable && <MonthCloseAction r={full} range={range} />}
        <ReportExports sheet={() => (r ? eventCommissionSheet(r, period, brandNow) : null)} fileBase={fileBase} />
        <ReportMore items={[
          { label: 'CSV', disabled: !r, onClick: () => { if (r) downloadText(`${fileBase}.csv`, eventCommissionCsv(r)); } },
          ...(canMark ? [{ label: 'Add a line (Finance)', onClick: () => setAddOpen(true) }] : []),
        ]} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange />
        <ReportTool label="View">
          <Segmented<CommissionBasis> options={[{ value: 'fair', label: BASIS_WORDS.fair.toggle }, { value: 'so_date', label: BASIS_WORDS.so_date.toggle }]}
            value={basis} onChange={setBasis} label="View" />
        </ReportTool>
        {brands.length > 1 && (
          <ReportTool label="Brand">
            <Segmented<string> options={[{ value: '', label: 'All brands' }, ...brands.map((b) => ({ value: b, label: b }))]} value={brandNow} onChange={setBrand} label="Brand" />
          </ReportTool>
        )}
      </ReportToolbar>

      {full && range.usable && <MonthCloseNote r={full} range={range} />}
      {!range.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {q.isLoading && (
        <div className={ec.skeleton} aria-label="Reading the orders">
          {[0, 1, 2].map((i) => <div key={i} className={`skeleton ${ec.skeletonBar}`} style={{ width: `${90 - i * 14}%` }} />)}
        </div>
      )}
      {q.isError && <ReportMessage tone="error">The report could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</ReportMessage>}

      {r && <ReportTiles tiles={tiles} label="Totals" />}

      {r && (
        <Card title={words.part1} hint={`as at ${fmtDateOrDash(r.to)} · amounts in RM${canMark ? " · Finance: Don't count / Next month on each order" : ''}`}>
          {r.fairs.length === 0 ? <p className={ec.empty}>{words.part1Empty}</p> : byFair ? (
            <>
              <DataTable<CommissionFairRow>
                tableId="event-commission-fairs" exportName={`event-commission-fairs-${range.from}-${range.to}`} freezeHeight="screen"
                columns={fairCols} rows={showIdle ? [...active, ...idle] : active} getRowKey={(f) => f.id}
                emptyLabel="Every fair in this range has no orders yet."
                onRowClick={(f) => toggle(String(f.id))}
                expandable={{ render: (f) => <FairOrders fair={f} ctl={ctl} />, rowKey: (f) => String(f.id), expandedIds: open, onExpandedChange: setOpen }}
              />
              {idle.length > 0 && (
                <button type="button" className={ec.idle} aria-expanded={showIdle} onClick={() => setShowIdle((v) => !v)}>
                  {showIdle ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                  {n(idle.length, 'fair')} with no orders yet
                </button>
              )}
            </>
          ) : (
            <DataTable<SoListRow>
              tableId="event-commission-so-list" exportName={`event-commission-orders-${range.from}-${range.to}`} freezeHeight="screen"
              columns={soListCols} rows={soList} getRowKey={(o) => o.docNo}
            />
          )}
        </Card>
      )}

      {r && (
        <Card title={words.part2} hint="one row per order · their upsales / drop sales are in the Upsales / Drop sales table · amounts in RM">
          {earlierRows.length === 0 ? <p className={ec.empty}>{words.part2Empty}</p> : (
            <DataTable<CommissionEarlierOrder>
              tableId="event-commission-earlier-orders" exportName={`event-commission-earlier-${range.from}-${range.to}`} freezeHeight="screen"
              columns={earlierCols} rows={earlierRows} getRowKey={(o) => o.docNo}
            />
          )}
        </Card>
      )}

      {r && monthAdjRows.length > 0 && (
        <Card title="Closed months — adjustments" hint="what changed for a closed month's orders after it closed · paid in this month · amounts in RM">
          <DataTable<CommissionMonthAdjustment>
            tableId="event-commission-month-adjustments" exportName={`event-commission-month-adjustments-${range.from}-${range.to}`} freezeHeight="screen"
            columns={MONTH_ADJ_COLUMNS} rows={monthAdjRows} getRowKey={(a) => `${a.month}-${a.docNo}`}
          />
        </Card>
      )}

      {r && deferredRows.length > 0 && (
        <Card title={SUMMARY_LABEL.deferredIn} hint={`${SUMMARY_HINT.deferredIn} (「这个算下个月」) · paid in this month · amounts in RM`}>
          <DataTable<CommissionDeferredIn>
            tableId="event-commission-moved-in" exportName={`event-commission-moved-in-${range.from}-${range.to}`} freezeHeight="screen"
            columns={DEFERRED_COLUMNS} rows={deferredRows} getRowKey={(d) => `${d.fromMonth}-${d.docNo}`}
          />
        </Card>
      )}

      {r && month && (manualRows.length > 0 || (addOpen && canMark)) && (
        <Card title={SUMMARY_LABEL.manual} hint={`${SUMMARY_HINT.manual} · amounts in RM`}>
          {addOpen && canMark && (
            <AddLineForm month={month} busy={adding} onCancel={() => setAddOpen(false)}
              onAdd={(line) => addLine({ ...line, month }, { onSuccess: () => setAddOpen(false) })} />
          )}
          {manualRows.length > 0 && (
            <DataTable<CommissionManualLine>
              tableId="event-commission-finance-lines" exportName={`event-commission-finance-lines-${range.from}-${range.to}`} freezeHeight="screen"
              columns={manualCols} rows={manualRows} getRowKey={(m) => m.line.id}
            />
          )}
          {canMark && !addOpen && (
            <button type="button" className={ec.idle} onClick={() => setAddOpen(true)}>+ Add a line for {monthLabel(month)}</button>
          )}
        </Card>
      )}
      {r && !month && manualRows.length > 0 && (
        <Card title={SUMMARY_LABEL.manual} hint={`${SUMMARY_HINT.manual} · amounts in RM`}>
          <DataTable<CommissionManualLine>
            tableId="event-commission-finance-lines" exportName={`event-commission-finance-lines-${range.from}-${range.to}`} freezeHeight="screen"
            columns={manualCols} rows={manualRows} getRowKey={(m) => m.line.id}
          />
        </Card>
      )}

      {r && (
        <Card title="Upsales / Drop sales"
          hint={`each order once, its final amount in the range · the effect is already inside the commission above${canMark ? " · Finance: Don't count change leaves the price change out, the original amount still counts" : ''}`}>
          {changedRows.length === 0 ? <p className={ec.empty}>No upsale or drop sale in this range.</p> : (
            <DataTable<CommissionChangedOrder>
              tableId="event-commission-changes" exportName={`event-commission-upsales-drops-${range.from}-${range.to}`} freezeHeight="screen"
              columns={changedCols} rows={changedRows} getRowKey={(o) => o.docNo}
            />
          )}
        </Card>
      )}

      {r && belowRows.length > 0 && (
        <Card title="Below 30% paid" hint="these orders earn nothing until 30% of the order is paid · amounts in RM">
          <DataTable<BelowDepositRow>
            tableId="event-commission-below-deposit" exportName={`event-commission-below-30-${range.from}-${range.to}`} freezeHeight="screen"
            columns={BELOW_COLUMNS} rows={belowRows} getRowKey={(o) => o.docNo}
          />
        </Card>
      )}

      {r && markedRows.length > 0 && (
        <Card title="Marked — not paid here" hint="Finance's marks: not counted, a price change left out, or paid next month · not in the total above · amounts in RM">
          <DataTable<CommissionMarkedOrder>
            tableId="event-commission-marked" exportName={`event-commission-marked-${range.from}-${range.to}`} freezeHeight="screen"
            columns={markedCols} rows={markedRows} getRowKey={(m) => m.mark.id}
          />
        </Card>
      )}
      {r && <p className={ec.notes}>{RULE_NOTE}</p>}
    </>
  );
};
