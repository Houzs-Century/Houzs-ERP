// ----------------------------------------------------------------------------
// cashflow-docs-forecast — the Cash Flow's "Orders & bills" forecast column
// (step 4 of the Hookka forecast port, docs/forecast-port-spec.md part 1, the
// `fc:` column, Hookka `buildForecastLegs`; owner 2026-11-24 「开始做第 4 步」).
//
// The money already in hand, for the current month and the months after it:
//   · customers — an open order's unpaid balance arrives in its delivery month
//     (the amended delivery date, else the customer's), on the debtor
//     control's Settlement. Owner 2026-11-24 「就分成有交货日期和没有交货日期的」:
//     an order whose date has passed, delivered or not, counts in the current
//     month on its own row; an order with no delivery date counts in no month
//     and is listed under the table by the year it was ordered;
//   · suppliers — what the books say is owed (owner 2026-11-24 「用账本的数」):
//     each supplier's balance in the formal AP Aging (acc/aging), its money not
//     tied to a bill knocking off its oldest bills first, so its newest bills
//     are the unpaid ones. Each is paid on its planned day (Bills to pay), else
//     its due date, else its month and the supplier's payment term, on the
//     accounts it was bought on (as an actual supplier payment reads); one past
//     that by the current month is paid in the current month on its own row;
//   · the Forecast P&L's other lines as the P&L forecast column times them —
//     salaries the month after, the rest in their own month — less the bills
//     already counted on the same account that month (sales and purchases come
//     from the orders and the bills instead);
//   · the Capex & financing table, on its accounts in its months.
// The current month is as it stood on its 1st — its orders and bills as at
// that day — so it sits beside its actual; a later month is from today's
// orders and bills, as far as they reach (a year at most). Pure: no reads.
// ----------------------------------------------------------------------------

import type { AgingRow } from './aging';
import { addMonthsYm, spreadSen, type CashLeg, type TermInfo } from './cashflow-pnl-forecast';

/** An open order: what is still to come in, and the day it is to be delivered. */
export type OpenOrder = { docNo: string; soDate: string; customer: string; balanceSen: number; deliveryDate: string | null };

export type BillKind = 'PI' | 'API' | 'LINE';

/** A bill the books still owe a supplier, or the unpaid part of one. */
export type OwedBill = { supplierCode: string | null; supplier: string; kind: BillKind; docNo: string; date: string; dueDate: string | null; sen: number };

/** An owed bill with what times and places it. */
export type DueBill = OwedBill & {
  plannedOn: string | null;
  term: TermInfo;
  parts: Array<{ code: string; name: string; sen: number }>;
};

/** Each supplier's bills the books still owe: its money not tied to a bill
    (未冲) knocks off its oldest open bills first, so what is left is its
    newest bills, adding up to its balance — nothing when it is paid ahead.
    A line with no bill behind it (an opening balance) is owed like a bill. */
export function owedBills(rows: readonly AgingRow[]): OwedBill[] {
  const out: OwedBill[] = [];
  for (const r of rows) {
    let credit = Math.max(0, -r.unappliedSen);
    for (const it of r.items) {
      const take = Math.min(credit, it.openSen);
      credit -= take;
      const sen = it.openSen - take;
      if (sen <= 0) continue;
      const kind: BillKind = it.group.startsWith('PI:') ? 'PI' : it.group.startsWith('API:') ? 'API' : 'LINE';
      out.push({ supplierCode: r.code, supplier: r.name, kind, docNo: it.docNo, date: it.date, dueDate: it.dueDate, sen });
    }
  }
  return out;
}

const afterBill = (n: number): string => (n === 0 ? 'in the month of the bill' : n === 1 ? 'a month after the bill' : `${n} months after the bill`);

/** When a bill is paid: its planned day, else its due date, else its month and the supplier's term. */
export function billMonth(b: Pick<DueBill, 'date' | 'dueDate' | 'plannedOn' | 'term'>): { ym: string; how: string; byTerm: boolean } {
  if (b.plannedOn) return { ym: b.plannedOn.slice(0, 7), how: `planned for ${b.plannedOn}`, byTerm: false };
  if (b.dueDate) return { ym: b.dueDate.slice(0, 7), how: `due ${b.dueDate}`, byTerm: false };
  return { ym: addMonthsYm(b.date.slice(0, 7), b.term.months), how: `${afterBill(b.term.months)}${b.term.flagged ? ' (no payment term set)' : ''}`, byTerm: true };
}

const YM = /^\d{4}-\d{2}/;
const deliveryYm = (o: OpenOrder): string | null => (o.deliveryDate && YM.test(o.deliveryDate) ? o.deliveryDate.slice(0, 7) : null);

export const ORDERS_ROW = 'Open orders (balance on delivery)';
export const LATE_ORDERS_ROW = 'Past delivery date, not paid';
export const LATE_BILLS_ROW = 'Supplier bills past due';
const SETTLEMENT = { id: 'BAL' as const, label: 'Settlement' };

export type DocsForecastInput = {
  currentYm: string;
  lastYm: string;
  arCode: string;
  ap: { code: string; name: string };
  baseline: { orders: readonly OpenOrder[]; bills: readonly DueBill[] };
  live: { orders: readonly OpenOrder[]; bills: readonly DueBill[] };
  costs: readonly CashLeg[];
  inputs: readonly CashLeg[];
};

export type DocsForecast = {
  months: string[];
  legs: CashLeg[];
  undated: Array<{ year: string; orders: number; sen: number }>;
  beyond: { orders: number; orderSen: number; bills: number; billSen: number };
  flagged: string[];
};

export function buildDocsLegs(input: DocsForecastInput): DocsForecast {
  const { currentYm, lastYm, arCode, ap } = input;
  const legs: CashLeg[] = [];
  const flagged = new Set<string>();

  const orderLeg = (ym: string, o: OpenOrder, late: boolean): CashLeg => ({
    ym, fromYm: o.soDate.slice(0, 7), ref: o.docNo, source: 'order', flow: 'in', code: arCode,
    key: `${arCode}:BAL:${late ? 'LATE' : 'ORD'}`, name: late ? LATE_ORDERS_ROW : ORDERS_ROW, group: SETTLEMENT,
    sen: o.balanceSen, party: o.customer, note: `delivery ${String(o.deliveryDate)}${late ? ', passed' : ''} · balance on delivery`,
  });
  const billLegs = (ym: string, b: DueBill, late: boolean): CashLeg[] => {
    const when = billMonth(b);
    if (when.byTerm && b.term.flagged) flagged.add(b.supplier);
    const base = { ym, fromYm: b.date.slice(0, 7), ref: b.docNo, source: 'bill' as const, flow: 'out' as const, party: b.supplier, note: `${when.how}${late ? ' · past due' : ''}` };
    if (late) return [{ ...base, code: ap.code, key: `${ap.code}:LATE`, name: LATE_BILLS_ROW, sen: b.sen }];
    if (b.parts.length === 0) return [{ ...base, code: ap.code, key: ap.code, name: ap.name, sen: b.sen }];
    return spreadSen(b.sen, b.parts.map((p) => ({ ...p, weight: p.sen }))).map((p) => ({ ...base, code: p.code, key: p.code, name: p.name, sen: p.sen }));
  };

  for (const o of input.baseline.orders) {
    const ym = deliveryYm(o);
    if (ym != null && ym <= currentYm && o.balanceSen > 0) legs.push(orderLeg(currentYm, o, ym < currentYm));
  }
  for (const b of input.baseline.bills) {
    const ym = billMonth(b).ym;
    if (ym <= currentYm && b.sen > 0) legs.push(...billLegs(currentYm, b, ym < currentYm));
  }

  const later = (ym: string | null): ym is string => ym != null && ym > currentYm && ym <= lastYm;
  let horizon = currentYm;
  const reach = (ym: string | null): void => { if (later(ym) && ym > horizon) horizon = ym; };
  const undated = new Map<string, { orders: number; sen: number }>();
  const beyond = { orders: 0, orderSen: 0, bills: 0, billSen: 0 };
  for (const o of input.live.orders) {
    if (o.balanceSen <= 0) continue;
    const ym = deliveryYm(o);
    if (ym == null) {
      const year = o.soDate.slice(0, 4) || 'unknown';
      const at = undated.get(year) ?? { orders: 0, sen: 0 };
      at.orders += 1;
      at.sen += o.balanceSen;
      undated.set(year, at);
      continue;
    }
    if (ym > lastYm) { beyond.orders += 1; beyond.orderSen += o.balanceSen; continue; }
    if (later(ym)) { reach(ym); legs.push(orderLeg(ym, o, false)); }
  }
  for (const b of input.live.bills) {
    if (b.sen <= 0) continue;
    const ym = billMonth(b).ym;
    if (ym > lastYm) { beyond.bills += 1; beyond.billSen += b.sen; continue; }
    if (later(ym)) { reach(ym); legs.push(...billLegs(ym, b, false)); }
  }
  for (const l of input.inputs) reach(l.ym);
  const months = [currentYm];
  for (let ym = addMonthsYm(currentYm, 1); ym <= horizon; ym = addMonthsYm(ym, 1)) months.push(ym);
  const shown = new Set(months);

  const billed = new Map<string, number>();
  for (const l of legs) if (l.source === 'bill' && l.key === l.code) billed.set(`${l.ym}|${l.code}`, (billed.get(`${l.ym}|${l.code}`) ?? 0) + l.sen);
  for (const c of input.costs) {
    if (!shown.has(c.ym)) continue;
    let sen = c.sen;
    let note = c.note;
    const k = `${c.ym}|${c.code}`;
    const b = billed.get(k) ?? 0;
    if (c.flow === 'out' && b > 0 && sen > 0) {
      const take = Math.min(b, sen);
      sen -= take;
      billed.set(k, b - take);
      note += ' · less the bills already counted';
    }
    if (sen !== 0) legs.push({ ...c, sen, note });
  }
  for (const l of input.inputs) if (shown.has(l.ym)) legs.push(l);

  return {
    months, legs,
    undated: [...undated].map(([year, v]) => ({ year, ...v })).sort((a, b) => a.year.localeCompare(b.year)),
    beyond,
    flagged: [...flagged].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
  };
}
