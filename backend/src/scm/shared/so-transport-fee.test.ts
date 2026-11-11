import { describe, expect, it } from 'vitest';
import { transportFeeProblem, transportFeeRegion } from './so-transport-fee';

/* Owner 2026-11-11: an order to Sabah, Sarawak, Labuan, Kelantan, Terengganu, Perlis or
   Singapore cannot be confirmed without a transport fee above RM 0. */
const goods = { itemCode: 'Y103-(Q)', description: 'Bedframe', itemGroup: 'bedframe', amountSen: 150000 };
const fee = (amountSen: number | null) => ({ itemCode: 'TRANSPORTATION CHARGES', description: 'TRANSPORTATION CHARGES', itemGroup: 'service', amountSen });

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
    expect(transportFeeProblem('Sabah', 'Malaysia', [goods])?.code).toBe('transport_fee_required');
  });
  it('Sabah with a transport line at RM 0 is refused', () => {
    const p = transportFeeProblem('Sabah', 'Malaysia', [goods, fee(0)]);
    expect(p?.code).toBe('transport_fee_required');
    expect(p?.message).toContain('above RM 0');
  });
  it('a discount that brings the fee to RM 0 is refused (amount is after discount)', () => {
    expect(transportFeeProblem('Perlis', 'Malaysia', [goods, fee(0)])).not.toBeNull();
  });
  it('Sabah with a priced transport line passes', () => {
    expect(transportFeeProblem('Sabah', 'Malaysia', [goods, fee(30000)])).toBeNull();
  });
  it('an SVC-DELIVERY fee or a SHIPPING line counts', () => {
    expect(transportFeeProblem('Kelantan', 'Malaysia', [goods, { itemCode: 'SVC-DELIVERY', description: null, itemGroup: 'service', amountSen: 5000 }])).toBeNull();
    expect(transportFeeProblem('Kelantan', 'Malaysia', [goods, { itemCode: 'SHIPPING COST', description: null, itemGroup: 'service', amountSen: 5000 }])).toBeNull();
  });
  it('a goods line whose name says transport does not count', () => {
    expect(transportFeeProblem('Sarawak', 'Malaysia', [{ ...goods, description: 'Transport Sofa', itemGroup: 'sofa' }])).not.toBeNull();
  });
  it('Singapore by country is refused without a fee', () => {
    expect(transportFeeProblem(null, 'Singapore', [goods])?.message).toContain('Singapore');
  });
  it('a line whose amount is not known is not judged on it', () => {
    expect(transportFeeProblem('Sabah', 'Malaysia', [goods, fee(null)])).toBeNull();
  });
  it('Selangor needs nothing', () => {
    expect(transportFeeProblem('Selangor', 'Malaysia', [goods])).toBeNull();
  });
});
