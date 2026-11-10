// The pure half of flatten-spec-buckets.mjs, on the production shape that
// started it: CODY-(K) at KL WAREHOUSE (company 2) after #5597, where "Leg 4"
// stood at movements +1 and "Leg 4 + Total 24" at -1, neither with an open lot.
import { describe, expect, test } from 'vitest';
import { parseInputs, refuseReasons, planFlatten, movementNotes, projectSoLines } from '../scripts/lib/flatten-spec-buckets.mjs';

const LEG4 = 'fabriccode=bf-01|gap=12"|divanheight=8"|legheight=4"';
const LEG4_T24 = 'fabriccode=bf-01|gap=12"|divanheight=8"|legheight=4"|totalheight=24"';
const OTHER = 'fabriccode=bf-02|gap=12"|divanheight=8"|legheight=4"';

const cody = (over = {}) => new Map([
  [LEG4, { mov: 1, lots: 0 }],
  [LEG4_T24, { mov: -1, lots: 0 }],
  [OTHER, { mov: 2, lots: 2 }],
  ...Object.entries(over),
]);

const env = {
  COMPANY_ID: '2', WAREHOUSE_ID: '41d544bc-0000-4000-8000-000000000000', ITEM_CODE: 'CODY-(K)',
  FROM_VK: LEG4, TO_VK: LEG4_T24, REF: '2990-DO-2611-016', REASON: 'shipped unit re-specced after shipping',
};

describe('parseInputs', () => {
  test('the CODY pair parses, keys kept byte for byte', () => {
    const r = parseInputs(env);
    expect(r.ok).toBe(true);
    expect(r.input).toMatchObject({ companyId: 2, itemCode: 'CODY-(K)', fromVk: LEG4, toVk: LEG4_T24, ref: '2990-DO-2611-016' });
  });

  test('every input is required, and the pair must be two buckets', () => {
    const r = parseInputs({});
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/COMPANY_ID.*WAREHOUSE_ID.*ITEM_CODE.*FROM_VK.*TO_VK.*REF.*REASON/);
    expect(parseInputs({ ...env, TO_VK: LEG4 }).errors).toContain('FROM_VK and TO_VK are the same bucket');
    expect(parseInputs({ ...env, WAREHOUSE_ID: 'KL' }).ok).toBe(false);
    expect(parseInputs({ ...env, COMPANY_ID: '0' }).ok).toBe(false);
  });
});

describe('refuseReasons', () => {
  test('exact opposites with no open lot may be flattened', () => {
    expect(refuseReasons(cody(), LEG4, LEG4_T24)).toEqual([]);
  });

  test('balances that are not exact opposites are refused', () => {
    expect(refuseReasons(cody({ [LEG4]: { mov: 2, lots: 0 } }), LEG4, LEG4_T24).join()).toMatch(/not exact opposites \(2 and -1\)/);
  });

  test('an open lot in either bucket is real stock and is refused', () => {
    expect(refuseReasons(cody({ [LEG4]: { mov: 1, lots: 1 } }), LEG4, LEG4_T24).join()).toMatch(/FROM bucket holds 1 open lot/);
    expect(refuseReasons(cody({ [LEG4_T24]: { mov: -1, lots: 1 } }), LEG4, LEG4_T24).join()).toMatch(/TO bucket holds 1 open lot/);
  });

  test('a pair already at 0 is refused, which is what makes a re-run inert', () => {
    const flat = cody({ [LEG4]: { mov: 0, lots: 0 }, [LEG4_T24]: { mov: 0, lots: 0 } });
    expect(refuseReasons(flat, LEG4, LEG4_T24).join()).toMatch(/nothing to flatten/);
  });

  test('a key with no movement and no lot (a typo, a quote mark) is refused', () => {
    const typo = 'fabriccode=bf-01|gap=12″|divanheight=8"|legheight=4"';
    expect(refuseReasons(cody(), typo, LEG4_T24).join()).toMatch(/no movement or lot carries FROM_VK/);
  });
});

describe('planFlatten', () => {
  test('CODY: -1 in Leg 4 first, then +1 in Leg 4 + Total 24 whose lot is closed; total unchanged', () => {
    const p = planFlatten(cody(), LEG4, LEG4_T24);
    expect(p.refusals).toEqual([]);
    expect(p.moves).toEqual([
      { vk: LEG4, qty: -1, closesMintedLot: false },
      { vk: LEG4_T24, qty: 1, closesMintedLot: true },
    ]);
    expect(p.after.get(LEG4)).toEqual({ mov: 0, lots: 0 });
    expect(p.after.get(LEG4_T24)).toEqual({ mov: 0, lots: 0 });
    expect(p.after.get(OTHER)).toEqual({ mov: 2, lots: 2 });
    expect(p.totalBefore).toEqual({ mov: 2, lots: 2 });
    expect(p.totalAfter).toEqual({ mov: 2, lots: 2 });
  });

  test('the order is negative first whichever side FROM is', () => {
    const p = planFlatten(cody(), LEG4_T24, LEG4);
    expect(p.moves.map((m) => m.qty)).toEqual([-1, 1]);
  });

  test('a refused pair writes nothing', () => {
    const p = planFlatten(cody({ [LEG4]: { mov: 1, lots: 1 } }), LEG4, LEG4_T24);
    expect(p.moves).toEqual([]);
    expect(p.after.get(LEG4)).toEqual({ mov: 1, lots: 1 });
  });
});

describe('movementNotes', () => {
  test('names the document, the reason and the pair', () => {
    const n = movementNotes({ ...parseInputs(env).input, vk: LEG4, qty: -1 });
    expect(n).toContain('2990-DO-2611-016');
    expect(n).toContain('shipped unit re-specced after shipping');
    expect(n).toContain(`FROM bucket -1; pair "${LEG4}" / "${LEG4_T24}"`);
  });
});

describe('projectSoLines', () => {
  const before = cody();
  const after = planFlatten(before, LEG4, LEG4_T24).after;
  const line = (over) => ({ id: 'l1', doc_no: '2990-SO-2611-001', vk: LEG4, qty: 1, stock_status: 'READY', stock_qty_ready: 1, bound_received: 0, ...over });

  test('a line counted ready on the phantom Leg 4 unit goes PENDING', () => {
    const [p] = projectSoLines([line({})], before, after);
    expect(p).toMatchObject({ poolBefore: 1, poolAfter: 0, readyBefore: 1, readyAfter: 0, statusAfter: 'PENDING', changes: true });
  });

  test('a line ready off its own received PO keeps it', () => {
    const [p] = projectSoLines([line({ bound_received: 1 })], before, after);
    expect(p).toMatchObject({ readyAfter: 1, statusAfter: 'READY', changes: false });
  });

  test('a pending line on the -1 bucket stays pending', () => {
    const [p] = projectSoLines([line({ vk: LEG4_T24, stock_status: 'PENDING', stock_qty_ready: 0 })], before, after);
    expect(p).toMatchObject({ poolBefore: -1, poolAfter: 0, readyAfter: 0, statusAfter: 'PENDING', changes: false });
  });
});
