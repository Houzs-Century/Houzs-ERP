// ----------------------------------------------------------------------------
// EventCommission — the Event Commission tab (owner 2026-10-20). For any range,
// two ways to look (「我要两个都看，一个是by fair，一个是by sales order 日期」):
//   · BY FAIR — the fairs that START in it, each with the event page's Total
//     Sales and Commission (the estimate) and what its orders have actually
//     earned; then what happened in the range to orders of EARLIER fairs;
//   · BY SO DATE — the orders OPENED in it (their SO date), grouped under their
//     fairs; then what happened in the range to orders opened EARLIER.
// An order earns its goods × the fair's brand rate once 30% of it is paid; a
// fair opens to each order with its upsales / drop sales. The rules are the
// server's (backend/src/scm/lib/event-commission.ts). Export writes both parts
// as CSV.
//
// THE LAYOUT (owner 2026-10-21: 这个页面优化，很乱 → 1 可以，2 不要，3 要，做，
// 要有header): the totals as four cards, Total commission first; each fair named
// on two lines ("[AKEMI] BIGHOME" over "MID VALLEY · Kuala Lumpur"); the fairs
// with no orders yet folded away at the bottom; a brand filter that every card,
// table and the export follow; amounts without "RM" and a dash for nothing; the
// column headings stay on screen while the list scrolls. Since 2026-10-25 (这个
// header，table 要和 pv 那边一样能调整，能换位 / 这个点开排版好看一点) every table
// is the system's DataTable — headings move and widen, columns hide, each person's
// layout kept — and a fair opens to its orders in a compact one, Paid and Paid %
// apart, upsales in green and drops in red, its own subtotal at the foot.
//
// 2026-10-26 (owner: 做宽一点 / brand, organizer, venue 全部一个column / earlier
// fairs 要有original amount, latest amount, amended amount / upsales 和 drop sales
// 在哪里？ / 一张单改了两次我不理，我看final结果): every table fits the page —
// set widths, a column each for Brand, Organizer, Venue and State; the earlier
// orders read once per order (Original → Latest, Amended, the commission they
// moved); and a third table lists every order whose goods the range changed, once,
// its final result, the effect at the fair's brand rate. An order changed only on
// its opening day is not an upsale or drop and is not listed (「可以」).
//
// Closing a month (owner 2026-10-26, 关月, Finance): once a month's commission is
// paid it never changes. Finance closes it (months close in order, each once it
// has ended) and the page shows it as it was closed from then on. What later
// moves its orders' commission — a payment dated back into it, a payment
// deleted, an order moved to another fair or put on hold — is paid in the first
// open month, in its own table, one row per order (「X 月调整」).
//
// Every table fills the screen (owner 2026-10-26: 这个可以做宽一点吗？ → 做): a
// page of four stacked tables left each frozen one at the six-row minimum; each
// is now as tall as the screen allows, its heading still frozen, and a fair's
// orders open in the page under it rather than in a box of their own.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Lock } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useCloseCommissionMonth, useEventCommission, useReopenCommissionMonth,
  type CommissionAdjustment, type CommissionBasis, type CommissionChange, type CommissionChangedOrder, type CommissionEarlierOrder,
  type CommissionFairRow, type CommissionMonthAdjustment, type CommissionSoRow, type EventCommission,
} from '../../vendor/scm/lib/event-queries';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { fmtDateOrDash, fmtDayMonthRange } from '../../vendor/shared/format';
import { DateField } from '../../vendor/scm/components/DateField';
import { Panel, Toggle } from '../../components/scm-v2/OverviewKit';
import { DataTable, type Column } from '../../components/DataTable';
import { cn } from '../../lib/utils';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthOf = (day: string, shift = 0): { from: string; to: string } => {
  const [y, m] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y!, m! - 1 + shift, 1));
  const last = new Date(Date.UTC(y!, m! + shift, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
};

/** "2026-09" → "2026/09": a month in the one date format (year first, numeric). */
export const monthLabel = (month: string): string => month.replace('-', '/');
/** The one calendar month [from, to] is, if it is exactly one. */
export const wholeMonthOf = (range: { from: string; to: string }): string | null => {
  const m = range.from.slice(0, 7);
  return range.from === `${m}-01` && range.to === monthOf(range.from).to ? m : null;
};

const fmtRm = (sen: number): string => {
  const text = (Math.abs(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${text})` : text;
};
const fmtRmWhole = (rm: number | null): string => (rm == null ? '—' : fmtRm(Math.round(rm * 100)));
/** A table amount: a dash for nothing, so the figures that matter stand out. */
const amt = (sen: number | null): string => (sen == null || sen === 0 ? '–' : fmtRm(sen));
const amtRm = (rm: number | null): string => (rm == null ? '–' : amt(Math.round(rm * 100)));

export const KIND_LABEL: Record<CommissionAdjustment['kind'], string> = {
  reached: 'Reached 30%', upsale: 'Upsale', drop: 'Drop sale', cancelled: 'Cancelled',
};
const NOT_COUNTED: Record<NonNullable<CommissionChange['notCounted']>, string> = {
  opening_day: 'opening-day fix, not counted', first_price: 'priced after opening, not counted',
  system_fix: 'system price fix, not counted',
};

/* The words each basis puts on the page. */
export const BASIS_WORDS: Record<CommissionBasis, { toggle: string; part1: string; part1Empty: string; part2: string; part2Empty: string; inRange: string; earlier: string }> = {
  fair: {
    toggle: 'By fair', part1: 'Fairs starting in the range', part1Empty: 'No fair starts in this range.',
    part2: 'Earlier fairs — each order, what happened in the range', part2Empty: 'Nothing on earlier fairs in this range.',
    inRange: 'Fairs in the range', earlier: 'Earlier fairs',
  },
  so_date: {
    toggle: 'By SO date', part1: 'Orders opened in the range (SO date), by fair', part1Empty: 'No order with a fair was opened in this range.',
    part2: 'Earlier orders — each order, what happened in the range', part2Empty: 'Nothing on earlier orders in this range.',
    inRange: 'Orders opened in the range', earlier: 'Earlier orders',
  },
};

/* A report from a server older than the toggle carries no basis — it is by fair. */
export const basisOf = (r: EventCommission): CommissionBasis => r.basis ?? 'fair';

/* Both parts as CSV: each fair, its orders beneath it; then the earlier lines. */
export const eventCommissionCsv = (r: EventCommission): string => {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const row = (cells: Array<string | number | null>) => cells.map(esc).join(',');
  const byFair = basisOf(r) === 'fair';
  const lines = [row(['Fair', 'Dates', 'Rate %', 'Total Sales', 'Estimate', 'Order', 'SO date', 'Salesperson', 'Goods', 'Paid %', '30% reached', 'Commission'])];
  for (const f of r.fairs) {
    lines.push(row([f.name, fmtDayMonthRange(f.startDate, f.endDate), f.ratePct, byFair ? fmtRmWhole(f.totalSalesRm) : '', byFair ? fmtRmWhole(f.estimateRm) : '', '', '', '', '', '', '', fmtRm(f.payableSen)]));
    for (const s of f.sos) lines.push(row(['', '', '', '', '', s.docNo, s.soDate ?? '', s.salesperson, fmtRm(s.goodsSen), s.paidPct, s.reachedOn ?? 'not yet', fmtRm(s.commissionSen)]));
  }
  lines.push('', row([BASIS_WORDS[basisOf(r)].earlier, 'Date', 'What', 'Order', 'Salesperson', 'Original', 'Latest', 'Amended', 'Commission']));
  for (const o of earlierOf(r)) {
    lines.push(row([o.fairName, o.lastDate, whatOf(o), o.docNo, o.salesperson, fmtRm(o.originalSen), fmtRm(o.latestSen), fmtRm(o.amendedSen), fmtRm(o.commissionSen)]));
  }
  lines.push('', row(['Upsales / drop sales', 'Last change', 'Order', 'Salesperson', 'Original', 'Latest', 'Amended', 'Rate %', 'Commission effect']));
  for (const o of changedOf(r)) {
    lines.push(row([o.fairName, o.lastChange, o.docNo, o.salesperson, fmtRm(o.originalSen), fmtRm(o.latestSen), fmtRm(o.amendedSen), o.ratePct, fmtRm(o.effectSen)]));
  }
  if (monthAdjOf(r).length > 0) {
    lines.push('', row(['Closed months — adjustments', 'Month', 'Order', 'Salesperson', 'Was', 'Now', 'Adjustment']));
    for (const a of monthAdjOf(r)) lines.push(row([a.fairName, a.month, a.docNo, a.salesperson, fmtRm(a.wasSen), fmtRm(a.nowSen), fmtRm(a.adjustmentSen)]));
  }
  lines.push('', row(['Total', '', '', '', '', '', '', '', fmtRm(r.totals.totalSen)]));
  return `${lines.join('\n')}\n`;
};

/* A report from a server before 2026-10-26 has no per-order lists — read as empty. */
export const earlierOf = (r: EventCommission): CommissionEarlierOrder[] => r.earlierOrders ?? [];
export const changedOf = (r: EventCommission): CommissionChangedOrder[] => r.changedOrders ?? [];
/* A report from a server before 2026-10-27 carries no closed-month adjustments. */
export const monthAdjOf = (r: EventCommission): CommissionMonthAdjustment[] => r.monthAdjustments ?? [];
/** What happened to an earlier order in the range, in a few words. */
export const whatOf = (o: CommissionEarlierOrder): string =>
  o.events.map((e) => `${KIND_LABEL[e.kind]}${e.beforeReach ? ' (before 30%)' : ''}`).filter((w, i, all) => all.indexOf(w) === i).join(' · ');

/** A fair's name on two lines. Fair names read "<state> [<BRAND>] <ORGANIZER>
    @ <VENUE>" — "Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY" becomes
    "[AKEMI] BIGHOME" over "MID VALLEY · Kuala Lumpur", the state's capitals
    evened out. A name of any other shape is kept whole. */
export function fairLines(name: string): { title: string; detail: string; brand: string | null; organizer: string; venue: string; state: string } {
  const m = /^\s*(.*?)\s*\[([^\]]+)\]\s*(.*?)\s*(?:@\s*(.*?))?\s*$/.exec(name);
  if (!m) return { title: name, detail: '', brand: null, organizer: '', venue: '', state: '' };
  /* The venue part is optional: with no "@" its group is undefined. */
  const [, rawState = '', rawBrand = '', rawOrganizer = '', rawVenue = ''] = m;
  const state = rawState.trim().toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
  const brand = rawBrand.trim();
  const title = `[${brand}] ${rawOrganizer.trim()}`.trim();
  const detail = [rawVenue.trim(), state].filter(Boolean).join(' · ');
  return { title, detail, brand: brand.toUpperCase(), organizer: rawOrganizer.trim(), venue: rawVenue.trim(), state };
}

/** A fair's brand, organizer, venue and state — a column each (owner
    2026-10-26) — from the project, else read off its name. */
export const fairPlace = (f: { name: string; brand?: string | null; organizer?: string | null; venue?: string | null; state?: string | null }) => {
  const named = fairLines(f.name);
  const pick = (own: string | null | undefined, fallback: string) => (own?.trim() ? own.trim() : fallback || null);
  return {
    brand: pick(f.brand?.toUpperCase(), named.brand ?? ''),
    organizer: pick(f.organizer, named.organizer),
    venue: pick(f.venue, named.venue),
    state: pick(f.state, named.state),
  };
};

const brandOfFair = (f: CommissionFairRow): string | null => (f.brand?.trim() ? f.brand.trim().toUpperCase() : fairLines(f.name).brand);
const brandOfOrder = (o: { brand: string | null; fairName: string }): string | null => (o.brand?.trim() ? o.brand.trim().toUpperCase() : fairLines(o.fairName).brand);

/** The brands on the report, for the filter — every fair's and every earlier line's. */
export const brandsOf = (r: EventCommission | undefined): string[] => {
  if (!r) return [];
  const all = [
    ...r.fairs.map(brandOfFair), ...r.adjustments.map((a) => fairLines(a.fairName).brand), ...changedOf(r).map((o) => brandOfOrder(o)),
    ...monthAdjOf(r).map((a) => brandOfOrder(a)),
  ];
  return [...new Set(all.filter((b): b is string => !!b))].sort();
};

/** The report for one brand — its fairs, its earlier lines, and totals of
    exactly those. All brands is the report as the server sent it. */
export const forBrand = (r: EventCommission, brand: string): EventCommission => {
  if (!brand) return r;
  const fairs = r.fairs.filter((f) => brandOfFair(f) === brand);
  const adjustments = r.adjustments.filter((a) => fairLines(a.fairName).brand === brand);
  const earlierOrders = earlierOf(r).filter((o) => brandOfOrder(o) === brand);
  const changedOrders = changedOf(r).filter((o) => brandOfOrder(o) === brand);
  const monthAdjustments = monthAdjOf(r).filter((a) => brandOfOrder(a) === brand);
  const payableSen = fairs.reduce((s, f) => s + f.payableSen, 0);
  const adjustmentsSen = adjustments.reduce((s, a) => s + a.commissionSen, 0);
  const monthAdjustmentsSen = monthAdjustments.reduce((s, a) => s + a.adjustmentSen, 0);
  return {
    ...r, fairs, adjustments, earlierOrders, changedOrders, monthAdjustments,
    totals: { payableSen, adjustmentsSen, monthAdjustmentsSen, totalSen: payableSen + adjustmentsSen + monthAdjustmentsSen },
  };
};

const downloadText = (name: string, text: string) => {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

/* The tables are the system's own (owner 2026-10-25: 这个header，table 要和 pv
   那边一样能调整，能换位): drag a heading to move it, drag its edge to widen it,
   hide a column from Columns — each kept per person under the table's id. A
   fair opens to its orders in the same table, compact (这个点开排版好看一点). */
const sum = <T,>(rows: readonly T[], pick: (r: T) => number): number => rows.reduce((s, r) => s + pick(r), 0);
const num = (text: string) => <span className="tabular-nums">{text}</span>;

const Kpi = ({ label, value, sub, main }: { label: string; value: string; sub?: string; main?: boolean }) => (
  <div className="rounded-lg border border-border bg-surface px-4 py-3">
    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
    <div className={cn('mt-1 font-semibold tabular-nums leading-tight text-ink', main ? 'text-[24px]' : 'text-[18px]')}>{value}</div>
    {sub && <div className="mt-0.5 text-[11.5px] text-ink-muted">{sub}</div>}
  </div>
);

/* Brand, organizer, venue and state as columns (owner 2026-10-26), on the fairs
   and on every order list. Widths add up to fit the page at his size (about
   1,250px of table), so nothing is pushed off to the right. */
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

const fairColumns = (byFair: boolean): Column<CommissionFairRow>[] => [
  ...placeColumns<CommissionFairRow>((f) => fairPlace(f), { brand: '100px', organizer: '150px', venue: '200px', state: '110px' }, (f) => f.sos.length === 0),
  { key: 'fair', label: 'Fair (full name)', width: '260px', defaultHidden: true, render: (f) => f.name, getValue: (f) => f.name },
  {
    key: 'dates', label: 'Dates', width: '100px',
    render: (f) => <span className="whitespace-nowrap">{fmtDayMonthRange(f.startDate, f.endDate)}</span>,
    getValue: (f) => f.startDate, exportValue: (f) => fmtDayMonthRange(f.startDate, f.endDate),
  },
  {
    key: 'rate', label: 'Rate', align: 'right', width: '70px',
    render: (f) => (f.ratePct == null ? <span className="text-ink-muted">no rate card</span> : num(`${f.ratePct}%`)),
    getValue: (f) => f.ratePct,
  },
  ...(byFair ? [
    {
      key: 'totalSales', label: 'Total sales', align: 'right' as const, width: '120px', description: "The event page's Total Sales.",
      render: (f: CommissionFairRow) => num(amtRm(f.totalSalesRm)), getValue: (f: CommissionFairRow) => f.totalSalesRm,
      total: (rows: CommissionFairRow[]) => num(amtRm(sum(rows, (f) => f.totalSalesRm ?? 0))),
    },
    {
      key: 'estimate', label: 'Estimate', align: 'right' as const, width: '110px', description: "Total sales × the rate — the event page's Commission row.",
      render: (f: CommissionFairRow) => num(amtRm(f.estimateRm)), getValue: (f: CommissionFairRow) => f.estimateRm,
      total: (rows: CommissionFairRow[]) => num(amtRm(sum(rows, (f) => f.estimateRm ?? 0))),
    },
  ] : []),
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
          <span className={cn('font-medium tabular-nums', ch.notCounted ? 'text-ink-muted' : ch.kind === 'upsale' ? 'text-synced' : 'text-err')}>
            {ch.kind === 'upsale' ? '+' : '−'}RM {fmtRm(Math.abs(ch.deltaGoodsSen))}
          </span>
          <span className="text-ink-muted">
            {' · '}{fmtDateOrDash(ch.date)}{ch.source === 'amendment' ? ' · amendment' : ''}{ch.notCounted ? ` · ${NOT_COUNTED[ch.notCounted]}` : ''}
          </span>
        </div>
      ))}
    </div>
  ));

const ORDER_COLUMNS: Column<CommissionSoRow>[] = [
  { key: 'order', label: 'Order', render: (s) => <span className="whitespace-nowrap font-mono">{s.docNo}</span>, getValue: (s) => s.docNo },
  { key: 'soDate', label: 'SO date', render: (s) => <span className="whitespace-nowrap">{fmtDateOrDash(s.soDate)}</span>, getValue: (s) => s.soDate },
  { key: 'salesperson', label: 'Salesperson', render: (s) => s.salesperson ?? '—', getValue: (s) => s.salesperson },
  { key: 'customer', label: 'Customer', render: (s) => s.customer ?? '—', getValue: (s) => s.customer },
  {
    key: 'goods', label: 'Goods', align: 'right', render: (s) => num(fmtRm(s.goodsSen)), getValue: (s) => s.goodsSen,
    exportValue: (s) => s.goodsSen / 100, total: (rows) => num(fmtRm(sum(rows, (s) => s.goodsSen))),
  },
  {
    key: 'paid', label: 'Paid', align: 'right', render: (s) => num(fmtRm(s.paidSen)), getValue: (s) => s.paidSen,
    exportValue: (s) => s.paidSen / 100, total: (rows) => num(fmtRm(sum(rows, (s) => s.paidSen))),
  },
  {
    key: 'paidPct', label: 'Paid %', align: 'right', description: 'Paid ÷ the order total. Commission is earned once it reaches 30%.',
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
    render: (s) => <span className="font-semibold tabular-nums">{amt(s.commissionSen)}</span>, getValue: (s) => s.commissionSen,
    exportValue: (s) => s.commissionSen / 100, total: (rows) => num(fmtRm(sum(rows, (s) => s.commissionSen))),
  },
  {
    key: 'changes', label: 'Upsales / drop sales', render: (s) => <Changes changes={s.changes} />,
    getValue: (s) => sum(s.changes.filter((ch) => !ch.notCounted), (ch) => ch.deltaGoodsSen),
    exportValue: (s) => s.changes.map((ch) => `${ch.kind === 'upsale' ? '+' : '-'}${fmtRm(Math.abs(ch.deltaGoodsSen))} ${ch.date}${ch.notCounted ? ' (not counted)' : ''}`).join('; '),
  },
];

/** A fair opened: one line on what its orders came to, then the orders. */
const FairOrders = ({ fair }: { fair: CommissionFairRow }) => {
  if (fair.sos.length === 0) return <div className="pl-6 text-[12px] text-ink-muted">No orders at this fair yet.</div>;
  const reached = fair.sos.filter((s) => s.reachedOn).length;
  return (
    <div className="space-y-2 pl-6">
      <div className="text-[12px] text-ink-secondary">
        <span className="font-semibold text-ink">{fair.sos.length} order{fair.sos.length === 1 ? '' : 's'}</span>
        {' · '}{reached} reached 30%{' · '}commission <span className="font-semibold tabular-nums text-ink">RM {fmtRm(fair.payableSen)}</span>
      </div>
      <DataTable<CommissionSoRow> tableId="event-commission-orders" embedded freezeHeight="off" columns={ORDER_COLUMNS} rows={fair.sos} getRowKey={(s) => s.docNo} />
    </div>
  );
};

/** Original → Latest and the difference: + in green, − in red. */
const amendedCell = (sen: number) => (sen === 0
  ? <span className="text-ink-muted">–</span>
  : <span className={cn('font-medium tabular-nums', sen > 0 ? 'text-synced' : 'text-err')}>{sen > 0 ? '+' : '−'}{fmtRm(Math.abs(sen))}</span>);
const historyTag = (on: boolean) => (on ? <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-ink-muted" title="Back-filled from the order's modification history (1–19 October 2026)">from history</span> : null);
const orderPlace = (o: CommissionEarlierOrder | CommissionChangedOrder) => fairPlace({ name: o.fairName, brand: o.brand, organizer: o.organizer, venue: o.venue, state: o.state });
const moneyColumns = <R extends { originalSen: number; latestSen: number; amendedSen: number }>(): Column<R>[] => [
  { key: 'original', label: 'Original', align: 'right', width: '95px', description: 'The order before the range\'s upsales / drop sales.', render: (o) => num(fmtRm(o.originalSen)), getValue: (o) => o.originalSen, exportValue: (o) => o.originalSen / 100 },
  { key: 'latest', label: 'Latest', align: 'right', width: '95px', description: 'The order at the end of the range.', render: (o) => num(fmtRm(o.latestSen)), getValue: (o) => o.latestSen, exportValue: (o) => o.latestSen / 100 },
  {
    key: 'amended', label: 'Amended', align: 'right', width: '95px', description: 'Latest − Original.',
    render: (o) => amendedCell(o.amendedSen), getValue: (o) => o.amendedSen, exportValue: (o) => o.amendedSen / 100,
    total: (rows) => amendedCell(sum(rows, (o) => o.amendedSen)),
  },
];

const EARLIER_COLUMNS: Column<CommissionEarlierOrder>[] = [
  { key: 'date', label: 'Date', width: '85px', render: (o) => <span className="whitespace-nowrap">{fmtDateOrDash(o.lastDate)}</span>, getValue: (o) => o.lastDate },
  { key: 'what', label: 'What', width: '170px', render: (o) => <span className="whitespace-normal">{whatOf(o)}{historyTag(o.fromHistory)}</span>, getValue: (o) => whatOf(o) },
  { key: 'order', label: 'Order', width: '125px', render: (o) => <span className="whitespace-nowrap font-mono">{o.docNo}</span>, getValue: (o) => o.docNo },
  ...placeColumns<CommissionEarlierOrder>(orderPlace, { brand: '85px', organizer: '115px', venue: '150px', state: '100px' }).map((c) => (c.key === 'state' ? { ...c, defaultHidden: true } : c)),
  { key: 'salesperson', label: 'Salesperson', width: '100px', render: (o) => o.salesperson ?? '—', getValue: (o) => o.salesperson },
  ...moneyColumns<CommissionEarlierOrder>(),
  {
    key: 'commission', label: 'Commission', align: 'right', width: '105px', description: 'What this order moved in the range: reaching 30% (its goods × rate), an upsale / drop after 30% (± the change × rate), a cancellation (− its goods × rate).',
    render: (o) => <span className={cn('font-semibold tabular-nums', o.commissionSen < 0 && 'text-err')}>{fmtRm(o.commissionSen)}</span>,
    getValue: (o) => o.commissionSen, exportValue: (o) => o.commissionSen / 100,
    total: (rows) => num(fmtRm(sum(rows, (o) => o.commissionSen))),
  },
];

const CHANGED_COLUMNS: Column<CommissionChangedOrder>[] = [
  { key: 'lastChange', label: 'Last change', width: '90px', render: (o) => <span className="whitespace-nowrap">{fmtDateOrDash(o.lastChange)}{historyTag(o.fromHistory)}</span>, getValue: (o) => o.lastChange },
  { key: 'order', label: 'Order', width: '125px', render: (o) => <span className="whitespace-nowrap font-mono">{o.docNo}</span>, getValue: (o) => o.docNo },
  ...placeColumns<CommissionChangedOrder>(orderPlace, { brand: '85px', organizer: '115px', venue: '150px', state: '100px' }).map((c) => (c.key === 'state' ? { ...c, defaultHidden: true } : c)),
  { key: 'salesperson', label: 'Salesperson', width: '100px', render: (o) => o.salesperson ?? '—', getValue: (o) => o.salesperson },
  ...moneyColumns<CommissionChangedOrder>(),
  { key: 'rate', label: 'Rate', align: 'right', width: '60px', render: (o) => (o.ratePct == null ? <span className="text-ink-muted">–</span> : num(`${o.ratePct}%`)), getValue: (o) => o.ratePct },
  {
    key: 'effect', label: 'Commission effect', align: 'right', width: '120px',
    description: 'Amended × the fair\'s brand rate, once the order has 30% paid. Already inside the commission above — not added again.',
    render: (o) => (o.reachedOn == null
      ? <span className="text-ink-muted">not yet 30%</span>
      : <span className={cn('tabular-nums', o.effectSen < 0 && 'text-err')}>{fmtRm(o.effectSen)}</span>),
    getValue: (o) => o.effectSen, exportValue: (o) => o.effectSen / 100,
    total: (rows) => num(fmtRm(sum(rows, (o) => o.effectSen))),
  },
];

const MONTH_ADJ_COLUMNS: Column<CommissionMonthAdjustment>[] = [
  { key: 'month', label: 'Month', width: '85px', description: 'The closed month this belongs to.', render: (a) => <span className="whitespace-nowrap">{monthLabel(a.month)}</span>, getValue: (a) => a.month },
  { key: 'order', label: 'Order', width: '125px', render: (a) => <span className="whitespace-nowrap font-mono">{a.docNo}</span>, getValue: (a) => a.docNo },
  ...placeColumns<CommissionMonthAdjustment>((a) => fairPlace({ name: a.fairName, brand: a.brand }), { brand: '85px', organizer: '115px', venue: '150px', state: '100px' })
    .map((c) => (c.key === 'state' ? { ...c, defaultHidden: true } : c)),
  { key: 'salesperson', label: 'Salesperson', width: '100px', render: (a) => a.salesperson ?? '—', getValue: (a) => a.salesperson },
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

/** Where the range stands on closing: a closed month as closed (Reopen when it
    is the latest), else which months are closed and, for a whole month that has
    ended and is next in line, Close. Finance only — the server refuses anyone else. */
const MonthCloseBar = ({ r, range }: { r: EventCommission; range: { from: string; to: string } }) => {
  const askConfirm = useConfirm();
  const close = useCloseCommissionMonth();
  const reopen = useReopenCommissionMonth();
  const months = r.closes?.months ?? [];
  const latest = months.length > 0 ? months[months.length - 1]! : null;
  const whole = wholeMonthOf(range);
  if (r.closed) {
    const next = monthOf(`${r.closed.month}-01`, 1).from.slice(0, 7);
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[12.5px] text-ink-secondary">
        <Lock size={14} strokeWidth={1.75} className="text-ink" />
        <span><span className="font-semibold text-ink">{monthLabel(r.closed.month)} is closed</span>
          {' — '}{fmtDateOrDash(new Date(Date.parse(r.closed.closedAt) + 8 * 3600_000).toISOString().slice(0, 10))}{r.closed.closedBy ? ` by ${r.closed.closedBy}` : ''}.
          {' '}These are its figures as closed; what changes for its orders later is paid in {monthLabel(next)}.</span>
        <span className="flex-1" />
        {latest === r.closed.month && (
          <Button variant="ghost" size="sm" disabled={reopen.isPending} onClick={() => {
            void askConfirm({
              title: `Reopen ${monthLabel(r.closed!.month)}?`,
              body: `It is recalculated from today's data again, and ${monthLabel(next)} stops carrying its adjustments until it is closed again.`,
              confirmLabel: 'Reopen',
            }).then((ok) => { if (ok) reopen.mutate(r.closed!.month); });
          }}>{reopen.isPending ? 'Reopening…' : `Reopen ${monthLabel(r.closed.month)}`}</Button>
        )}
      </div>
    );
  }
  const overlap = months.filter((m) => `${m}-01` <= range.to && monthOf(`${m}-01`).to >= range.from);
  const nextUp = latest ? monthOf(`${latest}-01`, 1).from.slice(0, 7) : whole;
  const canClose = whole != null && whole === nextUp && monthOf(`${whole}-01`).to < myt();
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
      <Lock size={13} strokeWidth={1.75} />
      <span>{latest ? `Closed up to ${monthLabel(latest)}.` : 'No month closed yet.'}</span>
      {overlap.length > 0 && <span className="text-ink-secondary">This range takes in {overlap.map(monthLabel).join(', ')} — recalculated here, not as closed.</span>}
      {canClose && (
        <Button variant="ghost" size="sm" disabled={close.isPending} onClick={() => {
          void askConfirm({
            title: `Close ${monthLabel(whole)}?`,
            body: `Its commission is kept as it stands now — RM ${fmtRm(r.totals.totalSen)} on this view. From then on it never changes: what changes for its orders later is paid in the next month as an adjustment.`,
            confirmLabel: `Close ${monthLabel(whole)}`,
          }).then((ok) => { if (ok) close.mutate(whole); });
        }}>{close.isPending ? 'Closing…' : `Close ${monthLabel(whole)}`}</Button>
      )}
    </div>
  );
};

export const EventCommissionTab = () => {
  const [range, setRange] = useState(() => monthOf(myt()));
  const [basis, setBasis] = useState<CommissionBasis>('fair');
  const [brand, setBrand] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showIdle, setShowIdle] = useState(false);
  const q = useEventCommission(range.from, range.to, basis);
  const full = q.data;
  const brands = useMemo(() => brandsOf(full), [full]);
  /* One filtered report feeds the cards, both tables and the export. */
  const r = useMemo(() => (full ? forBrand(full, brands.includes(brand) ? brand : '') : undefined), [full, brand, brands]);
  const words = BASIS_WORDS[basis];
  const byFair = basis === 'fair';
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const active = r ? r.fairs.filter((f) => f.sos.length > 0) : [];
  const idle = r ? r.fairs.filter((f) => f.sos.length === 0) : [];
  const columns = useMemo(() => fairColumns(byFair), [byFair]);
  const earlierRows = r ? earlierOf(r) : [];
  const changedRows = r ? changedOf(r) : [];
  const monthAdjRows = r ? monthAdjOf(r) : [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Toggle<CommissionBasis> value={basis} options={[['fair', BASIS_WORDS.fair.toggle], ['so_date', BASIS_WORDS.so_date.toggle]]} onChange={setBasis} />
        <span className="ml-1 text-[12px] text-ink-muted">From</span>
        <DateField value={range.from} aria-label="From date" onChange={(iso) => { if (iso) setRange((x) => ({ ...x, from: iso })); }} />
        <span className="text-[12px] text-ink-muted">to</span>
        <DateField value={range.to} aria-label="To date" onChange={(iso) => { if (iso) setRange((x) => ({ ...x, to: iso })); }} />
        <Button variant="ghost" size="sm" onClick={() => setRange(monthOf(myt()))}>This month</Button>
        <Button variant="ghost" size="sm" onClick={() => setRange(monthOf(myt(), -1))}>Last month</Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" disabled={!r} onClick={() => {
          if (r) downloadText(`event-commission-${basisOf(r) === 'fair' ? 'by-fair' : 'by-so-date'}${brand ? `-${brand.toLowerCase()}` : ''}-${range.from}-${range.to}.csv`, eventCommissionCsv(r));
        }}>
          <Download size={16} strokeWidth={1.75} /> Export
        </Button>
      </div>

      {full && <MonthCloseBar r={full} range={range} />}

      {r && (
        <div className={cn('grid grid-cols-2 gap-3', monthAdjRows.length > 0 ? 'md:grid-cols-5' : 'md:grid-cols-4')}>
          <Kpi main label="Total commission" value={`RM ${fmtRm(r.totals.totalSen)}`} sub={brand ? brand : 'all brands'} />
          <Kpi label={BASIS_WORDS[basisOf(r)].inRange} value={`RM ${fmtRm(r.totals.payableSen)}`}
            sub={`${active.reduce((s, f) => s + f.sos.length, 0)} orders`} />
          <Kpi label={BASIS_WORDS[basisOf(r)].earlier} value={`RM ${fmtRm(r.totals.adjustmentsSen)}`}
            sub={`${earlierRows.length} order${earlierRows.length === 1 ? '' : 's'}`} />
          {monthAdjRows.length > 0 && (
            <Kpi label="Closed months — adjustments" value={`RM ${fmtRm(r.totals.monthAdjustmentsSen ?? 0)}`}
              sub={`${monthAdjRows.length} order${monthAdjRows.length === 1 ? '' : 's'} · ${[...new Set(monthAdjRows.map((a) => monthLabel(a.month)))].join(', ')}`} />
          )}
          <Kpi label="Fairs" value={String(r.fairs.length)} sub={idle.length > 0 ? `${idle.length} with no orders yet` : 'all with orders'} />
        </div>
      )}
      <p className="text-[11.5px] text-ink-muted">
        An order earns its goods (no delivery or service) × the fair&apos;s brand rate once 30% of the order is paid.
        Upsales and drop sales count from 1/10/2026 (1–19 October read from each order&apos;s modification history), each in the month it happened, at the fair&apos;s brand rate.
      </p>

      {q.isLoading && <div className="text-[12px] text-ink-muted">Reading the orders…</div>}
      {q.isError && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">The report could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</div>}

      {r && (
        <Panel title={words.part1} hint={`as at ${fmtDateOrDash(r.to)} · amounts in RM`}
          right={brands.length > 1 && (
            <Toggle<string> value={brands.includes(brand) ? brand : ''} options={[['', 'All brands'], ...brands.map((b): [string, string] => [b, b])]} onChange={setBrand} />
          )}>
          {r.fairs.length === 0 ? <div className="px-1 py-2 text-[12px] text-ink-muted">{words.part1Empty}</div> : (
            <>
              <DataTable<CommissionFairRow>
                tableId="event-commission-fairs" exportName={`event-commission-fairs-${range.from}-${range.to}`} freezeHeight="screen"
                columns={columns} rows={showIdle ? [...active, ...idle] : active} getRowKey={(f) => f.id}
                emptyLabel="Every fair in this range has no orders yet."
                onRowClick={(f) => toggle(String(f.id))}
                expandable={{ render: (f) => <FairOrders fair={f} />, rowKey: (f) => String(f.id), expandedIds: open, onExpandedChange: setOpen }}
              />
              {idle.length > 0 && (
                <button type="button" aria-expanded={showIdle} onClick={() => setShowIdle((v) => !v)}
                  className="mt-2 inline-flex items-center gap-1 text-[12px] text-ink-secondary hover:text-primary">
                  {showIdle ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {idle.length} fair{idle.length === 1 ? '' : 's'} with no orders yet
                </button>
              )}
            </>
          )}
        </Panel>
      )}

      {r && (
        <Panel title={words.part2} hint="one row per order · amounts in RM">
          {earlierRows.length === 0 ? <div className="px-1 py-2 text-[12px] text-ink-muted">{words.part2Empty}</div> : (
            <DataTable<CommissionEarlierOrder>
              tableId="event-commission-earlier-orders" exportName={`event-commission-earlier-${range.from}-${range.to}`} freezeHeight="screen"
              columns={EARLIER_COLUMNS} rows={earlierRows} getRowKey={(o) => o.docNo}
            />
          )}
        </Panel>
      )}

      {r && monthAdjRows.length > 0 && (
        <Panel title="Closed months — adjustments" hint="what changed for a closed month's orders after it closed · paid in this month · amounts in RM">
          <DataTable<CommissionMonthAdjustment>
            tableId="event-commission-month-adjustments" exportName={`event-commission-month-adjustments-${range.from}-${range.to}`} freezeHeight="screen"
            columns={MONTH_ADJ_COLUMNS} rows={monthAdjRows} getRowKey={(a) => `${a.month}-${a.docNo}`}
          />
        </Panel>
      )}

      {r && (
        <Panel title="Upsales / Drop sales" hint="each order once, its final amount in the range · the effect is already inside the commission above">
          {changedRows.length === 0 ? <div className="px-1 py-2 text-[12px] text-ink-muted">No upsale or drop sale in this range.</div> : (
            <DataTable<CommissionChangedOrder>
              tableId="event-commission-changes" exportName={`event-commission-upsales-drops-${range.from}-${range.to}`} freezeHeight="screen"
              columns={CHANGED_COLUMNS} rows={changedRows} getRowKey={(o) => o.docNo}
            />
          )}
        </Panel>
      )}
    </div>
  );
};
