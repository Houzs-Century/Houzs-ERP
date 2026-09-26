import { describe, expect, it } from 'vitest';
import { crewComboOptions, crewComboValue, latestDoId, KEEP_CURRENT } from './dispatch-cell';

const drivers = [
  { id: 'd1', label: 'Ahmad' },
  { id: 'd2', label: 'Kumar' },
];

describe('crewComboOptions', () => {
  it('leads with a clearable blank, then the master rows', () => {
    const opts = crewComboOptions(drivers, null);
    expect(opts[0]).toEqual({ value: '', label: '— none —' });
    expect(opts.slice(1)).toEqual([
      { value: 'd1', label: 'Ahmad', group: undefined },
      { value: 'd2', label: 'Kumar', group: undefined },
    ]);
  });

  it('keeps an off-list current assignment selectable so it never blanks', () => {
    const opts = crewComboOptions(drivers, 'Gone Driver');
    expect(opts).toContainEqual({ value: KEEP_CURRENT, label: 'Gone Driver' });
    // ordered after the blank, before the master rows
    expect(opts.map((o) => o.value)).toEqual(['', KEEP_CURRENT, 'd1', 'd2']);
  });

  it('does NOT add a synthetic option when the current name is in the master', () => {
    const opts = crewComboOptions(drivers, 'Ahmad');
    expect(opts.map((o) => o.value)).toEqual(['', 'd1', 'd2']);
  });
});

describe('crewComboValue', () => {
  it('matches the current name to its master id', () => {
    expect(crewComboValue(drivers, 'Kumar')).toBe('d2');
  });
  it('falls back to KEEP_CURRENT for an off-list name', () => {
    expect(crewComboValue(drivers, 'Gone Driver')).toBe(KEEP_CURRENT);
  });
  it('is empty when nothing is assigned', () => {
    expect(crewComboValue(drivers, null)).toBe('');
    expect(crewComboValue(drivers, '   ')).toBe('');
  });
});

describe('latestDoId', () => {
  it('returns the last delivery order id (the one whose crew the board shows)', () => {
    expect(latestDoId([{ id: 'do1' }, { id: 'do2' }])).toBe('do2');
  });
  it('is null when the order has no delivery order yet', () => {
    expect(latestDoId([])).toBeNull();
  });
});
