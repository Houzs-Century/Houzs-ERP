import { describe, it, expect } from 'vitest';
import { planStockRelease, planAllocationCreate, specSignature, specMatches, type AllocationRow } from './po-allocations';

const alloc = (seq: number, qty: number, so: string | null): AllocationRow =>
  ({ id: `a-${seq}`, seq, qty, so_item_id: so });

describe('planStockRelease', () => {
  it('releases the whole line when nothing is sliced', () => {
    expect(planStockRelease(2, [])).toEqual({ seq: 1, qty: 2 });
  });

  it('releases only the un-allocated remainder', () => {
    expect(planStockRelease(5, [alloc(1, 2, 'so-1')])).toEqual({ seq: 2, qty: 3 });
  });

  it('returns null when the line is fully allocated — deliberate splits are not touched', () => {
    expect(planStockRelease(2, [alloc(1, 1, 'so-1'), alloc(2, 1, null)])).toBeNull();
  });

  it('never releases a negative remainder', () => {
    expect(planStockRelease(1, [alloc(1, 2, 'so-1')])).toBeNull();
  });

  it('produces a slice the create-planner itself would accept', () => {
    const existing = [alloc(1, 1, 'so-1')];
    const plan = planStockRelease(3, existing);
    expect(plan).not.toBeNull();
    const create = planAllocationCreate(3, existing, plan!.qty);
    expect('refusal' in create && create.refusal ? create.refusal : null).toBeNull();
  });
});

describe('specMatches — the allocation candidate/gate spec filter (owner 2026-08-08)', () => {
  const sofaA = { seatHeight: '24', legHeight: '6"', fabricCode: 'EZ-012', colourLabel: 'Dark Grey' };
  const sofaB = { seatHeight: '28', legHeight: '6"', fabricCode: 'EZ-012', colourLabel: 'Dark Grey' };
  const otherFabric = { seatHeight: '24', legHeight: '6"', fabricCode: 'AB-999', colourLabel: 'Dark Grey' };

  it('same fabric + same spec matches', () => {
    expect(specMatches({ itemGroup: 'sofa', variants: sofaA }, { itemGroup: 'sofa', variants: { ...sofaA } })).toBe(true);
  });

  it('a different SEAT height does NOT match — the spec must be the same product', () => {
    expect(specMatches({ itemGroup: 'sofa', variants: sofaA }, { itemGroup: 'sofa', variants: sofaB })).toBe(false);
  });

  it('a different fabric does NOT match', () => {
    expect(specMatches({ itemGroup: 'sofa', variants: sofaA }, { itemGroup: 'sofa', variants: otherFabric })).toBe(false);
  });

  it('dye-lot is EXCLUDED: the supplier-fabric-code parens is fabric identity, but no dye-lot field enters the signature', () => {
    // buildVariantSummary carries no dye-lot key, so two lines identical but for
    // a (notional) dye-lot still match — owner ruling: fabric+spec, not dye-lot.
    const withExtraUnknownKey = { ...sofaA, dyeLot: 'M2402-19' };
    expect(specMatches({ itemGroup: 'sofa', variants: sofaA }, { itemGroup: 'sofa', variants: withExtraUnknownKey })).toBe(true);
  });

  it('two plain no-variant lines of the same code still match (empty signature)', () => {
    expect(specSignature('sofa', null)).toBe('');
    expect(specMatches({ itemGroup: 'sofa', variants: null }, { itemGroup: 'sofa', variants: {} })).toBe(true);
  });

  it('signature is whitespace/case normalised', () => {
    expect(specSignature('sofa', sofaA)).toBe(specSignature('sofa', { ...sofaA }));
  });
});

