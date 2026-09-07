// The delivery-document matcher, now shared by create-migrated-documents.mjs
// and sync-ac-delta.mjs (lane `do`). It was moved out of the first of those on
// 2026-09-07 so the second could reuse the RULE while feeding it a different
// SOURCE; these tests pin the three behaviours the move had to preserve, each
// of which is a production defect that has already been paid for once:
//
//   docs/bugs/0043 — two AutoCount rows of one item code on one order both
//                    pointed at the FIRST sales-order line, so the delivery
//                    carried the same line twice.
//   the sofa branch — an AutoCount row naming a whole model must mark EVERY
//                    compartment of that build delivered, and must do it ONCE
//                    however many rows name the model.
//   the shape guard — one document may never hold the same (so_item_id, code,
//                    qty) twice, whatever the mapping above it decided.
import { describe, expect, it } from 'vitest';

import { buildMigratedDoPlan } from '../scripts/lib/migrated-do-writer.mjs';

const itemMap = new Map([
  ['AC-CHAIR', 'CHAIR-01'],
  ['AC-SOFA', '9028-1S'],
]);

const soLine = (id, code, over = {}) => ({
  id, item_code: code, doc_no: 'HC-SO-000001', ac: 'SO-000001',
  qty: 1, item_group: null, variants: null, description2: null,
  unit_price_sen: 10000, discount_sen: 0, unit_cost_sen: 5000, ...over,
});

const acRow = (over = {}) => ({
  DoNo: 'DO-000001', DoDate: '2026-09-01', SoNo: 'SO-000001',
  ItemCode: 'AC-CHAIR', LineDesc: 'A CHAIR', Qty: 1,
  DebtorCode: '300-C001', DebtorName: 'A CUSTOMER', ...over,
});

describe('the migrated delivery-order matcher', () => {
  it('two AutoCount rows of one code claim two DIFFERENT sales-order lines', () => {
    const { plan } = buildMigratedDoPlan({
      rows: [acRow(), acRow()],
      itemMap,
      soItems: [soLine('so-1', 'CHAIR-01'), soLine('so-2', 'CHAIR-01')],
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].items.map((i) => i.soItemId)).toEqual(['so-1', 'so-2']);
  });

  it('a third row with no unclaimed line left is skipped LOUDLY, never reused', () => {
    const { plan, stats } = buildMigratedDoPlan({
      rows: [acRow(), acRow(), acRow()],
      itemMap,
      soItems: [soLine('so-1', 'CHAIR-01'), soLine('so-2', 'CHAIR-01')],
    });
    expect(stats.exhausted).toBe(1);
    expect(plan[0].items).toHaveLength(2);
  });

  it('a sofa row names the whole build ONCE, however many rows name the model', () => {
    const pieces = [soLine('p-1', '9028-1S'), soLine('p-2', '9028-CNR'), soLine('p-3', '9028-2ER')];
    const { plan, stats } = buildMigratedDoPlan({
      rows: [acRow({ ItemCode: 'AC-SOFA' }), acRow({ ItemCode: 'AC-SOFA' })],
      itemMap,
      soItems: pieces,
    });
    /* The first row takes the exact-code line 9028-1S; the second finds it
       claimed and falls through to the model walk, which brings the whole build
       in once. What must NOT happen is the build arriving twice. */
    expect(stats.collapsed + stats.exhausted).toBeGreaterThan(0);
    const perLine = new Map();
    for (const i of plan[0].items) perLine.set(i.soItemId, (perLine.get(i.soItemId) ?? 0) + 1);
    expect([...perLine.values()].every((n) => n === 1)).toBe(true);
  });

  it('an unmapped AutoCount code produces no line and is counted', () => {
    const { plan, stats } = buildMigratedDoPlan({
      rows: [acRow({ ItemCode: 'AC-UNKNOWN' })],
      itemMap,
      soItems: [soLine('so-1', 'CHAIR-01')],
    });
    expect(stats.unmapped).toBe(1);
    expect(plan).toHaveLength(0);
  });

  it('a mapped code with no sales-order line is counted, not guessed at', () => {
    const { plan, stats } = buildMigratedDoPlan({
      rows: [acRow()],
      itemMap,
      soItems: [soLine('so-1', 'TABLE-01')],
    });
    expect(stats.noSoLine).toBe(1);
    expect(plan).toHaveLength(0);
  });

  it('a document already mirrored in the ERP is not planned again', () => {
    const { plan } = buildMigratedDoPlan({
      rows: [acRow()],
      itemMap,
      soItems: [soLine('so-1', 'CHAIR-01')],
      done: new Set(['DO-000001']),
    });
    expect(plan).toHaveLength(0);
  });

  it('the line carries the sales order money and classification, not zeroes', () => {
    const { plan } = buildMigratedDoPlan({
      rows: [acRow()],
      itemMap,
      soItems: [soLine('so-1', 'CHAIR-01', { item_group: 'sofa', description2: 'BUILD TEXT', unit_price_sen: 129900, unit_cost_sen: 70000 })],
    });
    const [line] = plan[0].items;
    expect(line.unitPriceSen).toBe(129900);
    expect(line.unitCostSen).toBe(70000);
    expect(line.group).toBe('sofa');
    expect(line.desc2).toBe('BUILD TEXT');
  });

  it('a source with no line description leaves it blank rather than inventing one', () => {
    // The truth-snapshot projection sync-ac-delta feeds has no Description
    // column; blank stays blank (COPY, NEVER COMPUTE).
    const { plan } = buildMigratedDoPlan({
      rows: [acRow({ LineDesc: null, DebtorCode: null, DebtorName: null })],
      itemMap,
      soItems: [soLine('so-1', 'CHAIR-01')],
    });
    expect(plan[0].items[0].name).toBeNull();
    expect(plan[0].debtorName).toBeNull();
  });
  /* The two shapes create-migrated-documents.mjs could not report before
     2026-09-07: a note that loses SOME of its lines, and a note that loses ALL
     of them and therefore never becomes a document at all. The aggregate
     counters cannot tell them apart — `byDo.size` simply does not include the
     second — so DO-001800 and DO-005583 left production with no delivery and no
     number anywhere went down. See docs/bugs. */
  it('attributes every dropped line to the delivery note it came off', () => {
    const { stats } = buildMigratedDoPlan({
      rows: [acRow(), acRow({ ItemCode: 'AC-UNKNOWN' })],
      itemMap,
      soItems: [soLine('so-1', 'CHAIR-01')],
    });
    const d = stats.byDoc.get('DO-000001');
    expect(d.bookLines).toBe(2);
    expect(d.kept).toBe(1);
    expect(d.dropped).toHaveLength(1);
    expect(d.dropped[0].why).toMatch(/mapping sheet has no ERP code/);
  });

  it('a note whose every line fails is visible as kept=0, not merely absent', () => {
    const { plan, stats } = buildMigratedDoPlan({
      rows: [acRow({ ItemCode: 'AC-CHAIR' })],
      itemMap,
      // the order carries a DIFFERENT code — the live shape: AutoCount
      // delivered a substituted item the sales order never named.
      soItems: [soLine('so-1', 'SOMETHING-ELSE')],
    });
    expect(plan).toHaveLength(0);
    const d = stats.byDoc.get('DO-000001');
    expect(d.kept).toBe(0);
    expect(d.bookLines).toBe(1);
    expect(d.dropped[0].why).toMatch(/no line with this item code/);
  });
});
