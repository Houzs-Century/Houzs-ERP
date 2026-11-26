
import { describe, it, expect } from 'vitest';
import { findOverDeliveredSoItems, findOverDeliveredUnlinkedItems } from './do-over-delivery';

describe('findOverDeliveredSoItems (linked lines, keyed by so_item_id)', () => {
  it('flags a linked line shipping past its remaining', () => {
    const linked = new Map([['so-item-1', 3]]);
    const remaining = new Map([['so-item-1', 2]]);
    expect(findOverDeliveredSoItems(linked, remaining)).toEqual(['so-item-1']);
  });

  it('allows a linked line within its remaining (partial delivery)', () => {
    const linked = new Map([['so-item-1', 2]]);
    const remaining = new Map([['so-item-1', 5]]);
    expect(findOverDeliveredSoItems(linked, remaining)).toEqual([]);
  });

  it('treats a missing id as 0 open — any qty over-delivers', () => {
    const linked = new Map([['so-item-1', 1]]);
    expect(findOverDeliveredSoItems(linked, new Map())).toEqual(['so-item-1']);
  });
});

describe('findOverDeliveredUnlinkedItems (unlinked lines, keyed by item_code)', () => {
  it('catches an unlinked duplicate against a fully-delivered SO line', () => {
    const unlinked = new Map([['NTYR-PILLOW', 2]]);
    const open = new Map([['NTYR-PILLOW', 0]]);
    expect(findOverDeliveredUnlinkedItems(unlinked, open)).toEqual(['NTYR-PILLOW']);
  });

  it('allows an unlinked line within the SO line\'s open qty (partial)', () => {
    const unlinked = new Map([['NTYR-PILLOW', 4]]);
    const open = new Map([['NTYR-PILLOW', 10]]);
    expect(findOverDeliveredUnlinkedItems(unlinked, open)).toEqual([]);
  });

  it('allows an unlinked line taking exactly the remaining open qty (multi-DO)', () => {
    const unlinked = new Map([['NTYR-PILLOW', 4]]);
    const open = new Map([['NTYR-PILLOW', 4]]);
    expect(findOverDeliveredUnlinkedItems(unlinked, open)).toEqual([]);
    expect(findOverDeliveredUnlinkedItems(new Map([['NTYR-PILLOW', 1]]), new Map([['NTYR-PILLOW', 0]])))
      .toEqual(['NTYR-PILLOW']);
  });

  it('allows a genuinely ad-hoc line the SO never ordered (absent code)', () => {
    const unlinked = new Map([['SPARE-LEG', 1]]);
    const open = new Map([['NTYR-PILLOW', 0]]);
    expect(findOverDeliveredUnlinkedItems(unlinked, open)).toEqual([]);
  });

  it('matches item codes case- and whitespace-insensitively on both sides', () => {
    const unlinked = new Map([['  ntyr-pillow ', 1]]);
    const open = new Map([['NTYR-PILLOW', 0]]);
    expect(findOverDeliveredUnlinkedItems(unlinked, open)).toEqual(['  ntyr-pillow ']);
  });

  it('reports every offending code, and only those', () => {
    const unlinked = new Map([
      ['NTYR-PILLOW', 2],
      ['MATTRESS-Q', 1],
      ['SPARE-LEG', 4],
      ['DIVAN-Q', 1],
    ]);
    const open = new Map([
      ['NTYR-PILLOW', 0],
      ['MATTRESS-Q', 3],
      ['DIVAN-Q', 0],
    ]);
    expect(findOverDeliveredUnlinkedItems(unlinked, open).sort()).toEqual(['DIVAN-Q', 'NTYR-PILLOW']);
  });

  it('ignores a line with no item code rather than blocking on it', () => {
    expect(findOverDeliveredUnlinkedItems(new Map([['', 2]]), new Map([['NTYR-PILLOW', 0]]))).toEqual([]);
  });

  it('the whole DO-2607-005 shape is caught, every line of it', () => {
    const codes = ['NTYR-PILLOW', 'MATTRESS-Q', 'BEDFRAME-K', 'DIVAN-Q', 'HEADBOARD', 'LEG-SET'];
    const unlinked = new Map(codes.map((c) => [c, 2] as const));
    const open = new Map(codes.map((c) => [c, 0] as const));
    expect(findOverDeliveredUnlinkedItems(unlinked, open)).toHaveLength(6);
  });
});
