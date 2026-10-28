// The SO -> PO dedication rule (scripts/lib/ac-po-line.mjs), which decides
// `purchase_order_items.so_item_id` — and therefore which bed the floor is told
// is ready, because a bedframe or sofa line is HARD-BOUND and reads READY only
// through its own dedicated purchase order (isHardBoundLine,
// src/scm/lib/so-stock-allocation.ts).
//
// The values below are the real ones from the 2026-09-07 incident: run
// 34123720786 wrote 10 dedications on the AutoCount DtlKey pair alone, and nine
// of them bound a sales-order line to a purchase-order line for a different bed.
// docs/bugs/0671-*.md has the full trace.
import { describe, expect, it } from 'vitest';

import { planSoPoDedications } from '../scripts/lib/ac-po-line.mjs';

const edge = (over = {}) => ({ DocNo: 'PO-010095', DtlKey: 917739, FromDocNo: 'SO-002558', FromSODtlKey: 165874, ...over });
const soLine = (over = {}) => ({ id: 'so-1', doc_no: 'HC-SO-002558', item_code: 'TRION (A) (HB STR)-(K)', ...over });
const poLine = (over = {}) => ({ id: 'po-1', po_number: 'HC-PO-010095', so_item_id: null, item_code: 'TRION (A) (HB STR)-(K)', ...over });

const maps = (so, po) => ({
  soItemByDtl: new Map([['165874', so]]),
  poItemByDtl: new Map([['917739', po]]),
});

describe('the SO -> PO dedication rule', () => {
  it('writes the dedication when the two ERP rows name the same product', () => {
    const { plan, mismatch } = planSoPoDedications({ edges: [edge()], ...maps(soLine(), poLine()) });
    expect(mismatch).toHaveLength(0);
    expect(plan).toEqual([{ poItemId: 'po-1', soItemId: 'so-1', poNo: 'HC-PO-010095', soNo: 'SO-002558' }]);
  });

  /* The nine. Every one of these pairs is in production today, written on the
     DtlKey pair with no item-code test. The book's own FromSODtlKey resolves to
     an SO line with a byte-identical AutoCount code in all nine, so the
     disagreement is between OUR two rows, and a link would bury it. */
  it.each([
    ['REGAL (A)-(K)', 'TRION (A) (HB STR)-(K)'],
    ['FENRIR-(Q)', 'HILTON (A)-(Q)'],
    ['TRION (A)-(K)', 'TRION (A) (HB STR)-(K)'],
    ['BEDFRAME KIV', 'CELENE (A)-(K)'],
    ['JAGER-(Q)', 'JAGER-(SS)'],
    ['CODY-(Q)', 'JAGER-(Q)'],
    ['TIFANNY-(K)', 'TIFANNY 2.0 (F)-(K)'],
    ['BEDFRAME KIV', 'JAGER-(K)'],
    ['JAGER-(Q)', 'DIVAN ONLY-(Q)'],
  ])('REFUSES the dedication when the SO says %s and the PO says %s', (soCode, poCode) => {
    const { plan, mismatch } = planSoPoDedications({
      edges: [edge()],
      ...maps(soLine({ item_code: soCode }), poLine({ item_code: poCode })),
    });
    expect(plan).toHaveLength(0);
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toMatchObject({ soCode, poCode, soDtl: '165874', poDtl: '917739' });
  });

  it('a refused pair leaves the SO line free for the PO line that DOES match it', () => {
    // Under-repair, never wrong-link: refusing must not also consume the line.
    const { plan, mismatch } = planSoPoDedications({
      edges: [edge(), edge({ DtlKey: 917741 })],
      soItemByDtl: new Map([['165874', soLine()]]),
      poItemByDtl: new Map([
        ['917739', poLine({ id: 'po-wrong', item_code: 'REGAL (A)-(K)' })],
        ['917741', poLine({ id: 'po-right' })],
      ]),
    });
    expect(mismatch.map((m) => m.poItemId)).toEqual(['po-wrong']);
    expect(plan.map((p) => p.poItemId)).toEqual(['po-right']);
  });

  it('normalises case and inner whitespace before calling two codes different', () => {
    const { plan, mismatch } = planSoPoDedications({
      edges: [edge()],
      ...maps(soLine({ item_code: '  trion (a)   (hb str)-(k) ' }), poLine()),
    });
    expect(mismatch).toHaveLength(0);
    expect(plan).toHaveLength(1);
  });

  it('an SO line already dedicated elsewhere is reported as missing, not mismatched', () => {
    const { plan, missing, mismatch } = planSoPoDedications({
      edges: [edge()],
      ...maps(soLine(), poLine()),
      alreadyClaimed: new Set(['so-1']),
    });
    expect(plan).toHaveLength(0);
    expect(mismatch).toHaveLength(0);
    expect(missing[0].why).toMatch(/already dedicated/);
  });

  it('a PO line that already carries a dedication is skipped silently', () => {
    const { plan, missing, mismatch } = planSoPoDedications({
      edges: [edge()],
      ...maps(soLine(), poLine({ so_item_id: 'so-9' })),
    });
    expect([plan.length, missing.length, mismatch.length]).toEqual([0, 0, 0]);
  });
});
