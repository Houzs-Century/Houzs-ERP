import { describe, expect, it } from 'vitest';
import { seatHeightLabel } from './SupplierDetail';

// Seat-height pool values are free text; the sofa pricing grid showed `25""`
// for a value typed with its own inch mark.
describe('seatHeightLabel', () => {
  it('adds the inch mark to a bare number', () => {
    expect(seatHeightLabel('24')).toBe('24"');
  });
  it('never doubles an inch mark already typed', () => {
    expect(seatHeightLabel('25"')).toBe('25"');
  });
  it('shows a word as typed', () => {
    expect(seatHeightLabel('DEFAULT')).toBe('DEFAULT');
  });
});
