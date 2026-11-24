// ----------------------------------------------------------------------------
// so-backlog-cover — Finance › Reports › SO conversion & backlog: the month's
// orders by Processing Date, and how much of the backlog the month cleared.
// Owner 2026-11-24, replacing the same day's DO-date version:
//   • 「根据 processing date，而不是几时放 processing date」 — an order counts in the
//     month of the Processing Date written on it, not the day it was typed in;
//   • backlog = 「以前还没有 process 的单」 — orders raised before the month that
//     had not been processed by its 1st, the orders brought over from
//     AutoCount at the cutover included;
//   • cover rate on the backlog amount = backlog processed in the month ÷ the
//     backlog at its 1st; on the month amount = backlog processed ÷ 「本月
//     process 的总额」, everything processed in the month;
//   • the average 「default 从系统，我也可以自己根据情况放」 — the plain mean of
//     each month's rate from a start month the reader may pick, by default the
//     company's first month in the ERP that had a backlog.
// An order with no Processing Date that has shipped on a delivery order counts
// on its first shipped DO's date: the cutover never mapped AutoCount's PDate
// (docs/modules/delivery-sheet-sync.md), and an order that went out was
// processed. The loader reads live orders only (not Draft, not Cancelled).
// ----------------------------------------------------------------------------

import { soIsMigratedShape } from '../scm/lib/so-is-migrated';
import { addMonths, monthEnd } from './dashboard';

export type ScOrder = {
  doc_no: string;
  so_date: string | null;
  processing_date: string | null;
  local_total_sen: number | string | null;
  debtor_name: string | null;
  linked_ac_docno: string | null;
};

/** this_month: raised in the month it was processed. backlog: raised before it. */
export type CoverPart = 'this_month' | 'backlog';

/** Where the date an order counts on comes from. */
export type DateFrom = 'processing_date' | 'first_do';

export type CoverRow = {
  docNo: string;
  soDate: string;
  /** The date the order counts on. */
  processedOn: string;
  dateFrom: DateFrom;
  customer: string | null;
  /** The order came over from AutoCount at the cutover (`soIsMigratedShape`). */
  imported: boolean;
  part: CoverPart;
  amountSen: number;
};

export type Count = { orders: number; amountSen: number };

export type CoverTotal = Count & {
  /** Share of the month's processed total, one decimal; null when nothing was processed. */
  pct: number | null;
};

export type CoverMonth = {
  month: string;
  /** Orders raised before the month and not processed by its 1st. */
  backlog: Count;
  /** Of those, the ones processed in the month. */
  backlogProcessed: Count;
  /** Everything processed in the month. */
  processed: Count;
  /** backlogProcessed ÷ backlog, one decimal; null with no backlog. */
  onBacklog: number | null;
  /** backlogProcessed ÷ processed, one decimal; null when nothing was processed. */
  onMonth: number | null;
};

export type SoBacklogCoverData = {
  month: string;
  from: string;
  to: string;
  total: Count;
  parts: Record<CoverPart, CoverTotal>;
  /** The backlog at the month's 1st. */
  backlog: Count;
  cover: { onBacklog: number | null; onMonth: number | null };
  /** Each rate's plain mean over the months from `from` to `to`; a month with no rate is left out. */
  average: { from: string; to: string; onBacklog: number | null; onMonth: number | null };
  /** Where the average starts when the reader picks nothing. */
  defaultFrom: string;
  /** The months the average covers, oldest first; the last is this month. */
  months: CoverMonth[];
  /** The orders processed in the month. */
  rows: CoverRow[];
};

const sen = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? Math.round(x) : 0;
};

const day = (v: string | null | undefined): string | null => (v ? String(v).slice(0, 10) : null);

export const pctOf = (part: number, whole: number): number | null =>
  (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

/** An order as the report places it: the date it counts on, or none yet. */
type Placed = Omit<CoverRow, 'processedOn' | 'dateFrom' | 'part'> & { on: string | null; dateFrom: DateFrom | null };

function place(orders: readonly ScOrder[], firstDo: ReadonlyMap<string, string>): Placed[] {
  const out: Placed[] = [];
  for (const o of orders) {
    const soDate = day(o.so_date);
    if (soDate === null) continue;
    const written = day(o.processing_date);
    const shipped = written ? null : (firstDo.get(o.doc_no) ?? null);
    out.push({
      docNo: o.doc_no,
      soDate,
      on: written ?? shipped,
      dateFrom: written ? 'processing_date' : shipped ? 'first_do' : null,
      customer: o.debtor_name,
      imported: soIsMigratedShape(o.doc_no, o.linked_ac_docno),
      amountSen: sen(o.local_total_sen),
    });
  }
  return out;
}

const count = (xs: readonly Placed[]): Count => ({ orders: xs.length, amountSen: xs.reduce((s, x) => s + x.amountSen, 0) });

function monthOf(placed: readonly Placed[], month: string): { cover: CoverMonth; inMonth: Placed[] } {
  const from = `${month}-01`;
  const to = monthEnd(month);
  const backlog = count(placed.filter((p) => p.soDate < from && (p.on === null || p.on >= from)));
  const inMonth = placed.filter((p) => p.on !== null && p.on >= from && p.on <= to && p.soDate <= to);
  const backlogProcessed = count(inMonth.filter((p) => p.soDate < from));
  const processed = count(inMonth);
  return {
    cover: {
      month, backlog, backlogProcessed, processed,
      onBacklog: pctOf(backlogProcessed.amountSen, backlog.amountSen),
      onMonth: pctOf(backlogProcessed.amountSen, processed.amountSen),
    },
    inMonth,
  };
}

/** The company's first month in the ERP with a backlog. Before its first order
 *  raised in the ERP the history is AutoCount's, and only the orders still open
 *  at the cutover came over (`import-ac-outstanding-so.mjs`), so those months
 *  are short; a first month with nothing waiting has no rate to give. */
function defaultFromOf(placed: readonly Placed[], month: string): string {
  const firstErp = placed.reduce<string | null>((a, p) => (!p.imported && (a === null || p.soDate < a) ? p.soDate : a), null);
  let m = firstErp === null ? month : firstErp.slice(0, 7);
  while (m < month && monthOf(placed, m).cover.backlog.orders === 0) m = addMonths(m, 1);
  return m < month ? m : month;
}

/** Shares of a whole, one decimal, adding up to 100.0: the rounding left over
 *  goes to the largest part, so a reader adding them never lands on 99.9. */
function sharesOf(amounts: Record<CoverPart, number>, whole: number): Record<CoverPart, number | null> {
  if (whole === 0) return { this_month: null, backlog: null };
  const tenths = { this_month: Math.round((amounts.this_month / whole) * 1000), backlog: Math.round((amounts.backlog / whole) * 1000) };
  const left = 1000 - tenths.this_month - tenths.backlog;
  if (amounts.backlog > amounts.this_month) tenths.backlog += left; else tenths.this_month += left;
  return { this_month: tenths.this_month / 10, backlog: tenths.backlog / 10 };
}

/** The plain mean of the months' rates as shown (one decimal), so a reader
 *  averaging the column by hand gets the same figure. */
function meanOf(rates: readonly (number | null)[]): number | null {
  const xs = rates.filter((r): r is number => r !== null);
  return xs.length === 0 ? null : Math.round((xs.reduce((s, r) => s + r, 0) / xs.length) * 10) / 10;
}

export function buildSoBacklogCover(input: {
  month: string;
  /** The average's first month; null = the company's default. */
  avgFrom: string | null;
  orders: readonly ScOrder[];
  /** Each order's first shipped DO date, read for the orders with no Processing Date. */
  firstDo: ReadonlyMap<string, string>;
}): SoBacklogCoverData {
  const { month } = input;
  const placed = place(input.orders, input.firstDo);
  const defaultFrom = defaultFromOf(placed, month);
  const avgFrom = input.avgFrom !== null && input.avgFrom <= month ? input.avgFrom : defaultFrom;

  const months: CoverMonth[] = [];
  for (let m = avgFrom; m < month; m = addMonths(m, 1)) months.push(monthOf(placed, m).cover);
  const { cover: now, inMonth } = monthOf(placed, month);
  months.push(now);

  const rows: CoverRow[] = inMonth.map((p) => ({
    docNo: p.docNo, soDate: p.soDate, processedOn: p.on!, dateFrom: p.dateFrom!, customer: p.customer,
    imported: p.imported, part: p.soDate < `${month}-01` ? 'backlog' : 'this_month', amountSen: p.amountSen,
  }));
  rows.sort((a, b) => (a.processedOn !== b.processedOn ? (a.processedOn < b.processedOn ? -1 : 1) : a.docNo.localeCompare(b.docNo)));

  const thisMonth = count(inMonth.filter((p) => p.soDate >= `${month}-01`));
  const shares = sharesOf({ this_month: thisMonth.amountSen, backlog: now.backlogProcessed.amountSen }, now.processed.amountSen);
  return {
    month,
    from: `${month}-01`,
    to: monthEnd(month),
    total: now.processed,
    parts: {
      this_month: { ...thisMonth, pct: shares.this_month },
      backlog: { ...now.backlogProcessed, pct: shares.backlog },
    },
    backlog: now.backlog,
    cover: { onBacklog: now.onBacklog, onMonth: now.onMonth },
    average: {
      from: avgFrom,
      to: month,
      onBacklog: meanOf(months.map((m) => m.onBacklog)),
      onMonth: meanOf(months.map((m) => m.onMonth)),
    },
    defaultFrom,
    months,
    rows,
  };
}
