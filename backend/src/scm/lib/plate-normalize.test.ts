import { describe, it, expect } from 'vitest';
import { normalizePlate, findDuplicateGroups, findRenames, pickSurvivor, type PlateRow } from './plate-normalize';

const row = (o: Partial<PlateRow> & { id: string; plate: string }): PlateRow => ({ refs: 0, active: true, createdAt: null, ...o });

describe('normalizePlate', () => {
  it('collapses the real production case', () => {
    // Owner, 2026-08-01: AKF 8100 and AKF8100 were two rows for one lorry.
    expect(normalizePlate('AKF 8100')).toBe('AKF8100');
    expect(normalizePlate('AKF8100')).toBe('AKF8100');
  });

  it('uppercases and strips hyphens, dots and inner spaces', () => {
    expect(normalizePlate('akf-8100')).toBe('AKF8100');
    expect(normalizePlate(' w 1591  t ')).toBe('W1591T');
    expect(normalizePlate('B.M.W 123')).toBe('BMW123');
  });

  it('returns empty for null, undefined and punctuation-only input', () => {
    expect(normalizePlate(null)).toBe('');
    expect(normalizePlate(undefined)).toBe('');
    expect(normalizePlate('   ')).toBe('');
    expect(normalizePlate('---')).toBe('');
  });
});

describe('findDuplicateGroups', () => {
  it('groups rows that collide only after normalisation', () => {
    const groups = findDuplicateGroups([
      row({ id: 'a', plate: 'AKF 8100', refs: 12 }),
      row({ id: 'b', plate: 'AKF8100', refs: 3 }),
      row({ id: 'c', plate: 'BLH 5106' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].canonical).toBe('AKF8100');
    expect(groups[0].survivor.id).toBe('a');
    expect(groups[0].losers.map((l) => l.id)).toEqual(['b']);
  });

  it('reports nothing when every plate is already canonical and unique', () => {
    expect(findDuplicateGroups([row({ id: 'a', plate: 'AKF8100' }), row({ id: 'b', plate: 'BLH5106' })])).toEqual([]);
  });

  it('never groups punctuation-only plates together under the empty canonical', () => {
    const groups = findDuplicateGroups([row({ id: 'a', plate: '---' }), row({ id: 'b', plate: '   ' })]);
    expect(groups).toEqual([]);
  });

  it('handles a three-way collision', () => {
    const groups = findDuplicateGroups([
      row({ id: 'a', plate: 'w 1591 t', refs: 1 }),
      row({ id: 'b', plate: 'W1591T', refs: 9 }),
      row({ id: 'c', plate: 'W-1591-T', refs: 4 }),
    ]);
    expect(groups[0].survivor.id).toBe('b');
    expect(groups[0].losers.map((l) => l.id).sort()).toEqual(['a', 'c']);
  });
});

describe('pickSurvivor — the fewest foreign keys to re-point wins', () => {
  it('most-referenced wins', () => {
    expect(pickSurvivor([row({ id: 'a', plate: 'X', refs: 2 }), row({ id: 'b', plate: 'X', refs: 40 })]).id).toBe('b');
  });

  it('on equal refs, active beats inactive', () => {
    expect(pickSurvivor([
      row({ id: 'a', plate: 'X', refs: 5, active: false }),
      row({ id: 'b', plate: 'X', refs: 5, active: true }),
    ]).id).toBe('b');
  });

  it('on equal refs and status, the OLDEST row wins', () => {
    expect(pickSurvivor([
      row({ id: 'a', plate: 'X', refs: 5, createdAt: '2026-07-01' }),
      row({ id: 'b', plate: 'X', refs: 5, createdAt: '2025-01-01' }),
    ]).id).toBe('b');
  });

  it('is deterministic when everything ties, so a dry run predicts the apply', () => {
    const rows = [row({ id: 'b', plate: 'X' }), row({ id: 'a', plate: 'X' })];
    expect(pickSurvivor(rows).id).toBe('a');
    expect(pickSurvivor([...rows].reverse()).id).toBe('a');
  });
});

describe('findRenames — a rename is NOT a merge', () => {
  it('reports a row whose canonical form nothing else claims', () => {
    expect(findRenames([row({ id: 'a', plate: 'BLH 5106' })]))
      .toEqual([{ id: 'a', from: 'BLH 5106', to: 'BLH5106' }]);
  });

  it('excludes rows that are part of a duplicate group', () => {
    // Renaming 'AKF 8100' to 'AKF8100' here would violate the UNIQUE index.
    expect(findRenames([
      row({ id: 'a', plate: 'AKF 8100' }),
      row({ id: 'b', plate: 'AKF8100' }),
    ])).toEqual([]);
  });

  it('ignores rows already canonical', () => {
    expect(findRenames([row({ id: 'a', plate: 'AKF8100' })])).toEqual([]);
  });

  it('ignores punctuation-only plates rather than renaming them to empty', () => {
    expect(findRenames([row({ id: 'a', plate: '---' })])).toEqual([]);
  });
});
