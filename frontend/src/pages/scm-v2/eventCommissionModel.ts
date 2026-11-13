// ----------------------------------------------------------------------------
// eventCommissionModel — the Event Commission tab's arithmetic and words, with
// no React in it: what a report sums to, how one brand narrows it, and the
// CSV and the Excel / PDF sheet. The tab (EventCommission.tsx) draws it; the
// rules that make the report are the server's (backend/src/scm/lib/
// event-commission.ts).
//
// THE CARDS (owner 2026-11-13: 「卡的顺序和下面的table的顺序要一样」, 「这两个total
// 不是应该一样？」): one card per table that adds to the total, in the tables'
// order, each its table's total, together the report's total — the orders opened
// in the range (by fair: the fairs starting in it), the earlier orders that reached
// 30% or were cancelled, the closed months' adjustments, what last month moved
// here, Finance's own lines, and the earlier orders' upsales / drop sales. The
// range's own upsales / drops are inside the first table's commission: their table
// has no card. The export (「排一排做好看一点」) is the same: a summary of the cards,
// with what the first one holds inside it — its orders with no fair, their upsales
// / drop sales, its 补开单 (owner 2026-11-12: 「我要看到 … drop sales upsales
// commission 多少，补开单的多少」) — as "of which" lines, then each table in the
// page's order under its own title.
// An order Finance marked (「这张单不要算」 / 「这个算下个月」) earns nothing here;
// what the mark took out is listed apart, not in the total. A price change
// Finance left out (「这次改价不算」) moves no commission and the order earns on the
// rest — what it left out is listed apart the same way.
// ----------------------------------------------------------------------------

import { guardFormula } from '../../lib/csv';
import type {
  CommissionAdjustment, CommissionBasis, CommissionChange, CommissionChangedOrder, CommissionDeferredIn, CommissionEarlierOrder,
  CommissionFairRow, CommissionManualLine, CommissionMarkedOrder, CommissionMarkInfo, CommissionMonthAdjustment, CommissionSoRow, EventCommission,
} from '../../vendor/scm/lib/event-queries';
import { fmtDateOrDash, fmtDayMonthRange } from '../../vendor/shared/format';
import { AMOUNT_COLUMN, sheetText, type ReportSheet, type SheetColumn, type SheetRow, type SheetTable, type SheetValue } from '../../vendor/scm/lib/report-sheet';

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
  system_fix: 'system price fix, not counted', price_wiped: 'price wiped to 0, not counted',
};
/** An upsale / drop Finance left out (「这次改价不算」), beside the change. */
export const LEFT_OUT_NOTE = 'left out by Finance, not counted';

/* The words each basis puts on the page. */
export const BASIS_WORDS: Record<CommissionBasis, { toggle: string; part1: string; card1: string; part1Empty: string; part2: string; part2Empty: string; inRange: string; earlier: string }> = {
  fair: {
    toggle: 'By fair', part1: 'Fairs starting in the range', card1: 'Fairs starting in the range', part1Empty: 'No fair starts in this range.',
    part2: 'Earlier fairs — reached 30% or cancelled in the range', part2Empty: 'No order of an earlier fair reached 30% or was cancelled in this range.',
    inRange: 'Fairs in the range', earlier: 'Earlier fairs',
  },
  so_date: {
    toggle: 'By SO date', part1: 'Orders opened in the range (SO date)', card1: 'Orders opened in the range', part1Empty: 'No order with a fair was opened in this range.',
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
/* Nor, before 2026-11-13, a line typed by Finance. */
export const manualOf = (r: EventCommission): CommissionManualLine[] => r.manualLines ?? [];
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
    ...monthAdjOf(r).map((a) => brandOfOrder(a)), ...deferredInOf(r).map((o) => brandOfOrder(o)), ...manualOf(r).map((o) => brandOfOrder(o)),
  ];
  return [...new Set(all.filter((b): b is string => !!b))].sort();
};

/** The report for one brand — its fairs, its earlier lines, and totals of
    exactly those. All brands is the report as the server sent it. */
export const forBrand = (r: EventCommission, brand: string): EventCommission => {
  if (!brand) return r;
  const fairs = r.fairs.filter((f) => brandOfFair(f) === brand);
  /* An earlier line's brand: its fair's, read off the name; with no fair, its order's — so the cards add up under one brand too. */
  const placeBrand = new Map([...earlierOf(r), ...changedOf(r)].map((o) => [o.docNo, brandOfOrder(o)]));
  const adjustments = r.adjustments.filter((a) => (fairLines(a.fairName).brand ?? placeBrand.get(a.docNo) ?? null) === brand);
  const earlierOrders = earlierOf(r).filter((o) => brandOfOrder(o) === brand);
  const changedOrders = changedOf(r).filter((o) => brandOfOrder(o) === brand);
  const monthAdjustments = monthAdjOf(r).filter((a) => brandOfOrder(a) === brand);
  const marked = markedOf(r).filter((o) => brandOfOrder(o) === brand);
  const deferredIn = deferredInOf(r).filter((o) => brandOfOrder(o) === brand);
  const payableSen = sum(fairs, (f) => f.payableSen);
  const adjustmentsSen = sum(adjustments, (a) => a.commissionSen);
  const monthAdjustmentsSen = sum(monthAdjustments, (a) => a.adjustmentSen);
  const deferredInSen = sum(deferredIn, (o) => o.commissionSen);
  /* Finance's own lines: only a report that has some carries the list and its figure. */
  const manualLines = manualOf(r).filter((o) => brandOfOrder(o) === brand);
  const manualSen = sum(manualLines, (o) => o.commissionSen);
  const manual = r.manualLines ? { manualLines } : {};
  return {
    ...r, fairs, adjustments, earlierOrders, changedOrders, monthAdjustments, marked, deferredIn, ...manual,
    totals: {
      payableSen, adjustmentsSen, monthAdjustmentsSen, deferredInSen, ...(r.manualLines ? { manualSen } : {}),
      totalSen: payableSen + adjustmentsSen + monthAdjustmentsSen + deferredInSen + manualSen,
    },
  };
};

/* ── The cards over the tables (owner 2026-11-13) ─────────────────────────────
   「卡的顺序和下面的table的顺序要一样」 and 「这两个total不是应该一样？」: one card per
   table that adds to the total, in the tables' order, each the total of its
   table — together the report's total:
     Orders opened in the range   (by fair: Fairs starting in the range) — its
                                  orders' commission, their own upsales / drops
                                  and 补开单 inside it;
     Earlier orders               reaching 30% here, or cancelled;
     Closed months — adjustments  what changed for a closed month's orders;
     Moved from last month        what the month before moved here;
     Added by Finance             Finance's own lines;
     Upsales / Drop sales — earlier orders
                                  the changes of orders opened before the range,
                                  which no table above holds.
   The upsales / drops of the orders opened in the range have a table of their
   own, with no card: they are inside the first table's commission already. */

/** The server's "No fair" rows (by SO date, an order with no fair) carry an id below 0. */
export const isNoFair = (f: Pick<CommissionFairRow, 'id'>): boolean => f.id < 0;

/** The upsales / drop sales of the orders opened in the range: inside the first table's commission. */
export const changesInRangeOf = (r: EventCommission): CommissionChangedOrder[] => changedOf(r).filter((o) => o.part === 'range');
/** Those of the earlier orders: added to the total on their own. */
export const changesEarlierOf = (r: EventCommission): CommissionChangedOrder[] => changedOf(r).filter((o) => o.part === 'earlier');

/** The words of the tables a card heads, and of the cards. */
export const TITLE = { monthAdj: 'Closed months — adjustments', deferredIn: 'Moved from last month', manual: 'Added by Finance' } as const;
export const HINT = {
  deferredIn: 'what last month moved here',
  manual: 'amounts Finance typed on an order for this month, at the order\'s own rate',
} as const;
/** "Upsales / Drop sales — earlier orders": the two changes tables, by who they belong to. */
export const changesTitle = (whose: string): string => `Upsales / Drop sales — ${whose.toLowerCase()}`;

/** "1 order", "426 orders". */
export const countText = (n: number, unit: string): string => `${n.toLocaleString('en-MY')} ${unit}${n === 1 ? '' : 's'}`;

export type CardKey = 'inRange' | 'earlier' | 'monthAdj' | 'deferredIn' | 'manual' | 'earlierChanges';
export type CommissionCard = { key: CardKey; label: string; sen: number; count: string };

/** The cards, in the tables' order. The first two and the last are always there; the
    others only when their table is. Their figures add up to the report's total. */
export function cardsOf(r: EventCommission): CommissionCard[] {
  const words = BASIS_WORDS[basisOf(r)];
  const sos = r.fairs.flatMap((f) => f.sos);
  const earlier = earlierShownOf(r);
  const monthAdj = monthAdjOf(r);
  const moved = deferredInOf(r);
  const manual = manualOf(r);
  const later = changesEarlierOf(r);
  const cards: CommissionCard[] = [
    {
      key: 'inRange', label: words.card1, sen: sum(sos, (s) => s.commissionSen),
      count: basisOf(r) === 'fair' ? `${countText(r.fairs.length, 'fair')} · ${countText(sos.length, 'order')}` : countText(sos.length, 'order'),
    },
    { key: 'earlier', label: words.earlier, sen: sum(earlier, (o) => o.commissionSen), count: countText(earlier.length, 'order') },
  ];
  if (monthAdj.length > 0) {
    cards.push({
      key: 'monthAdj', label: TITLE.monthAdj, sen: sum(monthAdj, (a) => a.adjustmentSen),
      count: `${countText(monthAdj.length, 'order')} · ${[...new Set(monthAdj.map((a) => monthLabel(a.month)))].join(', ')}`,
    });
  }
  if (moved.length > 0) cards.push({ key: 'deferredIn', label: TITLE.deferredIn, sen: sum(moved, (d) => d.commissionSen), count: countText(moved.length, 'order') });
  if (manual.length > 0) cards.push({ key: 'manual', label: TITLE.manual, sen: sum(manual, (m) => m.commissionSen), count: countText(manual.length, 'line') });
  cards.push({ key: 'earlierChanges', label: changesTitle(words.earlier), sen: sum(later, (o) => o.effectSen), count: countText(later.length, 'order') });
  return cards;
}

/** What the first table holds inside it, for the export's summary (owner 2026-11-12:
    「这个export 出来我要看到 … drop sales upsales commission 多少，补开单的多少」): its
    orders with no fair, their upsales / drop sales, its 补开单. Each is part of the
    first card already — "of which", not added again. */
export function insideFirstOf(r: EventCommission): Array<{ label: string; sen: number; count: string }> {
  const late = lateOf(r);
  const noFair = r.fairs.filter(isNoFair).flatMap((f) => f.sos);
  const changes = changesInRangeOf(r);
  const lateRows = r.fairs.flatMap((f) => f.sos).filter((s) => late.has(s.docNo));
  return [
    ...(noFair.length > 0 ? [{ label: 'of which No fair', sen: sum(noFair, (s) => s.commissionSen), count: countText(noFair.length, 'order') }] : []),
    { label: 'of which upsales / drop sales', sen: sum(changes, (o) => o.effectSen), count: countText(changes.length, 'order') },
    /* In English: the PDF's Chinese face has no 补开单, and refused the whole export over it. */
    { label: 'of which late bills', sen: sum(lateRows, (s) => s.commissionSen), count: countText(lateRows.length, 'order') },
  ];
}

/** Part 1's orders not yet at 30% (owner 2026-11-12: 「below deposit 另外分开」):
    what they earn once 30% of the order is paid, and how much is still owed for that. */
export type BelowDepositRow = CommissionSoRow & { fair: CommissionFairRow; neededSen: number };
export const belowDepositOf = (r: EventCommission): BelowDepositRow[] =>
  r.fairs.flatMap((f) => f.sos
    .filter((s) => s.reachedOn == null && !s.mark)
    .map((s) => ({ ...s, fair: f, neededSen: Math.max(0, Math.ceil(s.totalSen * 0.3) - s.paidSen) })));

/* ── The Excel / PDF sheet and the CSV ─────────────────────────────────────────
   Owner 2026-11-13: 「export 出来的顺便排一排做好看一点」. The summary (the cards, the
   first card's "of which" lines under it), then each table the page shows, in the
   page's order, under its own title: its order numbers down the side, names and
   dates read left to right, the figures right, a total at its foot. The tables
   not in the total come last and say so. */

const percentText = (p: number | null): string => (p == null ? '' : `${p}%`);
const rateText = (p: number | null | undefined): SheetValue => (p == null ? null : `${p}%`);
const left = (label: string, width?: number): SheetColumn => ({ label, kind: 'text', align: 'left', ...(width ? { width } : {}) });
const right = (label: string): SheetColumn => ({ label, kind: 'text', align: 'right' });
const row = (label: string, cells: SheetValue[], depth = 0): SheetRow => ({ kind: 'row', depth, label, cells });
const foot = (label: string, cells: SheetValue[]): SheetRow => ({ kind: 'total', depth: 0, label, cells });
/** A column summed for the foot, else left blank there. */
const footCells = <T,>(columns: Array<((x: T) => number) | null>, rows: readonly T[]): SheetValue[] =>
  columns.map((pick) => (pick ? sum(rows, pick) : ''));
const brandText = (o: { brand: string | null; fairName: string }): SheetValue => brandOfOrder(o) ?? null;
/** An upsale / drop's state in a few words, as the row on the page reads it. */
const changeNote = (o: CommissionChangedOrder): string => (o.mark ? markWords(o.mark)
  : o.reachedOn == null && !o.oldOrder ? 'not yet 30%'
    : o.changeMark && o.effectSen === 0 ? 'not counted' : '');

/** The orders of the first table, one row each: as the SO list reads, plus the rate. */
function ordersTable(title: string, rows: Array<CommissionSoRow & { fair: CommissionFairRow }>): SheetTable {
  const brand = (o: CommissionSoRow & { fair: CommissionFairRow }) => (isNoFair(o.fair) ? o.fair.brand?.toUpperCase() ?? null : fairPlace(o.fair).brand);
  return {
    title, labelHeader: 'Order',
    columns: [
      left('Ref No.', 12), left('SO date', 11), left('Brand', 11), left('Fair', 44), left('Salesperson', 14),
      AMOUNT_COLUMN('Goods'), right('Rate'), right('Paid %'), left('30% reached', 12), AMOUNT_COLUMN('Commission'), left('Marked', 26),
    ],
    rows: [
      ...rows.map((o) => row(o.docNo, [
        o.ref ?? null, dayText(o.soDate), brand(o), o.fair.name, o.salesperson ?? null,
        o.goodsSen, rateText(o.fair.ratePct), percentText(o.paidPct), o.reachedOn ? dayText(o.reachedOn) : 'not yet', o.commissionSen,
        o.mark ? markWords(o.mark) : '',
      ])),
      foot(`Total · ${countText(rows.length, 'order')}`, footCells<CommissionSoRow>([null, null, null, null, null, (o) => o.goodsSen, null, null, null, (o) => o.commissionSen, null], rows)),
    ],
  };
}

/** A table of upsales / drop sales, each order once, as the page's. */
function changesTable(title: string, rows: CommissionChangedOrder[]): SheetTable {
  return {
    title, labelHeader: 'Order',
    columns: [
      left('Last change', 11), left('Ref No.', 12), left('Brand', 11), left('Salesperson', 14),
      AMOUNT_COLUMN('Original'), AMOUNT_COLUMN('Latest'), AMOUNT_COLUMN('Amended'), right('Rate'), AMOUNT_COLUMN('Commission effect'), left('Note', 26),
    ],
    rows: [
      ...rows.map((o) => row(o.docNo, [
        dayText(o.lastChange), o.ref ?? null, brandText(o), o.salesperson ?? null,
        o.originalSen, o.latestSen, o.amendedSen, rateText(o.ratePct), o.effectSen, changeNote(o),
      ])),
      foot(`Total · ${countText(rows.length, 'order')}`, footCells<CommissionChangedOrder>([null, null, null, null, (o) => o.originalSen, (o) => o.latestSen, (o) => o.amendedSen, null, (o) => o.effectSen, null], rows)),
    ],
  };
}

/** The report as the page shows it, for Excel and PDF (and the CSV). */
export function eventCommissionSheet(r: EventCommission, period: string, brand: string): ReportSheet {
  const byFair = basisOf(r) === 'fair';
  const words = BASIS_WORDS[basisOf(r)];
  const cards = cardsOf(r);
  const tables: SheetTable[] = [];

  /* The summary: the cards, the first one's "of which" under it, the total. */
  const inside = insideFirstOf(r);
  tables.push({
    title: 'Summary',
    columns: [left('Orders', 24), AMOUNT_COLUMN('Commission')],
    rows: [
      ...cards.flatMap((c) => [
        row(c.label, [c.count, c.sen]),
        ...(c.key === 'inRange' ? inside.map((o) => ({ kind: 'memo' as const, depth: 1, label: o.label, cells: [o.count, o.sen] })) : []),
      ]),
      foot('Total commission', ['', r.totals.totalSen]),
    ],
  });

  /* 1 — the orders opened in the range; by fair, its fairs first. */
  const listed = r.fairs.flatMap((f) => f.sos.map((s) => ({ ...s, fair: f })));
  if (byFair) {
    /* A server before 2026-11-12 sent no goods per fair: the typed figures stand in, on the rows and in the total alike. */
    const goodsOf = (f: CommissionFairRow) => f.goodsSen ?? (f.totalSalesRm == null ? null : Math.round(f.totalSalesRm * 100));
    const timesRateOf = (f: CommissionFairRow) => f.estimateSen ?? (f.estimateRm == null ? null : Math.round(f.estimateRm * 100));
    tables.push({
      title: words.part1, labelHeader: 'Fair',
      columns: [left('Dates', 14), right('Rate'), AMOUNT_COLUMN('Goods'), AMOUNT_COLUMN('Goods × rate'), right('Orders'), AMOUNT_COLUMN('Commission')],
      rows: [
        ...r.fairs.map((f) => row(f.name, [
          fmtDayMonthRange(f.startDate, f.endDate), f.ratePct == null ? 'no rate card' : `${f.ratePct}%`,
          goodsOf(f), timesRateOf(f),
          String(f.sos.length), f.payableSen,
        ])),
        foot(`Total · ${countText(r.fairs.length, 'fair')}`, ['', '', sum(r.fairs, (f) => goodsOf(f) ?? 0), sum(r.fairs, (f) => timesRateOf(f) ?? 0), String(listed.length), r.totals.payableSen]),
      ],
    });
    tables.push(ordersTable(`${words.part1} — their orders`, listed));
  } else tables.push(ordersTable(words.part1, listed));

  /* 2 — the earlier orders: reaching 30% or cancelled. */
  const earlier = earlierShownOf(r);
  tables.push({
    title: words.part2, labelHeader: 'Order',
    columns: [left('Date', 11), left('What', 22), left('Ref No.', 12), left('Brand', 11), left('Salesperson', 14), AMOUNT_COLUMN('Original'), right('Rate'), AMOUNT_COLUMN('Commission'), left('Marked', 26)],
    rows: [
      ...earlier.map((o) => row(o.docNo, [
        dayText(o.lastDate), whatOf(o), o.ref ?? null, brandText(o), o.salesperson ?? null, o.originalSen, rateText(o.ratePct), o.commissionSen, o.mark ? markWords(o.mark) : '',
      ])),
      foot(`Total · ${countText(earlier.length, 'order')}`, footCells<CommissionEarlierOrder>([null, null, null, null, null, (o) => o.originalSen, null, (o) => o.commissionSen, null], earlier)),
    ],
  });

  /* 3 — what changed for a closed month's orders, with the goods and rate its Now is worked on. */
  const monthAdj = monthAdjOf(r);
  if (monthAdj.length > 0) {
    tables.push({
      title: TITLE.monthAdj, labelHeader: 'Order',
      columns: [left('Month', 9), left('Ref No.', 12), left('Brand', 11), left('Salesperson', 14), AMOUNT_COLUMN('Goods'), right('Rate'), AMOUNT_COLUMN('Paid'), AMOUNT_COLUMN('Now'), AMOUNT_COLUMN('Adjustment')],
      rows: [
        ...monthAdj.map((a) => row(a.docNo, [
          monthLabel(a.month), a.ref ?? null, brandText(a), a.salesperson ?? null, a.goodsSen ?? null, rateText(a.ratePct), a.wasSen, a.nowSen, a.adjustmentSen,
        ])),
        foot(`Total · ${countText(monthAdj.length, 'order')}`, footCells<CommissionMonthAdjustment>([null, null, null, null, (a) => a.goodsSen ?? 0, null, (a) => a.wasSen, (a) => a.nowSen, (a) => a.adjustmentSen], monthAdj)),
      ],
    });
  }

  /* 4 — what the month before moved here. */
  const moved = deferredInOf(r);
  if (moved.length > 0) {
    tables.push({
      title: TITLE.deferredIn, labelHeader: 'Order',
      columns: [left('From month', 10), left('Ref No.', 12), left('Brand', 11), left('Reason', 44), left('Salesperson', 14), AMOUNT_COLUMN('Commission')],
      rows: [
        ...moved.map((d) => row(d.docNo, [monthLabel(d.fromMonth), d.ref ?? null, brandText(d), d.mark.reason ?? '', d.salesperson ?? null, d.commissionSen])),
        foot(`Total · ${countText(moved.length, 'order')}`, footCells<CommissionDeferredIn>([null, null, null, null, null, (d) => d.commissionSen], moved)),
      ],
    });
  }

  /* 5 — Finance's own lines. */
  const manual = manualOf(r);
  if (manual.length > 0) {
    tables.push({
      title: TITLE.manual, labelHeader: 'Order',
      columns: [left('Ref No.', 12), left('Brand', 11), left('Salesperson', 14), left('Reason', 44), left('Added by', 24), AMOUNT_COLUMN('Goods'), right('Rate'), AMOUNT_COLUMN('Commission')],
      rows: [
        ...manual.map((m) => row(m.docNo, [m.ref ?? null, brandText(m), m.salesperson ?? null, m.line.reason ?? '', m.line.addedBy ?? '', m.goodsSen, rateText(m.ratePct), m.commissionSen])),
        foot(`Total · ${countText(manual.length, 'line')}`, footCells<CommissionManualLine>([null, null, null, null, null, (m) => m.goodsSen, null, (m) => m.commissionSen], manual)),
      ],
    });
  }

  /* 6 — the earlier orders' upsales / drop sales (the last card); 7 — those inside the first table. */
  tables.push(changesTable(changesTitle(words.earlier), changesEarlierOf(r)));
  const inRange = changesInRangeOf(r);
  if (inRange.length > 0) tables.push(changesTable(`${changesTitle(words.card1)} (inside ${words.card1}, not added again)`, inRange));

  /* Not in the total: the orders under 30%, and what Finance's marks took out. */
  const below = belowDepositOf(r);
  if (below.length > 0) {
    tables.push({
      title: 'Below 30% paid (not in the total)', labelHeader: 'Order',
      columns: [left('SO date', 11), left('Ref No.', 12), left('Brand', 11), left('Salesperson', 14), AMOUNT_COLUMN('Sales'), AMOUNT_COLUMN('Paid'), right('Paid %'), AMOUNT_COLUMN('To pay for 30%')],
      rows: [
        ...below.map((o) => row(o.docNo, [dayText(o.soDate), o.ref ?? null, isNoFair(o.fair) ? o.fair.brand?.toUpperCase() ?? null : fairPlace(o.fair).brand, o.salesperson ?? null, o.totalSen, o.paidSen, percentText(o.paidPct), o.neededSen])),
        foot(`Total · ${countText(below.length, 'order')}`, footCells<BelowDepositRow>([null, null, null, null, (o) => o.totalSen, (o) => o.paidSen, null, (o) => o.neededSen], below)),
      ],
    });
  }
  const marked = markedOf(r);
  if (marked.length > 0) {
    tables.push({
      title: 'Marked — not paid here (not in the total)', labelHeader: 'Order',
      columns: [left('Mark', 26), left('Ref No.', 12), left('Brand', 11), left('Reason', 44), left('Salesperson', 14), AMOUNT_COLUMN('Not paid here')],
      rows: [
        ...marked.map((m) => row(m.docNo, [markWords(m.mark), m.ref ?? null, brandText(m), m.mark.reason ?? '', m.salesperson ?? null, m.commissionSen])),
        foot(`Total · ${countText(marked.length, 'mark')}`, footCells<CommissionMarkedOrder>([null, null, null, null, null, (m) => m.commissionSen], marked)),
      ],
    });
  }

  return {
    title: 'Event commission',
    subtitle: `${period} · ${words.toggle.toLowerCase()} · ${brand || 'all brands'} · total ${fmtRm(r.totals.totalSen)} · RM`,
    meta: [{ label: 'Period', value: period }, { label: 'View', value: words.toggle }, { label: 'Brand', value: brand || 'All brands' }],
    tables,
    notes: [RULE_NOTE.replace(' (补开单)', '')],
    fmt: fmtRm,
  };
}

/** The same sheet as a CSV: each table under its title, its heading, its rows, a blank line. */
export const eventCommissionCsv = (r: EventCommission, period = '', brand = ''): string => {
  const sheet = eventCommissionSheet(r, period, brand);
  const esc = (v: string) => `"${guardFormula(v).replace(/"/g, '""')}"`;
  const line = (cells: string[]) => cells.map(esc).join(',');
  const out = [line([sheet.title]), line([sheet.subtitle]), ''];
  for (const t of sheet.tables) {
    if (t.title) out.push(line([t.title]));
    out.push(line([t.labelHeader ?? '', ...t.columns.map((c) => c.label)]));
    /* Nothing is a blank cell here: a dash would read as a formula to the guard. */
    for (const rw of t.rows) out.push(line([rw.label, ...t.columns.map((c, i) => { const v = rw.cells[i]; return v == null || v === '' ? '' : sheetText(c, v, fmtRm); })]));
    out.push('');
  }
  for (const n of sheet.notes ?? []) out.push(line([n]));
  return `${out.join('\n')}\n`;
};

export const RULE_NOTE = 'An order earns its goods (no delivery or service) × the fair\'s brand rate once 30% of the order is paid. Upsales and drop sales count from 1/9/2026 (1 September – 19 October read from each order\'s modification history), each in the month it happened, at the fair\'s brand rate; one Finance left out (Don\'t count change) moves no commission and the order earns on the rest. A price wiped to 0 and typed again is no change (typed again at another figure, the difference counts that day). A late bill (补开单) is an order keyed in the range for a fair that had ended before it. By SO date, an order with no fair earns at its own brand\'s rate from 1/10/2026; one opened before then earns only on its upsales and drop sales, whatever has been paid, and cancelled from 1/10/2026 it gives back its goods × that rate (under Earlier orders, in the month it was cancelled). A line added by Finance is an amount of goods typed on an order for one month, at the order\'s own rate.';

/** A fair's dates as a sort key: start, end, venue, organizer, brand — the
    fairs at one place and time sit together (owner 2026-11-12). */
export const fairSortKey = (f: CommissionFairRow): string => {
  const p = fairPlace(f);
  return [f.startDate, f.endDate ?? '', p.venue ?? '', p.organizer ?? '', p.brand ?? ''].join('|').toUpperCase();
};

/** "2026/10/02" for a day; a dash for none. */
export const dayText = (d: string | null | undefined): string => fmtDateOrDash(d ?? null);
