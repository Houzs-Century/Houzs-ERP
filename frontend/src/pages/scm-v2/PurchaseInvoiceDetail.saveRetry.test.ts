// A PI edit's Save that failed part-way, pressed again (Conts #1137 D20, PI half).
// Symptom: the lines saved by the first press were sent again by the second, so
// the invoice billed them twice; and the re-fetch after the first line landed
// re-seeded the editor from the server, throwing away the lines not saved yet.
// Fix: each added line's id is written back into its draft, and a re-fetch while
// editing merges into the drafts instead of replacing them.
import { describe, expect, test, vi } from 'vitest';
import { mergeEditLines, saveEditLines } from './PurchaseInvoiceDetail';

type Draft = Parameters<typeof saveEditLines>[1][number];
type Item = Parameters<typeof saveEditLines>[2][number];

const draft = (rid: string, over: Partial<Draft> = {}): Draft => ({
  rid, materialKind: 'mfg_product', itemCode: `SKU-${rid}`, materialName: `Item ${rid}`,
  qty: 1, unitPriceSen: 10_000, discountSen: 0, variants: {}, priceTouched: true, ...over,
} as Draft);
const item = (id: string, code: string): Item => ({
  id, item_code: code, material_name: `Item ${code.slice(4)}`, item_group: null, qty: 1,
  unit_price_sen: 10_000, discount_sen: 0, variants: {}, grn_item_id: null,
} as unknown as Item);

describe('PI edit Save pressed again after a failure', () => {
  test('a line saved by the first press is not added again by the second', async () => {
    let lines = [draft('a'), draft('b')];
    const saved = (rid: string, itemId: string) => { lines = lines.map((l) => (l.rid === rid ? { ...l, itemId } : l)); };
    let n = 0;
    const add = vi.fn(async (b: { id: string } & Record<string, unknown>) => {
      if (b.itemCode === 'SKU-b' && n++ === 0) throw new Error('network');
      return { item: { id: `item-${String(b.itemCode)}` } };
    });
    const update = vi.fn(async () => ({}));
    await expect(saveEditLines('pi-1', lines, [], { add, update, saved })).rejects.toThrow('network');
    expect(add).toHaveBeenCalledTimes(2);
    /* The server now holds line a; the second press sees it as saved and unchanged. */
    await saveEditLines('pi-1', lines, [item('item-SKU-a', 'SKU-a')], { add, update, saved });
    expect(add.mock.calls.map((c) => c[0].itemCode)).toEqual(['SKU-a', 'SKU-b', 'SKU-b']);
    expect(update).not.toHaveBeenCalled();
  });

  test('the re-fetch after the first line landed keeps the line not saved yet', () => {
    const typed = [draft('a', { itemId: 'item-a' }), draft('b')];
    const merged = mergeEditLines(typed, [item('item-a', 'SKU-a')]);
    expect(merged.map((l) => l.rid)).toEqual(['a', 'b']);
  });

  test('entering Edit seeds every saved line; a deleted line drops out; a line saved elsewhere appears', () => {
    expect(mergeEditLines([], [item('x', 'SKU-x')]).map((l) => l.itemId)).toEqual(['x']);
    const merged = mergeEditLines([draft('a', { itemId: 'gone' }), draft('b')], [item('y', 'SKU-y')]);
    expect(merged.map((l) => l.itemId ?? l.rid)).toEqual(['b', 'y']);
  });
});
