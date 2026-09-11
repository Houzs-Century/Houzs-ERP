/* The UPDATE_PAYMENT audit's from → to list, lifted out of the PATCH handler
   when the ledger hook was added (docs/bugs/0778) — the route file is over its
   size ceiling and may only shrink, and this comparison was always a fact
   about the ROW rather than about that route.
 *
 * It is a DIFFERENT question from acc/payment-repost's `ledgerBearingChange`,
 * and these cases exist to keep it that way: the audit records NINE columns,
 * the ledger reads FOUR. Collapsing them would either re-post the ledger every
 * time somebody fixes an approval code, or drop the approval code from the
 * audit trail — and both were one careless edit away once the two lists sat in
 * the same handler.
 */
import { describe, expect, it } from 'vitest';
import { soPaymentFieldChanges, type SoPaymentEditable } from './so-payment-row';

const row = (over: Partial<SoPaymentEditable> = {}): SoPaymentEditable => ({
  paid_at: '2026-09-01', method: 'cash', amount_sen: 199_000,
  merchant_provider: null, installment_months: null, online_type: null,
  approval_code: null, account_sheet: 'Cash', collected_by: null,
  ...over,
});

describe('soPaymentFieldChanges', () => {
  it('says nothing when nothing moved', () => {
    expect(soPaymentFieldChanges(row(), row())).toEqual([]);
  });

  it('names a moved column from → to', () => {
    expect(soPaymentFieldChanges(row(), row({ amount_sen: 199_100 })))
      .toEqual([{ field: 'amountSen', from: 199_000, to: 199_100 }]);
  });

  /* The order the audit has always printed, so a reader comparing an old entry
     with a new one is not comparing two different orderings. */
  it('keeps the order the audit has always used', () => {
    const changed = soPaymentFieldChanges(row(), row({
      paid_at: '2026-09-04', method: 'merchant', amount_sen: 1,
      merchant_provider: 'MBB', installment_months: 6, online_type: 'DuitNow',
      approval_code: 'A1', account_sheet: 'MBB', collected_by: 'staff-1',
    }));
    expect(changed.map((c) => c.field)).toEqual([
      'paidAt', 'method', 'amountSen', 'merchantProvider', 'installmentMonths',
      'onlineType', 'approvalCode', 'accountSheet', 'collectedBy',
    ]);
  });

  /* All NINE, not the four the ledger reads — an approval-code correction must
     still reach the audit trail even though it books nothing. */
  it('records the five columns the ledger does not care about', () => {
    for (const [col, field] of [
      ['installment_months', 'installmentMonths'], ['online_type', 'onlineType'],
      ['approval_code', 'approvalCode'], ['account_sheet', 'accountSheet'],
      ['collected_by', 'collectedBy'],
    ] as const) {
      const changed = soPaymentFieldChanges(row(), row({ [col]: 'moved' } as Partial<SoPaymentEditable>));
      expect(changed.map((c) => c.field), `${col} is not audited`).toEqual([field]);
    }
  });

  it('a column absent from the stored row reads as null, not as undefined', () => {
    expect(soPaymentFieldChanges({}, row({ method: 'cash' })))
      .toContainEqual({ field: 'method', from: null, to: 'cash' });
  });

  it('an absent value and an explicit null are the same value', () => {
    const { approval_code: _absent, ...withoutApproval } = row();
    expect(soPaymentFieldChanges(withoutApproval, row())).toEqual([]);
  });
});
