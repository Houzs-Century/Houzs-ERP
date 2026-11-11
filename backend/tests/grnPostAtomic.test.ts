// A GRN post is all or nothing (GRN_POST_MODE=atomic, lib/stock-post-tx.ts).
//
// Production found HC-GRN-2609-118 POSTED with no stock IN and HC-GRN-2610-045
// with a PO count that disagreed with its lines: the flip, the PO recount, the
// landed allocation and the stock IN were separate PostgREST writes, each
// committed on its own. The core now runs in ONE transaction. These tests drive
// the real postGrnAndRollup through a fake runner that puts every table back
// when the work answers !ok or throws, the rollback a real transaction gives.
// The real-Postgres proof is tests-pg/grnPostAtomic.pg.test.ts.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { postGrnAndRollup, postGrnHandler } from '../src/scm/routes/grns';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  STOCK_TX_ROLLED_BACK, STOCK_TX_UNAVAILABLE, stockPostMode, stockTxFor, type StockTx,
} from '../src/scm/lib/stock-post-tx';

const CO = 1;
const OTHER_CO = 2;

function tables(): Record<string, Row[]> {
  return {
    grns: [
      { id: 'g-1', grn_number: 'GRN-1', company_id: CO, status: 'DRAFT', warehouse_id: 'w1', exchange_rate: 1, allocation_method: 'QTY', received_at: '2026-11-01', total_sen: 0 },
      { id: 'g-other', grn_number: '2990-GRN-1', company_id: OTHER_CO, status: 'DRAFT', warehouse_id: 'w9', exchange_rate: 1, allocation_method: 'QTY', received_at: '2026-11-01', total_sen: 0 },
    ],
    grn_items: [
      { id: 'gi-1', grn_id: 'g-1', company_id: CO, purchase_order_item_id: 'poi-1', qty_accepted: 3, qty_received: 3, item_code: 'SKU-1', material_name: 'Chair', unit_price_sen: 10_000, line_total_sen: 30_000, item_group: 'chair', variants: null, zero_cost_ack: false, returned_qty: 0, returned_closed_qty: 0, allocated_charge_sen: 0 },
      { id: 'gi-o', grn_id: 'g-other', company_id: OTHER_CO, purchase_order_item_id: 'poi-o', qty_accepted: 4, qty_received: 4, item_code: 'SKU-9', material_name: 'Sofa', unit_price_sen: 50_000, line_total_sen: 200_000, item_group: 'sofa', variants: null, zero_cost_ack: false, returned_qty: 0, returned_closed_qty: 0, allocated_charge_sen: 0 },
    ],
    purchase_order_items: [
      { id: 'poi-1', purchase_order_id: 'po-1', qty: 5, received_qty: 0, warehouse_id: 'w1' },
      { id: 'poi-o', purchase_order_id: 'po-o', qty: 4, received_qty: 0, warehouse_id: 'w9' },
    ],
    purchase_orders: [
      { id: 'po-1', po_number: 'PO-1', status: 'SUBMITTED', company_id: CO, received_at: null },
      { id: 'po-o', po_number: '2990-PO-1', status: 'SUBMITTED', company_id: OTHER_CO, received_at: null },
    ],
    mfg_products: [],
    inventory_movements: [],
  };
}

type Sb = ReturnType<typeof fakeSb>;

/** Fails the stock IN insert the way a refused statement does. */
const failingMovements = (sb: Sb): Sb => ({
  ...sb,
  from: (t: string) => {
    const q = sb.from(t);
    if (t !== 'inventory_movements') return q;
    return { ...q, insert: () => ({ then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'trigger refused' } }).then(ok) }) };
  },
}) as Sb;

/** Throws on the PO status write, the way the transaction client throws a refused statement. */
const throwingPoWrite = (sb: Sb): Sb => ({
  ...sb,
  from: (t: string) => {
    const q = sb.from(t);
    if (t !== 'purchase_orders') return q;
    return { ...q, update: () => { throw new Error('PO write refused'); } };
  },
}) as Sb;

/** A StockTx over the fake: commits on ok, puts every table back on !ok or a throw. */
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

const grn = (sb: Sb, id: string) => sb.tables.grns!.find((g) => g.id === id)!;
const poLine = (sb: Sb, id: string) => sb.tables.purchase_order_items!.find((p) => p.id === id)!;

describe('GRN post, atomic: all or nothing', () => {
  test('success writes everything: POSTED, stock IN on the received date, PO recounted', async () => {
    const sb = fakeSb(tables());
    const tx = fakeTx(sb, null);
    const res = await postGrnAndRollup(sb, 'g-1', 'u1', CO, 'DRAFT', tx);
    expect(res.ok).toBe(true);
    expect(tx.rollbacks).toBe(0);
    expect(grn(sb, 'g-1').status).toBe('POSTED');
    expect(sb.tables.inventory_movements).toHaveLength(1);
    expect(sb.tables.inventory_movements![0]).toMatchObject({
      movement_type: 'IN', item_code: 'SKU-1', qty: 3, unit_cost_sen: 10_000,
      source_doc_type: 'GRN', source_doc_id: 'g-1', movement_date: '2026-11-01', batch_no: 'PO-1', company_id: CO,
    });
    expect(poLine(sb, 'poi-1').received_qty).toBe(3);
    expect(sb.tables.purchase_orders!.find((p) => p.id === 'po-1')!.status).toBe('PARTIALLY_RECEIVED');
  });

  test('a stock IN that fails after the flip leaves the GRN DRAFT, no movement, PO untouched', async () => {
    const sb = fakeSb(tables());
    const tx = fakeTx(sb, failingMovements);
    const res = await postGrnAndRollup(sb, 'g-1', 'u1', CO, 'DRAFT', tx);
    expect(res).toMatchObject({ ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503 });
    expect(tx.rollbacks).toBe(1);
    expect(grn(sb, 'g-1').status).toBe('DRAFT');
    expect(grn(sb, 'g-1').posted_at).toBeUndefined();
    expect(sb.tables.inventory_movements).toEqual([]);
    expect(poLine(sb, 'poi-1').received_qty).toBe(0);
  });

  test('a PO recount that fails after the flip rolls the flip back too', async () => {
    const sb = fakeSb(tables());
    const tx = fakeTx(sb, throwingPoWrite);
    const res = await postGrnAndRollup(sb, 'g-1', 'u1', CO, 'DRAFT', tx);
    expect(res).toMatchObject({ ok: false, reason: STOCK_TX_ROLLED_BACK });
    expect((res as { detail?: string }).detail).toContain('PO received recount');
    expect(grn(sb, 'g-1').status).toBe('DRAFT');
    expect(sb.tables.inventory_movements).toEqual([]);
    expect(poLine(sb, 'poi-1').received_qty).toBe(0);
  });

  test('a failed read refuses before writing (refuse-on-failed-read holds in atomic mode)', async () => {
    const sb = fakeSb(tables(), { grn_items: ['zero_cost_ack'] });
    const res = await postGrnAndRollup(sb, 'g-1', 'u1', CO, 'DRAFT', fakeTx(sb, null));
    expect(res).toMatchObject({ ok: false, reason: 'lines_unreadable', status: 503 });
    expect(grn(sb, 'g-1').status).toBe('DRAFT');
    expect(sb.tables.inventory_movements).toEqual([]);
  });

  test('company scope: posting another company\'s GRN id writes nothing to it', async () => {
    const sb = fakeSb(tables());
    const res = await postGrnAndRollup(sb, 'g-other', 'u1', CO, 'DRAFT', fakeTx(sb, null));
    expect(res.ok).toBe(false);
    expect(grn(sb, 'g-other').status).toBe('DRAFT');
    expect(sb.tables.inventory_movements).toEqual([]);
    expect(poLine(sb, 'poi-o').received_qty).toBe(0);
  });

  test('idempotent retry: a second post books no second IN', async () => {
    const sb = fakeSb(tables());
    const tx = fakeTx(sb, null);
    expect((await postGrnAndRollup(sb, 'g-1', 'u1', CO, 'DRAFT', tx)).ok).toBe(true);
    // The retry saw DRAFT: its CAS matches nothing.
    const again = await postGrnAndRollup(sb, 'g-1', 'u1', CO, 'DRAFT', tx);
    expect(again).toMatchObject({ ok: false, reason: 'already_posting', status: 409 });
    // A re-entry on the POSTED row: the already-booked guard holds.
    const reentry = await postGrnAndRollup(sb, 'g-1', 'u1', CO, 'POSTED', tx);
    expect(reentry.ok).toBe(true);
    expect(sb.tables.inventory_movements).toHaveLength(1);
    expect(poLine(sb, 'poi-1').received_qty).toBe(3);
  });

  test('after a rolled-back post, the retry posts cleanly', async () => {
    const sb = fakeSb(tables());
    await postGrnAndRollup(sb, 'g-1', 'u1', CO, 'DRAFT', fakeTx(sb, failingMovements));
    const res = await postGrnAndRollup(sb, 'g-1', 'u1', CO, 'DRAFT', fakeTx(sb, null));
    expect(res.ok).toBe(true);
    expect(sb.tables.inventory_movements).toHaveLength(1);
  });
});

describe('GRN post, two-step (the rollback switch) keeps the old behaviour', () => {
  test('a failed stock IN leaves the post standing and reports it', async () => {
    const sb = failingMovements(fakeSb(tables()));
    const res = await postGrnAndRollup(sb, 'g-1', 'u1', CO, 'DRAFT', null);
    expect(res.ok).toBe(true);
    expect((res as { movementErrors?: string[] }).movementErrors?.[0]).toContain('trigger refused');
    expect(grn(sb, 'g-1').status).toBe('POSTED');
    expect(poLine(sb, 'poi-1').received_qty).toBe(3);
  });
});

describe('the switch', () => {
  test('atomic unless it says two-step', () => {
    expect(stockPostMode(undefined, 'GRN_POST_MODE')).toBe('atomic');
    expect(stockPostMode({ GRN_POST_MODE: 'atomic' }, 'GRN_POST_MODE')).toBe('atomic');
    expect(stockPostMode({ GRN_POST_MODE: 'nonsense' }, 'GRN_POST_MODE')).toBe('atomic');
    expect(stockPostMode({ GRN_POST_MODE: ' Two-Step ' }, 'GRN_POST_MODE')).toBe('two-step');
    expect(stockTxFor({ GRN_POST_MODE: 'two-step' }, 'GRN_POST_MODE')).toBeNull();
  });

  test('no database URL: refuses without running the work, never falls back', async () => {
    const tx = stockTxFor({}, 'GRN_POST_MODE')!;
    let ran = false;
    const res = await tx(async () => { ran = true; return { ok: true }; });
    expect(ran).toBe(false);
    expect(res).toMatchObject({ ok: false, reason: STOCK_TX_UNAVAILABLE });
  });

  test('the confirm route: no database URL answers 503 "nothing was posted" and the GRN stays DRAFT', async () => {
    const sb = fakeSb(tables());
    sb.rpcHandlers.entity_audit_writable = () => true;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, sb as never);
      c.set('companyId' as never, CO as never);
      c.set('allowedCompanyIds' as never, [CO] as never);
      c.set('user' as never, { id: 'u1' } as never);
      c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
      await next();
    });
    app.patch('/grns/:id/post', postGrnHandler as never);
    const res = await app.request('/grns/g-1/post', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' }, {});
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe(STOCK_TX_UNAVAILABLE);
    expect(body.message).toContain('Nothing was posted');
    expect(grn(sb, 'g-1').status).toBe('DRAFT');
    expect(sb.tables.inventory_movements).toEqual([]);
  });
});
