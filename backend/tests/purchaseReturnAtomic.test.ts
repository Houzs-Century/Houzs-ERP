// A supplier return's stock and ledger writes are all or nothing
// (PURCHASE_RETURN_MODE=atomic, lib/stock-post-tx.ts, lib/purchase-return-stock.ts).
//
// A PR is created POSTED and its stock OUT, its GRN line's returned_qty and the
// PO line's received_qty recount used to be separate PostgREST writes; so was
// the cancel's flip, its reversing IN and the recount that releases the lines.
// A failure in between left a return that said one thing and a ledger that said
// another. These tests drive the real cores over fakeSb, with a fake runner
// that puts every table back when the work answers !ok or throws. Real
// Postgres: tests-pg/purchaseReturnAtomic.pg.test.ts.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { cancelPurchaseReturnHandler } from '../src/scm/routes/purchase-returns';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { STOCK_TX_ROLLED_BACK, STOCK_TX_UNAVAILABLE, type StockTx, type StockTxClient } from '../src/scm/lib/stock-post-tx';
import {
  cancelPrAtomically, isPrFlipMiss, postCreatedPrAtomically, recountGrnLines, type PrFlipResult,
} from '../src/scm/lib/purchase-return-stock';

const CO = 1;
const OTHER_CO = 2;

/* One PO line of 3, received in full on one POSTED GRN; a CREDIT return of 1 of
   them, already inserted POSTED (the create inserts before its stock writes). */
function tables(opts: { booked?: boolean; replaces?: boolean } = {}): Record<string, Row[]> {
  return {
    purchase_returns: [
      { id: 'pr-1', return_number: 'HC-PRT-1', company_id: CO, status: 'POSTED', kind: 'CREDIT', repair_warehouse_id: null, supplier_replaces: opts.replaces ?? true, grn_id: 'g-1' },
      { id: 'pr-o', return_number: '2990-PRT-1', company_id: OTHER_CO, status: 'POSTED', kind: 'CREDIT', repair_warehouse_id: null, supplier_replaces: true, grn_id: 'g-o' },
    ],
    purchase_return_items: [
      { id: 'pri-1', purchase_return_id: 'pr-1', company_id: CO, grn_item_id: 'gi-1', item_code: 'CHAIR-1', material_name: 'Chair', qty_returned: 1, item_group: 'chair', variants: null },
      { id: 'pri-o', purchase_return_id: 'pr-o', company_id: OTHER_CO, grn_item_id: 'gi-o', item_code: 'SOFA-9', material_name: 'Sofa', qty_returned: 1, item_group: 'sofa', variants: null },
    ],
    grns: [
      { id: 'g-1', status: 'POSTED', warehouse_id: 'w1', company_id: CO },
      { id: 'g-o', status: 'POSTED', warehouse_id: 'w9', company_id: OTHER_CO },
    ],
    grn_items: [
      { id: 'gi-1', grn_id: 'g-1', purchase_order_item_id: 'poi-1', qty_accepted: 3, returned_qty: opts.booked ? 1 : 0, returned_closed_qty: 0, company_id: CO },
      { id: 'gi-o', grn_id: 'g-o', purchase_order_item_id: 'poi-o', qty_accepted: 1, returned_qty: 0, returned_closed_qty: 0, company_id: OTHER_CO },
    ],
    purchase_order_items: [
      { id: 'poi-1', purchase_order_id: 'po-1', qty: 3, received_qty: opts.booked ? 2 : 3 },
      { id: 'poi-o', purchase_order_id: 'po-o', qty: 1, received_qty: 1 },
    ],
    purchase_orders: [
      { id: 'po-1', status: opts.booked ? 'PARTIALLY_RECEIVED' : 'RECEIVED', received_at: opts.booked ? null : '2026-11-01T00:00:00Z' },
      { id: 'po-o', status: 'RECEIVED', received_at: '2026-11-01T00:00:00Z' },
    ],
    warehouses: [{ id: 'w1', code: 'BLK', company_id: CO, is_default: true }],
    inventory_movements: [
      { id: 'm-in', company_id: CO, movement_type: 'IN', warehouse_id: 'w1', item_code: 'CHAIR-1', variant_key: '', batch_no: 'HC-PO-1', qty: 3, product_name: 'Chair', unit_cost_sen: 10000, source_doc_type: 'GRN', source_doc_id: 'g-1', source_doc_no: 'HC-GRN-1' },
      ...(opts.booked
        ? [{ id: 'm-out', company_id: CO, movement_type: 'OUT', warehouse_id: 'w1', item_code: 'CHAIR-1', variant_key: '', batch_no: 'HC-PO-1', qty: 1, product_name: 'Chair', unit_cost_sen: 10000, source_doc_type: 'PURCHASE_RETURN', source_doc_id: 'pr-1', source_doc_no: 'HC-PRT-1' }]
        : []),
    ],
  };
}

type Sb = ReturnType<typeof fakeSb>;

/* One table's writes refused, as a trigger or a constraint would. */
const refusing = (table: string, op: 'insert' | 'update') => (sb: Sb): Sb => ({
  ...sb,
  from: (t: string) => {
    const q = sb.from(t);
    if (t !== table) return q;
    const no = () => {
      const r = { data: null, error: { message: `${table} ${op} refused` } };
      const chain: Record<string, unknown> = {};
      for (const k of ['eq', 'neq', 'in', 'not', 'select']) chain[k] = () => chain;
      chain.maybeSingle = async () => r;
      chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(r).then(ok);
      return chain;
    };
    return { ...q, [op]: no };
  },
}) as Sb;

function fakeTx(sb: Sb, wrap: ((db: Sb) => Sb) | null): StockTx & { rollbacks: number } {
  const run = (async (work: (tx: never) => Promise<{ ok: boolean }>) => {
    const before = JSON.parse(JSON.stringify(sb.tables)) as Record<string, Row[]>;
    const restore = () => {
      for (const k of Object.keys(sb.tables)) delete sb.tables[k];
      Object.assign(sb.tables, before);
      run.rollbacks += 1;
    };
    try {
      const out = await work((wrap ? wrap(sb) : sb) as never);
      if (!out.ok) restore();
      return out;
    } catch (e) {
      restore();
      return { ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503, rolledBack: true, detail: String(e) };
    }
  }) as unknown as StockTx & { rollbacks: number };
  run.rollbacks = 0;
  return run;
}

/* The handler's flip: scoped CAS that refuses COMPLETED and CANCELLED. */
const flipCancel = (companyId: number, id = 'pr-1') => async (t: StockTxClient): Promise<PrFlipResult> => {
  const { data, error } = await (t as unknown as Sb).from('purchase_returns').update({ status: 'CANCELLED' })
    .eq('id', id).eq('company_id', companyId).neq('status', 'CANCELLED').neq('status', 'COMPLETED').select('id').maybeSingle();
  return { data: (data as { id: string } | null) ?? null, error: (error as { message: string } | null) ?? null };
};

const H = { id: 'pr-1', return_number: 'HC-PRT-1' };
const pr = (sb: Sb, id: string) => sb.tables.purchase_returns!.find((p) => p.id === id);
const outs = (sb: Sb) => sb.tables.inventory_movements!.filter((m) => m.source_doc_type === 'PURCHASE_RETURN');

describe('PR create, atomic: OUT, GRN returned and PO received, or nothing', () => {
  test('success: the OUT draws the GRN lot (same batch), the GRN line and the PO line count the return', async () => {
    const sb = fakeSb(tables());
    const tx = fakeTx(sb, null);
    const res = await postCreatedPrAtomically(tx, sb, H, 'g-1', CO, 'u1', ['gi-1']);
    expect(res).toMatchObject({ ok: true, wrote: true });
    expect(tx.rollbacks).toBe(0);
    expect(outs(sb)).toHaveLength(1);
    expect(outs(sb)[0]).toMatchObject({ movement_type: 'OUT', item_code: 'CHAIR-1', qty: 1, warehouse_id: 'w1', batch_no: 'HC-PO-1', company_id: CO });
    expect(sb.tables.grn_items![0]!.returned_qty).toBe(1);
    expect(sb.tables.purchase_order_items![0]!.received_qty).toBe(2);
    expect(sb.tables.purchase_orders![0]!.status).toBe('PARTIALLY_RECEIVED');
  });

  test('no replacement: the GRN line counts it closed and the PO stays RECEIVED, in the same transaction', async () => {
    const sb = fakeSb(tables({ replaces: false }));
    expect((await postCreatedPrAtomically(fakeTx(sb, null), sb, H, 'g-1', CO, 'u1', ['gi-1'])).ok).toBe(true);
    expect(sb.tables.grn_items![0]).toMatchObject({ returned_qty: 1, returned_closed_qty: 1 });
    expect(sb.tables.purchase_order_items![0]!.received_qty).toBe(3);
  });

  test('a stock OUT refused: nothing moved, the GRN and PO as they were, the return removed, 503', async () => {
    const sb = fakeSb(tables());
    const res = await postCreatedPrAtomically(fakeTx(sb, refusing('inventory_movements', 'insert')), sb, H, 'g-1', CO, 'u1', ['gi-1']);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.removed).toBe(true);
    expect((res.body as { message: string }).message).toContain('Nothing was returned');
    expect(outs(sb)).toEqual([]);
    expect(sb.tables.grn_items![0]!.returned_qty).toBe(0);
    expect(sb.tables.purchase_order_items![0]!.received_qty).toBe(3);
    expect(pr(sb, 'pr-1')).toBeUndefined();
    expect(pr(sb, 'pr-o')).toBeDefined();
  });

  test('a PO recount refused AFTER the OUT takes the OUT back with it', async () => {
    const sb = fakeSb(tables());
    const res = await postCreatedPrAtomically(fakeTx(sb, refusing('purchase_order_items', 'update')), sb, H, 'g-1', CO, 'u1', ['gi-1']);
    expect(res.ok).toBe(false);
    expect(outs(sb)).toEqual([]);
    expect(sb.tables.grn_items![0]!.returned_qty).toBe(0);
  });

  test('a failed line read refuses (refuse-on-failed-read): lines_unreadable', async () => {
    const sb = fakeSb(tables(), { purchase_return_items: ['material_name'] });
    const res = await postCreatedPrAtomically(fakeTx(sb, null), sb, H, 'g-1', CO, 'u1', ['gi-1']);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.body as { error: string }).error).toBe('lines_unreadable');
    expect(outs(sb)).toEqual([]);
  });
});

describe('PR cancel, atomic: flip, reversing IN and recount, or nothing', () => {
  test('success: CANCELLED, the OUT reversed into the same lot at its cost, the GRN and PO lines released', async () => {
    const sb = fakeSb(tables({ booked: true }));
    const res = await cancelPrAtomically(fakeTx(sb, null), 'pr-1', 'u1', flipCancel(CO));
    expect(res.ok).toBe(true);
    expect(pr(sb, 'pr-1')?.status).toBe('CANCELLED');
    const rev = outs(sb).filter((m) => m.movement_type === 'IN');
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ qty: 1, batch_no: 'HC-PO-1', unit_cost_sen: 10000, warehouse_id: 'w1', company_id: CO });
    expect(sb.tables.grn_items![0]!.returned_qty).toBe(0);
    expect(sb.tables.purchase_order_items![0]!.received_qty).toBe(3);
    expect(sb.tables.purchase_orders![0]!.status).toBe('RECEIVED');
    if (res.ok) expect(res.openedLotRows).toHaveLength(1); // the after-commit retro-cost input
  });

  test('a reversing IN refused after the flip leaves the return POSTED and the ledger as it was', async () => {
    const sb = fakeSb(tables({ booked: true }));
    const tx = fakeTx(sb, refusing('inventory_movements', 'insert'));
    const res = await cancelPrAtomically(tx, 'pr-1', 'u1', flipCancel(CO));
    expect(res).toMatchObject({ ok: false, reason: STOCK_TX_ROLLED_BACK });
    expect(tx.rollbacks).toBe(1);
    expect(pr(sb, 'pr-1')?.status).toBe('POSTED');
    expect(outs(sb)).toHaveLength(1);
    expect(sb.tables.grn_items![0]!.returned_qty).toBe(1);
  });

  test('a GRN recount refused after the reversal takes the reversal and the flip with it', async () => {
    const sb = fakeSb(tables({ booked: true }));
    const res = await cancelPrAtomically(fakeTx(sb, refusing('grn_items', 'update')), 'pr-1', 'u1', flipCancel(CO));
    expect(res.ok).toBe(false);
    expect(pr(sb, 'pr-1')?.status).toBe('POSTED');
    expect(outs(sb)).toHaveLength(1);
  });

  test('company scope: another company\'s return is not flipped and nothing moves', async () => {
    const sb = fakeSb(tables({ booked: true }));
    const res = await cancelPrAtomically(fakeTx(sb, null), 'pr-o', 'u1', flipCancel(CO, 'pr-o'));
    expect(isPrFlipMiss(res)).toBe(true);
    expect(pr(sb, 'pr-o')?.status).toBe('POSTED');
    expect(outs(sb)).toHaveLength(1);
  });

  test('safe retry: the second cancel matches no row; no second reversal', async () => {
    const sb = fakeSb(tables({ booked: true }));
    const tx = fakeTx(sb, null);
    expect((await cancelPrAtomically(tx, 'pr-1', 'u1', flipCancel(CO))).ok).toBe(true);
    expect(isPrFlipMiss(await cancelPrAtomically(tx, 'pr-1', 'u1', flipCancel(CO)))).toBe(true);
    expect(outs(sb)).toHaveLength(2);
  });

  test('recountGrnLines stops at the first failure and says why', async () => {
    const sb = fakeSb(tables(), { purchase_return_items: ['qty_returned'] });
    const r = await recountGrnLines(sb, ['gi-1', null]);
    expect(r.ok).toBe(false);
  });
});

function app(sb: Sb) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('companyCode' as never, 'HC' as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  a.patch('/purchase-returns/:id/cancel', cancelPurchaseReturnHandler as never);
  return a;
}
const cancel = (a: Hono, env: Record<string, string>) => a.request('/purchase-returns/pr-1/cancel', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}',
}, env);

describe('the cancel route', () => {
  test('no database URL: 503 "Nothing was cancelled", the return stays POSTED, nothing reversed', async () => {
    const sb = fakeSb(tables({ booked: true }));
    const res = await cancel(app(sb), {});
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe(STOCK_TX_UNAVAILABLE);
    expect(body.message).toContain('Nothing was cancelled');
    expect(pr(sb, 'pr-1')?.status).toBe('POSTED');
    expect(outs(sb)).toHaveLength(1);
  });

  test('two-step (the rollback switch) keeps the old path: CANCELLED, reversed, released', async () => {
    const sb = fakeSb(tables({ booked: true }));
    const res = await cancel(app(sb), { PURCHASE_RETURN_MODE: 'two-step' });
    expect(res.status).toBe(200);
    expect(pr(sb, 'pr-1')?.status).toBe('CANCELLED');
    expect(outs(sb)).toHaveLength(2);
    expect(sb.tables.grn_items![0]!.returned_qty).toBe(0);
  });

  test('two-step keeps the old failure shape: a failed reversal is reported, the cancel stands', async () => {
    const sb = refusing('inventory_movements', 'insert')(fakeSb(tables({ booked: true })));
    const res = await cancel(app(sb), { PURCHASE_RETURN_MODE: 'two-step' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reversalErrors?: string[] }).reversalErrors?.[0]).toContain('Stock reversal incomplete');
    expect(pr(sb, 'pr-1')?.status).toBe('CANCELLED');
  });
});
