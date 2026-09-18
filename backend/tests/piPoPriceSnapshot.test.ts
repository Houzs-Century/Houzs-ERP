/* The PO price on a purchase-invoice line is a TRAIL, not a live lookup.
 *
 * Owner, 2026-09-14: 「只要我 edit 过了，系统就直接把原来的 PO 价钱留痕下来」 and
 * 「这只是一个 reference 的 … 我 PI 要填多少钱都是我喜欢的」. Two things must hold:
 *   1. the price is taken from the SERVER's own link at insert — never from the
 *      request — so it says what the order said when the invoice was written;
 *   2. once taken it wins over the live join, so an approved PO amendment that
 *      re-prices a received line cannot rewrite an existing invoice's trail. */
import { describe, it, expect } from 'vitest';
import { attachGrnLineFacts, stampPoPriceSnapshot, defaultPiUnitPriceSen } from '../src/scm/lib/pi-po-price';

const stub = (tables: Record<string, unknown[]>) => {
  const calls: string[] = [];
  return {
    calls,
    sb: {
      from: (table: string) => ({
        select: (_cols: string) => ({
          in: async () => { calls.push(table); return { data: tables[table] ?? [], error: null }; },
        }),
      }),
    },
  };
};

describe('stampPoPriceSnapshot — at insert', () => {
  it('stamps the ordered price through the receipt line, and null where there is no PO', async () => {
    const { sb } = stub({
      grn_items: [{ id: 'g1', purchase_order_item_id: 'p1' }, { id: 'g2', purchase_order_item_id: null }],
      purchase_order_items: [{ id: 'p1', unit_price_sen: 80_000 }],
    });
    const rows: Array<Record<string, unknown>> = [
      { grn_item_id: 'g1', unit_price_sen: 83_000 },
      { grn_item_id: 'g2', unit_price_sen: 10_000 },
      { grn_item_id: null, unit_price_sen: 5_000 },
    ];
    await stampPoPriceSnapshot(sb, rows);
    expect(rows.map((r) => r.po_unit_price_sen)).toEqual([80_000, null, null]);
    // the billed price is the operator's and is never touched
    expect(rows.map((r) => r.unit_price_sen)).toEqual([83_000, 10_000, 5_000]);
  });

  it('a value in the request body is overwritten — the trail cannot be forged', async () => {
    const { sb } = stub({
      grn_items: [{ id: 'g1', purchase_order_item_id: 'p1' }],
      purchase_order_items: [{ id: 'p1', unit_price_sen: 0 }],
    });
    const rows: Array<Record<string, unknown>> = [
      { grn_item_id: 'g1', po_unit_price_sen: 99_999 },
      { grn_item_id: null, po_unit_price_sen: 12_345 },
    ];
    await stampPoPriceSnapshot(sb, rows);
    expect(rows.map((r) => r.po_unit_price_sen)).toEqual([0, null]);
  });

  it('no linked line -> no read at all', async () => {
    const { sb, calls } = stub({});
    await stampPoPriceSnapshot(sb, [{ grn_item_id: null }]);
    expect(calls).toEqual([]);
  });

  it('a failed read THROWS rather than writing a trail of nulls', async () => {
    const sb = {
      from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'boom' } }) }) }),
    };
    await expect(stampPoPriceSnapshot(sb, [{ grn_item_id: 'g1' }])).rejects.toThrow(/boom/);
  });
});

describe('attachGrnLineFacts — the stored trail wins over the live join', () => {
  it('a snapshot is served even after the purchase order was re-priced', async () => {
    const { sb } = stub({
      grn_items: [{ id: 'g1', supplier_sku: null, purchase_order_item_id: 'p1' }],
      purchase_order_items: [{ id: 'p1', unit_price_sen: 90_000, purchase_order_id: 'po', po: { po_number: 'PO-1' } }],
    });
    const items: Array<Record<string, unknown> & { id: string; grn_item_id?: string | null }> = [
      { id: 'l1', grn_item_id: 'g1', po_unit_price_sen: 80_000 },
    ];
    await attachGrnLineFacts(sb, items);
    expect(items[0]!.po_unit_price_sen).toBe(80_000);
    expect(items[0]!.po_price_source).toBe('snapshot');
  });

  it('a line written before the column existed falls back to the live join, and says so', async () => {
    const { sb } = stub({
      grn_items: [{ id: 'g1', supplier_sku: null, purchase_order_item_id: 'p1' }],
      purchase_order_items: [{ id: 'p1', unit_price_sen: 90_000, purchase_order_id: 'po', po: { po_number: 'PO-1' } }],
    });
    const items: Array<Record<string, unknown> & { id: string; grn_item_id?: string | null }> = [
      { id: 'l1', grn_item_id: 'g1', po_unit_price_sen: null },
      { id: 'l2', grn_item_id: null, po_unit_price_sen: null },
    ];
    await attachGrnLineFacts(sb, items);
    expect(items.map((i) => [i.po_unit_price_sen, i.po_price_source])).toEqual([
      [90_000, 'live'],
      [null, 'none'],
    ]);
  });
});

describe('defaultPiUnitPriceSen — what a new invoice line starts at', () => {
  it('the PO price, when the order named one', () => {
    expect(defaultPiUnitPriceSen(80_000, 83_000)).toBe(80_000);
  });
  it('the receipt price when the order named none (0) or there is no order', () => {
    expect(defaultPiUnitPriceSen(0, 21_380)).toBe(21_380);
    expect(defaultPiUnitPriceSen(null, 21_380)).toBe(21_380);
  });
  it('never NaN', () => {
    expect(defaultPiUnitPriceSen(null, Number.NaN)).toBe(0);
  });
});

describe('piPoPriceSummaryByInvoice — the list marker', () => {
  it('groups by invoice, counts differing lines and says how many lines had a PO price to compare', async () => {
    const { piPoPriceSummaryByInvoice } = await import('../src/scm/lib/pi-po-price');
    const out = piPoPriceSummaryByInvoice([
      { purchase_invoice_id: 'A', qty: 1, unit_price_sen: 83_000, po_unit_price_sen: 80_000 },
      { purchase_invoice_id: 'A', qty: 2, unit_price_sen: 22_500, po_unit_price_sen: 20_000 },
      { purchase_invoice_id: 'A', qty: 1, unit_price_sen: 5_000, po_unit_price_sen: 5_000 },
      { purchase_invoice_id: 'B', qty: 3, unit_price_sen: 21_380, po_unit_price_sen: 0 },
      { purchase_invoice_id: 'B', qty: 1, unit_price_sen: 900, po_unit_price_sen: null },
    ]);
    expect(out.get('A')).toEqual({ linesDiffering: 2, totalDiffSen: 8_000, comparableLines: 3, lines: 3 });
    expect(out.get('B')).toEqual({ linesDiffering: 0, totalDiffSen: 0, comparableLines: 0, lines: 2 });
  });
});
