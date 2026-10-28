import { describe, it, expect } from 'vitest';
import { deriveSetCount, type SetLine } from './set-count';

describe('deriveSetCount', () => {
  it('pairs frames and mattresses: N + N = N sets', () => {
    const lines: SetLine[] = [
      { category: 'BEDFRAME', qty: 2 },
      { category: 'MATTRESS', qty: 2 },
    ];
    const r = deriveSetCount(lines);
    expect(r.sets).toBe(2);
    expect(r.hasFurniture).toBe(true);
    expect(r).toMatchObject({ frames: 2, mattresses: 2, sofas: 0 });
  });

  it('unpaired items still occupy slots: max(frames, mattresses)', () => {
    expect(deriveSetCount([
      { category: 'BEDFRAME', qty: 3 },
      { category: 'MATTRESS', qty: 1 },
    ]).sets).toBe(3);
    expect(deriveSetCount([
      { category: 'MATTRESS', qty: 4 },
    ]).sets).toBe(4);
    expect(deriveSetCount([
      { category: 'BEDFRAME', qty: 1 },
    ]).sets).toBe(1);
  });

  it('adds sofas as their own slots', () => {
    const r = deriveSetCount([
      { category: 'BEDFRAME', qty: 2 },
      { category: 'MATTRESS', qty: 2 },
      { category: 'SOFA', qty: 1 },
    ]);
    expect(r.sets).toBe(3); // max(2,2) + 1
    expect(r.sofas).toBe(1);
  });

  it('ignores cancelled lines', () => {
    const r = deriveSetCount([
      { category: 'BEDFRAME', qty: 2, cancelled: true },
      { category: 'MATTRESS', qty: 1 },
    ]);
    expect(r.sets).toBe(1);
    expect(r.frames).toBe(0);
  });

  it('accessory / service only => no furniture, sets 0 (packer uses revenue)', () => {
    const r = deriveSetCount([
      { category: 'ACCESSORY', qty: 5 },
      { category: 'SERVICE', qty: 1 },
      { category: 'OTHERS', qty: 3 },
    ]);
    expect(r.sets).toBe(0);
    expect(r.hasFurniture).toBe(false);
  });

  it('treats missing / non-finite / non-positive qty as 0', () => {
    const r = deriveSetCount([
      { category: 'BEDFRAME', qty: null },
      { category: 'MATTRESS', qty: 'x' as unknown as number },
      { category: 'SOFA', qty: 0 },
      { category: 'SOFA', qty: -2 },
    ]);
    expect(r.sets).toBe(0);
    expect(r.hasFurniture).toBe(false);
  });

  it('rounds fractional quantities to whole units', () => {
    expect(deriveSetCount([{ category: 'BEDFRAME', qty: 1.4 }]).sets).toBe(1);
    expect(deriveSetCount([{ category: 'MATTRESS', qty: 2.6 }]).sets).toBe(3);
  });

  it('resolves category case-insensitively', () => {
    expect(deriveSetCount([{ category: 'bedframe', qty: 1 }, { category: 'mattress', qty: 1 }]).sets).toBe(1);
  });

  it('empty order => zero', () => {
    expect(deriveSetCount([])).toEqual({ sets: 0, hasFurniture: false, frames: 0, mattresses: 0, sofas: 0 });
  });
});
