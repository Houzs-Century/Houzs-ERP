// Pair a migrated delivery line on MODEL + COLOUR, and where colour cannot
// resolve it, write NO link.
//
// WHY. buildMigratedDoPlan buckets candidate sales-order lines on (AutoCount SO
// number, ERP item code) and then takes them BY POSITION. Two lines of one sofa
// model in different fabrics are an ordinary order, and the account book's
// delivery line carries no colour and no line key to settle which one is being
// delivered — `fromSoDtlKey` is 0 of 48,772 DO lines in the 2026-09-08 re-cut.
// When the two orders list them in a different sequence the result is an exact
// swap, and the writer copies `variants` off whichever line it picked, so the
// delivery note states the other customer's colour. DO-011505 and DO-011478 are
// that shape in production (docs/bugs/0672, instance 2).
//
// THE FALSE NEGATIVE THIS FILE EXISTS TO AVOID. tests/migratedDoWriter.test.mjs
// builds every fixture line with `variants: null`, so every candidate carries
// the SAME colour signature and this guard can never fire in that suite — the
// 22 tests there pass identically with the rule and without it. A fixture that
// cannot reach the code under test reads exactly like a passing one; that is
// the trap 0684 recorded for planRepoint's short-circuit, one module over.
// Every fixture below therefore gives the candidates DIFFERENT colours.
import { describe, expect, it } from 'vitest';

import { buildMigratedDoPlan } from '../scripts/lib/migrated-do-writer.mjs';

const itemMap = new Map([['AC-SOFA-2S', '9058-2S']]);

const soLine = (id, over = {}) => ({
  id, item_code: '9058-2S', doc_no: 'HC-SO-011008', ac: 'SO-011008',
  qty: 1, item_group: 'sofa', variants: null, description2: null,
  unit_price_sen: 638000, discount_sen: 0, unit_cost_sen: 300000, ...over,
});

const acRow = (over = {}) => ({
  DoNo: 'DO-011505', DoDate: '2026-09-01', SoNo: 'SO-011008',
  ItemCode: 'AC-SOFA-2S', LineDesc: 'A SOFA', Qty: 1,
  DebtorCode: '300-C001', DebtorName: 'A CUSTOMER', ...over,
});

const blue = { variants: { colourId: 'PC151-01' } };
const grey = { variants: { colourId: 'PC151-17' } };

describe('migrated delivery lines pair on model + colour', () => {
  it('REFUSES to link when two candidate lines of one code carry different colours', () => {
    const { plan, stats } = buildMigratedDoPlan({
      rows: [acRow()],
      itemMap,
      soItems: [soLine('so-blue', blue), soLine('so-grey', grey)],
    });
    expect(stats.ambiguousColour).toBe(1);
    expect(plan).toEqual([]);
  });

  it('records the refusal against the delivery note, so a person can see WHICH one to pair', () => {
    const { stats } = buildMigratedDoPlan({
      rows: [acRow()],
      itemMap,
      soItems: [soLine('so-blue', blue), soLine('so-grey', grey)],
    });
    const doc = stats.byDoc.get('DO-011505');
    expect(doc.kept).toBe(0);
    expect(doc.dropped).toHaveLength(1);
    expect(doc.dropped[0].why).toMatch(/2 different colours/);
    expect(doc.dropped[0].why).toMatch(/by hand/);
  });

  it('a missing link is what it writes — never a link to the wrong colour', () => {
    const { plan } = buildMigratedDoPlan({
      rows: [acRow(), acRow()],
      itemMap,
      soItems: [soLine('so-blue', blue), soLine('so-grey', grey)],
    });
    expect(plan.flatMap((p) => p.items.map((i) => i.soItemId))).toEqual([]);
  });

  it('STILL PAIRS when the candidates are the same colour — position cannot be wrong there', () => {
    const { plan, stats } = buildMigratedDoPlan({
      rows: [acRow(), acRow()],
      itemMap,
      soItems: [soLine('so-1', blue), soLine('so-2', blue)],
    });
    expect(stats.ambiguousColour).toBe(0);
    expect(plan[0].items.map((i) => i.soItemId)).toEqual(['so-1', 'so-2']);
  });

  it('STILL PAIRS a single candidate — one line has nothing to be confused with', () => {
    const { plan, stats } = buildMigratedDoPlan({
      rows: [acRow()],
      itemMap,
      soItems: [soLine('so-only', grey)],
    });
    expect(stats.ambiguousColour).toBe(0);
    expect(plan[0].items[0].soItemId).toBe('so-only');
  });

  it('reads the colour through the repo signature, so description2 separates two lines carrying no variants', () => {
    const { stats } = buildMigratedDoPlan({
      rows: [acRow()],
      itemMap,
      soItems: [
        soLine('so-1', { description2: 'COL: MODENZA 01' }),
        soLine('so-2', { description2: 'COL: MODENZA 05' }),
      ],
    });
    expect(stats.ambiguousColour).toBe(1);
  });

  it('the existing suite could not have caught this — identical variants leave the guard unreachable', () => {
    const { stats } = buildMigratedDoPlan({
      rows: [acRow()],
      itemMap,
      soItems: [soLine('so-1'), soLine('so-2')],
    });
    expect(stats.ambiguousColour).toBe(0);
  });
});
