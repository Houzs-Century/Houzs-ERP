// The over-delivery invariant at the DRAFT->shipped confirm chokepoint. The
// second describe() is the blind spot that let 2990-DO-2607-005 ship the same
// six items 2990-DO-2607-017 shipped — its lines carried no so_item_id, so the
// linked check below could not see them.

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
  // (1) The DO-005 shape: an UNLINKED line for an item the named SO ordered and
  // has NO open qty left for — was silently allowed, is now caught.
  it('catches an unlinked duplicate against a fully-delivered SO line', () => {
    const unlinked = new Map([['NTYR-PILLOW', 2]]);
    const open = new Map([['NTYR-PILLOW', 0]]); // ordered, fully delivered already
    expect(findOverDeliveredUnlinkedItems(unlinked, open)).toEqual(['NTYR-PILLOW']);
  });

  // (2a) A legitimate partial: the SO still has open qty, so an unlinked line
  // within it must still ship.
  it('allows an unlinked line within the SO line\'s open qty (partial)', () => {
    const unlinked = new Map([['NTYR-PILLOW', 4]]);
    const open = new Map([['NTYR-PILLOW', 10]]);
    expect(findOverDeliveredUnlinkedItems(unlinked, open)).toEqual([]);
  });

  // (2b) A legitimate multi-DO split: the second DO takes exactly the rest.
  it('allows an unlinked line taking exactly the remaining open qty (multi-DO)', () => {
    const unlinked = new Map([['NTYR-PILLOW', 4]]);
    const open = new Map([['NTYR-PILLOW', 4]]); // 6 of 10 already gone on a prior DO
    expect(findOverDeliveredUnlinkedItems(unlinked, open)).toEqual([]);
    // ...but one more unit on a THIRD DO, with nothing left open, is the dup.
    expect(findOverDeliveredUnlinkedItems(new Map([['NTYR-PILLOW', 1]]), new Map([['NTYR-PILLOW', 0]])))
      .toEqual(['NTYR-PILLOW']);
  });

  it('allows a genuinely ad-hoc line the SO never ordered (absent code)', () => {
    // The replacement part / sample case — not on the order, not a bypass.
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
      ['NTYR-PILLOW', 2], // ordered, 0 open  -> offender
      ['MATTRESS-Q', 1],  // ordered, 3 open  -> fine
      ['SPARE-LEG', 4],   // not ordered      -> fine
      ['DIVAN-Q', 1],     // ordered, 0 open  -> offender
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
    // Six items, all on 2990-SO-2606-019, all already fully delivered by -017.
    const codes = ['NTYR-PILLOW', 'MATTRESS-Q', 'BEDFRAME-K', 'DIVAN-Q', 'HEADBOARD', 'LEG-SET'];
    const unlinked = new Map(codes.map((c) => [c, 2] as const));
    const open = new Map(codes.map((c) => [c, 0] as const));
    expect(findOverDeliveredUnlinkedItems(unlinked, open)).toHaveLength(6);
  });
});
