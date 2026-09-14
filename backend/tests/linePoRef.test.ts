/* line-po-ref — which purchase order a goods-receipt or purchase-invoice LINE
 * came from (#26, owner confirmed 2026-09-14: "GRN & PI need PO related show
 * for every item — easier to cross check").
 *
 * The trap: a line with no link must read as NO purchase order, never as the
 * header's PO or a neighbour's. A GRN may span several POs of one supplier and
 * a PI may bill several GRNs, so the header ref is a guess for any given line. */
import { describe, it, expect } from 'vitest';
import { poPriceByPoItemId, poRefByPoItemId, poRefByPiLine, stampGrnLinePoRefs } from '../src/scm/lib/line-po-ref';
import { attachGrnLineFacts } from '../src/scm/lib/pi-po-price';

const poItems = [
  { id: 'p1', purchase_order_id: 'po-A', po: { po_number: 'HC-PO-010007' } },
  { id: 'p2', purchase_order_id: 'po-B', po: [{ po_number: 'HC-PO-010008' }] }, // PostgREST array shape
  { id: 'p3', purchase_order_id: 'po-C', po: null },                           // PO not visible
  { id: 'p4', purchase_order_id: null, po: { po_number: 'HC-PO-9' } },          // no id to link to
];

describe('poRefByPoItemId', () => {
  it('reads both the object and the array embed shape', () => {
    const m = poRefByPoItemId(poItems);
    expect(m.get('p1')).toEqual({ poId: 'po-A', poNumber: 'HC-PO-010007' });
    expect(m.get('p2')).toEqual({ poId: 'po-B', poNumber: 'HC-PO-010008' });
  });

  it('a half-known PO (no number, or no id) is not a ref — nothing to click or nothing to say', () => {
    const m = poRefByPoItemId(poItems);
    expect(m.has('p3')).toBe(false);
    expect(m.has('p4')).toBe(false);
  });
});

describe('stampGrnLinePoRefs', () => {
  it('stamps id + number per line and null on a manual line', () => {
    const lines: Array<Record<string, unknown> & { purchase_order_item_id: string | null }> = [
      { id: 'g1', purchase_order_item_id: 'p1' },
      { id: 'g2', purchase_order_item_id: null },
      { id: 'g3', purchase_order_item_id: 'p3' },
    ];
    stampGrnLinePoRefs(lines, poRefByPoItemId(poItems), poPriceByPoItemId([{ id: 'p1', unit_price_sen: 80_000 }, { id: 'p3', unit_price_sen: 0 }]));
    expect(lines.map((l) => [l.source_po_id, l.source_po_number, l.po_unit_price_sen])).toEqual([
      ['po-A', 'HC-PO-010007', 80_000],
      [null, null, null],
      // no readable PO number, but the order's price is still the order's price
      [null, null, 0],
    ]);
  });
});

describe('poRefByPiLine', () => {
  const grnItems = [
    { id: 'g1', purchase_order_item_id: 'p1' },
    { id: 'g2', purchase_order_item_id: 'p2' },
    { id: 'g3', purchase_order_item_id: null },
  ];
  it('walks PI line -> grn line -> PO line -> PO, per LINE (a PI can bill two POs)', () => {
    const m = poRefByPiLine(
      [{ id: 'l1', grn_item_id: 'g1' }, { id: 'l2', grn_item_id: 'g2' }],
      grnItems, poRefByPoItemId(poItems),
    );
    expect(m.get('l1')?.poNumber).toBe('HC-PO-010007');
    expect(m.get('l2')?.poNumber).toBe('HC-PO-010008');
  });

  it('a service line, a PO-less receipt and an unseen grn line all resolve to null', () => {
    const m = poRefByPiLine(
      [{ id: 'a', grn_item_id: null }, { id: 'b', grn_item_id: 'g3' }, { id: 'c', grn_item_id: 'gone' }],
      grnItems, poRefByPoItemId(poItems),
    );
    expect([m.get('a'), m.get('b'), m.get('c')]).toEqual([null, null, null]);
  });
});

describe('attachGrnLineFacts serves the PO ref from the SAME read as the PO price', () => {
  const stub = (tables: Record<string, unknown[]>) => {
    const calls: Array<{ table: string; cols: string }> = [];
    return {
      calls,
      sb: {
        from: (table: string) => ({
          select: (cols: string) => ({
            in: async () => { calls.push({ table, cols }); return { data: tables[table] ?? [], error: null }; },
          }),
        }),
      },
    };
  };

  it('stamps source_po_id / source_po_number beside po_unit_price_sen', async () => {
    const { sb, calls } = stub({
      grn_items: [{ id: 'g1', supplier_sku: 'DSL-8051', purchase_order_item_id: 'p1' }],
      purchase_order_items: [{ id: 'p1', unit_price_sen: 0, purchase_order_id: 'po-A', po: { po_number: 'HC-PO-010007' } }],
    });
    const items: Array<Record<string, unknown> & { id: string; grn_item_id?: string | null }> = [
      { id: 'l1', grn_item_id: 'g1' },
      { id: 'l2', grn_item_id: null },
    ];
    await attachGrnLineFacts(sb, items);
    expect(items[0]).toMatchObject({ source_po_id: 'po-A', source_po_number: 'HC-PO-010007', po_unit_price_sen: 0 });
    expect(items[1]).toMatchObject({ source_po_id: null, source_po_number: null, po_unit_price_sen: null });
    // one read per table, never one per line
    expect(calls.map((c) => c.table)).toEqual(['grn_items', 'purchase_order_items']);
  });
});
