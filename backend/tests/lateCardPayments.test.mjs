/* redate-late-card-payments.mjs's own logic (owner 2026-11-26: a card payment
   Merchant Recon shows was swiped in an earlier month is not the recorded
   month's income; move it to the swipe day). Made-up figures. Pinned: which
   payments move and to which day, which are refused, which earlier moves still
   need their entry or invoice, the plan's id, and what a moved payment must
   look like read back. */

import { describe, expect, test } from 'vitest';
import { followUps, latePaymentMoves, paymentProblems, planId } from '../scripts/lib/late-card-payments.mjs';

const line = (id, paid_at, txn_date, extra = {}) => ({
  id, so_doc_no: `SO-${id}`, so_status: 'CONFIRMED', paid_at, method: 'merchant', amount_sen: 100_00, version: 3,
  row_id: Number(String(id).replace(/\D/g, '') || 1), txn_date, ...extra,
});

describe('latePaymentMoves', () => {
  test('a payment recorded in a later month than its swipe moves to the swipe day', () => {
    const { moves, refused } = latePaymentMoves([line('p1', '2026-10-16', '2026-09-05')]);
    expect(refused).toEqual([]);
    expect(moves).toEqual([{ id: 'p1', so_doc_no: 'SO-p1', from: '2026-10-16', to: '2026-09-05', amount_sen: 100_00, version: 3, row_ids: [1] }]);
  });

  test('a swipe a year back moves too; one in the same month, or later, does not', () => {
    const { moves } = latePaymentMoves([
      line('p1', '2026-11-02', '2025-11-22'),
      line('p2', '2026-09-29', '2026-09-05'),
      line('p3', '2026-10-01', '2026-10-03'),
    ]);
    expect(moves.map((m) => [m.id, m.to])).toEqual([['p1', '2025-11-22']]);
  });

  test('lines on different days, a payment that is not by card, or a cancelled order are refused and named', () => {
    const { moves, refused } = latePaymentMoves([
      line('p1', '2026-10-16', '2026-09-05', { row_id: 1 }),
      line('p1', '2026-10-16', '2026-09-06', { row_id: 2 }),
      line('p2', '2026-10-16', '2026-09-05', { method: 'imported' }),
      line('p3', '2026-10-16', '2026-09-05', { so_status: 'CANCELLED' }),
    ]);
    expect(moves).toEqual([]);
    expect(refused.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    expect(refused[0].why).toContain('2026-09-05, 2026-09-06');
  });

  test('two lines on the same day settle one payment once, with both line ids', () => {
    const { moves } = latePaymentMoves([
      line('p1', '2026-10-16', '2026-09-05', { row_id: 7 }),
      line('p1', '2026-10-16', '2026-09-05', { row_id: 4 }),
    ]);
    expect(moves).toHaveLength(1);
    expect(moves[0].row_ids).toEqual([4, 7]);
  });
});

describe('followUps', () => {
  test('a moved payment whose entry or invoice is not on its day yet is followed up', () => {
    const out = followUps([
      { id: 'a', so_doc_no: 'SO-1', paid_at: '2026-09-05', amount_sen: 1, method: 'merchant', entryDays: ['2026-09-05'], invoiceDays: ['2026-09-05'] },
      { id: 'b', so_doc_no: 'SO-2', paid_at: '2026-09-05', amount_sen: 1, method: 'merchant', entryDays: ['2026-10-16'], invoiceDays: [] },
      { id: 'c', so_doc_no: 'SO-3', paid_at: '2026-09-05', amount_sen: 1, method: 'merchant', entryDays: [], invoiceDays: [] },
      { id: 'd', so_doc_no: 'SO-4', paid_at: '2026-09-05', amount_sen: 1, method: 'merchant', entryDays: ['2026-09-05'], invoiceDays: ['2026-10-16'] },
    ]);
    expect(out.map((f) => f.id)).toEqual(['b', 'c', 'd']);
  });
});

describe('planId', () => {
  test('the same moves give the same id in any order; a different day gives another', () => {
    const a = { id: 'p1', so_doc_no: 'SO-1', from: '2026-10-16', to: '2026-09-05', amount_sen: 1, version: 2 };
    const b = { id: 'p2', so_doc_no: 'SO-2', from: '2026-11-03', to: '2026-06-20', amount_sen: 2, version: 1 };
    expect(planId([a, b], [])).toBe(planId([b, a], []));
    expect(planId([a, b], [])).not.toBe(planId([a, { ...b, to: '2026-06-21' }], []));
    expect(planId([a], [])).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('paymentProblems', () => {
  const want = { id: 'p1', day: '2026-09-05', amount_sen: 100_00, version: 4, depositFrom: '2026-09-01', hadInvoice: true };
  const entry = (entry_date, posted = true, reversed = false) => ({
    posted, reversed, entry_date, lines: [{ debit_sen: 100_00, credit_sen: 0 }, { debit_sen: 0, credit_sen: 100_00 }],
  });
  const row = { paid_at: '2026-09-05', version: 4, amount_sen: 100_00 };

  test('moved right: dated the swipe day, one live entry that day, its invoice that day', () => {
    expect(paymentProblems({
      want, row,
      entries: [entry('2026-10-16', true, true), entry('2026-09-05')],
      invoices: [{ status: 'CANCELLED', invoice_date: '2026-10-16', amount_sen: 100_00 }, { status: 'ISSUED', invoice_date: '2026-09-05', amount_sen: 100_00 }],
    })).toEqual([]);
  });

  test('an entry left on the old day, or an invoice that did not follow, is a problem', () => {
    const p = paymentProblems({
      want, row,
      entries: [entry('2026-10-16')],
      invoices: [{ status: 'ISSUED', invoice_date: '2026-10-16', amount_sen: 100_00 }],
    });
    expect(p.join(' | ')).toContain('entry is dated 2026-10-16');
    expect(p.join(' | ')).toContain('live deposit invoice dated 2026-10-16');
  });

  test('before the deposit invoices start, no live invoice may stand; after it, one that had one keeps one', () => {
    const early = { ...want, day: '2025-11-22' };
    expect(paymentProblems({
      want: early, row: { ...row, paid_at: '2025-11-22' }, entries: [entry('2025-11-22')],
      invoices: [{ status: 'ISSUED', invoice_date: '2025-11-22', amount_sen: 100_00 }],
    }).join(' | ')).toContain('before the deposit invoices start');
    expect(paymentProblems({ want, row, entries: [entry('2026-09-05')], invoices: [] }).join(' | ')).toContain('had a deposit invoice and now has 0');
  });
});
