import { describe, expect, it } from 'vitest';
import { shortRackLabel, shortRackLabels } from './rack-label';
import { formatRacksCompact } from './packing-list-model';

describe('a rack is shown without the word "Rack" (owner 2026-11-10, 2990-DO-2611-018 printed "Rack / R12. / 1")', () => {
  it('drops the word, keeps the code', () => {
    expect(shortRackLabel('Rack R12.1')).toBe('R12.1');
    expect(shortRackLabel('RACK 3')).toBe('3');
    expect(shortRackLabel('L8.2')).toBe('L8.2');
    expect(shortRackLabel('Rack')).toBe('Rack');
    expect(shortRackLabels(['Rack L8.2', 'Rack R12.1'])).toEqual(['L8.2', 'R12.1']);
    expect(shortRackLabels(null)).toEqual([]);
  });
  it('the packing list prints the codes only', () => {
    expect(formatRacksCompact(['Rack 4', 'Rack 3', 'Rack 3', null])).toBe('3, 4');
    expect(formatRacksCompact([])).toBe('');
  });
});
