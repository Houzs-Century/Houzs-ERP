// ----------------------------------------------------------------------------
// eventCommissionModel — the Event Commission tab's arithmetic and words, with
// no React in it: what a report sums to, how one brand narrows it, and the
// CSV and the Excel / PDF sheet. The tab (EventCommission.tsx) draws it; the
// rules that make the report are the server's (backend/src/scm/lib/
// event-commission.ts).
//
// THE SUMMARY (owner 2026-11-12: 「这个export 出来我要看到total sales commission
// 多少， drop sales upsales commission 多少，补开单的多少」): every sen of a report
// sits on exactly one line, so the lines add up to its total —
//   Fair commission       this range's fairs (by SO date: the orders opened in
//                         it), less the upsales / drops inside them;
//   No fair               by SO date, the orders opened in it with no fair, at
//                         their own brand's rate (owner 2026-11-12: 「全部列出来，
//                         没有展会的标 No fair，要算佣金」 — Finance leaves out the
//                         ones that should not earn with Don't count);
//   Upsales / drop sales  the effect of the range's upsales and drops;
//   Late bills (补开单)    an order sold at a fair that had ended before the range
//                         and keyed in it (「上个月展会卖、这个月才开单」), all of it;
//   Earlier orders        an earlier order reaching 30% here, or cancelled;
//   Closed months         what changed for a closed month's orders;
//   Moved from last month what the month before moved here (「这个算下个月」).
// The page's earlier-orders table follows the Earlier line (owner 2026-11-12):
// only orders that reached 30% or were cancelled, their price changes left to
// the Upsales / Drop sales table (earlierShownOf).
// An order Finance marked (「这张单不要算」 / 「这个算下个月」) earns nothing here;
// what the mark took out is listed apart, not in the total. A price change
// Finance left out (「这次改价不算」) is not on the Upsales / drop sales line and
// the order earns on the rest — what it left out is listed apart the same way.
// ----------------------------------------------------------------------------

import { guardFormula } from '../../lib/csv';
import type {
  CommissionAdjustment, CommissionBasis, CommissionChange, CommissionChangedOrder, CommissionDeferredIn, CommissionEarlierOrder,
  CommissionFairRow, CommissionMarkedOrder, CommissionMarkInfo, CommissionMonthAdjustment, CommissionSoRow, EventCommission,
} from '../../vendor/scm/lib/event-queries';
import { fmtDateOrDash, fmtDayMonthRange } from '../../vendor/shared/format';
import { AMOUNT_COLUMN, type ReportSheet, type SheetRow, type SheetTable, type SheetValue } from '../../vendor/scm/lib/report-sheet';

export const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
export const monthOf = (day: string, shift = 0): { from: string; to: string } => {
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
/** The month a range is OF for Finance's marks: from the 1st to a day inside
    that month — the whole month or this month so far (the server's monthOfRange). */
export const markMonthOf = (range: { from: string; to: string }): string | null => {
  if (!/^\d{4}-\d{2}-01$/.test(range.from) || range.to < range.from) return null;
  return range.to.slice(0, 7) === range.from.slice(0, 7) ? range.from.slice(0, 7) : null;
};
/** The month after YYYY-MM. */
export const nextMonthOf = (month: string): string => monthOf(`${month}-01`, 1).from.slice(0, 7);

export const fmtRm = (sen: number): string => {
  const text = (Math.abs(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${text})` : text;
};
export const fmtRmWhole = (rm: number | null): string => (rm == null ? '—' : fmtRm(Math.round(rm * 100)));
/** A table amount: a dash for nothing, so the figures that matter stand out. */
export const amt = (sen: number | null): string => (sen == null || sen === 0 ? '–' : fmtRm(sen));
export const amtRm = (rm: number | null): string => (rm == null ? '–' : amt(Math.round(rm * 100)));
export const sum = <T,>(rows: readonly T[], pick: (r: T) => number): number => rows.reduce((s, r) => s + pick(r), 0);

export const KIND_LABEL: Record<CommissionAdjustment['kind'], string> = {
  reached: 'Reached 30%', upsale: 'Upsale', drop: 'Drop sale', cancelled: 'Cancelled',
};
export const NOT_COUNTED: Record<NonNullable<CommissionChange['notCounted']>, string> = {
  opening_day: 'opening-day fix, not counted', first_price: 'priced after opening, not counted',
  system_fix: 'system price fix, not counted',
};
/** An upsale / drop Finance left out (「这次改价不算」), beside the change. */
export const LEFT_OUT_NOTE = 'left out by Finance, not counted';

/* The words each basis puts on the page. */
export const BASIS_WORDS: Record<CommissionBasis, { toggle: string; part1: string; part1Empty: string; part2: string; part2Empty: string; inRange: string; earlier: string }> = {
  fair: {
    toggle: 'By fair', part1: 'Fairs starting in the range', part1Empty: 'No fair starts in this range.',
    part2: 'Earlier fairs — reached 30% or cancelled in the range', part2Empty: 'No order of an earlier fair reached 30% or was cancelled in this range.',
    inRange: 'Fairs in the range', earlier: 'Earlier fairs',
  },
  so_date: {
    toggle: 'By SO date', part1: 'Orders opened in the range (SO date)', part1Empty: 'No order with a fair was opened in this range.',
    part2: 'Earlier orders — reached 30% or cancelled in the range', part2Empty: 'No earlier order reached 30% or was cancelled in this range.',
    inRange: 'Orders opened in the range', earlier: 'Earlier orders',
  },
};

/* A report from a server older than the toggle carries no basis — it is by fair. */
export const basisOf = (r: EventCommission): CommissionBasis => r.basis ?? 'fair';
/* A report from a server before 2026-10-26 has no per-order lists — read as empty. */
export const earlierOf = (r: EventCommission): CommissionEarlierOrder[] => r.earlierOrders ?? [];
export const changedOf = (r: EventCommission): CommissionChangedOrder[] => r.changedOrders ?? [];
/* A report from a server before 2026-10-27 carries no closed-month adjustments. */
export const monthAdjOf = (r: EventCommission): CommissionMonthAdjustment[] => r.monthAdjustments ?? [];
/* Nor, before 2026-11-12, late bills, marks or anything moved from last month. */
export const lateOf = (r: EventCommission): Set<string> => new Set(r.lateBills ?? []);
export const markedOf = (r: EventCommission): CommissionMarkedOrder[] => r.marked ?? [];
export const deferredInOf = (r: EventCommission): CommissionDeferredIn[] => r.deferredIn ?? [];
/** The earlier orders as the page lists them (owner 2026-11-12: 「earlier order 我只
    想显示reached 30% 和cancelled」, 「这样drop up sales 就不需要算cancelled 了」): only
    an order that reached 30% or was cancelled in the range, with those events
    alone. Its upsales and drop sales are the Upsales / Drop sales table's, so
    what it shows is its commission less the effect listed there — the summary's
    Earlier line: reaching 30% earns on the order before the range's changes, a
    cancellation takes back what it had earned. An order only priced up or down
    is not listed; the money is unchanged. */
export const earlierShownOf = (r: EventCommission): CommissionEarlierOrder[] => {
  const effect = new Map(changedOf(r).filter((o) => o.part === 'earlier').map((o) => [o.docNo, o.effectSen]));
  return earlierOf(r).flatMap((o) => {
    const events = o.events.filter((e) => e.kind === 'reached' || e.kind === 'cancelled');
    if (events.length === 0) return [];
    return [{
      ...o,
      events,
      lastDate: events.reduce((m, e) => (e.date > m ? e.date : m), events[0]!.date),
      commissionSen: o.commissionSen - (effect.get(o.docNo) ?? 0),
      fromHistory: false,
    }];
  });
};
/** What happened to an earlier order in the range, in a few words. */
export const whatOf = (o: CommissionEarlierOrder): string =>
  o.events.map((e) => `${KIND_LABEL[e.kind]}${e.uncounted ? ' (left out)' : e.beforeReach ? ' (before 30%)' : ''}`)
    .filter((w, i, all) => all.indexOf(w) === i).join(' · ');
/** A mark in a few words: "Not counted", "Price change not counted" or "Next month (2026/11)". */
export const markWords = (m: Pick<CommissionMarkInfo, 'kind' | 'month'>): string => {
  if (m.kind === 'exclude') return 'Not counted';
  if (m.kind === 'exclude_change') return 'Price change not counted';
  return `Next month${m.month ? ` (${monthLabel(nextMonthOf(m.month))})` : ''}`;
};

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
    ...monthAdjOf(r).map((a) => brandOfOrder(a)), ...deferredInOf(r).map((o) => brandOfOrder(o)),
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
  const marked = markedOf(r).filter((o) => brandOfOrder(o) === brand);
  const deferredIn = deferredInOf(r).filter((o) => brandOfOrder(o) === brand);
  const payableSen = sum(fairs, (f) => f.payableSen);
  const adjustmentsSen = sum(adjustments, (a) => a.commissionSen);
  const monthAdjustmentsSen = sum(monthAdjustments, (a) => a.adjustmentSen);
  const deferredInSen = sum(deferredIn, (o) => o.commissionSen);
  return {
    ...r, fairs, adjustments, earlierOrders, changedOrders, monthAdjustments, marked, deferredIn,
    totals: { payableSen, adjustmentsSen, monthAdjustmentsSen, deferredInSen, totalSen: payableSen + adjustmentsSen + monthAdjustmentsSen + deferredInSen },
  };
};

/* ── The summary: each sen on one line ────────────────────────────────────── */

export type SummaryKey = 'fair' | 'noFair' | 'changes' | 'late' | 'earlier' | 'monthAdj' | 'deferredIn';
/** The server's "No fair" rows (by SO date, an order with no fair) carry an id below 0. */
export const isNoFair = (f: Pick<CommissionFairRow, 'id'>): boolean => f.id < 0;
export type CommissionSummary = Record<SummaryKey, number> & { totalSen: number };
export const SUMMARY_LABEL: Record<SummaryKey, string> = {
  fair: 'Fair commission', noFair: 'No fair', changes: 'Upsales / drop sales', late: 'Late bills (补开单)', earlier: 'Earlier orders',
  monthAdj: 'Closed months — adjustments', deferredIn: 'Moved from last month',
};
export const SUMMARY_HINT: Record<SummaryKey, string> = {
  fair: 'what the orders earned, before their upsales / drop sales',
  noFair: 'orders opened in the range with no fair, at the rate of their own brand (bed frames alone: the VP brand)',
  changes: 'the effect of the upsales and drop sales, at the brand rate',
  late: 'sold at a fair that had ended before the range, keyed in it',
  earlier: 'earlier orders that reached 30% here, or were cancelled',
  monthAdj: 'what changed for a closed month\'s orders',
  deferredIn: 'what last month moved here',
};
export const SUMMARY_ORDER: SummaryKey[] = ['fair', 'noFair', 'changes', 'late', 'earlier', 'monthAdj', 'deferredIn'];

/** One order's commission on this report, split over the summary lines. */
export type OrderLine = {
  docNo: string; ref: string | null; fairName: string; brand: string | null; salesperson: string | null; soDate: string | null;
  goodsSen: number | null; paidPct: number | null; reachedOn: string | null;
  split: Record<SummaryKey, number>;
  totalSen: number;
  /** Its marks — the order not counted or moved, a price change left out — and
      what they took out of this report together. */
  marks: CommissionMarkInfo[];
  markedSen: number;
};
/** An order's marks in the export's one cell. */
const marksText = (l: OrderLine): string => l.marks.map(markWords).join('; ');

/** Every order on the report, once, its commission split over the summary
    lines; the lines' sums are the summary and add up to the report's total. */
export function orderLines(r: EventCommission): OrderLine[] {
  const late = lateOf(r);
  const effect = new Map(changedOf(r).map((o) => [o.docNo, o]));
  const lines = new Map<string, OrderLine>();
  const zero = (): Record<SummaryKey, number> => ({ fair: 0, noFair: 0, changes: 0, late: 0, earlier: 0, monthAdj: 0, deferredIn: 0 });
  const lineOf = (docNo: string, init: () => Omit<OrderLine, 'split' | 'totalSen' | 'marks' | 'markedSen'>): OrderLine => {
    let l = lines.get(docNo);
    if (!l) {
      l = { ...init(), split: zero(), totalSen: 0, marks: [], markedSen: 0 };
      lines.set(docNo, l);
    }
    return l;
  };
  const add = (l: OrderLine, key: SummaryKey, sen: number) => { l.split[key] += sen; l.totalSen += sen; };
  const placeLine = (o: { docNo: string; ref?: string | null; fairName: string; brand: string | null; salesperson: string | null; soDate?: string | null }) =>
    () => ({ docNo: o.docNo, ref: o.ref ?? null, fairName: o.fairName, brand: brandOfOrder(o), salesperson: o.salesperson, soDate: o.soDate ?? null, goodsSen: null, paidPct: null, reachedOn: null });

  for (const f of r.fairs) {
    for (const s of f.sos) {
      const l = lineOf(s.docNo, () => ({
        docNo: s.docNo, ref: s.ref ?? null, fairName: f.name, brand: brandOfFair(f), salesperson: s.salesperson, soDate: s.soDate,
        goodsSen: s.goodsSen, paidPct: s.paidPct, reachedOn: s.reachedOn,
      }));
      if (late.has(s.docNo)) { add(l, 'late', s.commissionSen); continue; }
      const e = effect.get(s.docNo);
      const inside = e && e.part === 'range' ? e.effectSen : 0;
      add(l, 'changes', inside);
      add(l, isNoFair(f) ? 'noFair' : 'fair', s.commissionSen - inside);
    }
  }
  const earlierByDoc = new Map<string, number>();
  for (const a of r.adjustments) earlierByDoc.set(a.docNo, (earlierByDoc.get(a.docNo) ?? 0) + a.commissionSen);
  const earlierPlace = new Map(earlierOf(r).map((o) => [o.docNo, o]));
  for (const [docNo, sen] of earlierByDoc) {
    const place = earlierPlace.get(docNo) ?? r.adjustments.find((a) => a.docNo === docNo)!;
    const l = lineOf(docNo, placeLine({ ...place, brand: 'brand' in place ? place.brand : null }));
    if (late.has(docNo)) { add(l, 'late', sen); continue; }
    const e = effect.get(docNo);
    const inside = e && e.part === 'earlier' ? e.effectSen : 0;
    add(l, 'changes', inside);
    add(l, 'earlier', sen - inside);
  }
  for (const a of monthAdjOf(r)) {
    const l = lineOf(a.docNo, placeLine(a));
    add(l, late.has(a.docNo) ? 'late' : 'monthAdj', a.adjustmentSen);
  }
  for (const d of deferredInOf(r)) add(lineOf(d.docNo, placeLine(d)), 'deferredIn', d.commissionSen);
  for (const m of markedOf(r)) {
    const l = lineOf(m.docNo, placeLine(m));
    l.marks.push(m.mark);
    l.markedSen += m.commissionSen;
  }
  return [...lines.values()].sort((a, b) => (a.fairName < b.fairName ? -1 : a.fairName > b.fairName ? 1 : a.docNo < b.docNo ? -1 : 1));
}

/** The report on the summary lines; they add up to its total. */
export function summaryOf(r: EventCommission): CommissionSummary {
  const lines = orderLines(r);
  const out = { fair: 0, noFair: 0, changes: 0, late: 0, earlier: 0, monthAdj: 0, deferredIn: 0, totalSen: 0 };
  for (const l of lines) {
    for (const k of SUMMARY_ORDER) out[k] += l.split[k];
    out.totalSen += l.totalSen;
  }
  return out;
}

/** Part 1's orders not yet at 30% (owner 2026-11-12: 「below deposit 另外分开」):
    what they earn once 30% of the order is paid, and how much is still owed for that. */
export type BelowDepositRow = CommissionSoRow & { fair: CommissionFairRow; neededSen: number };
export const belowDepositOf = (r: EventCommission): BelowDepositRow[] =>
  r.fairs.flatMap((f) => f.sos
    .filter((s) => s.reachedOn == null && !s.mark)
    .map((s) => ({ ...s, fair: f, neededSen: Math.max(0, Math.ceil(s.totalSen * 0.3) - s.paidSen) })));

/* ── CSV and the Excel / PDF sheet ─────────────────────────────────────────── */

const percentText = (p: number | null): string => (p == null ? '' : `${p}%`);

/** The summary lines, then one row per order with its split. */
export const eventCommissionCsv = (r: EventCommission): string => {
  const esc = (v: string | number | null) => `"${guardFormula(String(v ?? '')).replace(/"/g, '""')}"`;
  const row = (cells: Array<string | number | null>) => cells.map(esc).join(',');
  const s = summaryOf(r);
  const lines = [row(['Summary', 'RM'])];
  for (const k of SUMMARY_ORDER) lines.push(row([SUMMARY_LABEL[k], fmtRm(s[k])]));
  lines.push(row(['Total', fmtRm(s.totalSen)]), '');
  lines.push(row(['Order', 'Ref No.', 'Fair', 'Brand', 'Salesperson', 'SO date', 'Goods', 'Paid %', '30% reached',
    ...SUMMARY_ORDER.map((k) => SUMMARY_LABEL[k]), 'Commission', 'Marked', 'Not paid here']));
  for (const l of orderLines(r)) {
    lines.push(row([
      l.docNo, l.ref, l.fairName, l.brand, l.salesperson, l.soDate, l.goodsSen == null ? '' : fmtRm(l.goodsSen), percentText(l.paidPct), l.reachedOn,
      ...SUMMARY_ORDER.map((k) => fmtRm(l.split[k])), fmtRm(l.totalSen), marksText(l), l.marks.length > 0 ? fmtRm(l.markedSen) : '',
    ]));
  }
  lines.push('', row(['Total', '', '', '', '', '', '', '', '', ...SUMMARY_ORDER.map((k) => fmtRm(s[k])), fmtRm(s.totalSen), '', '']));
  return `${lines.join('\n')}\n`;
};

export const RULE_NOTE = 'An order earns its goods (no delivery or service) × the fair\'s brand rate once 30% of the order is paid. Upsales and drop sales count from 1/9/2026 (1 September – 19 October read from each order\'s modification history), each in the month it happened, at the fair\'s brand rate; one Finance left out (Don\'t count change) moves no commission and the order earns on the rest. A late bill (补开单) is an order keyed in the range for a fair that had ended before it.';

/** The report as the owner asked to export it: the summary, the fairs (by fair),
    then every order once with its commission split over the summary lines. */
export function eventCommissionSheet(r: EventCommission, period: string, brand: string): ReportSheet {
  const byFair = basisOf(r) === 'fair';
  const words = BASIS_WORDS[basisOf(r)];
  const text = (v: string | number | null | undefined): SheetValue => (v == null || v === '' ? null : String(v));
  const s = summaryOf(r);
  const summary: SheetTable = {
    columns: [AMOUNT_COLUMN('Commission')],
    rows: [
      ...SUMMARY_ORDER.map((k): SheetRow => ({ kind: 'row', depth: 0, label: SUMMARY_LABEL[k], cells: [s[k]] })),
      { kind: 'total', depth: 0, label: 'Total commission', cells: [s.totalSen] },
    ],
  };
  const tables: SheetTable[] = [summary];
  if (byFair) {
    tables.push({
      columns: [
        { label: 'Dates', kind: 'text' }, { label: 'Rate', kind: 'text' },
        AMOUNT_COLUMN('Total sales'), AMOUNT_COLUMN('Estimate'), { label: 'Orders', kind: 'text' }, AMOUNT_COLUMN('Commission'),
      ],
      rows: [
        ...r.fairs.map((f): SheetRow => ({
          kind: 'row', depth: 0, label: f.name,
          cells: [
            fmtDayMonthRange(f.startDate, f.endDate), f.ratePct == null ? 'no rate card' : `${f.ratePct}%`,
            f.goodsSen ?? (f.totalSalesRm == null ? null : Math.round(f.totalSalesRm * 100)),
            f.estimateSen ?? (f.estimateRm == null ? null : Math.round(f.estimateRm * 100)),
            String(f.sos.length), f.payableSen,
          ],
        })),
        { kind: 'total', depth: 0, label: words.inRange, cells: [null, null, sum(r.fairs, (f) => f.goodsSen ?? 0), sum(r.fairs, (f) => f.estimateSen ?? 0), null, r.totals.payableSen] },
      ],
    });
  }
  const lines = orderLines(r);
  tables.push({
    columns: [
      { label: 'Ref No.', kind: 'text' }, { label: 'Fair', kind: 'text' }, { label: 'Salesperson', kind: 'text' }, AMOUNT_COLUMN('Goods'), { label: 'Paid %', kind: 'text' },
      ...SUMMARY_ORDER.map((k) => AMOUNT_COLUMN(SUMMARY_LABEL[k])), AMOUNT_COLUMN('Commission'), { label: 'Marked', kind: 'text' },
    ],
    rows: [
      ...lines.map((l): SheetRow => ({
        kind: 'row', depth: 0, label: l.docNo,
        cells: [text(l.ref), l.fairName, text(l.salesperson), l.goodsSen, text(percentText(l.paidPct)), ...SUMMARY_ORDER.map((k) => l.split[k]), l.totalSen, text(marksText(l))],
      })),
      { kind: 'total', depth: 0, label: 'Every order', cells: [null, null, null, null, null, ...SUMMARY_ORDER.map((k) => s[k]), s.totalSen, null] },
    ],
  });
  return {
    title: 'Event commission',
    subtitle: `${period} · ${words.toggle.toLowerCase()} · ${brand || 'all brands'} · total ${fmtRm(r.totals.totalSen)} · RM`,
    meta: [{ label: 'Period', value: period }, { label: 'View', value: words.toggle }],
    tables,
    notes: [RULE_NOTE],
  };
}

/** A fair's dates as a sort key: start, end, venue, organizer, brand — the
    fairs at one place and time sit together (owner 2026-11-12). */
export const fairSortKey = (f: CommissionFairRow): string => {
  const p = fairPlace(f);
  return [f.startDate, f.endDate ?? '', p.venue ?? '', p.organizer ?? '', p.brand ?? ''].join('|').toUpperCase();
};

/** "2026/10/02" for a day; a dash for none. */
export const dayText = (d: string | null | undefined): string => fmtDateOrDash(d ?? null);
