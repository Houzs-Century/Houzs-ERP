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
// column headings stay on screen while the list scrolls.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useEventCommission,
  type CommissionAdjustment, type CommissionBasis, type CommissionChange, type CommissionFairRow, type EventCommission,
} from '../../vendor/scm/lib/event-queries';
import { fmtDateOrDash, fmtDayMonthRange } from '../../vendor/shared/format';
import { DateField } from '../../vendor/scm/components/DateField';
import { Panel, Toggle } from '../../components/scm-v2/OverviewKit';
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

/* Table cells. Alignment and wrapping are set per kind, never added on top of a
   shared string: `cn` only joins, so a cell adding text-left to one that says
   text-right gets both and the stylesheet picks (Project Overview, 2026-10-21). */
const TH_BASE = 'border-b border-border bg-surface px-2.5 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted';
const TH_L = cn(TH_BASE, 'whitespace-nowrap text-left');
const TH_R = cn(TH_BASE, 'whitespace-nowrap text-right');
const TD_BASE = 'border-b border-border px-2.5 py-2 align-top text-[12.5px]';
const TD_L = cn(TD_BASE, 'text-left');
const TD_R = cn(TD_BASE, 'whitespace-nowrap text-right tabular-nums');
/** The table's own box: the headings stay at its top while the rows scroll. */
const SCROLL = 'max-h-[70vh] overflow-auto';

const FairName = ({ name, dim }: { name: string; dim?: boolean }) => {
  const { title, detail } = fairLines(name);
  return (
    <div className="min-w-[220px]">
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

export const EventCommissionTab = () => {
  const [range, setRange] = useState(() => monthOf(myt()));
  const [basis, setBasis] = useState<CommissionBasis>('fair');
  const [brand, setBrand] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [showIdle, setShowIdle] = useState(false);
  const q = useEventCommission(range.from, range.to, basis);
  const full = q.data;
  const brands = useMemo(() => brandsOf(full), [full]);
  /* One filtered report feeds the cards, both tables and the export. */
  const r = useMemo(() => (full ? forBrand(full, brands.includes(brand) ? brand : '') : undefined), [full, brand, brands]);
  const words = BASIS_WORDS[basis];
  const byFair = basis === 'fair';
  const toggle = (id: number) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const active = r ? r.fairs.filter((f) => f.sos.length > 0) : [];
  const idle = r ? r.fairs.filter((f) => f.sos.length === 0) : [];
  const cols = byFair ? 7 : 5;

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
            <div className={SCROLL}>
              <table className="w-full border-separate border-spacing-0">
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th className={TH_L}>Fair</th>
                    <th className={TH_L}>Dates</th>
                    <th className={TH_R}>Rate</th>
                    {byFair && <th className={TH_R}>Total sales</th>}
                    {byFair && <th className={TH_R}>Estimate</th>}
                    <th className={TH_R}>Orders</th>
                    <th className={TH_R}>Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((f) => <FairRows key={f.id} fair={f} byFair={byFair} open={open.has(f.id)} onToggle={() => toggle(f.id)} />)}
                  {idle.length > 0 && (
                    <tr className="cursor-pointer hover:bg-surface-2/50" onClick={() => setShowIdle((v) => !v)} aria-expanded={showIdle}>
                      <td className={cn(TD_L, 'text-ink-secondary')} colSpan={cols}>
                        <span className="inline-flex items-center gap-1">
                          {showIdle ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {idle.length} fair{idle.length === 1 ? '' : 's'} with no orders yet
                        </span>
                      </td>
                    </tr>
                  )}
                  {showIdle && idle.map((f) => <FairRows key={f.id} fair={f} byFair={byFair} open={false} onToggle={() => {}} dim />)}
                  <tr className="font-semibold">
                    <td className={TD_L} colSpan={3}>Total</td>
                    {byFair && <td className={TD_R}>{amtRm(r.fairs.reduce((s, f) => s + (f.totalSalesRm ?? 0), 0))}</td>}
                    {byFair && <td className={TD_R}>{amtRm(r.fairs.reduce((s, f) => s + (f.estimateRm ?? 0), 0))}</td>}
                    <td className={TD_R}>{r.fairs.reduce((s, f) => s + f.sos.length, 0)}</td>
                    <td className={TD_R}>{fmtRm(r.totals.payableSen)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {r && (
        <Panel title={words.part2} hint="amounts in RM">
          {r.adjustments.length === 0 ? <div className="px-1 py-2 text-[12px] text-ink-muted">{words.part2Empty}</div> : (
            <div className={SCROLL}>
              <table className="w-full border-separate border-spacing-0">
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th className={TH_L}>Date</th>
                    <th className={TH_L}>What</th>
                    <th className={TH_L}>Order</th>
                    <th className={TH_L}>Fair</th>
                    <th className={TH_L}>Salesperson</th>
                    <th className={TH_R}>Goods</th>
                    <th className={TH_R}>Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {r.adjustments.map((a, i) => (
                    <tr key={`${a.docNo}-${a.kind}-${i}`}>
                      <td className={cn(TD_L, 'whitespace-nowrap')}>{fmtDateOrDash(a.date)}</td>
                      <td className={TD_L}>{KIND_LABEL[a.kind]}{a.beforeReach ? <span className="text-ink-muted"> · before 30% — counted when reached</span> : null}</td>
                      <td className={cn(TD_L, 'whitespace-nowrap font-mono')}>{a.docNo}</td>
                      <td className={TD_L}><FairName name={a.fairName} /></td>
                      <td className={TD_L}>{a.salesperson ?? '—'}</td>
                      <td className={TD_R}>{fmtRm(a.goodsSen)}</td>
                      <td className={cn(TD_R, a.commissionSen < 0 && 'text-err')}>{fmtRm(a.commissionSen)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className={TD_L} colSpan={6}>Total</td>
                    <td className={TD_R}>{fmtRm(r.totals.adjustmentsSen)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
};

function FairRows({ fair, byFair, open, onToggle, dim }: { fair: CommissionFairRow; byFair: boolean; open: boolean; onToggle: () => void; dim?: boolean }) {
  const has = fair.sos.length > 0;
  return (
    <>
      <tr className={cn(has && 'cursor-pointer hover:bg-surface-2/50', dim && 'text-ink-secondary')}
        onClick={has ? onToggle : undefined} aria-expanded={has ? open : undefined}>
        <td className={TD_L}>
          <div className="flex items-start gap-1">
            <span className="mt-0.5 w-[14px] shrink-0 text-ink-muted">{has ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</span>
            <FairName name={fair.name} dim={dim} />
          </div>
        </td>
        <td className={cn(TD_L, 'whitespace-nowrap')}>{fmtDayMonthRange(fair.startDate, fair.endDate)}</td>
        <td className={TD_R}>{fair.ratePct == null ? <span className="text-ink-muted">no rate card</span> : `${fair.ratePct}%`}</td>
        {byFair && <td className={TD_R}>{amtRm(fair.totalSalesRm)}</td>}
        {byFair && <td className={TD_R}>{amtRm(fair.estimateRm)}</td>}
        <td className={TD_R}>{fair.sos.length || '–'}</td>
        <td className={cn(TD_R, 'font-semibold')}>{amt(fair.payableSen)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={byFair ? 7 : 5} className="border-b border-border bg-surface-2/40 px-3 py-2">
            <table className="w-full border-separate border-spacing-0 text-[12px]">
              <thead>
                <tr>
                  <th className={TH_L}>Order</th>
                  <th className={TH_L}>SO date</th>
                  <th className={TH_L}>Salesperson</th>
                  <th className={TH_L}>Customer</th>
                  <th className={TH_R}>Goods</th>
                  <th className={TH_R}>Paid</th>
                  <th className={TH_L}>30% reached</th>
                  <th className={TH_R}>Commission</th>
                  <th className={TH_L}>Upsales / drop sales</th>
                </tr>
              </thead>
              <tbody>
                {fair.sos.map((s) => (
                  <tr key={s.docNo}>
                    <td className={cn(TD_L, 'whitespace-nowrap font-mono')}>{s.docNo}</td>
                    <td className={cn(TD_L, 'whitespace-nowrap')}>{fmtDateOrDash(s.soDate)}</td>
                    <td className={TD_L}>{s.salesperson ?? '—'}</td>
                    <td className={TD_L}>{s.customer ?? '—'}</td>
                    <td className={TD_R}>{fmtRm(s.goodsSen)}</td>
                    <td className={TD_R}>{fmtRm(s.paidSen)} <span className="text-ink-muted">({s.paidPct}%)</span></td>
                    <td className={cn(TD_L, 'whitespace-nowrap')}>{s.reachedOn ? fmtDateOrDash(s.reachedOn) : <span className="text-ink-muted">not yet</span>}</td>
                    <td className={TD_R}>{amt(s.commissionSen)}</td>
                    <td className={TD_L}>
                      {s.changes.length === 0 ? <span className="text-ink-muted">—</span> : s.changes.map((ch, i) => (
                        <div key={`${ch.date}-${i}`} className={ch.notCounted ? 'text-ink-muted' : undefined}>
                          {ch.kind === 'upsale' ? '+' : '−'}RM {fmtRm(Math.abs(ch.deltaGoodsSen))} · {fmtDateOrDash(ch.date)}
                          {ch.source === 'amendment' ? ' · amendment' : ''}
                          {ch.notCounted ? ` · ${NOT_COUNTED[ch.notCounted]}` : ''}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
