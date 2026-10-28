// The labels a rack SEED run creates. Two contracts:
//   · the owner's real KL WAREHOUSE numbering (L1.1 … L21.2 / R1.1 … R17.2),
//   · and the FLAT shape every seed run made before 2026-09-09 — `levels: 1`
//     must still produce exactly "<prefix> 1".."<prefix> N", or an old run is
//     no longer reproducible from its own inputs.
import { describe, expect, it } from 'vitest';
import { buildSeedRackLabels, MAX_SEED_RACKS } from './rack-labels';

describe('buildSeedRackLabels', () => {
  it('keeps the historic flat shape when levels is 1', () => {
    expect(buildSeedRackLabels({ prefix: 'Rack', count: 3 }))
      .toEqual(['Rack 1', 'Rack 2', 'Rack 3']);
    // levels explicitly 1 is the same thing, not a second shape.
    expect(buildSeedRackLabels({ prefix: 'Rack', count: 3, levels: 1 }))
      .toEqual(['Rack 1', 'Rack 2', 'Rack 3']);
  });

  it('builds the aisle.level grid the owner asked for', () => {
    const left = buildSeedRackLabels({ prefix: 'Rack', series: 'L', count: 21, levels: 2 });
    expect(left).toHaveLength(42);
    expect(left[0]).toBe('Rack L1.1');
    expect(left[1]).toBe('Rack L1.2');
    expect(left[2]).toBe('Rack L2.1');
    expect(left[41]).toBe('Rack L21.2');

    const right = buildSeedRackLabels({ prefix: 'Rack', series: 'R', count: 17, levels: 2 });
    expect(right).toHaveLength(34);
    expect(right[0]).toBe('Rack R1.1');
    expect(right[33]).toBe('Rack R17.2');
  });

  it('orders level-within-aisle, never aisle-within-level', () => {
    expect(buildSeedRackLabels({ prefix: 'Rack', series: 'L', count: 2, levels: 3 }))
      .toEqual(['Rack L1.1', 'Rack L1.2', 'Rack L1.3', 'Rack L2.1', 'Rack L2.2', 'Rack L2.3']);
  });

  it('takes a series without levels, and levels without a series', () => {
    expect(buildSeedRackLabels({ prefix: 'Rack', series: 'A', count: 2 }))
      .toEqual(['Rack A1', 'Rack A2']);
    expect(buildSeedRackLabels({ prefix: 'Rack', count: 2, levels: 2 }))
      .toEqual(['Rack 1.1', 'Rack 1.2', 'Rack 2.1', 'Rack 2.2']);
  });

  it('drops the separating space when there is no prefix', () => {
    expect(buildSeedRackLabels({ prefix: '', series: 'L', count: 1, levels: 2 }))
      .toEqual(['L1.1', 'L1.2']);
    expect(buildSeedRackLabels({ series: 'L', count: 1, levels: 2 }))
      .toEqual(['L1.1', 'L1.2']);
  });

  it('trims what the operator typed', () => {
    expect(buildSeedRackLabels({ prefix: '  Rack  ', series: ' L ', count: 1, levels: 1 }))
      .toEqual(['Rack L1']);
  });

  it('caps at MAX_SEED_RACKS, counting LABELS and not aisles', () => {
    // 150 aisles x 2 levels = 300 labels; the cap is on what gets written.
    const capped = buildSeedRackLabels({ prefix: 'Rack', series: 'L', count: 150, levels: 2 });
    expect(capped).toHaveLength(MAX_SEED_RACKS);
    expect(capped[MAX_SEED_RACKS - 1]).toBe('Rack L100.2');
  });

  it('returns nothing for a count that is not a positive number', () => {
    for (const count of [0, -1, Number.NaN]) {
      expect(buildSeedRackLabels({ prefix: 'Rack', count })).toEqual([]);
    }
  });

  it('treats a junk levels value as 1 rather than producing no labels', () => {
    expect(buildSeedRackLabels({ prefix: 'Rack', count: 2, levels: 0 }))
      .toEqual(['Rack 1', 'Rack 2']);
    expect(buildSeedRackLabels({ prefix: 'Rack', count: 2, levels: Number.NaN }))
      .toEqual(['Rack 1', 'Rack 2']);
  });
});
