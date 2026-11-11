import { describe, expect, it } from 'vitest';
import { transportFeeEditProblem, transportFeeProblem, transportFeeRegion, type TransportFeeLine } from './so-transport-fee';

/* Owner 2026-11-11: a Houzs order to Sabah, Sarawak, Labuan, Kelantan, Terengganu,
   Perlis or Singapore cannot be confirmed without a transport fee above RM 0. */
const goods = { itemCode: 'Y103-(Q)', description: 'Bedframe', itemGroup: 'bedframe', amountSen: 150000 };
const fee = (amountSen: number | null) => ({ itemCode: 'TRANSPORTATION CHARGES', description: 'TRANSPORTATION CHARGES', itemGroup: 'service', amountSen });
const H = 'HOUZS';

describe('transportFeeRegion', () => {
  it.each(['Sabah', 'SARAWAK', 'Labuan', ' kelantan ', 'Terengganu', 'Trengganu', 'Perlis', 'Singapore'])('%s needs a fee', (s) => {
    expect(transportFeeRegion(s, 'Malaysia')).not.toBeNull();
  });
  it('Singapore is caught by country whatever the state says', () => {
    expect(transportFeeRegion('Central', 'Singapore')).toBe('Singapore');
  });
  it.each(['Selangor', 'Kuala Lumpur', 'Johor', 'Pahang', 'Penang', '', null])('%s does not', (s) => {
    expect(transportFeeRegion(s, 'Malaysia')).toBeNull();
  });
});

describe('transportFeeProblem', () => {
  it('Sabah with no transport line is refused', () => {
    expect(transportFeeProblem(H, 'Sabah', 'Malaysia', [goods])?.code).toBe('transport_fee_required');
  });
  it('Sabah with a transport line at RM 0 (after discount) is refused', () => {
    const p = transportFeeProblem(H, 'Sabah', 'Malaysia', [goods, fee(0)]);
    expect(p?.code).toBe('transport_fee_required');
    expect(p?.message).toContain('above RM 0');
  });
  it('Sabah with a priced transport line passes', () => {
    expect(transportFeeProblem(H, 'Sabah', 'Malaysia', [goods, fee(30000)])).toBeNull();
  });
  it('an SVC-DELIVERY fee or a SHIPPING line counts', () => {
    expect(transportFeeProblem(H, 'Kelantan', 'Malaysia', [goods, { itemCode: 'SVC-DELIVERY', description: null, itemGroup: 'service', amountSen: 5000 }])).toBeNull();
    expect(transportFeeProblem(H, 'Kelantan', 'Malaysia', [goods, { itemCode: 'SHIPPING COST', description: null, itemGroup: 'service', amountSen: 5000 }])).toBeNull();
  });
  it('a goods line whose name says transport does not count', () => {
    expect(transportFeeProblem(H, 'Sarawak', 'Malaysia', [{ ...goods, description: 'Transport Sofa', itemGroup: 'sofa' }])).not.toBeNull();
  });
  it('Singapore by country is refused without a fee', () => {
    expect(transportFeeProblem(H, null, 'Singapore', [goods])?.message).toContain('Singapore');
  });
  it('a line whose amount is not known is not judged on it', () => {
    expect(transportFeeProblem(H, 'Sabah', 'Malaysia', [goods, fee(null)])).toBeNull();
  });
  it('Selangor needs nothing', () => {
    expect(transportFeeProblem(H, 'Selangor', 'Malaysia', [goods])).toBeNull();
  });
  it('Houzs only: a 2990 (or unknown company) order to Sabah is not refused', () => {
    expect(transportFeeProblem('2990', 'Sabah', 'Malaysia', [goods])).toBeNull();
    expect(transportFeeProblem(null, 'Sabah', 'Malaysia', [goods])).toBeNull();
  });
});

describe('transportFeeEditProblem: only what the edit breaks', () => {
  const at = (state: string, lines: TransportFeeLine[] = [goods]) => ({ state, country: 'Malaysia', lines });
  it('moving Selangor -> Sabah without a fee is refused', () => {
    expect(transportFeeEditProblem(H, at('Selangor'), at('Sabah'))).not.toBeNull();
  });
  it('moving Selangor -> Sabah with a priced fee passes', () => {
    expect(transportFeeEditProblem(H, at('Selangor', [goods, fee(5000)]), at('Sabah', [goods, fee(5000)]))).toBeNull();
  });
  it('taking the fee off a Sabah order (deleted or RM 0) is refused', () => {
    expect(transportFeeEditProblem(H, at('Sabah', [goods, fee(5000)]), at('Sabah'))).not.toBeNull();
    expect(transportFeeEditProblem(H, at('Sabah', [goods, fee(5000)]), at('Sabah', [goods, fee(0)]))).not.toBeNull();
  });
  it('an older Sabah order that never had a fee still saves other changes', () => {
    expect(transportFeeEditProblem(H, at('Sabah'), at('Sabah'))).toBeNull();
  });
  it('moving Sabah -> Sarawak still needs the fee', () => {
    expect(transportFeeEditProblem(H, at('Sabah'), at('Sarawak'))).not.toBeNull();
  });
  it('moving out of the fee places never needs one', () => {
    expect(transportFeeEditProblem(H, at('Sabah', [goods, fee(5000)]), at('Selangor'))).toBeNull();
  });
  it('2990 edits are never judged', () => {
    expect(transportFeeEditProblem('2990', at('Selangor'), at('Sabah'))).toBeNull();
  });
});
