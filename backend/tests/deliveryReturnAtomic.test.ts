// A customer return's stock writes are all or nothing (DELIVERY_RETURN_MODE=atomic,
// lib/stock-post-tx.ts, lib/delivery-return-stock.ts).
//
// A DR could read RECEIVED with its goods never booked back, or CANCELLED with
// them still on the books: the status write and the stock writes were separate
// PostgREST calls, each committed on its own. The create's stock IN, and the
// cancel's flip with its drain, now run in ONE transaction. These tests drive
// the real cores over fakeSb, with a fake runner that puts every table back when
// the work answers !ok or throws, the rollback a real transaction gives. Real
// Postgres: tests-pg/deliveryReturnAtomic.pg.test.ts.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchDeliveryReturnStatusHandler } from '../src/scm/routes/delivery-returns';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { STOCK_TX_ROLLED_BACK, STOCK_TX_UNAVAILABLE, type StockTx, type StockTxClient } from '../src/scm/lib/stock-post-tx';
import {
  cancelDrAtomically, drResyncCore, isDrFlipMiss, receiveCreatedDrAtomically, type DrFlip,
} from '../src/scm/lib/delivery-return-stock';

const CO = 1;
const OTHER_CO = 2;

function tables(status = 'RECEIVED', booked = false): Record<string, Row[]> {
  return {
    delivery_returns: [
      { id: 'dr-1', return_number: 'HC-DR-1', company_id: CO, status, warehouse_id: 'w1', delivery_order_id: null },
      { id: 'dr-o', return_number: '2990-DR-1', company_id: OTHER_CO, status: 'RECEIVED', warehouse_id: 'w9', delivery_order_id: null },
    ],
    delivery_return_items: [
      { id: 'ri-1', delivery_return_id: 'dr-1', company_id: CO, do_item_id: 'dl-1', item_code: 'CHAIR-1', description: 'Chair', qty_returned: 2, item_group: 'chair', variants: null, unit_cost_sen: 5000 },
      { id: 'ri-o', delivery_return_id: 'dr-o', company_id: OTHER_CO, do_item_id: 'dl-o', item_code: 'SOFA-9', description: 'Sofa', qty_returned: 1, item_group: 'sofa', variants: null, unit_cost_sen: 9000 },
    ],
    delivery_order_items: [
      { id: 'dl-1', so_item_id: null, delivery_order_id: 'do-1', company_id: CO },
      { id: 'dl-o', so_item_id: null, delivery_order_id: 'do-o', company_id: OTHER_CO },
    ],
    delivery_orders: [
      { id: 'do-1', warehouse_id: 'w1', so_doc_no: null, company_id: CO },
      { id: 'do-o', warehouse_id: 'w9', so_doc_no: null, company_id: OTHER_CO },
    ],
    mfg_sales_order_items: [],
    warehouses: [{ id: 'w1', code: 'BLK', company_id: CO, is_default: true }],
    inventory_movements: booked
      ? [{ id: 'm-1', company_id: CO, movement_type: 'IN', warehouse_id: 'w1', item_code: 'CHAIR-1', variant_key: '', batch_no: null, qty: 2, product_name: 'Chair', unit_cost_sen: 5000, source_doc_type: 'DR', source_doc_id: 'dr-1', source_doc_no: 'HC-DR-1' }]
      : [],
  };
}

type Sb = ReturnType<typeof fakeSb>;

/* The stock insert refused, as the FIFO trigger or a constraint would. */
const failingInsert = (sb: Sb): Sb => ({
  ...sb,
  from: (t: string) => {
    const q = sb.from(t);
    if (t !== 'inventory_movements') return q;
    return { ...q, insert: () => ({ then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'fifo trigger refused' } }).then(ok) }) };
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

/* The handler's flip: CAS on the status it read, scoped to the caller's company. */
const flipCancel = (companyId: number, prev: string, id = 'dr-1'): DrFlip => async (t: StockTxClient) => {
  const { data, error } = await (t as unknown as Sb).from('delivery_returns').update({ status: 'CANCELLED' })
    .eq('id', id).eq('company_id', companyId).eq('status', prev).select('id, status').maybeSingle();
  return { data: (data as { id: string; status: string } | null) ?? null, error: (error as { message: string } | null) ?? null };
};

const dr = (sb: Sb, id: string) => sb.tables.delivery_returns!.find((d) => d.id === id);

describe('DR create, atomic: the stock IN or nothing', () => {
  test('success books the IN at the line cost and keeps the return', async () => {
    const sb = fakeSb(tables());
    const tx = fakeTx(sb, null);
    const res = await receiveCreatedDrAtomically(tx, sb, 'dr-1', 'HC-DR-1', CO, 'u1');
    expect(res.ok).toBe(true);
    expect(tx.rollbacks).toBe(0);
    expect(sb.tables.inventory_movements).toHaveLength(1);
    expect(sb.tables.inventory_movements![0]).toMatchObject({
      movement_type: 'IN', item_code: 'CHAIR-1', qty: 2, unit_cost_sen: 5000, warehouse_id: 'w1',
      source_doc_type: 'DR', source_doc_id: 'dr-1', company_id: CO,
    });
    expect(dr(sb, 'dr-1')?.status).toBe('RECEIVED');
  });

  test('a stock IN refused after the insert: nothing booked, the return and its lines are removed, 503 says so', async () => {
    const sb = fakeSb(tables());
    const res = await receiveCreatedDrAtomically(fakeTx(sb, failingInsert), sb, 'dr-1', 'HC-DR-1', CO, 'u1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.removed).toBe(true);
    expect((res.body as { error: string }).error).toBe(STOCK_TX_ROLLED_BACK);
    expect((res.body as { message: string }).message).toContain('Nothing was received');
    expect(sb.tables.inventory_movements).toEqual([]);
    expect(dr(sb, 'dr-1')).toBeUndefined();
    expect(sb.tables.delivery_return_items!.filter((r) => r.delivery_return_id === 'dr-1')).toEqual([]);
    // The other company's return is not touched by the clean-up.
    expect(dr(sb, 'dr-o')).toBeDefined();
  });

  test('a failed line read refuses (refuse-on-failed-read): lines_unreadable, nothing booked', async () => {
    const sb = fakeSb(tables(), { delivery_return_items: ['unit_cost_sen'] });
    const res = await receiveCreatedDrAtomically(fakeTx(sb, null), sb, 'dr-1', 'HC-DR-1', CO, 'u1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.body as { error: string }).error).toBe('lines_unreadable');
    expect(sb.tables.inventory_movements).toEqual([]);
  });

  test('idempotent retry: a second run books no second IN', async () => {
    const sb = fakeSb(tables());
    const tx = fakeTx(sb, null);
    expect((await receiveCreatedDrAtomically(tx, sb, 'dr-1', 'HC-DR-1', CO, 'u1')).ok).toBe(true);
    expect((await receiveCreatedDrAtomically(tx, sb, 'dr-1', 'HC-DR-1', CO, 'u1')).ok).toBe(true);
    expect(sb.tables.inventory_movements).toHaveLength(1);
  });
});

describe('DR cancel, atomic: the flip and the drain or nothing', () => {
  test('success: CANCELLED and the booked units drained by a signed ADJUSTMENT', async () => {
    const sb = fakeSb(tables('RECEIVED', true));
    const res = await cancelDrAtomically(fakeTx(sb, null), 'dr-1', 'u1', flipCancel(CO, 'RECEIVED'));
    expect(res.ok).toBe(true);
    expect(dr(sb, 'dr-1')?.status).toBe('CANCELLED');
    const adj = sb.tables.inventory_movements!.filter((m) => m.source_doc_type === 'ADJUSTMENT');
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ movement_type: 'ADJUSTMENT', qty: -2, item_code: 'CHAIR-1', warehouse_id: 'w1', source_doc_id: 'dr-1' });
  });

  test('a drain refused after the flip leaves the return RECEIVED with its stock as it was', async () => {
    const sb = fakeSb(tables('RECEIVED', true));
    const tx = fakeTx(sb, failingInsert);
    const res = await cancelDrAtomically(tx, 'dr-1', 'u1', flipCancel(CO, 'RECEIVED'));
    expect(res).toMatchObject({ ok: false, reason: STOCK_TX_ROLLED_BACK });
    expect(tx.rollbacks).toBe(1);
    expect(dr(sb, 'dr-1')?.status).toBe('RECEIVED');
    expect(sb.tables.inventory_movements).toHaveLength(1);
  });

  test('an unreadable movement list refuses: it would book the whole return a second time', async () => {
    const sb = fakeSb(tables('RECEIVED', true), { inventory_movements: ['product_name'] });
    const res = await cancelDrAtomically(fakeTx(sb, null), 'dr-1', 'u1', flipCancel(CO, 'RECEIVED'));
    expect(res).toMatchObject({ ok: false, reason: 'lines_unreadable' });
    expect(dr(sb, 'dr-1')?.status).toBe('RECEIVED');
  });

  test('company scope: a flip scoped to this company does not touch another company\'s return', async () => {
    const sb = fakeSb(tables('RECEIVED', true));
    const res = await cancelDrAtomically(fakeTx(sb, null), 'dr-o', 'u1', flipCancel(CO, 'RECEIVED', 'dr-o'));
    expect(isDrFlipMiss(res)).toBe(true);
    expect(dr(sb, 'dr-o')?.status).toBe('RECEIVED');
    expect(sb.tables.inventory_movements).toHaveLength(1);
  });

  test('safe retry: the second cancel matches no row, and a re-run drain writes nothing', async () => {
    const sb = fakeSb(tables('RECEIVED', true));
    const tx = fakeTx(sb, null);
    expect((await cancelDrAtomically(tx, 'dr-1', 'u1', flipCancel(CO, 'RECEIVED'))).ok).toBe(true);
    expect(isDrFlipMiss(await cancelDrAtomically(tx, 'dr-1', 'u1', flipCancel(CO, 'RECEIVED')))).toBe(true);
    expect((await drResyncCore(sb, 'dr-1', 'u1')).written).toEqual([]);
    expect(sb.tables.inventory_movements!.filter((m) => m.source_doc_type === 'ADJUSTMENT')).toHaveLength(1);
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
  a.patch('/delivery-returns/:id/status', patchDeliveryReturnStatusHandler as never);
  return a;
}
const cancel = (a: Hono, env: Record<string, string>) => a.request('/delivery-returns/dr-1/status', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'CANCELLED' }),
}, env);

describe('the cancel route', () => {
  test('no database URL: 503 "Nothing was cancelled", the return stays RECEIVED, nothing drained', async () => {
    const sb = fakeSb(tables('RECEIVED', true));
    const res = await cancel(app(sb), {});
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe(STOCK_TX_UNAVAILABLE);
    expect(body.message).toContain('Nothing was cancelled');
    expect(dr(sb, 'dr-1')?.status).toBe('RECEIVED');
    expect(sb.tables.inventory_movements).toHaveLength(1);
  });

  test('two-step (the rollback switch) keeps the old path: CANCELLED with the drain', async () => {
    const sb = fakeSb(tables('RECEIVED', true));
    const res = await cancel(app(sb), { DELIVERY_RETURN_MODE: 'two-step' });
    expect(res.status).toBe(200);
    expect(dr(sb, 'dr-1')?.status).toBe('CANCELLED');
    expect(sb.tables.inventory_movements!.filter((m) => m.source_doc_type === 'ADJUSTMENT')).toHaveLength(1);
  });

  test('two-step keeps the old failure shape: a failed drain is reported, the return stays CANCELLED', async () => {
    const sb = failingInsert(fakeSb(tables('RECEIVED', true)));
    const res = await cancel(app(sb), { DELIVERY_RETURN_MODE: 'two-step' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { movementErrors?: string[] }).movementErrors?.[0]).toContain('fifo trigger refused');
    expect(dr(sb, 'dr-1')?.status).toBe('CANCELLED');
  });
});
