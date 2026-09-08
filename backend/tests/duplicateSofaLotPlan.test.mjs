// ---------------------------------------------------------------------------
// The planner behind repair-duplicate-sofa-cutover-lots.mjs.
//
// It decides which open sofa cutover lots are the SAME sofa opened twice, and
// it decides it about STOCK — so every refusal below is a case where retiring
// would have destroyed something real, and each one is a test rather than a
// sentence in a header.
//
// The keep rule is pinned against the REAL computeVariantKey, imported from the
// backend source, not against the script mirror: the whole defect is a
// disagreement between two computations of one key, so a test that used the
// mirror on both sides could not see the disagreement it exists to catch.
// ---------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import {
  planDuplicateSofaLots,
  modelOfCompartment,
  variantKeyMirror,
} from '../scripts/lib/duplicate-sofa-lot-plan.mjs';
import { computeVariantKey } from '../src/scm/shared/variant-key';

const KEY = (g, v) => computeVariantKey(g, v);

/** HC-PO-009712's real shape on production, 2026-09-08. */
const UMBRELLA = { fabricCode: 'BO315-03', seatHeight: '30', specials: ['BOTTOM USE UMBRELLA FABRIC'] };
const UMBRELLA_NYLON = { fabricCode: 'BO315-03', seatHeight: '30', specials: ['BOTTOM USE UMBRELLA FABRIC', 'Nylon Fabric'] };

const lot = (over) => ({
  id: 'lot-1', batchNo: 'HC-PO-009712', itemCode: '5535-CNR', variantKey: KEY('sofa', UMBRELLA),
  warehouseId: 'wh-kl', qtyReceived: 1, qtyRemaining: 1, unitCostSen: 0, consumptions: 0,
  createdAt: '2026-08-28T13:05:49Z', ...over,
});
const poLine = (over) => ({
  poNumber: 'HC-PO-009712', itemCode: '5535-CNR', itemGroup: 'sofa', variants: UMBRELLA_NYLON, ...over,
});
const run = (lots, poLines, soBindings = []) =>
  planDuplicateSofaLots({ lots, poLines, soBindings, computeKey: KEY });

describe('the mirror and the real key agree', () => {
  test('on the build this repair exists for', () => {
    expect(variantKeyMirror('sofa', UMBRELLA_NYLON)).toBe(computeVariantKey('sofa', UMBRELLA_NYLON));
    expect(variantKeyMirror('sofa', UMBRELLA)).toBe(computeVariantKey('sofa', UMBRELLA));
    // And the two builds are genuinely different keys, or the fixture proves nothing.
    expect(KEY('sofa', UMBRELLA)).not.toBe(KEY('sofa', UMBRELLA_NYLON));
  });
});

describe('modelOfCompartment', () => {
  test('strips the LAST segment, so a model with its own dash survives', () => {
    expect(modelOfCompartment('8030-1A(LHF)')).toBe('8030');
    expect(modelOfCompartment('SOFA-333 44-CNR')).toBe('SOFA-333 44');
    expect(modelOfCompartment('5535-CNR')).toBe('5535');
  });
});

describe('the keep rule', () => {
  test('retires the stale key and keeps the one the purchase line computes today', () => {
    const r = run(
      [lot({ id: 'stale' }), lot({ id: 'current', variantKey: KEY('sofa', UMBRELLA_NYLON) })],
      [poLine()],
    );
    expect(r.retire.map((x) => x.lotId)).toEqual(['stale']);
    expect(r.retire[0].currentKey).toBe(KEY('sofa', UMBRELLA_NYLON));
    expect(r.refusals).toEqual([]);
  });

  test('it is NOT newest-wins — a special REMOVED keeps the older lot', () => {
    // The purchase line is back to plain umbrella; the NEWER lot is the stale one.
    const r = run(
      [
        lot({ id: 'older', variantKey: KEY('sofa', UMBRELLA), createdAt: '2026-08-28T00:00:00Z' }),
        lot({ id: 'newer', variantKey: KEY('sofa', UMBRELLA_NYLON), createdAt: '2026-09-08T00:00:00Z' }),
      ],
      [poLine({ variants: UMBRELLA })],
    );
    expect(r.retire.map((x) => x.lotId)).toEqual(['newer']);
  });

  test('a cell with ONE key is left alone', () => {
    const r = run([lot()], [poLine({ variants: UMBRELLA })]);
    expect(r.retire).toEqual([]);
    expect(r.refusals).toEqual([]);
  });
});

describe('it refuses rather than guessing', () => {
  test('when NO open lot carries the purchase line\'s key', () => {
    const third = { fabricCode: 'BO315-03', seatHeight: '30', specials: ['Something Else'] };
    const r = run(
      [lot({ id: 'a' }), lot({ id: 'b', variantKey: KEY('sofa', UMBRELLA_NYLON) })],
      [poLine({ variants: third })],
    );
    expect(r.retire).toEqual([]);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0].why).toMatch(/NO open lot carries it/);
    expect(r.refusals[0].lotIds.sort()).toEqual(['a', 'b']);
  });

  test('a lot that has already been consumed — retiring it would restate a shipment', () => {
    const r = run(
      [lot({ id: 'shipped', consumptions: 1 }), lot({ id: 'current', variantKey: KEY('sofa', UMBRELLA_NYLON) })],
      [poLine()],
    );
    expect(r.retire).toEqual([]);
    expect(r.refusals[0].why).toMatch(/already been consumed/);
  });

  test('a part-consumed lot — something took goods from it', () => {
    const r = run(
      [lot({ id: 'part', qtyReceived: 2, qtyRemaining: 1 }), lot({ id: 'current', variantKey: KEY('sofa', UMBRELLA_NYLON) })],
      [poLine()],
    );
    expect(r.retire).toEqual([]);
    expect(r.refusals[0].why).toMatch(/part-consumed/);
  });

  test('a lot carrying COST — this tool may not move money', () => {
    const r = run(
      [lot({ id: 'costed', unitCostSen: 195000 }), lot({ id: 'current', variantKey: KEY('sofa', UMBRELLA_NYLON) })],
      [poLine()],
    );
    expect(r.retire).toEqual([]);
    expect(r.refusals[0].why).toMatch(/carries a cost/);
  });

  test('a lot a live sales order is allocated to by its EXACT key', () => {
    const r = run(
      [lot({ id: 'bound' }), lot({ id: 'current', variantKey: KEY('sofa', UMBRELLA_NYLON) })],
      [poLine()],
      [{ batchNo: 'HC-PO-009712', itemCode: '5535-CNR', variantKey: KEY('sofa', UMBRELLA) }],
    );
    expect(r.retire).toEqual([]);
    expect(r.refusals[0].why).toMatch(/a sales order is allocated/);
  });

  test('a binding on the OTHER key does not protect the stale lot', () => {
    const r = run(
      [lot({ id: 'stale' }), lot({ id: 'current', variantKey: KEY('sofa', UMBRELLA_NYLON) })],
      [poLine()],
      [{ batchNo: 'HC-PO-009712', itemCode: '5535-CNR', variantKey: KEY('sofa', UMBRELLA_NYLON) }],
    );
    expect(r.retire.map((x) => x.lotId)).toEqual(['stale']);
  });
});

describe('a model that is on no line of the order it claims to come from', () => {
  // HC-PO-009712 is a 5535 order and carries a set of 8030 pieces, written
  // 2026-09-07 20:49. Two more exist. Reported, never retired.
  const foreign = lot({ id: 'foreign', itemCode: '8030-CNR', variantKey: KEY('sofa', UMBRELLA_NYLON) });

  test('is reported even though it carries only ONE key', () => {
    const r = run([foreign], [poLine()]);
    expect(r.retire).toEqual([]);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0].why).toMatch(/MODEL NOT ON THE ORDER/);
    expect(r.refusals[0].why).toContain('5535');
  });

  test('and is never retired even when the same cell also has two keys', () => {
    const r = run(
      [foreign, lot({ id: 'foreign2', itemCode: '8030-CNR', variantKey: KEY('sofa', UMBRELLA) })],
      [poLine()],
    );
    expect(r.retire).toEqual([]);
    expect(r.refusals[0].why).toMatch(/MODEL NOT ON THE ORDER/);
  });

  test('a batch with no sofa purchase line at all is refused, not retired', () => {
    const r = run([lot({ id: 'a' }), lot({ id: 'b', variantKey: KEY('sofa', UMBRELLA_NYLON) })], []);
    expect(r.retire).toEqual([]);
    expect(r.refusals[0].why).toMatch(/no sofa purchase line at all/);
  });
});

describe('the planner is pure', () => {
  test('it refuses to run without the key function rather than defaulting to one', () => {
    expect(() => planDuplicateSofaLots({ lots: [], poLines: [], soBindings: [] }))
      .toThrow(/computeKey is required/);
  });

  test('two orders are decided independently', () => {
    const r = run(
      [
        lot({ id: 'a1' }), lot({ id: 'a2', variantKey: KEY('sofa', UMBRELLA_NYLON) }),
        lot({ id: 'b1', batchNo: 'HC-PO-009630' }),
      ],
      [poLine(), poLine({ poNumber: 'HC-PO-009630', variants: UMBRELLA })],
    );
    expect(r.retire.map((x) => x.lotId)).toEqual(['a1']);
    expect(r.refusals).toEqual([]);
  });
});
