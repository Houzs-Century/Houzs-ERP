/* Procurement Overview, period edition (owner, 2026-10-17). Everything follows
   the selected period [from, to]; anything "open" or "late" is measured AS OF
   the period's last day (or today, whichever is earlier), so a past month shows
   what was open and late at its end, not what is open today.

   Money is sen = quantity × the PO line's unit price. A PO line is the unit
   ("line"); a PO is counted once however many of its lines match.

   Two lead times, kept apart because they answer different questions:
   - supplier lead time: PO date → goods received, and whether it came by the
     date first put on the PO (on time) — "how long do they really take";
   - ordering lead: how far ahead of the customer's need we place the order,
     and how early the goods actually arrive before the customer needs them.
     The days we could order later come from that real slack, not from the
     MRP setting. */
import { daysBetween, overdueBucket, percentile, type ProcurementCategory } from './procurement-overview';

export interface PLine {
  poId: string; poNumber: string; poDate: string; supplier: string; category: ProcurementCategory;
  itemCode: string | null; itemDesc: string | null; soDocNo: string | null;
  qty: number; priceSen: number;
  /** The date first put on the PO line. */
  originalDue: string | null;
  /** The latest date the supplier promised (originalDue when never moved). */
  promised: string | null;
  /** When the customer needs it: the linked sales order's confirmed date, else its original date. */
  needDate: string | null;
  /** Goods received notes; `inferred` is quantity the line records as received
   *  with no GRN behind it (marked received on import) — dated at its due date,
   *  counted as received, never used for lead time or on time. */
  receipts: Array<{ date: string; qty: number; rejected: number; inferred?: boolean }>;
}

export type Basis = 'original' | 'promised';
type Bucket = 'late5' | 'late0to4' | 'due2to7' | 'due8plus';
const BUCKETS: Bucket[] = ['late5', 'late0to4', 'due2to7', 'due8plus'];

const receivedBy = (l: PLine, date: string) => l.receipts.filter((r) => r.date <= date).reduce((a, r) => a + r.qty, 0);
const openQtyAt = (l: PLine, date: string) => (l.poDate <= date ? Math.max(0, l.qty - receivedBy(l, date)) : 0);
const dueOf = (l: PLine, basis: Basis) => (basis === 'original' ? l.originalDue : l.promised ?? l.originalDue);
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
/* Lead-time figures use the middle value (owner 2026-10-17): a few lines
   ordered months ahead would drag an average; half the lines are at or under
   the median, half at or over. Even count = the mean of the two middle ones. */
const mid = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const h = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2) * 10) / 10;
};
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export interface GroupRow {
  key: string;
  raised: { pos: number; lines: number; sen: number; receivedSen: number; openSen: number };
  due: { lines: number; sen: number; receivedSen: number; openSen: number };
  receivedSen: number;
  open: { lines: number; sen: number; late: number; lateSen: number; buckets: Record<Bucket, { lines: number; sen: number }> };
  supplierLead: { receipts: number; midDays: number | null; p80Days: number | null; onTimePct: number | null; latePct: number | null; onTimeAmountPct: number | null; midDaysLate: number | null };
  ordering: { lines: number; avgOrderAheadDays: number | null; avgDueBeforeNeedDays: number | null; measured: number; midOrderBeforeNeedDays: number | null; midArrivedBeforeNeedDays: number | null; p20ArrivedBeforeNeedDays: number | null; canOrderLaterDays: number | null };
}

/** Lines a supplier-lead figure needs before it is trusted. */
export const MIN_SAMPLES = 10;

export function procurementPeriod(lines: PLine[], from: string, to: string, today: string, basis: Basis) {
  const asOf = to < today ? to : today;
  const inPeriod = (d: string | null) => !!d && d >= from && d <= to;

  const group = (keyOf: (l: PLine) => string): GroupRow[] => {
    const map = new Map<string, PLine[]>();
    for (const l of lines) { const k = keyOf(l); map.set(k, [...(map.get(k) ?? []), l]); }
    return [...map.entries()].map(([key, ls]) => row(key, ls))
      .filter((r) => r.raised.lines || r.due.lines || r.receivedSen || r.open.lines || r.supplierLead.receipts)
      .sort((a, b) => b.open.sen + b.raised.sen - (a.open.sen + a.raised.sen));
  };

  const row = (key: string, ls: PLine[]): GroupRow => {
    const raised = ls.filter((l) => inPeriod(l.poDate));
    const due = ls.filter((l) => inPeriod(dueOf(l, basis)));
    const sen = (l: PLine, q: number) => q * l.priceSen;
    const buckets = Object.fromEntries(BUCKETS.map((b) => [b, { lines: 0, sen: 0 }])) as GroupRow['open']['buckets'];
    let openLines = 0; let openSen = 0; let late = 0; let lateSen = 0;
    for (const l of ls) {
      const q = openQtyAt(l, asOf);
      const d = dueOf(l, basis);
      if (q <= 0 || !d) continue;
      openLines += 1; openSen += sen(l, q);
      const daysLate = daysBetween(d, asOf);
      const b = overdueBucket(daysLate);
      buckets[b].lines += 1; buckets[b].sen += sen(l, q);
      if (daysLate > 0) { late += 1; lateSen += sen(l, q); }
    }
    /* Supplier lead: each receipt in the period, PO date → received. */
    const rc = ls.flatMap((l) => l.receipts.filter((r) => inPeriod(r.date) && !r.inferred).map((r) => ({ l, r })));
    const leads = rc.map(({ l, r }) => daysBetween(l.poDate, r.date));
    const withDue = rc.filter(({ l }) => !!l.originalDue);
    const lateBy = withDue.map(({ l, r }) => daysBetween(l.originalDue as string, r.date));
    const onTime = lateBy.filter((x) => x <= 0).length;
    const amt = (xs: typeof withDue) => xs.reduce((a, { l, r }) => a + r.qty * l.priceSen, 0);
    /* Ordering lead: the lines raised in the period, and the lines received in
       it whose customer date is known. */
    const ahead = raised.filter((l) => l.originalDue).map((l) => daysBetween(l.poDate, l.originalDue as string));
    const beforeNeed = raised.filter((l) => l.originalDue && l.needDate).map((l) => daysBetween(l.originalDue as string, l.needDate as string));
    const real = (l: PLine) => l.receipts.filter((r) => inPeriod(r.date) && !r.inferred);
    const slack = ls.filter((l) => l.needDate && real(l).length > 0)
      .map((l) => daysBetween(real(l).map((r) => r.date).sort().at(-1) as string, l.needDate as string));
    const p20 = slack.length ? percentile(slack, 0.2) : null;
    /* The same received lines: how many days before the customer date the PO went out. */
    const orderBeforeNeed = ls.filter((l) => l.needDate && real(l).length > 0).map((l) => daysBetween(l.poDate, l.needDate as string));
    return {
      key,
      raised: {
        pos: new Set(raised.map((l) => l.poId)).size, lines: raised.length,
        sen: raised.reduce((a, l) => a + sen(l, l.qty), 0),
        receivedSen: raised.reduce((a, l) => a + sen(l, Math.min(l.qty, receivedBy(l, asOf))), 0),
        openSen: raised.reduce((a, l) => a + sen(l, openQtyAt(l, asOf)), 0),
      },
      due: {
        lines: due.length, sen: due.reduce((a, l) => a + sen(l, l.qty), 0),
        receivedSen: due.reduce((a, l) => a + sen(l, Math.min(l.qty, receivedBy(l, asOf))), 0),
        openSen: due.reduce((a, l) => a + sen(l, openQtyAt(l, asOf)), 0),
      },
      receivedSen: rc.reduce((a, { l, r }) => a + r.qty * l.priceSen, 0),
      open: { lines: openLines, sen: openSen, late, lateSen, buckets },
      supplierLead: {
        receipts: rc.length, midDays: mid(leads), p80Days: leads.length ? percentile(leads, 0.8) : null,
        onTimePct: pct(onTime, withDue.length), latePct: pct(withDue.length - onTime, withDue.length),
        onTimeAmountPct: pct(amt(withDue.filter((_, i) => (lateBy[i] as number) <= 0)), amt(withDue)),
        midDaysLate: mid(lateBy.filter((x) => x > 0)),
      },
      ordering: {
        lines: raised.length, avgOrderAheadDays: avg(ahead), avgDueBeforeNeedDays: avg(beforeNeed),
        measured: slack.length, midOrderBeforeNeedDays: mid(orderBeforeNeed), midArrivedBeforeNeedDays: mid(slack), p20ArrivedBeforeNeedDays: p20,
        /* Ordering later by the 20th-percentile slack still has 80% of lines
           arriving by the customer's date. Too few lines, or no slack: null / 0. */
        canOrderLaterDays: slack.length < MIN_SAMPLES || p20 == null ? null : Math.max(0, Math.floor(p20)),
      },
    };
  };

  const total = row('TOTAL', lines);
  const openAt = lines
    .map((l) => ({ l, q: openQtyAt(l, asOf), d: dueOf(l, basis) }))
    .filter((x): x is { l: PLine; q: number; d: string } => x.q > 0 && !!x.d)
    .map(({ l, q, d }) => ({
      poId: l.poId, poNumber: l.poNumber, poDate: l.poDate, supplier: l.supplier, category: l.category,
      itemCode: l.itemCode, itemDesc: l.itemDesc, soDocNo: l.soDocNo, openQty: q, openSen: q * l.priceSen,
      originalDue: l.originalDue, promised: l.promised, needDate: l.needDate, daysLate: daysBetween(d, asOf),
    }));
  return {
    asOf, basis, total,
    byCategory: group((l) => l.category),
    bySupplier: group((l) => l.supplier),
    overdue: openAt.filter((x) => x.daysLate > 0).sort((a, b) => b.daysLate - a.daysLate).slice(0, 300),
    dueSoon: openAt.filter((x) => x.daysLate <= 0 && x.daysLate >= -3).sort((a, b) => b.daysLate - a.daysLate).slice(0, 300),
  };
}

/* Dead stock (owner, 2026-10-17): stock on hand by how long since it last went
   out. Idle days run from the last OUT movement of that item in that warehouse,
   or — never sent out — from its first movement there. A balance is a snapshot,
   so this is as of today whatever the period. */
export interface StockRow { warehouse: string; category: string; itemCode: string; name: string | null; qty: number; valueSen: number; lastOut: string | null; firstMove: string | null }
type Age = 'd0to90' | 'd91to180' | 'd181to365' | 'd365plus';
const AGES: Age[] = ['d0to90', 'd91to180', 'd181to365', 'd365plus'];
const ageOf = (idle: number | null): Age => (idle == null || idle <= 90 ? 'd0to90' : idle <= 180 ? 'd91to180' : idle <= 365 ? 'd181to365' : 'd365plus');

export function deadStock(rows: StockRow[], today: string) {
  const idleOf = (r: StockRow) => { const d = r.lastOut ?? r.firstMove; return d ? daysBetween(d, today) : null; };
  const by = (keyOf: (r: StockRow) => string) => {
    const map = new Map<string, { key: string; skus: number; valueSen: number; deadSkus: number; deadSen: number; ages: Record<Age, number> }>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = map.get(k) ?? { key: k, skus: 0, valueSen: 0, deadSkus: 0, deadSen: 0, ages: Object.fromEntries(AGES.map((a) => [a, 0])) as Record<Age, number> };
      const age = ageOf(idleOf(r));
      g.skus += 1; g.valueSen += r.valueSen; g.ages[age] += r.valueSen;
      if (age !== 'd0to90') { g.deadSkus += 1; g.deadSen += r.valueSen; }
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) => b.deadSen - a.deadSen);
  };
  const dead = rows.filter((r) => ageOf(idleOf(r)) !== 'd0to90');
  return {
    asOf: today,
    totalSen: rows.reduce((a, r) => a + r.valueSen, 0), skus: rows.length,
    deadSen: dead.reduce((a, r) => a + r.valueSen, 0), deadSkus: dead.length,
    byCategory: by((r) => r.category), byWarehouse: by((r) => r.warehouse),
    top: dead.map((r) => ({ ...r, idleDays: idleOf(r) })).sort((a, b) => b.valueSen - a.valueSen).slice(0, 50),
  };
}

/* Stock turnover and sellers over the period (owner, 2026-10-17, decision B:
   sellers by quantity ordered on sales orders, turnover by what actually left
   the warehouse; "turnover is just the stock balance — do it live"). Turnover
   = cost sent out in the period, scaled to a year, over the stock value now;
   days of stock = stock value over the daily cost sent out. */
export interface OutMove { warehouse: string; category: string; costSen: number; zeroCost: boolean }
export interface SoldLine { itemCode: string; name: string | null; category: string; qty: number; salesSen: number }

/** `turnDays`: the days the OUT moves cover (a fixed trailing window, not the
 *  page's period); `sellerDays`: the days the sold lines cover (the period). */
export function turnoverAndSellers(stock: StockRow[], outs: OutMove[], sold: SoldLine[], turnDays: number, sellerDays: number) {
  const days = turnDays;
  const by = (keyOfStock: (r: StockRow) => string, keyOfOut: (o: OutMove) => string) => {
    const map = new Map<string, { key: string; stockSen: number; outSen: number }>();
    for (const r of stock) { const k = keyOfStock(r); const g = map.get(k) ?? { key: k, stockSen: 0, outSen: 0 }; g.stockSen += r.valueSen; map.set(k, g); }
    for (const o of outs) { const k = keyOfOut(o); const g = map.get(k) ?? { key: k, stockSen: 0, outSen: 0 }; g.outSen += o.costSen; map.set(k, g); }
    return [...map.values()].map((g) => ({
      ...g,
      turnsPerYear: g.stockSen > 0 ? Math.round(((g.outSen * (365 / days)) / g.stockSen) * 10) / 10 : null,
      daysOfStock: g.outSen > 0 ? Math.round(g.stockSen / (g.outSen / days)) : null,
    })).sort((a, b) => b.stockSen - a.stockSen);
  };
  const stockByItem = new Map<string, { qty: number; valueSen: number; name: string | null; category: string }>();
  for (const r of stock) {
    const g = stockByItem.get(r.itemCode) ?? { qty: 0, valueSen: 0, name: r.name, category: r.category };
    g.qty += r.qty; g.valueSen += r.valueSen; stockByItem.set(r.itemCode, g);
  }
  const soldByItem = new Map<string, SoldLine>();
  for (const s of sold) {
    const g = soldByItem.get(s.itemCode) ?? { ...s, qty: 0, salesSen: 0 };
    g.qty += s.qty; g.salesSen += s.salesSen; soldByItem.set(s.itemCode, g);
  }
  const totalOut = outs.reduce((a, o) => a + o.costSen, 0);
  const totalStock = stock.reduce((a, r) => a + r.valueSen, 0);
  return {
    days, sellerDays,
    total: { stockSen: totalStock, outSen: totalOut, turnsPerYear: totalStock > 0 ? Math.round(((totalOut * (365 / days)) / totalStock) * 10) / 10 : null, daysOfStock: totalOut > 0 ? Math.round(totalStock / (totalOut / days)) : null },
    zeroCostOuts: outs.filter((o) => o.zeroCost).length,
    byCategory: by((r) => r.category, (o) => o.category),
    byWarehouse: by((r) => r.warehouse, (o) => o.warehouse),
    topSellers: [...soldByItem.values()].sort((a, b) => b.qty - a.qty).slice(0, 15).map((s) => {
      const st = stockByItem.get(s.itemCode);
      return { ...s, stockQty: st?.qty ?? 0, coverDays: s.qty > 0 ? Math.round((st?.qty ?? 0) / (s.qty / sellerDays)) : null };
    }),
    lowSellers: [...stockByItem.entries()].filter(([, g]) => g.qty > 0)
      .map(([code, g]) => ({ itemCode: code, name: g.name, category: g.category, stockQty: g.qty, stockSen: g.valueSen, soldQty: soldByItem.get(code)?.qty ?? 0 }))
      .sort((a, b) => a.soldQty - b.soldQty || b.stockSen - a.stockSen).slice(0, 15),
  };
}
