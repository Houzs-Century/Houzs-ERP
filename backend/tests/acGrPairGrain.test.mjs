/* The goods-receipt pair grain: the BOOK side and the EXPECTED POPULATION are
 * two different sets, and this pins them apart.
 *
 * THE BUG THIS EXISTS FOR. check-ac-erp-reconcile.mjs built both from one
 * filtered loop -- it walked SCOPE.GR and kept only lines naming a SCOPE.PO --
 * so `headers` and `scope` came out identical (400 and 400 on the 2026-09-07
 * snapshot). The reconcile then classifies every ERP claim three ways:
 *
 *     in the book and in scope        -> compared
 *     in the book, NOT in scope       -> "present though out of scope"
 *     NOT in the book                 -> "phantom", i.e. a document the ERP
 *                                        invented and the book never had
 *
 * When the book side IS the scope, the middle category cannot occur, so a
 * receipt the book plainly states lands in the third and is reported as
 * invented. Run 34148510412 reported 97 that way, every one of them real.
 *
 * The invariant, and it is the whole point: A PAIR THE BOOK STATES IS NEVER
 * PHANTOM, however the population is drawn.
 */
import { describe, expect, test } from 'vitest';
import { grPairGrain } from '../scripts/lib/ac-gr-pair-grain.mjs';

/* A receipt raised against two purchase orders, only one of them in scope --
   the exact shape of all 97 (e.g. GR-005239 covers PO-009815 and PO-009824). */
const line = (dtlKey, fromDocNo, extra = {}) => ({
  dtlKey, fromDocType: 'PO', fromDocNo,
  subTotalSen: 1000, docSubTotalSen: 1000, ...extra,
});
const header = () => ({ docDate: '2026-08-01', cancelled: 'F', currency: 'MYR', rate: 1 });

const book = {
  GR: {
    headers: new Map([
      ['GR-001', header()],   // in scope: reaches SCOPE.GR via PO-IN
      ['GR-002', header()],   // out of scope entirely -- no in-scope PO line
    ]),
    lines: new Map([
      ['GR-001', [line(11, 'PO-IN'), line(12, 'PO-OUT')]],
      ['GR-002', [line(21, 'PO-OUT2')]],
    ]),
    desc2: new Map(),
  },
};
/* SCOPE.GR holds GR-001 only (it has >=1 line naming an in-scope PO);
   SCOPE.PO holds PO-IN only. */
const SCOPE = { GR: new Set(['GR-001']), PO: new Set(['PO-IN']) };

describe('AutoCount goods receipts at (receipt x purchase order) pair grain', () => {
  const { view, scope } = grPairGrain(book, SCOPE);

  test('the book side states every pair the book actually has', () => {
    expect([...view.headers.keys()].sort()).toEqual(
      ['GR-001|PO-IN', 'GR-001|PO-OUT', 'GR-002|PO-OUT2'],
    );
  });

  test('the expected population is the in-scope subset, and only that', () => {
    expect([...scope]).toEqual(['GR-001|PO-IN']);
  });

  test('the book side is a STRICT superset of the population', () => {
    for (const k of scope) expect(view.headers.has(k)).toBe(true);
    expect(view.headers.size).toBeGreaterThan(scope.size);
  });

  /* The regression itself, stated the way the reconcile asks it. */
  test('a pair the book states is never phantom, in or out of scope', () => {
    const erpClaims = ['GR-001|PO-IN', 'GR-001|PO-OUT', 'GR-002|PO-OUT2'];
    const phantom = erpClaims.filter((k) => !view.headers.has(k));
    const outOfScopeMirrored = erpClaims.filter((k) => view.headers.has(k) && !scope.has(k));
    expect(phantom).toEqual([]);
    expect(outOfScopeMirrored.sort()).toEqual(['GR-001|PO-OUT', 'GR-002|PO-OUT2']);
  });

  test('a pair the book does NOT state is still reported phantom', () => {
    expect(view.headers.has('GR-999|PO-NOPE')).toBe(false);
  });

  test('a pair header totals only ITS OWN lines', () => {
    // GR-001 has two lines of 1000 sen, one per purchase order: 1000 each,
    // never the receipt's 2000 -- that is the total the ERP document can equal.
    expect(view.headers.get('GR-001|PO-IN').totalSen).toBe(1000);
    expect(view.headers.get('GR-001|PO-IN').lineCount).toBe(1);
  });
});
