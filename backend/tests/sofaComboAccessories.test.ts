import { describe, expect, it } from 'vitest';
import {
  comboAccessoriesKey,
  findDuplicateCombo,
  matchComboBuild,
  normalizeComboAccessories,
  pickComboMatch,
  type PickComboArgs,
  type SofaComboRow,
  type SofaPricedAccessory,
} from '../src/scm/shared/sofa-combo-pricing';
import { computeSofaPrice, computeSofaSellingResult, computeSofaSellingSen, type Cell, type SofaProductPricing } from '../src/scm/shared/sofa-build';
import { computeSofaSellingResult as frontendSellingResult } from '../../frontend/src/vendor/shared/sofa-build';
import { checkPwpEligibility, type PureEligibilityArgs } from '../src/scm/lib/pwp-claim-single';

const piece = (id: string, cellId = 'a', modelId = 'cushion'): SofaPricedAccessory =>
  ({ id, cellId, modelId, priceSen: 25_050 });
const combo = (overrides: Partial<SofaComboRow> = {}): SofaComboRow => ({
  id: 'inclusive', baseModel: '8210', modules: [['2NA']],
  accessories: [{ modelId: 'cushion', qty: 2 }],
  tier: 'PRICE_1', customerId: null, pricesByHeight: { '24': 112_575 },
  effectiveFrom: '2026-01-01', ...overrides,
});
const args = (overrides: Partial<PickComboArgs> = {}): PickComboArgs => ({
  baseModel: '8210', modules: ['2NA'], cellIds: ['a'],
  accessories: [piece('one'), piece('two')], customerId: null,
  tier: 'PRICE_1', height: '24', asOf: '2026-10-30', ...overrides,
});

describe('sofa combos with accessories', () => {
  it('refuses an inclusive reward on the single-line path while legacy sofa rewards still work', () => {
    const claim: PureEligibilityArgs = {
      codeRow: {
        code: 'PWP-TEST', status: 'AVAILABLE', owner_staff_id: 'staff', reward_category: 'SOFA',
        eligible_reward_model_ids: [], reward_combo_ids: ['inclusive'], customer_id: null,
        source_doc_no: null, redeemed_doc_no: null, type: 'pwp',
      },
      product: { category: 'SOFA', model_id: 'sofa-model', base_model: '8210' },
      customerId: null, ownerStaffId: 'staff', qty: 1, isOrphanedUsed: false,
      alreadyOnOrder: false, sofaModules: ['2NA'], sofaCombos: [combo()],
    };
    expect(checkPwpEligibility(claim)).toMatchObject({ ok: false });
    expect(checkPwpEligibility({ ...claim, sofaCombos: [combo({ accessories: [] })] }))
      .toMatchObject({ ok: true, grantSofaComboIds: ['inclusive'] });
  });
  it('matches voucher composition without relying on a price or accepting modules alone', () => {
    const row = combo({ pricesByHeight: {} });
    expect(matchComboBuild(args(), row)?.matchedAccessoryIds).toEqual(['one', 'two']);
    expect(matchComboBuild({ modules: ['2NA'] }, row)).toBeNull();
    expect(matchComboBuild({ modules: ['2NA'] }, combo({ accessories: [] }))).not.toBeNull();
  });
  it('includes exactly the required quantities and leaves added pieces outside the combo', () => {
    const match = pickComboMatch(args({ accessories: [piece('one'), piece('two'), piece('extra')] }), [combo()]);
    expect(match).toMatchObject({ comboPriceSen: 112_575, matchedIndices: [0], matchedAccessoryIds: ['one', 'two'] });
  });

  it.each([
    { accessories: [] },
    { accessories: [piece('one')] },
    { accessories: [piece('one'), piece('two', 'a', 'other-cushion')] },
    { accessories: [piece('one'), piece('one')] },
    { accessories: [piece('one'), piece('two', 'another-sofa')] },
    { cellIds: undefined },
  ] satisfies Partial<PickComboArgs>[])('requires every physical piece on this sofa (%j)', (overrides) => {
    expect(pickComboMatch(args(overrides), [combo()])).toBeNull();
  });

  it('does not borrow pieces from an extra module outside the matched subset', () => {
    expect(pickComboMatch(args({
      modules: ['2NA', '1NA'], cellIds: ['a', 'extra'],
      accessories: [piece('one', 'extra'), piece('two', 'extra')],
    }), [combo()])).toBeNull();
  });

  it('finds a valid alternative subset when repeated modules carry different pieces', () => {
    expect(pickComboMatch(args({
      modules: ['2NA', '2NA'], cellIds: ['empty', 'a'],
    }), [combo()])).toMatchObject({ matchedIndices: [1], matchedAccessoryIds: ['one', 'two'] });
  });

  it('preserves OR-slot matching when the required pieces are on an alternative subset', () => {
    expect(pickComboMatch(args({
      modules: ['2NA', '3NA', '2A(LHF)'], cellIds: ['empty', 'a', 'b'],
    }), [combo({ modules: [['2NA', '3NA'], ['3NA', '2A(LHF)']] })]))
      .toMatchObject({ matchedAccessoryIds: ['one', 'two'] });
  });

  it('keeps bare and inclusive packages distinct and prefers the inclusive package when complete', () => {
    const bare = combo({ id: 'bare', accessories: undefined, effectiveFrom: '2026-10-29', pricesByHeight: { '24': 70_000 } });
    for (const rows of [[bare, combo()], [combo(), bare]]) {
      expect(pickComboMatch(args(), rows)?.row.id).toBe('inclusive');
      expect(pickComboMatch(args({ accessories: [piece('one')] }), rows)?.row.id).toBe('bare');
      expect(pickComboMatch(args({ accessories: undefined, cellIds: undefined }), rows))
        .toMatchObject({ row: { id: 'bare' }, matchedAccessoryIds: [] });
    }
  });

  it('prefers the complete four-piece package over a newer two-piece package', () => {
    const two = combo({ id: 'two', effectiveFrom: '2026-10-29' });
    const four = combo({ id: 'four', accessories: [{ modelId: 'cushion', qty: 4 }] });
    for (const rows of [[two, four], [four, two]]) {
      expect(pickComboMatch(args({ accessories: [piece('one'), piece('two'), piece('three'), piece('four')] }), rows))
        .toMatchObject({ row: { id: 'four' }, matchedAccessoryIds: ['one', 'two', 'three', 'four'] });
      expect(pickComboMatch(args(), rows)?.row.id).toBe('two');
    }
  });

  it('still gives customer scope priority over a company inclusive package', () => {
    const customer = combo({ id: 'customer', customerId: 'customer-id', accessories: [] });
    expect(pickComboMatch(args({ customerId: 'customer-id' }), [combo(), customer])?.row.id).toBe('customer');
  });

  it('normalizes accessory identity by Model and quantity', () => {
    expect(normalizeComboAccessories([{ modelId: ' back ', qty: 1 }, { modelId: 'arm', qty: 1 }, { modelId: 'back', qty: 1 }]))
      .toEqual([{ modelId: 'arm', qty: 1 }, { modelId: 'back', qty: 2 }]);
    expect(comboAccessoriesKey(undefined)).toBe(comboAccessoriesKey([]));
    expect(findDuplicateCombo('8210', [['2NA']], [combo()])).toBeNull();
    expect(findDuplicateCombo('8210', [['2NA']], [combo()], [{ modelId: 'cushion', qty: 1 }])).toBeNull();
    expect(findDuplicateCombo('8210', [['2NA']], [combo()], [
      { modelId: 'cushion', qty: 1 }, { modelId: 'cushion', qty: 1 },
    ])?.id).toBe('inclusive');
  });

  it.each([0, -1, 0.5, NaN, Infinity])('fails closed for malformed required quantity %s', (qty) => {
    const accessories = [{ modelId: 'cushion', qty }];
    expect(normalizeComboAccessories(accessories)).toBeNull();
    expect(pickComboMatch(args(), [combo({ accessories })])).toBeNull();
  });
});

describe('inclusive combo price on a sofa group', () => {
  const cells: Cell[] = [
    { id: 'a', moduleId: '2NA', x: 0, y: 0, rot: 0 },
    { id: 'b', moduleId: '1NA', x: 142, y: 0, rot: 0 },
  ];
  const pricing = (overrides: Partial<SofaProductPricing> = {}): SofaProductPricing => ({
    compartments: [
      { compartmentId: '2NA', active: true, priceSen: 75_000 },
      { compartmentId: '1NA', active: true, priceSen: 20_000 },
    ], bundles: [], reclinerUpgradeSen: 0, combos: [combo()],
    baseModel: '8210', fabricTier: 'PRICE_1', accessories: [piece('one'), piece('two'), piece('extra')],
    ...overrides,
  });

  it('charges the inclusive amount once, retaining extra modules and sen precision', () => {
    const result = computeSofaPrice(cells, '24', pricing());
    expect(result.total).toBe(132_575);
    expect(result.groups[0]).toMatchObject({
      basis: 'combo', comboId: 'inclusive', comboPrice: 112_575,
      comboSubsetALaCarte: 125_100, comboExtrasALaCarte: 20_000,
      comboMatchedCellIds: ['a'], comboMatchedAccessoryIds: ['one', 'two'],
    });
    // Only the third cushion remains a separately charged accessory line.
    const included = new Set(result.groups.flatMap((g) => g.comboMatchedAccessoryIds ?? []));
    const total = result.total + pricing().accessories!
      .filter((p) => !included.has(p.id)).reduce((sum, p) => sum + p.priceSen, 0);
    expect(total).toBe(157_625);
  });

  it('keeps backend, frontend and the total-only selling wrapper on the same result', () => {
    const prices = { '2NA': 75_000, '1NA': 20_000 };
    const pieces = pricing().accessories!;
    const result = computeSofaSellingResult(cells, '24', prices, [combo()], pieces);
    expect(result.total).toBe(132_575);
    expect(result.groups[0]?.comboMatchedAccessoryIds).toEqual(['one', 'two']);
    expect(computeSofaSellingSen(cells, '24', prices, [combo()], pieces)).toBe(result.total);
    expect(frontendSellingResult(cells, '24', prices, [combo()], pieces)).toEqual(result);
  });

  it('does not reuse one sofa’s pieces for another disconnected sofa', () => {
    const result = computeSofaPrice([
      cells[0]!, { ...cells[0]!, id: 'another', x: 500 },
    ], '24', pricing());
    expect(result.groups.map((g) => [g.basis, g.finalPrice, g.comboMatchedAccessoryIds]))
      .toEqual([['combo', 112_575, ['one', 'two']], ['a_la_carte', 75_000, []]]);
  });

  it('does not include pieces when a zero combo price is not applied', () => {
    const result = computeSofaPrice(cells, '24', pricing({ combos: [combo({ pricesByHeight: { '24': 0 } })] }));
    expect(result.total).toBe(95_000);
    expect(result.groups[0]?.comboMatchedAccessoryIds).toEqual([]);
  });
});
