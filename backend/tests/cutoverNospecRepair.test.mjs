// The pure half of repair-cutover-nospec-stock.mjs, on the production shape
// that started it: SQUARE PILLOW at KL (company 1), cutover stock in the
// no-spec bucket, the fabric buckets the DOs shipped from negative and uncosted.
import { describe, expect, test } from 'vitest';
import {
  parseAllowedMonths, affectedClosedMonths, unallowedMonths, siblingSkip, planItemWarehouse, stateAfter, movementNotes,
} from '../scripts/lib/cutover-nospec-repair.mjs';

const RED = 'fabriccode=pc-151';
const BLUE = 'fabriccode=pc-152';
const CUTOFF = '2026-11-10T00:00:00.000000';

const lot = (id, receivedAt, qty, unitCostSen = 1000, rawVk = '') => ({ lotId: id, receivedAt, qtyRemaining: qty, unitCostSen, rawVk });
const out = (id, createdAt, qty, over = {}) => ({
  movementId: id, doId: `do-${id}`, qty, createdAt, isDropship: false, strictBatchCommitted: false, doStatus: 'SHIPPED',
  alreadyConsumedQty: 0, alreadyCostedSen: 0, docNo: `HC-DO-${id}`, month: createdAt.slice(0, 7), ...over,
});

/* SQUARE PILLOW @ KL: the cutover lots sit in the no-spec bucket; RED shipped 3
   in September and BLUE 2 in October, all uncosted. */
const pillow = () => ({
  cutoffTs: CUTOFF,
  empty: { mov: 53, lots: [lot('L2', '2026-08-29T01:00:00.000000', 40, 900), lot('L1', '2026-08-29T00:00:00.000000', 2, 800)] },
  negatives: [
    { vk: BLUE, mov: -2, lotOpen: 0, firstOutAt: '2026-10-02', outs: [out('b1', '2026-10-02T03:00:00.000000', 2)] },
    { vk: RED, mov: -3, lotOpen: 0, firstOutAt: '2026-09-05', outs: [out('r1', '2026-09-05T03:00:00.000000', 1), out('r2', '2026-09-20T03:00:00.000000', 2)] },
  ],
  stocked: [{ vk: '', lotOpen: 42 }],
});

describe('planItemWarehouse', () => {
  test('SQUARE PILLOW: each negative fabric bucket back to 0, the no-spec bucket down by the same, cost from its oldest lots', () => {
    const plan = planItemWarehouse(pillow());
    expect(plan.skips).toEqual([]);
    expect(plan.moved).toBe(5);
    expect(plan.emptyBefore).toEqual({ mov: 53, lots: 42 });
    expect(plan.emptyAfter).toEqual({ mov: 48, lots: 37 });
    // Oldest negative first: RED (September) takes the oldest lot L1 (2 units) then 1 of L2.
    const [red, blue] = plan.fixes;
    expect(red.vk).toBe(RED);
    expect(red).toMatchObject({ need: 3, qty: 3, capped: false, before: { mov: -3, lots: 0 }, after: { mov: 0, lots: 0 } });
    expect(red.takes.map((t) => [t.lotId, t.qty, t.unitCostSen])).toEqual([['L1', 2, 800], ['L2', 1, 900]]);
    // The reconcile costs the oldest DO OUT first, from the oldest lot.
    expect(red.costed.map((c) => [c.docNo, c.qty, c.month])).toEqual([['HC-DO-r1', 1, '2026-09'], ['HC-DO-r2', 2, '2026-09']]);
    expect(blue).toMatchObject({ vk: BLUE, qty: 2, after: { mov: 0, lots: 0 } });
    expect(blue.takes.map((t) => [t.lotId, t.qty])).toEqual([['L2', 2]]);
    expect(blue.costed.map((c) => [c.docNo, c.qty])).toEqual([['HC-DO-b1', 2]]);
  });

  test('capped: the no-spec bucket holds less than the hole, so it gives what it has and never goes negative', () => {
    const input = { ...pillow(), empty: { mov: 4, lots: [lot('L1', '2026-08-29T00:00:00.000000', 10)] } };
    const plan = planItemWarehouse(input);
    // Movement balance 4 caps it (open lots say 10): RED 3, BLUE only 1.
    expect(plan.moved).toBe(4);
    expect(plan.emptyAfter).toEqual({ mov: 0, lots: 6 });
    expect(plan.fixes.map((f) => [f.vk, f.qty, f.capped, f.residual, f.after.mov])).toEqual([[RED, 3, false, 0, 0], [BLUE, 1, true, 1, -1]]);
    expect(plan.fixes[1].costed.map((c) => [c.docNo, c.qty, c.stillShort])).toEqual([['HC-DO-b1', 1, 1]]);
  });

  test('a bucket with a stocked sibling of another fabric is left for people; one with a closer key for the key repair', () => {
    const input = pillow();
    input.stocked.push({ vk: 'fabriccode=pc-999', lotOpen: 4 });
    const plan = planItemWarehouse(input);
    expect(plan.fixes).toEqual([]);
    expect(plan.moved).toBe(0);
    expect(plan.skips.map((s) => [s.vk, s.code])).toEqual([[RED, 'different-value'], [BLUE, 'different-value']]);
    expect(plan.emptyAfter).toEqual(plan.emptyBefore);

    expect(siblingSkip(RED, [{ vk: 'fabriccode=PC 151', lotOpen: 1 }])).toMatchObject({ code: 'closer-sibling', cls: 'format' });
    expect(siblingSkip(RED, [{ vk: '', lotOpen: 9 }, { vk: RED, lotOpen: 0 }])).toBeNull();
  });

  test('only units the reconcile can cost are moved: drop-ship, cancelled and strict-batch OUTs are not', () => {
    const input = pillow();
    input.negatives = [{
      vk: RED, mov: -4, lotOpen: 0, firstOutAt: '2026-09-05',
      outs: [
        out('d', '2026-09-05T00:00:00.000000', 1, { isDropship: true }),
        out('c', '2026-09-06T00:00:00.000000', 1, { doStatus: 'CANCELLED' }),
        out('s', '2026-09-07T00:00:00.000000', 1, { strictBatchCommitted: true }),
        out('ok', '2026-09-08T00:00:00.000000', 1),
      ],
    }];
    const plan = planItemWarehouse(input);
    expect(plan.fixes.map((f) => [f.qty, f.residual])).toEqual([[1, 3]]);
    expect(plan.fixes[0].costed.map((c) => c.docNo)).toEqual(['HC-DO-ok']);

    input.negatives[0].outs = input.negatives[0].outs.slice(0, 3);
    expect(planItemWarehouse(input).skips.map((s) => s.code)).toEqual(['nothing-reconcilable']);
  });

  test('no-spec lots with a NULL variant_key cannot be consumed by an ADJUSTMENT: refused', () => {
    const input = { ...pillow(), empty: { mov: 10, lots: [lot('L1', '2026-08-29T00:00:00.000000', 10, 100, null)] } };
    const plan = planItemWarehouse(input);
    expect(plan.fixes).toEqual([]);
    expect(plan.skips.map((s) => s.code)).toEqual(['empty-null-vk', 'empty-null-vk']);
  });

  test('idempotent: after the apply a re-plan finds nothing to do (full fix and capped)', () => {
    const full = pillow();
    const p1 = planItemWarehouse(full);
    const again = planItemWarehouse(stateAfter(full, p1));
    expect(again.fixes).toEqual([]);
    expect(again.moved).toBe(0);

    const capped = { ...pillow(), empty: { mov: 4, lots: [lot('L1', '2026-08-29T00:00:00.000000', 10)] } };
    const p2 = planItemWarehouse(capped);
    const after = stateAfter(capped, p2);
    expect(after.empty.mov).toBe(0);
    const again2 = planItemWarehouse(after);
    expect(again2.fixes).toEqual([]);
    expect(again2.skips.map((s) => [s.vk, s.code])).toEqual([[BLUE, 'empty-none']]);
  });
});

describe('closed stock months', () => {
  test('every closed month from the earliest costed DO month on is affected', () => {
    expect(affectedClosedMonths(['2026-09', '2026-10'], ['2026-08', '2026-09', '2026-10'])).toEqual(['2026-09', '2026-10']);
    expect(affectedClosedMonths(['2026-10'], ['2026-08', '2026-09'])).toEqual([]);
    expect(affectedClosedMonths([], ['2026-09'])).toEqual([]);
  });

  test('apply is refused until ALLOW_CLOSED_MONTHS names every affected month', () => {
    const plan = planItemWarehouse(pillow());
    const months = plan.fixes.flatMap((f) => f.costed.map((c) => c.month));
    const affected = affectedClosedMonths(months, ['2026-08', '2026-09', '2026-10']);
    expect(affected).toEqual(['2026-09', '2026-10']);

    const none = parseAllowedMonths(undefined);
    expect(none.ok && unallowedMonths(affected, none.months)).toEqual(['2026-09', '2026-10']);
    const some = parseAllowedMonths('2026-09');
    expect(some.ok && unallowedMonths(affected, some.months)).toEqual(['2026-10']);
    const all = parseAllowedMonths(' 2026-09, 2026-10 ');
    expect(all.ok && unallowedMonths(affected, all.months)).toEqual([]);
    expect(parseAllowedMonths('2026-9').ok).toBe(false);
    expect(parseAllowedMonths('Sept').ok).toBe(false);
  });
});

test('movement notes name the run, the side and the spec, and carry no money', () => {
  const n = movementNotes({ side: 'to', qty: 2, specVk: RED, ref: 'CUTOVER-NOSPEC-2026-11-10' });
  expect(n).toContain('CUTOVER-NOSPEC-2026-11-10');
  expect(n).toContain('spec bucket +2');
  expect(n).toContain(RED);
  expect(n).not.toMatch(/RM|sen\b/);
});
