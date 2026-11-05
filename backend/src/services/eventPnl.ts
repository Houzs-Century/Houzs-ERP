// ----------------------------------------------------------------------------
// eventPnl.ts — the PMS event page's TWO P&Ls (owner 2026-10-16, 「这样下面的
// P&L 就要分成两个了，一个是我的 total sales 的，一个是根据 SO 的」; built on
// 2026-10-19's 「这些都要修」).
//
//   BY TOTAL SALES   the fair as the owner keys it: the Total Sales box (or the
//                    sales lines; the SO total when the box is empty).
//   BY SALES ORDERS  the fair as the Sales Orders opened at it say: their total,
//                    at their own cost.
//
// WHAT EACH ROW READS
//   Sales      see above.
//   COGS       By SO: the orders' own cost (snapshotted from Product
//              Maintenance at save — 「cogs 如果有 SO 了，本身每个 sku 有成本价
//              钱吧」), in the order header's four buckets. By Total Sales: a
//              COGS someone typed stands; else the orders' cost RATIO applied
//              to Total Sales (the not-yet-opened part costs what the opened
//              part does); else nothing to go on.
//   Rental, Setup, Transport Setup & Dismantle, Others Costing
//              the same in both: Finance's figure when the books fill the row
//              (applied upstream — scm/lib/event-books.ts), else the typed one.
//   Service   the orders' service lines (service_sen) are not Sales: they are
//              their own Service revenue line, and their cost (service_cost_sen)
//              sits in Transport Fee - the service charge is what covers the
//              transport (owner 2026-10-20). Sales = the goods alone.
//   Transport Fee, Commission, Merchandise
//              Finance's figure when the books fill the row; else a typed line
//              (older events were imported with them); else the brand's rate
//              card % of THIS column's sales — and the commission boost judged
//              on THIS column's GP%. Until now they were computed from the
//              sales LINES only, so the Total Sales box never drove them and
//              every new fair showed 0 (owner 2026-10-16: 「有 sales 了这些也
//              不会自动算」).
//
// Pure: no I/O. The stored auto lines (`auto_source`) are outputs of the old
// engine and are not read here — counting them as well would count the % rows
// twice.
// ----------------------------------------------------------------------------

import { rowOfCategory } from '../scm/lib/event-books';

export type PnlLine = {
  kind?: string | null;
  category?: string | null;
  amount?: number | null;
  auto_source?: string | null;
  source?: string | null;
};

/** The Sales Orders opened at the fair (cancelled ones excluded), in RM.
 *  salesRm = the goods (order total less its service lines). */
export type SoTotals = {
  count: number;
  salesRm: number;
  serviceRm: number;
  serviceCostRm: number;
  costRm: { mattSofa: number; bedframe: number; accessories: number; others: number };
};

/** The brand's rate card (project_cost_rates). Null = the brand has none. */
export type CostRate = {
  transport_pct: number;
  merchandise_pct: number;
  commission_normal_pct: number;
  commission_boost_pct: number | null;
  boost_min_gp_pct: number | null;
  boost_min_sales: number | null;
};

export type PctRowFrom = 'books' | 'typed' | 'rate' | 'none';
export type PctRow = { amount: number; from: PctRowFrom; pct: number | null };
/** Transport Fee also carries the orders' service cost (see above). */
export type TransportRow = PctRow & { serviceCost: number };

export type PnlColumn = {
  sales: number;
  salesFrom: 'lines' | 'box' | 'so' | 'none';
  cogs: { mattSofa: number; bedframe: number; accessories: number; other: number; total: number; from: 'typed' | 'so' | 'so_ratio' | 'none' };
  rental: number;
  setup: number;
  transportSetupDismantle: number;
  others: number;
  /** The orders' service charges: income beside Sales, not in it. */
  serviceRevenue: number;
  transportFee: TransportRow;
  commission: PctRow & { boost: boolean };
  merchandise: PctRow;
  totalCost: number;
  grossProfit: number;
  netProfit: number;
};

export type EventPnl = {
  by_sales: PnlColumn;
  /** Null when no Sales Order was opened at the fair. */
  by_so: PnlColumn | null;
  so_count: number;
};

/* A cost category with no named row of its own is Others Costing — the one map
   of category to row (scm/lib/event-books.ts rowOfCategory, pinned against the
   page's own rows by tests/eventBooks.test.ts). */
const isOthers = (category: string): boolean => rowOfCategory(category) === 'others';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const cat = (l: PnlLine): string => (l.category ?? '').trim();

/**
 * The two P&Ls for one event.
 *
 * @param lines     The event's finance lines WITH the books applied (a row the
 *                  books fill already carries Finance's lines in place of the
 *                  typed ones), plus the sales entries as income lines.
 * @param booksRows The rows the books fill — a % row filled by Finance is
 *                  Finance's figure in both columns.
 * @param lumpSales The Total Sales box (project_finance.total_sales).
 */
export function eventPnl(input: {
  lines: readonly PnlLine[];
  booksRows: ReadonlySet<string>;
  lumpSales: number | null;
  so: SoTotals | null;
  rate: CostRate | null;
}): EventPnl {
  const live = input.lines.filter((l) => !l.auto_source);
  const sum = (kind: string, cats: readonly string[] | null, typedOnly = false) =>
    round2(live
      .filter((l) => l.kind === kind && (cats ? cats.includes(cat(l)) : true) && (!typedOnly || !l.source))
      .reduce((s, l) => s + Number(l.amount ?? 0), 0));

  const shared = {
    rental: sum('cost', ['rental']),
    setup: sum('cost', ['setup']),
    transportSetupDismantle: sum('cost', ['transport_setup_dismantle']),
    others: round2(live.filter((l) => l.kind === 'cost' && isOthers(cat(l))).reduce((s, l) => s + Number(l.amount ?? 0), 0)),
  };
  const so = input.so && input.so.count > 0 ? input.so : null;

  /* A % row: Finance's figure if the books fill it; else a typed line; else the
     rate card on this column's sales. */
  const pctRow = (row: string, cats: readonly string[], pct: number | null, sales: number): PctRow => {
    if (input.booksRows.has(row)) return { amount: sum('cost', cats), from: 'books', pct: null };
    const typed = sum('cost', cats, true);
    if (typed !== 0) return { amount: typed, from: 'typed', pct: null };
    if (pct == null || sales <= 0) return { amount: 0, from: 'none', pct: null };
    return { amount: round2((sales * pct) / 100), from: 'rate', pct };
  };

  const column = (sales: number, salesFrom: PnlColumn['salesFrom'], cogs: PnlColumn['cogs'], service: { revenue: number; cost: number }): PnlColumn => {
    const r = input.rate;
    const gpPct = sales > 0 ? ((sales - cogs.total) / sales) * 100 : 0;
    const boost = !!r && r.commission_boost_pct != null
      && (r.boost_min_gp_pct == null || gpPct >= Number(r.boost_min_gp_pct))
      && (r.boost_min_sales == null || sales >= Number(r.boost_min_sales));
    const transportBase = pctRow('transport_fee', ['transport', 'transport_fee'], r ? Number(r.transport_pct) : null, sales);
    /* Finance's figure, when the books fill the row, already is the transport. */
    const serviceCost = transportBase.from === 'books' ? 0 : round2(service.cost);
    const transportFee: TransportRow = { ...transportBase, amount: round2(transportBase.amount + serviceCost), serviceCost };
    const merchandise = pctRow('merchandise', ['merchandise'], r ? Number(r.merchandise_pct) : null, sales);
    const commissionPct = r ? Number(boost ? r.commission_boost_pct : r.commission_normal_pct) : null;
    const commissionRow = pctRow('commission', ['commission'], commissionPct, sales);
    const commission = { ...commissionRow, boost: boost && commissionRow.from === 'rate' };
    const totalCost = round2(cogs.total + shared.rental + shared.setup + shared.transportSetupDismantle + shared.others
      + transportFee.amount + commission.amount + merchandise.amount);
    return {
      sales, salesFrom, cogs, ...shared, serviceRevenue: round2(service.revenue), transportFee, commission, merchandise, totalCost,
      grossProfit: round2(sales - cogs.total),
      netProfit: round2(sales + service.revenue - totalCost),
    };
  };

  /* BY TOTAL SALES — sales lines, else the box, else the orders' total. */
  const linesSales = sum('income', ['sales']);
  const box = Number(input.lumpSales ?? 0);
  const [sales, salesFrom]: [number, PnlColumn['salesFrom']] = linesSales > 0 ? [linesSales, 'lines']
    : box > 0 ? [round2(box), 'box']
    : so && so.salesRm > 0 ? [round2(so.salesRm), 'so']
    : [0, 'none'];

  const typedCogs = {
    mattSofa: sum('cost', ['cogs_matt_sofa']),
    bedframe: sum('cost', ['cogs_bedframe']),
    accessories: sum('cost', ['cogs_accessories']),
    other: sum('cost', ['cogs']),
  };
  const typedTotal = round2(typedCogs.mattSofa + typedCogs.bedframe + typedCogs.accessories + typedCogs.other);
  const soCogs = so ? {
    mattSofa: round2(so.costRm.mattSofa), bedframe: round2(so.costRm.bedframe),
    accessories: round2(so.costRm.accessories), other: round2(so.costRm.others),
  } : null;
  const withTotal = (c: { mattSofa: number; bedframe: number; accessories: number; other: number }, from: PnlColumn['cogs']['from']) =>
    ({ ...c, total: round2(c.mattSofa + c.bedframe + c.accessories + c.other), from });

  let bySalesCogs: PnlColumn['cogs'];
  if (typedTotal !== 0) bySalesCogs = withTotal(typedCogs, 'typed');
  else if (soCogs && so && so.salesRm > 0 && sales > 0) {
    const k = sales / so.salesRm;
    bySalesCogs = withTotal({
      mattSofa: round2(soCogs.mattSofa * k), bedframe: round2(soCogs.bedframe * k),
      accessories: round2(soCogs.accessories * k), other: round2(soCogs.other * k),
    }, salesFrom === 'so' ? 'so' : 'so_ratio');
  } else bySalesCogs = withTotal({ mattSofa: 0, bedframe: 0, accessories: 0, other: 0 }, 'none');

  /* HC-0134 (owner 2026-10-27): the orders' service lines (delivery) are in
     neither Service revenue nor Transport Fee here; Sales is already the goods. */
  const soService = { revenue: 0, cost: 0 };
  return {
    by_sales: column(sales, salesFrom, bySalesCogs, soService),
    by_so: so && soCogs ? column(round2(so.salesRm), 'so', withTotal(soCogs, 'so'), soService) : null,
    so_count: so?.count ?? 0,
  };
}
