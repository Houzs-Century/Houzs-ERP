// A DO's first ship is all or nothing (DO_SHIP_MODE=atomic, lib/stock-post-tx.ts).
//
// HC-DO-2610-319 shipped with 4 lines and no stock OUT: the status flip, the OUT
// rows and the rack STOCK_OUT rows were separate PostgREST writes, each committed
// on its own. They now run in ONE transaction. These tests drive the real
// shipDoAtomically (and through it the real deduction) over fakeSb, with a fake
// runner that puts every table back when the work answers !ok or throws, the
// rollback a real transaction gives. Real Postgres: tests-pg/doShipAtomic.pg.test.ts.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchDeliveryOrderStatusHandler, shipDoAtomically } from '../src/scm/routes/delivery-orders-mfg';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { STOCK_TX_ROLLED_BACK, STOCK_TX_UNAVAILABLE, type StockTx, type StockTxClient } from '../src/scm/lib/stock-post-tx';
import { doShipFailureResponse, keepCreatedDoAsDraft, type DoShipFlip } from '../src/scm/lib/do-ship-atomic';

const CO = 1;
const OTHER_CO = 2;

function tables(): Record<string, Row[]> {
  return {
    delivery_orders: [
      { id: 'do-1', do_number: 'HC-DO-1', company_id: CO, status: 'DRAFT', so_doc_no: null, warehouse_id: 'w1', is_dropship: false, migrated_no_stock: false },
      { id: 'do-o', do_number: '2990-DO-1', company_id: OTHER_CO, status: 'DRAFT', so_doc_no: null, warehouse_id: 'w9', is_dropship: false, migrated_no_stock: false },
    ],
    delivery_order_items: [
      { id: 'l1', delivery_order_id: 'do-1', company_id: CO, so_item_id: null, item_code: 'CHAIR-1', description: 'Chair', qty: 2, item_group: 'chair', variants: null, rack_id: null, committed_po_batch_no: null },
      { id: 'l-o', delivery_order_id: 'do-o', company_id: OTHER_CO, so_item_id: null, item_code: 'SOFA-9', description: 'Sofa', qty: 1, item_group: 'sofa', variants: null, rack_id: null, committed_po_batch_no: null },
    ],
    warehouses: [{ id: 'w1', code: 'BLK', company_id: CO, is_default: true }],
    warehouse_racks: [{ id: 'r1', rack: 'A-01', warehouse_id: 'w1', company_id: CO, reserved: false }],
    warehouse_rack_items: [{ id: 'ri1', rack_id: 'r1', item_code: 'CHAIR-1', qty: 5, stocked_in_date: '2026-10-01', company_id: CO }],
    warehouse_rack_movements: [],
    inventory_movements: [],
    mfg_sales_order_items: [],
  };
}

type Sb = ReturnType<typeof fakeSb>;

const failingOut = (sb: Sb): Sb => ({
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

/* The handler's flip, over the status the caller read and the caller's company. */
const flipTo = (companyId: number, prev: string, to: string, id = 'do-1'): DoShipFlip => async (t: StockTxClient) => {
  const { data } = await (t as unknown as Sb).from('delivery_orders').update({ status: to }).eq('id', id).eq('company_id', companyId)
    .eq('status', prev).select('id, status').maybeSingle();
  return data ? { ok: true, data: data as { id: string; status: string } } : { ok: false, reason: 'status_changed' };
};

const doRow = (sb: Sb, id: string) => sb.tables.delivery_orders!.find((d) => d.id === id)!;

describe('DO ship, atomic: all or nothing', () => {
  test('success writes everything: LOADED, the OUT row, the rack STOCK_OUT', async () => {
    const sb = fakeSb(tables());
    const tx = fakeTx(sb, null);
    const res = await shipDoAtomically(tx, sb, 'do-1', 'u1', flipTo(CO, 'DRAFT', 'LOADED'));
    expect(res.ok).toBe(true);
    expect(tx.rollbacks).toBe(0);
    expect(doRow(sb, 'do-1').status).toBe('LOADED');
    expect(sb.tables.inventory_movements).toHaveLength(1);
    expect(sb.tables.inventory_movements![0]).toMatchObject({ movement_type: 'OUT', item_code: 'CHAIR-1', qty: 2, source_doc_type: 'DO', source_doc_id: 'do-1', warehouse_id: 'w1', company_id: CO });
    expect(sb.tables.warehouse_rack_movements).toHaveLength(1);
    expect(sb.tables.warehouse_rack_movements![0]).toMatchObject({ movement_type: 'STOCK_OUT', rack_id: 'r1', quantity: 2, source_doc_no: 'HC-DO-1' });
    expect(sb.tables.warehouse_rack_items![0]!.qty).toBe(3);
  });

  test('an OUT that fails after the flip leaves the DO DRAFT, no movement, the rack untouched', async () => {
    const sb = fakeSb(tables());
    const tx = fakeTx(sb, failingOut);
    const res = await shipDoAtomically(tx, sb, 'do-1', 'u1', flipTo(CO, 'DRAFT', 'LOADED'));
    expect(res).toMatchObject({ ok: false, reason: STOCK_TX_ROLLED_BACK });
    expect(tx.rollbacks).toBe(1);
    expect(doRow(sb, 'do-1').status).toBe('DRAFT');
    expect(sb.tables.inventory_movements).toEqual([]);
    expect(sb.tables.warehouse_rack_movements).toEqual([]);
    expect(sb.tables.warehouse_rack_items![0]!.qty).toBe(5);
    expect(doShipFailureResponse(res as { reason: string }).status).toBe(503);
  });

  test('a failed line read refuses and rolls the flip back (refuse-on-failed-read holds)', async () => {
    const sb = fakeSb(tables(), { delivery_order_items: ['committed_po_batch_no'] });
    const res = await shipDoAtomically(fakeTx(sb, null), sb, 'do-1', 'u1', flipTo(CO, 'DRAFT', 'LOADED'));
    expect(res).toMatchObject({ ok: false, reason: 'lines_unreadable' });
    expect(doRow(sb, 'do-1').status).toBe('DRAFT');
    expect(sb.tables.inventory_movements).toEqual([]);
  });

  test('company scope: a flip scoped to this company does not touch another company\'s DO', async () => {
    const sb = fakeSb(tables());
    const res = await shipDoAtomically(fakeTx(sb, null), sb, 'do-o', 'u1', flipTo(CO, 'DRAFT', 'LOADED', 'do-o'));
    expect(res).toMatchObject({ ok: false, reason: 'status_changed' });
    expect(doRow(sb, 'do-o').status).toBe('DRAFT');
    expect(sb.tables.inventory_movements).toEqual([]);
  });

  test('idempotent retry: a second ship writes no second OUT', async () => {
    const sb = fakeSb(tables());
    const tx = fakeTx(sb, null);
    expect((await shipDoAtomically(tx, sb, 'do-1', 'u1', flipTo(CO, 'DRAFT', 'LOADED'))).ok).toBe(true);
    // The retry read DRAFT: its CAS matches nothing.
    expect(await shipDoAtomically(tx, sb, 'do-1', 'u1', flipTo(CO, 'DRAFT', 'LOADED'))).toMatchObject({ ok: false, reason: 'status_changed' });
    // A create re-entry (no flip): the existing-OUT guard holds.
    expect((await shipDoAtomically(tx, sb, 'do-1', 'u1', null)).ok).toBe(true);
    expect(sb.tables.inventory_movements).toHaveLength(1);
    expect(sb.tables.warehouse_rack_movements).toHaveLength(1);
  });

  test('create-as-confirmed: a rolled-back ship puts the LOADED DO back to DRAFT and says so', async () => {
    const sb = fakeSb(tables());
    doRow(sb, 'do-1').status = 'LOADED';
    const res = await shipDoAtomically(fakeTx(sb, failingOut), sb, 'do-1', 'u1', null);
    expect(res.ok).toBe(false);
    const body = await keepCreatedDoAsDraft(sb, 'do-1', CO, 'HC-DO-1', res as { reason: string });
    expect(body).toMatchObject({ reverted: true });
    expect((body as { message: string }).message).toContain('HC-DO-1 was kept as a DRAFT');
    expect(doRow(sb, 'do-1').status).toBe('DRAFT');
    expect(sb.tables.inventory_movements).toEqual([]);
  });
});

function app(sb: Sb) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  a.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  return a;
}
const confirm = (a: Hono, env: Record<string, string>) => a.request('/delivery-orders/do-1/status', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'LOADED', confirmShortStock: true }),
}, env);

describe('the Confirm route', () => {
  test('no database URL: 503 "Nothing was shipped", the DO stays DRAFT, nothing moved', async () => {
    const sb = fakeSb(tables());
    const res = await confirm(app(sb), {});
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe(STOCK_TX_UNAVAILABLE);
    expect(body.message).toContain('Nothing was shipped');
    expect(doRow(sb, 'do-1').status).toBe('DRAFT');
    expect(sb.tables.inventory_movements).toEqual([]);
  });

  test('two-step (the rollback switch) keeps the old path: LOADED with the OUT', async () => {
    const sb = fakeSb(tables());
    const res = await confirm(app(sb), { DO_SHIP_MODE: 'two-step' });
    expect(res.status).toBe(200);
    expect(doRow(sb, 'do-1').status).toBe('LOADED');
    expect(sb.tables.inventory_movements).toHaveLength(1);
  });

  test('two-step keeps the old failure shape too: a failed OUT is reported, the DO stays LOADED', async () => {
    const sb = failingOut(fakeSb(tables()));
    const res = await confirm(app(sb), { DO_SHIP_MODE: 'two-step' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { movementErrors?: string[] }).movementErrors?.[0]).toContain('fifo trigger refused');
    expect(doRow(sb, 'do-1').status).toBe('LOADED');
  });
});
