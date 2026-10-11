// "Has this SKU / Model been used yet?" — the guard whose whole job is to say
// NO, which used to say YES when it could not look.
//
// findSkuUsage bound the PostgREST error and discarded it (`if (error) continue`)
// and findModelUsage never bound one, so a blip on mfg_sales_order_items came
// back as "never sold" — the exact absence that authorises the delete this guard
// exists to refuse, and on ?force=true the delete that also wipes
// inventory_movements and the supplier bindings for that code.
import { describe, expect, test } from 'vitest';
import { findSkuUsage, findModelUsage, isMissingTable } from './sku-usage';

type Row = Record<string, unknown>;

/** PostgREST stand-in. `fail` maps a table to the error it answers with. */
function fakeSb(tables: Record<string, Row[]>, fail: Record<string, { code?: string; message: string }> = {}) {
  return {
    from(table: string) {
      const eqs: Array<[string, unknown]> = [];
      const rows = () => (tables[table] ?? []).filter((r) => eqs.every(([c, v]) => r[c] === v));
      const b: Record<string, unknown> = {
        select() { return b; },
        eq(col: string, val: unknown) { eqs.push([col, val]); return b; },
        limit() { return b; },
        then(resolve: (v: unknown) => unknown) {
          const err = fail[table];
          return Promise.resolve(
            err ? { data: null, error: err } : { data: rows(), error: null },
          ).then(resolve);
        },
      };
      return b;
    },
  } as never;
}

describe('findSkuUsage — where a code is already spent', () => {
  test('an unused code is provably unused', async () => {
    const sb = fakeSb({ mfg_sales_order_items: [], purchase_order_items: [], inventory_movements: [] });
    expect(await findSkuUsage(sb, 'NEW-1')).toEqual({ ok: true, usage: null });
  });

  test('a sold code reports the sales order it is on', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [{ item_code: 'SOLD-1', doc_no: 'HC-SO-2607-013' }],
    });
    expect(await findSkuUsage(sb, 'SOLD-1'))
      .toEqual({ ok: true, usage: { where: 'a sales order', doc: 'HC-SO-2607-013' } });
  });

  test('a code that only ever moved in stock is still used', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [], purchase_order_items: [],
      inventory_movements: [{ product_code: 'MOVED-1', source_doc_no: 'GRN-1' }],
    });
    expect((await findSkuUsage(sb, 'MOVED-1')) as { usage: unknown })
      .toMatchObject({ ok: true, usage: { where: 'a stock movement' } });
  });

  test('an empty code is not a probe at all', async () => {
    expect(await findSkuUsage(fakeSb({}), '')).toEqual({ ok: true, usage: null });
  });
});

describe('isMissingTable — "absent" told apart from "failed"', () => {
  test('the two ways PostgREST says the table is not there', () => {
    expect(isMissingTable({ code: 'PGRST205', message: "Could not find the table 'scm.x'" })).toBe(true);
    expect(isMissingTable({ code: '42P01', message: 'relation "scm.x" does not exist' })).toBe(true);
    expect(isMissingTable({ message: 'relation "scm.x" does not exist' })).toBe(true);
  });

  /* This is the whole reason the predicate is spelled out instead of a bare
     `if (error) continue` — the errors below are NOT absences. */
  test('a timeout, a reset and an RLS denial are failures, not absences', () => {
    expect(isMissingTable({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false);
    expect(isMissingTable({ message: 'connection reset by peer' })).toBe(false);
    expect(isMissingTable({ code: '42501', message: 'permission denied for table mfg_sales_order_items' })).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });
});

/* ── THE REGRESSION ────────────────────────────────────────────────────────
   Make the probe's read REJECT and assert the verdict is a refusal, not
   "unused". If the error binding is dropped again these fail: `data` is null,
   the loop finds nothing, and the function reports a SKU that is sold on a live
   order as free to delete.

   A failed read must never read as an absence when the absence is what
   authorises the write. */
describe('a probe that failed is not "unused"', () => {
  test('a SKU whose usage could not be read is NOT reported unused', async () => {
    const sb = fakeSb(
      { mfg_sales_order_items: [{ item_code: 'SOLD-1', doc_no: 'HC-SO-1' }] },
      { mfg_sales_order_items: { message: 'connection reset' } },
    );
    const verdict = await findSkuUsage(sb, 'SOLD-1');
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining('connection reset') });
  });

  test('a failure on ANY of the three probes refuses — not just the first', async () => {
    const base = { mfg_sales_order_items: [], purchase_order_items: [], inventory_movements: [] };
    for (const table of ['mfg_sales_order_items', 'purchase_order_items', 'inventory_movements']) {
      const verdict = await findSkuUsage(fakeSb(base, { [table]: { message: 'timeout' } }), 'X-1');
      expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining(table) });
    }
  });

  /* The one tolerance the original comment was reaching for, kept exactly and
     no wider: a table that does not exist on a fresh deployment records nothing,
     so it really is "no usage here". */
  test('a table that does not exist yet is still tolerated', async () => {
    const sb = fakeSb(
      { purchase_order_items: [], inventory_movements: [] },
      { mfg_sales_order_items: { code: '42P01', message: 'relation "scm.mfg_sales_order_items" does not exist' } },
    );
    expect(await findSkuUsage(sb, 'X-1')).toEqual({ ok: true, usage: null });
  });

  test("a model whose SKU LIST could not be read is NOT reported unused", async () => {
    // Zero iterations used to mean "no SKU under this model is used".
    const sb = fakeSb({ mfg_products: [{ model_id: 'm1', code: 'A-1' }] }, { mfg_products: { message: 'timeout' } });
    expect(await findModelUsage(sb, 'm1')).toMatchObject({ ok: false });
  });

  test("a model refuses when one of its SKUs' probes could not be read", async () => {
    const sb = fakeSb(
      { mfg_products: [{ model_id: 'm1', code: 'A-1' }], mfg_sales_order_items: [], purchase_order_items: [], inventory_movements: [] },
      { inventory_movements: { message: 'connection reset' } },
    );
    expect(await findModelUsage(sb, 'm1')).toMatchObject({ ok: false });
  });

  test('a model with no used SKU is still provably free', async () => {
    const sb = fakeSb({
      mfg_products: [{ model_id: 'm1', code: 'A-1' }],
      mfg_sales_order_items: [], purchase_order_items: [], inventory_movements: [],
    });
    expect(await findModelUsage(sb, 'm1')).toEqual({ ok: true, usage: null });
  });

  test('a model with a used SKU reports which one', async () => {
    const sb = fakeSb({
      mfg_products: [{ model_id: 'm1', code: 'A-1' }],
      mfg_sales_order_items: [{ item_code: 'A-1', doc_no: 'HC-SO-9' }],
    });
    expect(await findModelUsage(sb, 'm1'))
      .toEqual({ ok: true, usage: { code: 'A-1', where: 'a sales order', doc: 'HC-SO-9' } });
  });
});
