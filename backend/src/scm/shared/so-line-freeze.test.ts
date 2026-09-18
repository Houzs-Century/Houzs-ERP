/* The owner's 2026-09-15 per-line freeze, with no database in it. */
import { describe, expect, test } from 'vitest';
import {
  soDownstreamHardLocked,
  soItemFrozen,
  soLineFreezeFrom,
  soLineFrozen,
  soOrderFullyFrozen,
  type SoFreezeDownstreamLine,
} from './so-line-freeze';

const doLine = (so_item_id: string | null, status: string | null): SoFreezeDownstreamLine => ({ kind: 'DO', so_item_id, status });
const siLine = (so_item_id: string | null, status: string | null, do_item_id: string | null = null): SoFreezeDownstreamLine => ({ kind: 'SI', so_item_id, do_item_id, status });

describe('rule 1 — a line a live delivery order or invoice names is frozen', () => {
  test('a line on a DRAFT delivery order is frozen', () => {
    const f = soLineFreezeFrom([doLine('a', 'DRAFT')], 1);
    expect(soLineFrozen(f, 'a')).toBe(true);
    expect(soLineFrozen(f, 'b')).toBe(false);
  });

  test('a line on a sales invoice is frozen', () => {
    expect(soLineFrozen(soLineFreezeFrom([siLine('a', 'SENT')], 1), 'a')).toBe(true);
  });

  test('a CANCELLED document frees its line, whatever the case of the status', () => {
    const f = soLineFreezeFrom([doLine('a', 'CANCELLED'), siLine('a', ' cancelled ')], 0);
    expect(soLineFrozen(f, 'a')).toBe(false);
    expect(f.hasLiveDownstream).toBe(false);
  });

  test('a document whose status could not be found is treated as live', () => {
    expect(soLineFrozen(soLineFreezeFrom([doLine('a', null)], 0), 'a')).toBe(true);
  });
});

describe('rule 2 — partly delivered is wholly frozen', () => {
  test('the freeze does not look at quantity: one unit delivered freezes the line', () => {
    const f = soLineFreezeFrom([doLine('bedframe-x3', 'LOADED')], 1);
    expect(soLineFrozen(f, 'bedframe-x3')).toBe(true);
    expect(soOrderFullyFrozen(f, ['bedframe-x3', 'mattress'])).toBe(false);
  });
});

describe('rule 3 — a live downstream line naming no SO line freezes every line', () => {
  test('a delivery-order line with no so_item_id', () => {
    const f = soLineFreezeFrom([doLine(null, 'DELIVERED')], 1);
    expect(f.unlinked).toBe(true);
    expect(soLineFrozen(f, 'anything')).toBe(true);
    expect(soOrderFullyFrozen(f, ['a', 'b'])).toBe(true);
  });

  test('an invoice line that billed a delivery-order line is NOT unlinked — the DO line places it', () => {
    expect(soLineFreezeFrom([siLine(null, 'SENT', 'doi-1')], 1).unlinked).toBe(false);
  });

  test('an invoice line naming neither is unlinked', () => {
    expect(soLineFreezeFrom([siLine(null, 'SENT', null)], 1).unlinked).toBe(true);
  });

  test('an unlinked line on a CANCELLED document changes nothing', () => {
    expect(soLineFreezeFrom([doLine(null, 'CANCELLED')], 0).unlinked).toBe(false);
  });
});

describe('rule 4 — the order stays open while something is left to convert', () => {
  test('an order with no downstream document is never fully frozen', () => {
    expect(soOrderFullyFrozen(soLineFreezeFrom([], 0), [])).toBe(false);
    expect(soOrderFullyFrozen(soLineFreezeFrom([], 0), ['a'])).toBe(false);
  });

  test('every live line frozen = fully frozen', () => {
    const f = soLineFreezeFrom([doLine('a', 'LOADED'), siLine('b', 'PAID')], 2);
    expect(soOrderFullyFrozen(f, ['a', 'b'])).toBe(true);
  });

  test('a live document with no lines yet, on an order with no lines, is fully frozen', () => {
    expect(soOrderFullyFrozen(soLineFreezeFrom([], 1), [])).toBe(true);
  });

  test('a live document with no lines yet leaves an order with lines open', () => {
    expect(soOrderFullyFrozen(soLineFreezeFrom([], 1), ['a'])).toBe(false);
  });
});

describe('what the screens read', () => {
  test('soItemFrozen reads the server flag strictly', () => {
    expect(soItemFrozen({ downstream_frozen: true })).toBe(true);
    expect(soItemFrozen({ downstream_frozen: false })).toBe(false);
    expect(soItemFrozen({ downstream_frozen: 'true' })).toBe(false);
    expect(soItemFrozen({})).toBe(false);
    expect(soItemFrozen(null)).toBe(false);
  });

  test('soDownstreamHardLocked prefers the per-line verdict', () => {
    expect(soDownstreamHardLocked({ has_children: true, downstream_fully_frozen: false })).toBe(false);
    expect(soDownstreamHardLocked({ has_children: true, downstream_fully_frozen: true })).toBe(true);
  });

  test('a payload without the new flag falls back to the STRICTER old lock', () => {
    expect(soDownstreamHardLocked({ has_children: true })).toBe(true);
    expect(soDownstreamHardLocked({ has_children: false })).toBe(false);
    expect(soDownstreamHardLocked(null)).toBe(false);
  });
});
