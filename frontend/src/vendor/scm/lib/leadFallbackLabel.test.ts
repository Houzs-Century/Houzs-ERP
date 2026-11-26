import { describe, expect, test } from 'vitest';
import { leadFallbackLabel } from './mrp-queries';

const from = (m: Record<string, number>) => (c: string) => m[c];
const label = (c: string) => c[0]!.toUpperCase() + c.slice(1);

describe('leadFallbackLabel', () => {
  test('a warehouse box falls back to the global number for the same category', () => {
    expect(leadFallbackLabel('sofa', [from({}), from({ sofa: 7, others: 10 })], label, 'Global default')).toBe('Global default: 7 days');
  });
  test('no number for the category: Others, the warehouse one before the global one', () => {
    expect(leadFallbackLabel('carpet', [from({ others: 21 }), from({ others: 10 })], label, 'Global default')).toBe('Others: 21 days');
    expect(leadFallbackLabel('carpet', [from({}), from({ others: 10 })], label, 'Global default')).toBe('Others: 10 days');
  });
  test('a Sofa Accessory tries Sofa before Others; Others itself and nothing set read 0', () => {
    expect(leadFallbackLabel('fabric_accessory', [from({ sofa: 5, others: 10 })], label, 'x')).toBe('Sofa: 5 days');
    expect(leadFallbackLabel('others', [from({ others: 10 })], label, 'x')).toBe('0 days');
    expect(leadFallbackLabel('dining', [from({})], label, 'x')).toBe('0 days');
  });
});
