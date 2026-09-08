// The rule that decides which purchase-order header is rolled up from its own
// lines (scripts/lib/po-header-rollup.mjs).
//
// The owner ruled on 2026-09-08: recompute the header = add up the lines. 70
// migrated purchase orders read RM 0.00 at the header while their lines carry
// money (docs/bugs/0675-70-migrated-purchase-orders-*).
//
// What is defended here is not the addition. It is the four refusals - a header
// that disagrees but is not zero, a header with no currency, lines that
// disagree with themselves, and the promise that nothing ever sums two
// currencies together. `PO-009335` is CNY at rate 0.619380: book MYR 21,266.35,
// own-currency 34,334.90. Comparing the wrong pair of those already wrote
// RM 13,068.55 of fabricated discount onto a live document (docs/bugs/0665).
import { describe, expect, it } from 'vitest';

import { isZeroHeaderWithPricedLines, planPoHeaderRollups } from '../scripts/lib/po-header-rollup.mjs';

const header = (over = {}) => ({
  id: 'po-1', po_number: 'HC-PO-009800', linked_ac_docno: 'PO-009800', currency: 'MYR',
  status: 'SUBMITTED', subtotal_sen: 0, tax_sen: 0, total_sen: 0,
  line_count: 2, line_sum_sen: 200000, qty_price_sum_sen: 200000, ...over,
});

describe('the purchase-order header roll-up rule', () => {
  it('rolls a zero header up to the sum of its own lines', () => {
    const { plan, refused, counts } = planPoHeaderRollups({ headers: [header()] });
    expect(refused).toHaveLength(0);
    expect(counts.zeroHeaderPricedLines).toBe(1);
    expect(plan).toEqual([{
      id: 'po-1', poNumber: 'HC-PO-009800', acDocNo: 'PO-009800', currency: 'MYR', status: 'SUBMITTED',
      lineCount: 2, fromSubtotalSen: 0, fromTotalSen: 0, taxSen: 0,
      toSubtotalSen: 200000, toTotalSen: 200000,
    }]);
  });

  /* The app's own rule is subtotal + tax, not the line sum alone
     (applyPoAmendment, src/scm/lib/po-revision.ts). A header carrying tax must
     keep it. */
  it('keeps the header tax and adds it on top of the line sum', () => {
    const { plan } = planPoHeaderRollups({ headers: [header({ tax_sen: 12000 })] });
    expect(plan[0]).toMatchObject({ taxSen: 12000, toSubtotalSen: 200000, toTotalSen: 212000 });
  });

  it('leaves a header that already equals its own lines alone', () => {
    const { plan, counts } = planPoHeaderRollups({
      headers: [header({ subtotal_sen: 200000, total_sen: 200000 })],
    });
    expect(plan).toHaveLength(0);
    expect(counts.headerAlreadyEqualsLines).toBe(1);
  });

  it('says nothing about a document whose lines are zero too', () => {
    const { plan, refused, counts } = planPoHeaderRollups({
      headers: [header({ line_sum_sen: 0, qty_price_sum_sen: 0 })],
    });
    expect(plan).toHaveLength(0);
    expect(refused).toHaveLength(0);
    expect(counts.zeroHeaderZeroLines).toBe(1);
  });

  /* The owner ruled on the 70 ZERO-total documents. A header that merely
     disagrees is a different question and a different decision. */
  it('REFUSES a header that disagrees with its lines but is not zero', () => {
    const { plan, refused, counts } = planPoHeaderRollups({
      headers: [header({ subtotal_sen: 150000, total_sen: 150000 })],
    });
    expect(plan).toHaveLength(0);
    expect(counts.headerDisagreesButNotZero).toBe(1);
    expect(refused[0]).toMatchObject({ why: 'notZero' });
  });

  it('REFUSES a header with no currency rather than assuming ringgit', () => {
    const { plan, refused, counts } = planPoHeaderRollups({ headers: [header({ currency: null })] });
    expect(plan).toHaveLength(0);
    expect(counts.noCurrency).toBe(1);
    expect(refused[0]).toMatchObject({ why: 'noCurrency' });
  });

  it('REFUSES when the lines disagree with themselves', () => {
    const { plan, refused, counts } = planPoHeaderRollups({
      headers: [header({ qty_price_sum_sen: 190000 })],
    });
    expect(plan).toHaveLength(0);
    expect(counts.lineSumUnsound).toBe(1);
    expect(refused[0]).toMatchObject({ why: 'lineSumUnsound' });
  });

  /* THE GUARD THAT MATTERS MOST. A single grand total across currencies is the
     shape that already cost RM 13,068.55 on a live purchase order. */
  it('never sums two currencies together and rolls a CNY document up in CNY', () => {
    const { plan, byCurrency } = planPoHeaderRollups({
      headers: [
        header(),
        header({ id: 'po-2', po_number: 'HC-PO-009335', currency: 'CNY', line_sum_sen: 3433490, qty_price_sum_sen: 3433490 }),
      ],
    });
    expect(plan).toHaveLength(2);
    expect(byCurrency.get('MYR')).toEqual({ documents: 1, before_sen: 0, after_sen: 200000 });
    expect(byCurrency.get('CNY')).toEqual({ documents: 1, before_sen: 0, after_sen: 3433490 });
    expect(byCurrency.size).toBe(2);
    expect(plan.find((p) => p.poNumber === 'HC-PO-009335')).toMatchObject({ currency: 'CNY', toTotalSen: 3433490 });
  });

  it('names the population predicate so the runner and the test share it', () => {
    expect(isZeroHeaderWithPricedLines({ total_sen: 0, line_sum_sen: 1 })).toBe(true);
    expect(isZeroHeaderWithPricedLines({ total_sen: 0, line_sum_sen: 0 })).toBe(false);
    expect(isZeroHeaderWithPricedLines({ total_sen: 1, line_sum_sen: 1 })).toBe(false);
  });
});
