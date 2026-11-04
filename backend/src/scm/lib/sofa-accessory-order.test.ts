import { describe, expect, it } from 'vitest';
import { applySofaAccessoryInclusions, isStoredIncludedSofaAccessory, validateSofaAccessoryOrder } from './sofa-accessory-order';
import { recomputeFromSnapshot, type ProductRowLite, type MfgItemForRecompute } from './mfg-pricing-recompute';
import type { SofaComboRow } from '../shared/sofa-combo-pricing';

const sofa: ProductRowLite = {
  code: '8210-2NA', category: 'SOFA', model_id: 'sofa', base_model: '8210',
  base_price_sen: 60_000, price1_sen: null, cost_price_sen: 60_000,
  seat_height_prices: null, sell_price_sen: 75_000,
};
const cushion: ProductRowLite = {
  ...sofa, code: 'BC06', category: 'FABRIC_ACCESSORY', model_id: 'cushion', base_model: 'BC06',
  base_price_sen: 10_000, cost_price_sen: 10_000, sell_price_sen: 25_050,
};
const combo: SofaComboRow = {
  id: 'inclusive', baseModel: '8210', modules: [['2NA']],
  accessories: [{ modelId: 'cushion', qty: 2 }], tier: 'PRICE_1', customerId: null,
  pricesByHeight: { '24': 112_575 }, effectiveFrom: '2026-01-01',
};
const piece = (id: string) => ({ id, cellId: 'a', modelId: 'cushion' });
function order() {
  return [
    { itemCode: sofa.code, itemGroup: 'sofa', cartLineKey: 'sofa-key', qty: 2, unitPriceSen: 112_575,
      variants: { cells: [{ id: 'a', moduleId: '2NA', x: 0, y: 0, rot: 0 }], depth: '24',
        sofaAccessories: [piece('one'), piece('two'), piece('extra')] } },
    { itemCode: cushion.code, itemGroup: 'fabric_accessory', qty: 4, unitPriceSen: 0,
      variants: { sofaAccessoryOfKey: 'sofa-key', sofaAccessoryPieceIds: ['one', 'two'] } },
    { itemCode: cushion.code, itemGroup: 'fabric_accessory', qty: 2, unitPriceSen: 25_050,
      variants: { sofaAccessoryOfKey: 'sofa-key', sofaAccessoryPieceIds: ['extra'] } },
  ] as Array<Record<string, unknown>>;
}
const products = [sofa, cushion, cushion];

describe('authoritative accessory bundle order', () => {
  it('prices the complete set once, charges only the extra piece, and keeps cost on every SKU', () => {
    const items = order();
    const validation = validateSofaAccessoryOrder(items, products);
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error(validation.reason);
    const priced = items.map((it, idx) => recomputeFromSnapshot({
      itemCode: String(it.itemCode), itemGroup: String(it.itemGroup), qty: Number(it.qty),
      unitPriceSen: Number(it.unitPriceSen), variants: it.variants as MfgItemForRecompute['variants'],
      sofaAccessories: validation.context.parents.get(idx),
    }, products[idx]!, null, null, [combo], idx === 0 ? { '2NA': 75_000 } : null));
    const childCost = priced[1]!.unit_cost_sen;
    expect(childCost).toBeGreaterThan(0);
    expect(applySofaAccessoryInclusions(items, priced, validation.context)).toBeNull();
    expect(priced.map((r) => r.unit_price_sen)).toEqual([112_575, 0, 25_050]);
    expect(priced.map((r) => r.drift)).toEqual([false, false, false]);
    expect(priced.reduce((sum, r) => sum + r.total_sen, 0)).toBe(275_250);
    expect(priced[1]!.unit_cost_sen).toBe(childCost);
    expect(isStoredIncludedSofaAccessory({ item_group: 'fabric_accessory', variants: items[1]!.variants })).toBe(true);
    expect(isStoredIncludedSofaAccessory({ item_group: 'fabric_accessory', variants: items[2]!.variants })).toBe(false);
  });

  it.each([
    ['missing child line', (items: ReturnType<typeof order>) => { items.pop(); }],
    ['wrong quantity', (items: ReturnType<typeof order>) => { items[1]!.qty = 2; }],
    ['wrong sofa', (items: ReturnType<typeof order>) => { (items[1]!.variants as Record<string, unknown>).sofaAccessoryOfKey = 'missing'; }],
    ['reused piece', (items: ReturnType<typeof order>) => { (items[2]!.variants as Record<string, unknown>).sofaAccessoryPieceIds = ['one']; }],
    ['forged inclusion', (items: ReturnType<typeof order>) => { (items[1]!.variants as Record<string, unknown>).sofaComboIncluded = { buildKey: 'x', pieceIds: ['one'] }; }],
    ['wrong attachment', (items: ReturnType<typeof order>) => { ((items[0]!.variants as Record<string, unknown>).sofaAccessories as ReturnType<typeof piece>[])[0]!.cellId = 'missing'; }],
  ])('refuses %s before pricing', (_label, change) => {
    const items = order();
    change(items);
    expect(validateSofaAccessoryOrder(items, products).ok).toBe(false);
  });

  it('checks the real SKU model and category, not the submitted item group', () => {
    expect(validateSofaAccessoryOrder(order(), [sofa, { ...cushion, model_id: 'other' }, cushion]).ok).toBe(false);
    expect(validateSofaAccessoryOrder(order(), [sofa, { ...cushion, category: 'ACCESSORY' }, cushion]).ok).toBe(false);
  });

  it('refuses a line that mixes included and separately charged quantities', () => {
    const items = order();
    items.splice(2);
    items[1]!.qty = 6;
    (items[1]!.variants as Record<string, unknown>).sofaAccessoryPieceIds = ['one', 'two', 'extra'];
    const validation = validateSofaAccessoryOrder(items, products);
    if (!validation.ok) throw new Error(validation.reason);
    const priced = items.map((it, idx) => recomputeFromSnapshot({
      itemCode: String(it.itemCode), itemGroup: String(it.itemGroup), qty: Number(it.qty), unitPriceSen: Number(it.unitPriceSen),
      variants: it.variants as MfgItemForRecompute['variants'], sofaAccessories: validation.context.parents.get(idx),
    }, products[idx]!, null, null, [combo], idx === 0 ? { '2NA': 75_000 } : null));
    expect(applySofaAccessoryInclusions(items, priced, validation.context)).toMatch(/separate order lines/);
  });

  it('refuses to discard a separate special charge on an included accessory', () => {
    const items = order();
    (items[1]!.variants as Record<string, unknown>).extraAddonAmountRM = 25;
    const validation = validateSofaAccessoryOrder(items, products);
    if (!validation.ok) throw new Error(validation.reason);
    const priced = items.map((it, idx) => recomputeFromSnapshot({
      itemCode: String(it.itemCode), itemGroup: String(it.itemGroup), qty: Number(it.qty), unitPriceSen: Number(it.unitPriceSen),
      variants: it.variants as MfgItemForRecompute['variants'], sofaAccessories: validation.context.parents.get(idx),
    }, products[idx]!, null, null, [combo], idx === 0 ? { '2NA': 75_000 } : null));
    expect(applySofaAccessoryInclusions(items, priced, validation.context)).toMatch(/separate charge/);
    expect(priced[1]!.unit_price_sen).toBeGreaterThan(0);
  });

  it('leaves legacy orders without accessory links unchanged', () => {
    expect(validateSofaAccessoryOrder([{ itemCode: 'BC06', qty: 1, variants: { fabricCode: 'CG-001' } }], [cushion]))
      .toEqual({ ok: true, context: { parents: new Map(), children: new Map() } });
  });

  it('refuses a stale included-zero submission instead of silently charging accessories again', () => {
    const items = order();
    const validation = validateSofaAccessoryOrder(items, products);
    if (!validation.ok) throw new Error(validation.reason);
    const priced = items.map((it, idx) => recomputeFromSnapshot({
      itemCode: String(it.itemCode), itemGroup: String(it.itemGroup), qty: Number(it.qty), unitPriceSen: Number(it.unitPriceSen),
      variants: it.variants as MfgItemForRecompute['variants'], sofaAccessories: validation.context.parents.get(idx),
    }, products[idx]!, null, null, [], idx === 0 ? { '2NA': 75_000 } : null));
    expect(applySofaAccessoryInclusions(items, priced, validation.context)).toMatch(/no longer includes/);
  });
});
