// The pure half of repair-do-resync-return-lots.mjs, on the two production rows
// that started it (CODY-(K), KL WAREHOUSE, 2026-11-10): the return lots minted
// by the 02:45 edit of 2990-DO-2611-018 and the 02:48 edit of 2990-DO-2611-016.
import { describe, expect, test } from 'vitest';
import { FALLBACK_NOTES, skipReason, unwindPlan } from '../scripts/lib/do-return-lot-repair.mjs';

const fallbackIn = (extra = {}) => ({
  notes: FALLBACK_NOTES, lot_id: 'lot-4fd7', qty_received: 1, qty_remaining: 1, lot_used: 0, unstamped_lines: 0, ...extra,
});

describe('skipReason', () => {
  test('an untouched lot minted by the fallback IN, on a stamped line, is repaired', () => {
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

  test('an unstamped line waits: its old consumption is the only record of the PO', () => {
    expect(skipReason(fallbackIn({ unstamped_lines: 1 }))).toMatch(/stamp-do-shipped-from/);
  });
});

describe('unwindPlan', () => {
  test('DO-016: the one unit goes back to the GRN 2990-GRN-2611-010 lot it came from', () => {
    const p = unwindPlan([{ id: 'c-a4d7', lot_id: 'lot-a4d7', qty_consumed: 1, unit_cost_sen: 55000 }], 1);
    expect(p).toEqual({ steps: [{ id: 'c-a4d7', lot_id: 'lot-a4d7', take: 1, remove: true, left: 0, unit_cost_sen: 55000 }], restored: 1, uncosted: 0 });
  });

  test('newest consumption first, a partial one is shrunk', () => {
    const p = unwindPlan([
      { id: 'new', lot_id: 'L2', qty_consumed: 1, unit_cost_sen: 200 },
      { id: 'old', lot_id: 'L1', qty_consumed: 3, unit_cost_sen: 100 },
    ], 2);
    expect(p.steps.map((s) => [s.id, s.take, s.remove, s.left])).toEqual([['new', 1, true, 0], ['old', 1, false, 2]]);
  });

  test('units the DO shipped uncosted have nothing to give back', () => {
    expect(unwindPlan([], 1)).toEqual({ steps: [], restored: 0, uncosted: 1 });
  });
});
