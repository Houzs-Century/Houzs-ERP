/* The plan behind set-opening-bill-goods.mjs (owner 2026-11-25, 「如果系统可以
   分得出purchase of sofa 和purchase of bedding 更加好」): an opening bill reads
   the lines of the AutoCount purchase invoice its text names — product groups in
   the ERP's words, values in MYR before tax — unless that invoice is cancelled,
   carries nothing, or is less than the bill; a bill the source lacks keeps what
   it holds; rows already held are no change (RE-RUN: inert); the re-read's
   shape check. Made-up codes and figures. */
import { describe, expect, test } from 'vitest';
import {
  acDocOf, billMyrSen, erpGroup, goodsText, invoicesOf, lineSen, planFor, shapeProblems, summaryOf,
} from '../scripts/lib/opening-bill-goods-plan.mjs';

const line = (doc, party, group, subTotal, extra = {}) => ({
  T: 'PI', DocNo: doc, PartyCode: party, ItemGroup: group, SubTotalExTax: subTotal, SubTotal: subTotal, CurrencyRate: 1, LocalNetTotal: 1000, Cancelled: 'F', ...extra,
});
const bill = (id, doc, supplierCode, totalSen, extra = {}) => ({
  id, number: `API-${id}`, supplierCode, notes: doc === null ? 'OPENING 31/08 FROM AUTOCOUNT: EXCHANGE DIFFERENCE' : `OPENING 31/08 FROM AUTOCOUNT: AUTOCOUNT ${doc} — SUPPLIER INVOICE X-1`,
  totalSen, currency: 'MYR', rate: 1, ...extra,
});

describe('opening bill goods: reading AutoCount\'s lines', () => {
  test('the invoice a bill names; groups in the ERP\'s words; a line\'s value at its rate', () => {
    expect(acDocOf('OPENING 31/08 FROM AUTOCOUNT: AUTOCOUNT PI-007001 — SUPPLIER INVOICE A-9')).toBe('PI-007001');
    expect(acDocOf('OPENING 31/08 FROM AUTOCOUNT: AUTOCOUNT HC-PI-2608-004')).toBe('HC-PI-2608-004');
    expect(acDocOf('OPENING 31/08 FROM AUTOCOUNT: AUTOCOUNT DEBIT NOTE DN-1')).toBeNull();
    expect(acDocOf(null)).toBeNull();
    expect([erpGroup('ACC'), erpGroup('other'), erpGroup(' sofa '), erpGroup(null), erpGroup('BEDFRAME')]).toEqual(['ACCESSORY', 'OTHERS', 'SOFA', '', 'BEDFRAME']);
    expect(lineSen({ SubTotalExTax: 100.5, CurrencyRate: 1 })).toBe(10050);
    expect(lineSen({ SubTotalExTax: null, SubTotal: 200, CurrencyRate: 0.6 })).toBe(12000);
    expect(billMyrSen({ totalSen: 1000, currency: 'CNY', rate: 0.6 })).toBe(600);
  });

  test('the source\'s invoices: per product group, cancelled kept as cancelled, the MYR total', () => {
    const inv = invoicesOf([
      line('PI-1', 'A001', 'SOFA', 300), line('PI-1', 'A001', 'BEDFRAME', 600), line('PI-1', 'A001', 'SOFA', 100), line('PI-1', 'A001', 'ACC', 0),
      line('PI-2', 'B001', null, 50, { Cancelled: 'T' }), { T: 'GR', DocNo: 'GR-1' },
    ]);
    expect([...inv.keys()]).toEqual(['PI-1', 'PI-2']);
    expect(inv.get('PI-1')).toEqual({ party: 'A001', cancelled: false, totalSen: 100000, groups: new Map([['SOFA', 40000], ['BEDFRAME', 60000], ['ACCESSORY', 0]]) });
    expect(inv.get('PI-2').cancelled).toBe(true);
  });
});

describe('opening bill goods: the plan', () => {
  const invoices = invoicesOf([
    line('PI-1', 'A001', 'SOFA', 300), line('PI-1', 'A001', 'BEDFRAME', 700),
    line('PI-2', 'A001', 'MATTRESS', 500, { LocalNetTotal: 500 }),
    line('PI-3', 'B001', 'SOFA', 200, { Cancelled: 'T' }),
    line('PI-4', 'B001', 'SOFA', 0),
    line('PI-5', 'OLD-B', 'BEDFRAME', 400, { LocalNetTotal: 400 }),
  ]);
  const bills = [
    bill('b1', 'PI-1', 'A001', 80000),            // owed part of PI-1: read
    bill('b2', 'PI-2', 'A001', 50000),            // already held: no change
    bill('b3', 'PI-3', 'B001', 20000),            // cancelled in AutoCount
    bill('b4', 'PI-4', 'B001', 100),              // carries nothing
    bill('b5', 'PI-1', 'B001', 200000),           // more than its invoice: not that invoice
    bill('b6', 'PI-9', 'B001', 100),              // not in the source
    bill('b7', null, 'B001', 100),                // names no invoice
    bill('b8', 'PI-5', 'B001', 40000),            // AutoCount keeps it under an older creditor code
  ];
  const current = new Map([['b2', new Map([['MATTRESS', 50000]])]]);

  test('read, unchanged, skipped and missing; a change only where the rows differ', () => {
    const p = planFor(bills, invoices, current);
    expect(p.changes.map((c) => [c.number, goodsText(c.from), goodsText(c.to), c.doc])).toEqual([
      ['API-b1', '(none)', 'BEDFRAME:70000|SOFA:30000', 'PI-1'],
      ['API-b8', '(none)', 'BEDFRAME:40000', 'PI-5'],
    ]);
    expect(p.read.map((r) => r.bill.id)).toEqual(['b1', 'b2', 'b8']);
    expect(p.read.find((r) => r.bill.id === 'b8').otherParty).toBe(true);
    expect(p.skipped.map((k) => [k.bill.id, k.why])).toEqual([
      ['b3', 'its AutoCount invoice is cancelled'],
      ['b4', 'its AutoCount lines carry no value'],
      ['b5', 'the bill is more than its AutoCount invoice'],
    ]);
    expect(p.missing.map((m) => m.bill.id)).toEqual(['b6', 'b7']);
  });

  test('RE-RUN: once applied, nothing to change', () => {
    const first = planFor(bills, invoices, current);
    const held = new Map(current);
    for (const c of first.changes) held.set(c.id, c.to);
    expect(planFor(bills, invoices, held).changes).toEqual([]);
  });

  test('the summary per supplier code: counts and shares, never an amount', () => {
    const rows = summaryOf(planFor(bills, invoices, current));
    expect(rows).toEqual([
      { code: 'A001', read: 2, missing: 0, skipped: 0, shares: 'BEDFRAME 47% · MATTRESS 33% · SOFA 20%' },
      { code: 'B001', read: 1, missing: 2, skipped: 3, shares: 'BEDFRAME 100%' },
    ]);
  });

  test('the re-read: each planned bill holds its groups; every row an opening bill of the company in the ERP\'s words', () => {
    const changes = planFor(bills, invoices, current).changes;
    const landed = new Map(changes.map((c) => [c.id, c.to]));
    const opening = new Set(bills.map((b) => b.id));
    expect(shapeProblems(changes, landed, opening)).toEqual([]);
    const wrong = new Map(landed);
    wrong.set('b1', new Map([['SOFA', 30000]]));
    wrong.set('zz', new Map([['sofa', 1]]));
    expect(shapeProblems(changes, wrong, opening)).toEqual([
      'bill API-b1 holds SOFA:30000, planned BEDFRAME:70000|SOFA:30000',
      'bill zz is not an opening bill of this company',
      'bill zz holds sofa:1',
    ]);
  });
});
