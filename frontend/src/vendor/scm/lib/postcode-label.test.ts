import { describe, expect, it } from 'vitest';
import { postcodeIndex, postcodeLabel, type LocalityRow } from './localities-queries';

const row = (postcode: string, city: string, state: string): LocalityRow => ({ postcode, city, state, stateCode: '', country: 'MY' });

// HC-0196: the board's Postcode column adds the area name from the localities table.
describe('postcodeLabel', () => {
  const idx = postcodeIndex([
    row('53000', 'Cyberjaya', 'Selangor'), row('47100', 'Puchong', 'Selangor'),
    row('11111', 'Alpha', 'Penang'), row('11111', 'Beta', 'Penang'), row('22222', 'Gamma', 'Kedah'), row('22222', 'Delta', 'Perak'),
  ]);
  it('adds the city when the postcode names one', () => {
    expect(postcodeLabel(idx, '53000', 'Selangor')).toBe('53000 Cyberjaya');
    expect(postcodeLabel(idx, '47100', null)).toBe('47100 Puchong');
  });
  it('uses the order state to pick between states, and refuses a guess within one', () => {
    expect(postcodeLabel(idx, '22222', 'Perak')).toBe('22222 Delta');
    expect(postcodeLabel(idx, '22222', null)).toBe('22222');
    expect(postcodeLabel(idx, '11111', 'Penang')).toBe('11111');
  });
  it('leaves an unknown or blank postcode as it is', () => {
    expect(postcodeLabel(idx, '99999', 'Selangor')).toBe('99999');
    expect(postcodeLabel(idx, null, null)).toBe('');
  });
});
