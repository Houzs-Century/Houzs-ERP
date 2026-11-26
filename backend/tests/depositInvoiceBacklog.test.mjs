/* issue-missing-deposit-invoices.mjs's own logic (owner 2026-11-26: Houzs's
   deposit invoices count from the books' first day, so the payments since then
   need theirs). Made-up figures. Pinned: one run's share of the backlog, month
   by month in payment order with a cap and a month filter; the plan's id; and
   what an issued deposit invoice must look like read back. */

import { describe, expect, test } from 'vitest';
import { batchByMonth, dayOf, depositInvoiceProblems, planId } from '../scripts/lib/deposit-invoice-backlog.mjs';

const pay = (id, so_doc_no, paid_at, amount_sen) => ({ id, so_doc_no, paid_at, amount_sen });
const ROLES = { AR: '300-0000', DEPOSIT_INCOME: '509-0000' };

describe('batchByMonth', () => {
  const payments = [
    pay('p4', 'SO-3', '2026-10-02', 400_00),
    pay('p2', 'SO-1', '2026-09-20', 200_00),
    pay('p1', 'SO-1', '2026-09-05', 100_00),
    pay('p3', 'SO-2', '2026-09-20', 300_00),
    pay('p0', 'SO-9', null, 900_00),
  ];

  test('month by month, each month by payment day then id; an undated payment is left out', () => {
    const b = batchByMonth(payments, { months: null, maxPerMonth: null });
    expect([...b.keys()]).toEqual(['2026-09', '2026-10']);
    expect(b.get('2026-09').map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(b.get('2026-10').map((p) => [p.id, p.day])).toEqual([['p4', '2026-10-02']]);
  });

  test('a cap takes each month\'s first ones; a month filter keeps only those months', () => {
    expect([...batchByMonth(payments, { months: null, maxPerMonth: 2 })].map(([m, l]) => [m, l.map((p) => p.id)]))
      .toEqual([['2026-09', ['p1', 'p2']], ['2026-10', ['p4']]]);
    expect([...batchByMonth(payments, { months: new Set(['2026-10']), maxPerMonth: null }).keys()]).toEqual(['2026-10']);
  });
});

describe('planId', () => {
  const b = batchByMonth([pay('p1', 'SO-1', '2026-09-05', 100_00), pay('p2', 'SO-2', '2026-10-01', 200_00)], { months: null, maxPerMonth: null });

  test('the same plan gives the same id whatever order it was read in', () => {
    const again = batchByMonth([pay('p2', 'SO-2', '2026-10-01', 200_00), pay('p1', 'SO-1', '2026-09-05', 100_00)], { months: null, maxPerMonth: null });
    expect(planId(again, [])).toBe(planId(b, []));
    expect(planId(b, [])).toMatch(/^[0-9a-f]{12}$/);
  });

  test('a changed amount, another payment, or an invoice to post is another plan', () => {
    const moved = batchByMonth([pay('p1', 'SO-1', '2026-09-05', 101_00), pay('p2', 'SO-2', '2026-10-01', 200_00)], { months: null, maxPerMonth: null });
    expect(planId(moved, [])).not.toBe(planId(b, []));
    expect(planId(b, [{ id: 'd9', di_number: 'HC-DI-2609-009', amount_sen: 50_00 }])).not.toBe(planId(b, []));
  });
});

describe('depositInvoiceProblems', () => {
  const payment = { ...pay('p1', 'SO-1', '2026-09-05', 100_00), day: '2026-09-05' };
  const di = { id: 'd1', payment_id: 'p1', payment_source: 'SOPAY', so_doc_no: 'SO-1', amount_sen: 100_00, invoice_date: '2026-09-05', di_number: 'HC-DI-2609-001', status: 'ISSUED', je_no: 'JE-1', party_code: '300-C001' };
  const entry = { id: 'e1', je_no: 'JE-1', posted: true, reversed: false, source_type: 'DI', source_doc_no: 'HC-DI-2609-001', entry_date: '2026-09-05' };
  const lines = [
    { journal_entry_id: 'e1', account_code: '300-0000', debit_sen: 100_00, credit_sen: 0, party_code: '300-C001' },
    { journal_entry_id: 'e1', account_code: '509-0000', debit_sen: 0, credit_sen: 100_00, party_code: null },
  ];
  const check = (over = {}) => depositInvoiceProblems({ payment, invoices: [di], entries: [entry], lines, roles: ROLES, ...over });

  test('the invoice and its entry as they should be: no problem; a cancelled one beside it does not count', () => {
    expect(check()).toEqual([]);
    expect(check({ invoices: [{ ...di, id: 'd0', status: 'CANCELLED', je_no: 'JE-0' }, di] })).toEqual([]);
  });

  test('none, or two, live invoices on the payment', () => {
    expect(check({ invoices: [] })).toEqual(['payment p1 (SO-1, 2026-09-05): 0 live deposit invoices, expected one']);
    expect(check({ invoices: [di, { ...di, id: 'd2', di_number: 'HC-DI-2609-002' }] })[0]).toMatch(/2 live deposit invoices/);
  });

  test('the wrong amount, day, order or month in the number', () => {
    expect(check({ invoices: [{ ...di, amount_sen: 99_00 }] }).join(' ')).toMatch(/not the payment's amount/);
    expect(check({ invoices: [{ ...di, invoice_date: '2026-09-06' }] }).join(' ')).toMatch(/dated 2026-09-06/);
    expect(check({ invoices: [{ ...di, so_doc_no: 'SO-2' }] }).join(' ')).toMatch(/is on SO-2/);
    expect(check({ invoices: [{ ...di, di_number: 'HC-DI-2610-001' }], entries: [{ ...entry, source_doc_no: 'HC-DI-2610-001' }] }).join(' ')).toMatch(/not numbered in its month \(DI-2609-/);
  });

  test('no journal, or one that is reversed, dated another day or of another document', () => {
    expect(check({ invoices: [{ ...di, je_no: null }] })).toEqual(['payment p1 (SO-1, 2026-09-05): HC-DI-2609-001 has no journal']);
    expect(check({ entries: [{ ...entry, reversed: true }] }).join(' ')).toMatch(/not a posted, standing entry/);
    expect(check({ entries: [{ ...entry, entry_date: '2026-09-30' }] }).join(' ')).toMatch(/JE-1 is dated 2026-09-30/);
    expect(check({ entries: [{ ...entry, source_type: 'SI' }] }).join(' ')).toMatch(/not the entry of HC-DI-2609-001/);
  });

  test('lines that are not Dr AR with the invoice\'s party / Cr deposit income for the amount', () => {
    const shaped = /not two lines, Dr 300-0000 \(the invoice's party\) \/ Cr 509-0000/;
    expect(check({ lines: [{ ...lines[0], party_code: '300-C002' }, lines[1]] }).join(' ')).toMatch(shaped);
    expect(check({ lines: [lines[0], { ...lines[1], account_code: '500-0000' }] }).join(' ')).toMatch(shaped);
    expect(check({ lines: [...lines, { ...lines[1], credit_sen: 0, debit_sen: 0 }] }).join(' ')).toMatch(shaped);
  });

  test('a day is only a calendar day', () => {
    expect(dayOf('2026-09-05')).toBe('2026-09-05');
    expect(dayOf('2026-09-05T10:00:00Z')).toBe('2026-09-05');
    expect(dayOf('Sat Sep 05 2026')).toBe(null);
  });
});
