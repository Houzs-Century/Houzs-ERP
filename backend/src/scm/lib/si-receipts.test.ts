/* The printed "Payments received" list's rows (owner 2026-10-06): the order's
   own rows and the invoice's, oldest first, amounts as numbers. */
import { describe, expect, test } from 'vitest';
import { invoiceReceipts } from './si-receipts';

describe('every sum received towards an invoice', () => {
  test("the order's rows and the invoice's own, each oldest first", () => {
    const r = invoiceReceipts({
      so_doc_no: '2990-SO-2606-012', order_collected_sen: 300_000, applied_sen: 300_000,
      transactions: [
        { id: 't2', paid_at: '2026-06-20', method: 'installment', amount_sen: 200_000, account_sheet: null, note: null },
        { id: 't1', paid_at: '2026-06-15', method: 'cash', amount_sen: 100_000, account_sheet: null, note: null },
      ],
    }, [{ paid_at: '2026-07-02', method: 'transfer', amount_sen: '36500' }]);
    expect(r).toEqual({
      order: [
        { paid_at: '2026-06-15', method: 'cash', amount_sen: 100_000 },
        { paid_at: '2026-06-20', method: 'installment', amount_sen: 200_000 },
      ],
      invoice: [{ paid_at: '2026-07-02', method: 'transfer', amount_sen: 36_500 }],
    });
  });

  test('no order money and no receipts: two empty lists', () => {
    expect(invoiceReceipts(null, [])).toEqual({ order: [], invoice: [] });
  });
});
