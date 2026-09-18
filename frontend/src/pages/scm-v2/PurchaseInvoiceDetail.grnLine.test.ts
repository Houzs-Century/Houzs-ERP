// grnItemToEditLine — the one non-trivial mapping behind "Transfer from GRN"
// on an already-saved Purchase Invoice: a picked OutstandingGrnItem + qty
// becomes a PoLineCard draft (EditLine) that Save later sends to
// POST /purchase-invoices/:id/items with grnItemId set.
import { describe, expect, test } from 'vitest';
import type { OutstandingGrnItem } from '../../vendor/scm/lib/suppliers-queries';
import { grnItemToEditLine } from './PurchaseInvoiceDetail';

const grnItem = (over: Partial<OutstandingGrnItem> = {}): OutstandingGrnItem => ({
  grnItemId: 'gi-1', grnId: 'g-1', grnDocNo: 'GRN-2609-001', receivedAt: '2026-09-10',
  supplierId: 's-1', supplierCode: 'DIG', supplierName: 'DIGLANT MANUFACTURING SDN BHD',
  purchaseOrderId: 'po-1', poDocNo: 'HC-PO-009984',
  itemCode: 'AK-ULTIMATE MATT (Q)', description: 'AKEMI ULTIMATE MATTRESS (152X190X36CM)',
  itemGroup: 'MATTRESS', qtyAccepted: 4, remaining: 4, unitPriceSen: 130_000,
  variants: { fabricCode: 'BO315-21' },
  currency: 'MYR', exchangeRate: 1,
  ...over,
});

describe('grnItemToEditLine', () => {
  test('carries the GRN line id, locks identity, and takes the picked qty (not remaining)', () => {
    const line = grnItemToEditLine(grnItem({ remaining: 4 }), 2);
    expect(line.grnItemId).toBe('gi-1');
    expect(line.grnLinked).toBe(true);
    expect(line.qty).toBe(2); // the qty typed in the picker, not the full remaining
  });

  test('item identity and price come straight off the GRN line', () => {
    const line = grnItemToEditLine(grnItem(), 4);
    expect(line.itemCode).toBe('AK-ULTIMATE MATT (Q)');
    expect(line.materialName).toBe('AKEMI ULTIMATE MATTRESS (152X190X36CM)');
    expect(line.unitPriceSen).toBe(130_000);
    expect(line.category).toBe('mattress'); // lower-cased, matches PoLineCard's category convention
    expect(line.variants).toEqual({ fabricCode: 'BO315-21' });
  });

  test('a blank description falls back to the item code, never an empty name', () => {
    const line = grnItemToEditLine(grnItem({ description: null }), 1);
    expect(line.materialName).toBe('AK-ULTIMATE MATT (Q)');
  });

  test('price stays touched so the cost auto-recompute never overwrites a billed price', () => {
    const line = grnItemToEditLine(grnItem(), 1);
    expect(line.priceTouched).toBe(true);
  });

  test('two picks from the same GRN line produce the same rid — Save must treat a re-pick as one line, not a duplicate insert', () => {
    const a = grnItemToEditLine(grnItem(), 1);
    const b = grnItemToEditLine(grnItem(), 3);
    expect(a.rid).toBe(b.rid);
  });
});
