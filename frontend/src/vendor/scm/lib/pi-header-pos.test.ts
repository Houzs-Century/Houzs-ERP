import { describe, expect, it } from 'vitest';
import { piPoNumbers, piPoShortLabel } from './pi-header-pos';

describe('piPoNumbers — the POs a purchase invoice bills (owner 2026-11-10)', () => {
  it('lists every distinct PO the lines name, in PO-number order', () => {
    expect(piPoNumbers(['HC-PO-2610-202', 'HC-PO-2610-125', 'HC-PO-2610-202', null, ' '], 'HC-PO-2610-125'))
      .toEqual(['HC-PO-2610-125', 'HC-PO-2610-202']);
  });
  it('the lines win over the header FK, which holds only the first receipt\'s PO', () => {
    expect(piPoNumbers(['HC-PO-2610-202'], 'HC-PO-2610-125')).toEqual(['HC-PO-2610-202']);
  });
  it('no line names a PO: the header PO, else nothing', () => {
    expect(piPoNumbers([null, undefined], 'HC-PO-2610-125')).toEqual(['HC-PO-2610-125']);
    expect(piPoNumbers([], null)).toEqual([]);
  });
  it('orders numerically, not by character', () => {
    expect(piPoNumbers(['PO-10', 'PO-9'], null)).toEqual(['PO-9', 'PO-10']);
  });
});

describe('piPoShortLabel', () => {
  it('shows the first few and counts the rest', () => {
    expect(piPoShortLabel(['A', 'B', 'C', 'D', 'E'], 3)).toBe('A, B, C +2 more');
    expect(piPoShortLabel(['A', 'B'], 3)).toBe('A, B');
    expect(piPoShortLabel([], 3)).toBe('—');
  });
});
