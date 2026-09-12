/* The money taken on the ORDER, shown on the documents that come out of it.
 *
 * Owner 2026-09-12: SO payments must carry to the delivery order and the sales
 * invoice. The invoice already showed them; the delivery order showed nothing.
 */
import { describe, it, expect } from 'vitest';
import { summariseCollected, type CollectedPayment } from './collected-on-order';

const pay = (over: Partial<CollectedPayment>): CollectedPayment => ({
  id: 'p1', paid_at: '2026-09-01', method: 'transfer',
  amount_sen: 0, account_sheet: null, note: null, ...over,
});

describe('summariseCollected', () => {
  it('adds the rows up in sen, without floating-point arithmetic', () => {
    const s = summariseCollected([
      pay({ id: 'a', amount_sen: 150_00 }),
      pay({ id: 'b', amount_sen: 99_99 }),
    ]);
    expect(s.totalSen).toBe(249_99);
    expect(s.count).toBe(2);
  });

  it('shows the newest payment first, so the latest receipt is at the top', () => {
    const s = summariseCollected([
      pay({ id: 'old', paid_at: '2026-08-01' }),
      pay({ id: 'new', paid_at: '2026-09-10' }),
      pay({ id: 'mid', paid_at: '2026-09-01' }),
    ]);
    expect(s.payments.map((p) => p.id)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks a same-date tie by id, so the order never reshuffles between renders', () => {
    const s = summariseCollected([
      pay({ id: 'a', paid_at: '2026-09-01' }),
      pay({ id: 'b', paid_at: '2026-09-01' }),
    ]);
    expect(s.payments.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('a payment with no date sorts last rather than throwing the list around', () => {
    const s = summariseCollected([
      pay({ id: 'dated', paid_at: '2026-09-01' }),
      pay({ id: 'undated', paid_at: null }),
    ]);
    expect(s.payments[0].id).toBe('dated');
  });

  it('an empty order collects nothing', () => {
    expect(summariseCollected([])).toEqual({ payments: [], totalSen: 0, count: 0 });
    expect(summariseCollected(undefined).totalSen).toBe(0);
    expect(summariseCollected(null).count).toBe(0);
  });

  it('a junk amount counts as zero rather than poisoning the total with NaN', () => {
    /* One NaN turns the whole figure into "NaN" on screen, which reads as the
       system being broken rather than as one bad row. */
    const s = summariseCollected([
      pay({ id: 'good', amount_sen: 100_00 }),
      pay({ id: 'bad', amount_sen: Number.NaN }),
    ]);
    expect(s.totalSen).toBe(100_00);
  });

  it('does not mutate the caller’s array — it is a react-query cache', () => {
    const rows = [pay({ id: 'a', paid_at: '2026-08-01' }), pay({ id: 'b', paid_at: '2026-09-01' })];
    const before = rows.map((p) => p.id);
    summariseCollected(rows);
    expect(rows.map((p) => p.id)).toEqual(before);
  });
});
