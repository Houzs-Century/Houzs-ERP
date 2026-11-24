/* The Cash Flow's Orders & bills column, the rules (step 4 of the forecast
   port; the door is backend/tests/cashFlowForecast.test.ts). Pinned: a
   supplier's money not tied to a bill pays its oldest bills first, so its
   newest are the owed ones; a bill is paid on its plan, else its due date,
   else its month and the supplier's term; the current month as at its 1st —
   what fell in it, and what was late on its own row; the later months from
   today's orders and bills, as far as they reach and a year at most; an order
   with no delivery date in no month, by the year ordered; the Forecast P&L's
   other lines less the bills already counted. Made-up names and figures. */
import { describe, expect, test } from 'vitest';
import type { AgingRow } from './aging';
import type { CashLeg } from './cashflow-pnl-forecast';
import { billMonth, buildDocsLegs, owedBills, type DueBill, type OpenOrder } from './cashflow-docs-forecast';

const row = (code: string, unappliedSen: number, items: Array<[string, string, number]>): AgingRow => ({
  key: code, code, name: `Supplier ${code}`, balanceSen: items.reduce((s, [, , v]) => s + v, 0) + unappliedSen, cells: [0, 0, 0, 0, 0], unappliedSen,
  items: items.map(([group, date, openSen]) => ({ group, docNo: group.split(':')[1] ?? group, kind: 'Purchase invoice', date, dueDate: null, amountSen: openSen, openSen, column: 0 })),
  unapplied: [],
});

describe('the bills the books still owe', () => {
  test("a supplier's money not tied to a bill pays its oldest bills first; one paid ahead owes nothing", () => {
    expect(owedBills([
      row('S1', -150, [['PI:A', '2026-08-01', 100], ['API:B', '2026-09-01', 100], ['PI:C', '2026-10-01', 100]]),
      row('S2', -500, [['PI:D', '2026-10-01', 300]]),
      row('S3', 0, [['LINE:OB#1', '2026-08-31', 70]]),
    ]).map((b) => [b.supplierCode, b.kind, b.docNo, b.sen])).toEqual([
      ['S1', 'API', 'B', 50], ['S1', 'PI', 'C', 100],
      ['S3', 'LINE', 'OB#1', 70],
    ]);
  });

  test('paid on its plan, else its due date, else its month and the term', () => {
    const term = { months: 2, flagged: false };
    expect(billMonth({ date: '2026-10-05', dueDate: '2026-11-04', plannedOn: '2026-12-15', term })).toMatchObject({ ym: '2026-12', how: 'planned for 2026-12-15' });
    expect(billMonth({ date: '2026-10-05', dueDate: '2026-11-04', plannedOn: null, term })).toMatchObject({ ym: '2026-11', how: 'due 2026-11-04' });
    expect(billMonth({ date: '2026-10-05', dueDate: null, plannedOn: null, term })).toMatchObject({ ym: '2026-12', how: '2 months after the bill', byTerm: true });
    expect(billMonth({ date: '2026-10-05', dueDate: null, plannedOn: null, term: { months: 1, flagged: true } }).how).toBe('a month after the bill (no payment term set)');
    expect(billMonth({ date: '2026-10-05', dueDate: null, plannedOn: null, term: { months: 0, flagged: false } }).ym).toBe('2026-10');
  });
});

const order = (docNo: string, soDate: string, balanceSen: number, deliveryDate: string | null): OpenOrder => ({ docNo, soDate, customer: `Customer ${docNo}`, balanceSen, deliveryDate });
const due = (docNo: string, date: string, sen: number, over: Partial<DueBill> = {}): DueBill => ({
  supplierCode: 'S1', supplier: 'Supplier One', kind: 'PI', docNo, date, dueDate: null, plannedOn: null, sen,
  term: { months: 1, flagged: false }, parts: [{ code: '601-0001', name: 'PURCHASES OF BEDDING', sen: 3 }, { code: '601-0003', name: 'PURCHASE OF SOFA', sen: 1 }], ...over,
});
const cost = (ym: string, code: string, sen: number, flow: 'in' | 'out' = 'out'): CashLeg =>
  ({ ym, fromYm: ym, ref: null, source: 'pnl', flow, code, key: code, name: code, sen, party: code, note: 'Nov 2026 Forecast P&L' });
const brief = (legs: CashLeg[]) => legs.map((l) => `${l.ym} ${l.flow} ${l.key} ${l.sen}${l.ref ? ` ${l.ref}` : ''}`).sort();

describe('the Orders & bills column', () => {
  const base = {
    currentYm: '2026-11', lastYm: '2027-11', arCode: '300-0000', ap: { code: '400-0000', name: 'ACCOUNT PAYABLE' },
    costs: [] as CashLeg[], inputs: [] as CashLeg[],
  };

  test('the current month as at its 1st: what fell in it, and what was late on its own row', () => {
    const r = buildDocsLegs({
      ...base,
      baseline: {
        orders: [order('SO-1', '2026-10-01', 200, '2026-11-20'), order('SO-2', '2026-09-01', 300, '2026-10-15'), order('SO-3', '2026-10-01', 400, '2026-12-01'), order('SO-4', '2026-10-01', 500, null)],
        bills: [due('PI-1', '2026-10-05', 400), due('PI-2', '2026-08-05', 60), due('PI-3', '2026-10-25', 90, { dueDate: '2026-12-20' }), due('OB#1', '2026-08-31', 70, { kind: 'LINE', parts: [] })],
      },
      live: { orders: [], bills: [] },
    });
    expect(r.months).toEqual(['2026-11']);
    expect(brief(r.legs)).toEqual([
      '2026-11 in 300-0000:BAL:LATE 300 SO-2',
      '2026-11 in 300-0000:BAL:ORD 200 SO-1',
      '2026-11 out 400-0000:LATE 60 PI-2',
      '2026-11 out 400-0000:LATE 70 OB#1',
      '2026-11 out 601-0001 300 PI-1',
      '2026-11 out 601-0003 100 PI-1',
    ]);
    expect(r.legs.find((l) => l.ref === 'SO-2')).toMatchObject({ name: 'Past delivery date, not paid', group: { id: 'BAL', label: 'Settlement' }, party: 'Customer SO-2', source: 'order' });
    expect(r.legs.find((l) => l.ref === 'PI-2')).toMatchObject({ name: 'Supplier bills past due', note: 'a month after the bill · past due', source: 'bill' });
  });

  test("the later months from today's: as far as they reach, a year at most; no delivery date is no month, by the year ordered", () => {
    const r = buildDocsLegs({
      ...base,
      baseline: { orders: [], bills: [] },
      live: {
        orders: [order('SO-5', '2026-11-05', 400, '2027-01-10'), order('SO-6', '2025-03-01', 70, null), order('SO-7', '2026-06-01', 100, null), order('SO-8', '2026-10-01', 500, '2028-01-01'), order('SO-9', '2026-10-01', 80, '2026-11-30')],
        bills: [due('PI-4', '2026-11-02', 900, { plannedOn: '2026-12-15', parts: [] }), due('PI-5', '2026-11-03', 10, { dueDate: '2028-02-01' }), due('PI-6', '2026-10-01', 20, { term: { months: 1, flagged: true }, supplier: 'Beta' })],
      },
    });
    expect(r.months).toEqual(['2026-11', '2026-12', '2027-01']);
    /* SO-9 and PI-6 fall in the current month by today's papers: that month is as at its 1st. */
    expect(brief(r.legs)).toEqual(['2026-12 out 400-0000 900 PI-4', '2027-01 in 300-0000:BAL:ORD 400 SO-5']);
    expect(r.undated).toEqual([{ year: '2025', orders: 1, sen: 70 }, { year: '2026', orders: 1, sen: 100 }]);
    expect(r.beyond).toEqual({ orders: 1, orderSen: 500, bills: 1, billSen: 10 });
    expect(r.flagged).toEqual([]);
  });

  test("the Forecast P&L's other lines in the months shown, less the bills already counted; the keyed table; a supplier timed without a term is named", () => {
    const keyed: CashLeg = { ...cost('2027-02', '460-0001', 1_000, 'in'), source: 'input' };
    const r = buildDocsLegs({
      ...base,
      baseline: { orders: [], bills: [due('API-1', '2026-10-28', 200, { kind: 'API', supplier: 'Beta', term: { months: 1, flagged: true }, parts: [{ code: '900-R001', name: 'RENTAL', sen: 1 }] })] },
      live: { orders: [], bills: [] },
      costs: [cost('2026-11', '900-R001', 500), cost('2026-12', '900-S100', 2_000), cost('2028-06', '900-S100', 1), cost('2026-11', '700-0001', 30, 'in')],
      inputs: [keyed],
    });
    expect(r.months).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(brief(r.legs)).toEqual([
      '2026-11 in 700-0001 30',
      '2026-11 out 900-R001 200 API-1',
      '2026-11 out 900-R001 300',
      '2026-12 out 900-S100 2000',
      '2027-02 in 460-0001 1000',
    ]);
    expect(r.legs.find((l) => l.key === '900-R001' && l.ref == null)?.note).toBe('Nov 2026 Forecast P&L · less the bills already counted');
    expect(r.flagged).toEqual(['Beta']);
  });
});
