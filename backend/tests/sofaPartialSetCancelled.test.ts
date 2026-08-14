import { describe, it, expect } from 'vitest';
import { findIncompleteSofaSets } from '../src/scm/lib/sofa-batch-guard';

/* A cancelled sofa module must not count as a member of the "complete set" that
 * findIncompleteSofaSets requires a DO to ship whole.
 *
 * Why this test exists: a cancelled line can never appear on a delivery order —
 * every picker reads live lines only — so if it counted as a set member it would
 * be missing from EVERY delivery and the guard would refuse every DO for that
 * Sales Order with sofa_partial_set, naming an item the operator had already
 * removed. Production held zero cancelled sales-order lines until 2026-08-10,
 * when a repair reinstated two hard-deleted sofa modules that way (PR #1937), so
 * the guard had never been exercised with one. HC-SO-012624 was READY_TO_SHIP at
 * the time. See docs/autocount-line-retirement-plan.md gap 2 and BUG-HISTORY.md.
 *
 * The fake supabase APPLIES the predicates rather than recording them, so the
 * test fails if the `cancelled` filter is dropped — asserting that `.eq` was
 * called would pass against a filter applied to the wrong column. */

type Row = Record<string, unknown>;

function makeSb(tables: Record<string, Row[]>) {
  const makeBuilder = (table: string): unknown => {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const run = () => {
      const rows = (tables[table] ?? []).filter(
        (r) => eqs.every(([k, v]) => r[k] === v) && ins.every(([k, vs]) => vs.includes(r[k] as never)),
      );
      return { data: rows, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = new Proxy(() => undefined, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (onFulfilled: (v: unknown) => unknown) => Promise.resolve(run()).then(onFulfilled);
        }
        return (...args: unknown[]) => {
          if (prop === 'eq') eqs.push([String(args[0]), args[1]]);
          if (prop === 'in') ins.push([String(args[0]), (args[1] ?? []) as unknown[]]);
          return builder;
        };
      },
    });
    return builder;
  };
  return { from: (table: string) => makeBuilder(table) };
}

/* HC-SO-012624 as production holds it: two live READY sofa modules, the
 * restored 9050-2S cancelled, plus an unrelated non-sofa line. */
const SO = 'HC-SO-012624';
const LIVE_A = { id: 'a', doc_no: SO, item_code: '9050-1A(LHF)', item_group: 'sofa', stock_status: 'READY', cancelled: false };
const LIVE_B = { id: 'b', doc_no: SO, item_code: '9050-2A(RHF)', item_group: 'sofa', stock_status: 'READY', cancelled: false };
const DISPOSE = { id: 'd', doc_no: SO, item_code: 'DISPOSE', item_group: 'service', stock_status: 'PENDING', cancelled: false };

const products = [
  { code: '9050-1A(LHF)', category: 'SOFA', company_id: 1 },
  { code: '9050-2A(RHF)', category: 'SOFA', company_id: 1 },
  { code: '9050-2S', category: 'SOFA', company_id: 1 },
  { code: 'DISPOSE', category: 'SERVICE', company_id: 1 },
];

describe('findIncompleteSofaSets — cancelled lines are not set members', () => {
  it('lets the whole live set ship even when a cancelled sofa module sits at READY', async () => {
    /* The worst shape: the cancelled row still carries stock_status READY,
       because so-stock-allocation excludes cancelled rows and so never clears
       the derived columns (gap 1, still open). */
    const cancelledReady = { id: 'c', doc_no: SO, item_code: '9050-2S', item_group: 'sofa', stock_status: 'READY', cancelled: true };
    const sb = makeSb({
      mfg_products: products,
      mfg_sales_order_items: [LIVE_A, LIVE_B, cancelledReady, DISPOSE],
    });

    const out = await findIncompleteSofaSets(sb, ['a', 'b'], 1);

    expect(out).toEqual([]);
  });

  it('still refuses a delivery that leaves a LIVE sofa module behind', async () => {
    const sb = makeSb({
      mfg_products: products,
      mfg_sales_order_items: [LIVE_A, LIVE_B, DISPOSE],
    });

    const out = await findIncompleteSofaSets(sb, ['a'], 1);

    expect(out).toEqual([{ docNo: SO, missingItemCodes: ['9050-2A(RHF)'] }]);
  });

  it('ignores a cancelled line handed in as one of the shipped ids', async () => {
    /* Defence in depth: if a caller ever passes a cancelled so_item_id, it must
       not drag its Sales Order into the check as though a set were being
       shipped. */
    const cancelledReady = { id: 'c', doc_no: SO, item_code: '9050-2S', item_group: 'sofa', stock_status: 'READY', cancelled: true };
    const sb = makeSb({
      mfg_products: products,
      mfg_sales_order_items: [LIVE_A, LIVE_B, cancelledReady, DISPOSE],
    });

    const out = await findIncompleteSofaSets(sb, ['c'], 1);

    expect(out).toEqual([]);
  });
});
