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
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useEventCommission,
  type CommissionAdjustment, type CommissionBasis, type CommissionChange, type CommissionFairRow, type CommissionSoRow, type EventCommission,
} from '../../vendor/scm/lib/event-queries';
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
};

/* The words each basis puts on the page. */
export const BASIS_WORDS: Record<CommissionBasis, { toggle: string; part1: string; part1Empty: string; part2: string; part2Empty: string; inRange: string; earlier: string }> = {
  fair: {
    toggle: 'By fair', part1: 'Fairs starting in the range', part1Empty: 'No fair starts in this range.',
    part2: 'Earlier fairs — what happened in the range', part2Empty: 'Nothing on earlier fairs in this range.',
    inRange: 'Fairs in the range', earlier: 'Earlier fairs',
  },
  so_date: {
    toggle: 'By SO date', part1: 'Orders opened in the range (SO date), by fair', part1Empty: 'No order with a fair was opened in this range.',
    part2: 'Earlier orders — what happened in the range', part2Empty: 'Nothing on earlier orders in this range.',
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
  lines.push('', row([BASIS_WORDS[basisOf(r)].earlier, 'Date', 'What', 'Order', 'Salesperson', 'Goods', 'Commission']));
  for (const a of r.adjustments) lines.push(row([a.fairName, a.date, KIND_LABEL[a.kind], a.docNo, a.salesperson, fmtRm(a.goodsSen), fmtRm(a.commissionSen)]));
  lines.push('', row(['Total', '', '', '', '', '', fmtRm(r.totals.totalSen)]));
  return `${lines.join('\n')}\n`;
};

/** A fair's name on two lines. Fair names read "<state> [<BRAND>] <ORGANIZER>
    @ <VENUE>" — "Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY" becomes
    "[AKEMI] BIGHOME" over "MID VALLEY · Kuala Lumpur", the state's capitals
    evened out. A name of any other shape is kept whole. */
export function fairLines(name: string): { title: string; detail: string; brand: string | null } {
  const m = /^\s*(.*?)\s*\[([^\]]+)\]\s*(.*?)\s*(?:@\s*(.*?))?\s*$/.exec(name);
  if (!m) return { title: name, detail: '', brand: null };
  /* The venue part is optional: with no "@" its group is undefined. */
  const [, rawState = '', rawBrand = '', rawOrganizer = '', rawVenue = ''] = m;
  const state = rawState.trim().toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
  const brand = rawBrand.trim();
  const title = `[${brand}] ${rawOrganizer.trim()}`.trim();
  const detail = [rawVenue.trim(), state].filter(Boolean).join(' · ');
  return { title, detail, brand: brand.toUpperCase() };
}

const brandOfFair = (f: CommissionFairRow): string | null => (f.brand?.trim() ? f.brand.trim().toUpperCase() : fairLines(f.name).brand);

/** The brands on the report, for the filter — every fair's and every earlier line's. */
export const brandsOf = (r: EventCommission | undefined): string[] => {
  if (!r) return [];
  const all = [...r.fairs.map(brandOfFair), ...r.adjustments.map((a) => fairLines(a.fairName).brand)];
  return [...new Set(all.filter((b): b is string => !!b))].sort();
};

/** The report for one brand — its fairs, its earlier lines, and totals of
    exactly those. All brands is the report as the server sent it. */
export const forBrand = (r: EventCommission, brand: string): EventCommission => {
  if (!brand) return r;
  const fairs = r.fairs.filter((f) => brandOfFair(f) === brand);
  const adjustments = r.adjustments.filter((a) => fairLines(a.fairName).brand === brand);
  const payableSen = fairs.reduce((s, f) => s + f.payableSen, 0);
  const adjustmentsSen = adjustments.reduce((s, a) => s + a.commissionSen, 0);
  return { ...r, fairs, adjustments, totals: { payableSen, adjustmentsSen, totalSen: payableSen + adjustmentsSen } };
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

const FairName = ({ name, dim }: { name: string; dim?: boolean }) => {
  const { title, detail } = fairLines(name);
  return (
    <div className="min-w-[200px] whitespace-normal">
      <div className={cn('font-semibold', dim ? 'text-ink-secondary' : 'text-ink')}>{title}</div>
      {detail && <div className="mt-0.5 text-[11px] leading-snug text-ink-muted">{detail}</div>}
    </div>
  );
};

const Kpi = ({ label, value, sub, main }: { label: string; value: string; sub?: string; main?: boolean }) => (
  <div className="rounded-lg border border-border bg-surface px-4 py-3">
    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
    <div className={cn('mt-1 font-semibold tabular-nums leading-tight text-ink', main ? 'text-[24px]' : 'text-[18px]')}>{value}</div>
    {sub && <div className="mt-0.5 text-[11.5px] text-ink-muted">{sub}</div>}
  </div>
);

const fairColumns = (byFair: boolean): Column<CommissionFairRow>[] => [
  {
    key: 'fair', label: 'Fair', alwaysVisible: true,
    render: (f) => <FairName name={f.name} dim={f.sos.length === 0} />,
    getValue: (f) => fairLines(f.name).title, searchValue: (f) => f.name, exportValue: (f) => f.name,
  },
  {
    key: 'dates', label: 'Dates',
    render: (f) => <span className="whitespace-nowrap">{fmtDayMonthRange(f.startDate, f.endDate)}</span>,
    getValue: (f) => f.startDate, exportValue: (f) => fmtDayMonthRange(f.startDate, f.endDate),
  },
  {
    key: 'rate', label: 'Rate', align: 'right',
    render: (f) => (f.ratePct == null ? <span className="text-ink-muted">no rate card</span> : num(`${f.ratePct}%`)),
    getValue: (f) => f.ratePct,
  },
  ...(byFair ? [
    {
      key: 'totalSales', label: 'Total sales', align: 'right' as const, description: "The event page's Total Sales.",
      render: (f: CommissionFairRow) => num(amtRm(f.totalSalesRm)), getValue: (f: CommissionFairRow) => f.totalSalesRm,
      total: (rows: CommissionFairRow[]) => num(amtRm(sum(rows, (f) => f.totalSalesRm ?? 0))),
    },
    {
      key: 'estimate', label: 'Estimate', align: 'right' as const, description: "Total sales × the rate — the event page's Commission row.",
      render: (f: CommissionFairRow) => num(amtRm(f.estimateRm)), getValue: (f: CommissionFairRow) => f.estimateRm,
      total: (rows: CommissionFairRow[]) => num(amtRm(sum(rows, (f) => f.estimateRm ?? 0))),
    },
  ] : []),
  {
    key: 'orders', label: 'Orders', align: 'right',
    render: (f) => num(f.sos.length ? String(f.sos.length) : '–'), getValue: (f) => f.sos.length,
    total: (rows) => num(String(sum(rows, (f) => f.sos.length))),
  },
  {
    key: 'commission', label: 'Commission', align: 'right', description: 'What its orders earned: goods × rate, once 30% of the order is paid.',
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
      <DataTable<CommissionSoRow> tableId="event-commission-orders" embedded columns={ORDER_COLUMNS} rows={fair.sos} getRowKey={(s) => s.docNo} />
    </div>
  );
};

const EARLIER_COLUMNS: Column<CommissionAdjustment>[] = [
  { key: 'date', label: 'Date', render: (a) => <span className="whitespace-nowrap">{fmtDateOrDash(a.date)}</span>, getValue: (a) => a.date },
  {
    key: 'what', label: 'What',
    render: (a) => <>{KIND_LABEL[a.kind]}{a.beforeReach ? <span className="text-ink-muted"> · before 30% — counted when reached</span> : null}</>,
    getValue: (a) => KIND_LABEL[a.kind],
  },
  { key: 'order', label: 'Order', render: (a) => <span className="whitespace-nowrap font-mono">{a.docNo}</span>, getValue: (a) => a.docNo },
  { key: 'fair', label: 'Fair', render: (a) => <FairName name={a.fairName} />, getValue: (a) => fairLines(a.fairName).title, exportValue: (a) => a.fairName },
  { key: 'salesperson', label: 'Salesperson', render: (a) => a.salesperson ?? '—', getValue: (a) => a.salesperson },
  { key: 'goods', label: 'Goods', align: 'right', render: (a) => num(fmtRm(a.goodsSen)), getValue: (a) => a.goodsSen, exportValue: (a) => a.goodsSen / 100 },
  {
    key: 'commission', label: 'Commission', align: 'right',
    render: (a) => <span className={cn('tabular-nums', a.commissionSen < 0 && 'text-err')}>{fmtRm(a.commissionSen)}</span>,
    getValue: (a) => a.commissionSen, exportValue: (a) => a.commissionSen / 100,
    total: (rows) => num(fmtRm(sum(rows, (a) => a.commissionSen))),
  },
];

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
  const keyOf = useMemo(() => new Map((r?.adjustments ?? []).map((a, i) => [a, `${a.docNo}|${a.kind}|${a.date}|${i}`] as const)), [r]);

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

      {r && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi main label="Total commission" value={`RM ${fmtRm(r.totals.totalSen)}`} sub={brand ? brand : 'all brands'} />
          <Kpi label={BASIS_WORDS[basisOf(r)].inRange} value={`RM ${fmtRm(r.totals.payableSen)}`}
            sub={`${active.reduce((s, f) => s + f.sos.length, 0)} orders`} />
          <Kpi label={BASIS_WORDS[basisOf(r)].earlier} value={`RM ${fmtRm(r.totals.adjustmentsSen)}`}
            sub={`${r.adjustments.length} change${r.adjustments.length === 1 ? '' : 's'}`} />
          <Kpi label="Fairs" value={String(r.fairs.length)} sub={idle.length > 0 ? `${idle.length} with no orders yet` : 'all with orders'} />
        </div>
      )}
      <p className="text-[11.5px] text-ink-muted">
        An order earns its goods (no delivery or service) × the fair&apos;s brand rate once 30% of the order is paid.
        Upsales and drop sales are recorded from 20/10/2026.
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
                tableId="event-commission-fairs" exportName={`event-commission-fairs-${range.from}-${range.to}`}
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
        <Panel title={words.part2} hint="amounts in RM">
          {r.adjustments.length === 0 ? <div className="px-1 py-2 text-[12px] text-ink-muted">{words.part2Empty}</div> : (
            <DataTable<CommissionAdjustment>
              tableId="event-commission-earlier" exportName={`event-commission-earlier-${range.from}-${range.to}`}
              columns={EARLIER_COLUMNS} rows={r.adjustments} getRowKey={(a) => keyOf.get(a) ?? a.docNo}
            />
          )}
        </Panel>
      )}
    </div>
  );
};
