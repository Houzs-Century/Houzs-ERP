// The pure half of repair-do-resync-return-lots.mjs, on the two production rows
// that started it (CODY-(K), KL WAREHOUSE, 2026-11-10): the return lots minted
// by the 02:45 edit of 2990-DO-2611-018 and the 02:48 edit of 2990-DO-2611-016.
import { describe, expect, test } from 'vitest';
import { FALLBACK_NOTES, skipReason, planActual } from '../scripts/lib/do-return-lot-repair.mjs';

const fallbackIn = (extra = {}) => ({
  notes: FALLBACK_NOTES, lot_id: 'lot-4fd7', qty_received: 1, qty_remaining: 1, lot_used: 0, ...extra,
});

describe('skipReason', () => {
  test('an untouched lot minted by the fallback IN is repaired, stamped line or not', () => {
    expect(skipReason(fallbackIn())).toBeNull();
  });

  test('an IN the return function wrote (its notes carry more) is not a fallback', () => {
    expect(skipReason(fallbackIn({ notes: `${FALLBACK_NOTES} Original lots restored at original cost.` }))).toMatch(/not a fallback/);
  });

  test('a lot already closed (the DO was cancelled, or this ran before) is left', () => {
    expect(skipReason(fallbackIn({ qty_remaining: 0 }))).toMatch(/already closed/);
  });

  test('a lot another document drew on is left for the trace to follow', () => {
    expect(skipReason(fallbackIn({ lot_used: 1 }))).toMatch(/already drew/);
    expect(skipReason(fallbackIn({ qty_remaining: 0.5 }))).toMatch(/already drew/);
  });

});

const LEG4 = 'fabriccode=bf-01|gap=12"|divanheight=8"|legheight=4"';
const LEG2 = 'fabriccode=bf-01|gap=12"|divanheight=8"|legheight=2"';

describe('planActual — put the unit back where it really came from (owner 2026-11-10)', () => {
  test('DO-016: the new-spec OUT consumed nothing, so the GRN 2611-010 unit stays shipped, moved onto that OUT', () => {
    const p = planActual(
      [{ id: 'c-a4d7', lot_id: 'lot-a4d7', qty_consumed: 1 }],
      [{ id: 'out-1722', variant_key: `${LEG4}|totalheight=24"`, qty: 1, consumed: 0 }],
      1,
    );
    expect(p).toEqual({ move: [{ id: 'c-a4d7', lot_id: 'lot-a4d7', take: 1, to_out: 'out-1722', to_vk: `${LEG4}|totalheight=24"` }], restore: [], uncosted: 0 });
  });

  test('DO-018: the new-spec OUT took GRN 2610-011, so the GRN 2610-028 unit goes back on the shelf', () => {
    const p = planActual(
      [{ id: 'c-a10d', lot_id: 'lot-a10d', qty_consumed: 1 }],
      [{ id: 'out-a657', variant_key: `${LEG2}|totalheight=22"`, qty: 1, consumed: 1 }],
      1,
    );
    expect(p).toEqual({ move: [], restore: [{ id: 'c-a10d', lot_id: 'lot-a10d', take: 1 }], uncosted: 0 });
  });

  test('a plain qty reduction (no new-spec OUT) gives the units back, newest consumption first', () => {
    const p = planActual(
      [{ id: 'new', lot_id: 'L2', qty_consumed: 1 }, { id: 'old', lot_id: 'L1', qty_consumed: 3 }],
      [],
      2,
    );
    expect(p.restore).toEqual([{ id: 'new', lot_id: 'L2', take: 1 }, { id: 'old', lot_id: 'L1', take: 1 }]);
    expect(p.move).toEqual([]);
  });

  test('a partly covered new-spec OUT takes only its uncovered units; the rest comes back', () => {
    const p = planActual(
      [{ id: 'c', lot_id: 'L', qty_consumed: 3 }],
      [{ id: 'o', variant_key: 'v2', qty: 2, consumed: 1 }],
      3,
    );
    expect(p.move).toEqual([{ id: 'c', lot_id: 'L', take: 1, to_out: 'o', to_vk: 'v2' }]);
    expect(p.restore).toEqual([{ id: 'c', lot_id: 'L', take: 2 }]);
  });

  test('units the DO shipped uncosted have nothing to move or give back', () => {
    expect(planActual([], [{ id: 'o', variant_key: 'v2', qty: 1, consumed: 0 }], 1)).toEqual({ move: [], restore: [], uncosted: 1 });
  });
});
