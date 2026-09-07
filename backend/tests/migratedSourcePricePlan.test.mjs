/* The refusals of lib/migrated-source-price-plan.mjs, each exercised with a
 * planted defect. Every one of them exists because the alternative already
 * happened once against production money:
 *
 *   - the decomposed sofa            docs/bugs/0673, RM 2,216,501, caught in dry-run
 *   - the undiscounted line amount   docs/bugs/0662 / 0664
 *   - blank read as zero             the owner's 空白不覆盖, 2026-09-07
 *
 * These cannot be exercised against the live database without first creating
 * the damage there, which is the whole reason the decisions are a pure module.
 */
import { describe, it, expect } from 'vitest';

import { alignGroupsToBook, planSourceDocument } from '../scripts/lib/migrated-source-price-plan.mjs';

const row = (over = {}) => ({
  lineId: 'row-1',
  itemCode: 'ITEM',
  qty: 1,
  qtyReceived: 1,
  invoicedQty: 0,
  returnedQty: 0,
  unitSen: 0,
  discountSen: 0,
  lineTotalSen: 0,
  ...over,
});

const group = (key, rows, qty) => ({
  key,
  qty: qty ?? Math.max(...rows.map((r) => r.qty)),
  itemCodes: rows.map((r) => r.itemCode),
  rows,
});

const bookLine = (over = {}) => ({
  dtlKey: '1', seq: 16, itemKey: 'AC-ITEM', qty: 1, unitPriceSen: 10000, subTotalSen: 10000, ...over,
});

const doc = (groups) => ({ docNo: 'HC-GR-000815', acDocNo: 'GR-000815', groups });

describe('alignGroupsToBook', () => {
  it('steps over a book line the book prices at nothing', () => {
    const g = [group('1', [row({ itemCode: 'SOFA' })])];
    const b = [bookLine({ dtlKey: '9', qty: 2, unitPriceSen: 0, subTotalSen: 0 }), bookLine({ dtlKey: '10' })];
    const { pairs, dropped, error } = alignGroupsToBook(g, b);
    expect(error).toBeNull();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].book.dtlKey).toBe('10');
    expect(dropped.map((d) => d.dtlKey)).toEqual(['9']);
  });

  it('never steps over a book line that states money', () => {
    const g = [group('1', [row({ qty: 5, qtyReceived: 5 })], 5)];
    const b = [bookLine({ dtlKey: '9', qty: 2, subTotalSen: 25000 })];
    const { error } = alignGroupsToBook(g, b);
    expect(error).toMatch(/no AutoCount line left/);
  });

  it('refuses when a priced book line has no ERP line to land on', () => {
    const g = [group('1', [row()])];
    const b = [bookLine({ dtlKey: '1' }), bookLine({ dtlKey: '2', seq: 32 })];
    const { error } = alignGroupsToBook(g, b);
    expect(error).toMatch(/is priced and has no ERP line to land on/);
  });
});

describe('planSourceDocument', () => {
  it('copies the book SubTotal, not qty x UnitPrice — the worked example GR-000815', () => {
    /* One AutoCount receipt line, three ERP compartments. The book states
       UnitPrice 3,373.45 and SubTotal 2,867.43, and PI-001531 bills 2,867.43. */
    const rows = [
      row({ lineId: 'a', itemCode: '5527-1A(RHF)' }),
      row({ lineId: 'b', itemCode: '5527-1A(LHF)' }),
      row({ lineId: 'c', itemCode: '5527-Console' }),
    ];
    const { writes, refusals } = planSourceDocument({
      doc: doc([group('145254', rows)]),
      bookLines: [bookLine({ dtlKey: '209355', unitPriceSen: 337345, subTotalSen: 286743 })],
    });
    expect(refusals).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      lineId: 'a', unitSen: 337345, discountSen: 50602, lineTotalSen: 286743,
    });
    /* THE POINT OF THE WHOLE MODULE: the sofa is worth the SubTotal ONCE, not
       once per compartment. 286743 x 3 = 860229 is docs/bugs/0673 in miniature. */
    expect(writes.reduce((t, w) => t + w.lineTotalSen, 0)).toBe(286743);
    expect(writes[0].siblingsLeftAtZero).toEqual(['5527-1A(LHF)', '5527-Console']);
  });

  it('refuses a blank book figure rather than reading it as zero', () => {
    const { writes, refusals } = planSourceDocument({
      doc: doc([group('1', [row()])]),
      bookLines: [bookLine({ subTotalSen: null })],
    });
    expect(writes).toEqual([]);
    expect(refusals[0]).toMatch(/blank never overwrites/);
  });

  it('honours a book line that STATES zero money by writing nothing at all', () => {
    const { writes, refusals } = planSourceDocument({
      doc: doc([group('1', [row({ itemCode: 'FREE PILLOW' })])]),
      bookLines: [bookLine({ unitPriceSen: 0, subTotalSen: 0 })],
    });
    expect(writes).toEqual([]);
    expect(refusals).toEqual([]);
  });

  it('refuses when the ERP carries more line groups than the book states', () => {
    const { writes, refusals } = planSourceDocument({
      doc: doc([group('1', [row({ lineId: 'a' })]), group('2', [row({ lineId: 'b', itemCode: 'OTHER' })])]),
      bookLines: [bookLine()],
    });
    expect(writes).toEqual([]);
    expect(refusals[0]).toMatch(/a price cannot fix a line-shape difference/);
  });

  it('refuses an assignment that only sort order could decide', () => {
    /* Two book lines, same quantity, different money, landing on two ERP groups
       that are different products. Nothing here knows which is which. */
    const { writes, refusals } = planSourceDocument({
      doc: doc([
        group('1', [row({ lineId: 'a', itemCode: 'HILTON (A)-(K)' })]),
        group('2', [row({ lineId: 'b', itemCode: 'TRION (A)-(Q)' })]),
      ]),
      bookLines: [
        bookLine({ dtlKey: '914148', subTotalSen: 71000, unitPriceSen: 71000 }),
        bookLine({ dtlKey: '914150', seq: 32, subTotalSen: 72500, unitPriceSen: 72500 }),
      ],
    });
    expect(writes).toEqual([]);
    expect(refusals[0]).toMatch(/decided by sort order/);
  });

  it('allows the same assignment when the two groups are the same product', () => {
    const { writes, refusals } = planSourceDocument({
      doc: doc([
        group('1', [row({ lineId: 'a', itemCode: 'AKEMI BULWARK MATT (SP)' })]),
        group('2', [row({ lineId: 'b', itemCode: 'AKEMI BULWARK MATT (SP)' })]),
      ]),
      bookLines: [
        bookLine({ dtlKey: '835397', unitPriceSen: 312000, subTotalSen: 312000 }),
        bookLine({ dtlKey: '835399', seq: 32, unitPriceSen: 264000, subTotalSen: 264000 }),
      ],
    });
    expect(refusals).toEqual([]);
    expect(writes.map((w) => w.lineTotalSen)).toEqual([312000, 264000]);
  });

  it('never overwrites a line that already carries money', () => {
    const { writes, refusals } = planSourceDocument({
      doc: doc([group('1', [row({ unitSen: 999, lineTotalSen: 999 })])]),
      bookLines: [bookLine()],
    });
    expect(writes).toEqual([]);
    expect(refusals[0]).toMatch(/never overwritten/);
  });

  it('refuses a line whose invoiced quantity and received quantity disagree', () => {
    const { writes, refusals } = planSourceDocument({
      doc: doc([group('1', [row({ qty: 1, qtyReceived: 2 })])]),
      bookLines: [bookLine()],
    });
    expect(writes).toEqual([]);
    expect(refusals[0]).toMatch(/is not the quantity the line total is computed from/);
  });

  it('refuses a book amount larger than qty x unit price — a surcharge, not a discount', () => {
    const { writes, refusals } = planSourceDocument({
      doc: doc([group('1', [row()])]),
      bookLines: [bookLine({ unitPriceSen: 10000, subTotalSen: 12000 })],
    });
    expect(writes).toEqual([]);
    expect(refusals[0]).toMatch(/surcharge, not a discount/);
  });
});
