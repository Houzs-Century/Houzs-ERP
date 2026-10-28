// DO revert — the Ops-lead exception power (2026-08-26). Drives the REAL handler
// with a fake PostgREST (mirrors driverPodOwnership.test.ts) so the gating,
// legal-transition rules, downstream lock and reverse-iff-DRAFT decision are
// pinned against the route. The inventory reversal itself is exercised only far
// enough to prove the branch is taken (`inventoryReversed`), not the movement
// rows — reverseInventoryForDo no-ops on a fake whose fn_reverse_do_out rpc
// "succeeds", which is exactly what we want here.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { revertDeliveryOrderHandler } from '../src/scm/routes/delivery-order-revert';

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' = 'select';
  private patch: Row = {};
  private wantCount = false;
  constructor(private rows: Row[]) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.wantCount = true;
    return this;
  }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  is(col: string, val: unknown) {
    if (val === null) this.preds.push((r) => r[col] === null || r[col] === undefined);
    else this.preds.push((r) => r[col] === val);
    return this;
  }
  order() { return this; } limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } or() { return this; }
  private run(): Row[] {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  private result() {
    const hit = this.run();
    return this.wantCount ? { data: hit, count: hit.length, error: null } : { data: hit, error: null };
  }
  maybeSingle() { const r = this.result(); return Promise.resolve({ ...r, data: (r.data as Row[])[0] ?? null }); }
  single() {
    const r = this.result();
    const d = (r.data as Row[])[0] ?? null;
    return Promise.resolve({ data: d, count: (r as any).count, error: d ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve(this.result()).then(res, rej);
  }
}

function revertApp(opts: {
  caps?: string[];
  doStatus?: string;
  hasInvoice?: boolean;
}) {
  const tables: Record<string, Row[]> = {
    delivery_orders: [
      { id: 'do-1', do_number: 'DO-1', company_id: 1, status: opts.doStatus ?? 'LOADED', so_doc_no: 'SO-1', dispatched_at: '2026-08-26T00:00:00Z' },
    ],
    sales_invoices: opts.hasInvoice ? [{ id: 'si-1', delivery_order_id: 'do-1', status: 'DRAFT', invoice_number: 'SI-1' }] : [],
    delivery_returns: [],
    inventory_movements: [],
    delivery_order_items: [],
    warehouse_racks: [],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'staff-uuid' } as never);
    c.set('houzsUser' as never, {
      id: 42,
      name: 'Ops Lead',
      position_name: 'Operation Executive',
      permissions_set: new Set<string>(),
      position_capabilities: opts.caps ?? ['scm.do.revert'],
    } as never);
    await next();
  });
  app.post('/delivery-orders/:id/revert', revertDeliveryOrderHandler as never);
  return { app, tables };
}

function revert(app: Hono, toStatus: unknown, reason: unknown = 'wrong scan', id = 'do-1') {
  return app.request(`/delivery-orders/${id}/revert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toStatus, reason }),
  });
}
const bodyOf = async (r: Response) => (await r.json().catch(() => ({}))) as any;

describe('DO revert — gating', () => {
  test('a caller WITHOUT scm.do.revert is refused', async () => {
    const { app } = revertApp({ caps: ['scm.do.dispatch'], doStatus: 'LOADED' });
    const res = await revert(app, 'DRAFT');
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error).toBe('capability_required');
  });

  test('a reason is required', async () => {
    const { app } = revertApp({ doStatus: 'LOADED' });
    const res = await revert(app, 'DRAFT', '   ');
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe('reason_required');
  });

  test('the target must be LOADED or DRAFT', async () => {
    const { app } = revertApp({ doStatus: 'DISPATCHED' });
    expect((await bodyOf(await revert(app, 'IN_TRANSIT'))).error).toBe('invalid_target');
    expect((await bodyOf(await revert(app, 'CANCELLED'))).error).toBe('invalid_target');
  });
});

describe('DO revert — legal transitions', () => {
  test('a DELIVERED order is not revertable', async () => {
    const { app } = revertApp({ doStatus: 'DELIVERED' });
    const res = await revert(app, 'DRAFT');
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe('not_revertable');
  });

  test('a DRAFT order is not revertable — nothing to undo', async () => {
    const { app } = revertApp({ doStatus: 'DRAFT' });
    const res = await revert(app, 'LOADED');
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe('not_revertable');
  });

  test('a revert may not move forward or sideways (LOADED → LOADED)', async () => {
    const { app } = revertApp({ doStatus: 'LOADED' });
    const res = await revert(app, 'LOADED');
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe('not_backward');
  });
});

describe('DO revert — stock crosses the boundary only into DRAFT', () => {
  test('LOADED → DRAFT restores stock (inventoryReversed) and flips the row', async () => {
    const { app, tables } = revertApp({ doStatus: 'LOADED' });
    const res = await revert(app, 'DRAFT');
    expect(res.status).toBe(200);
    const b = await bodyOf(res);
    expect(b.to).toBe('DRAFT');
    expect(b.inventoryReversed).toBe(true);
    expect(tables.delivery_orders[0].status).toBe('DRAFT');
  });

  test('DISPATCHED → LOADED moves NO stock and clears dispatched_at', async () => {
    const { app, tables } = revertApp({ doStatus: 'DISPATCHED' });
    const res = await revert(app, 'LOADED');
    expect(res.status).toBe(200);
    const b = await bodyOf(res);
    expect(b.to).toBe('LOADED');
    expect(b.inventoryReversed).toBe(false);
    expect(tables.delivery_orders[0].status).toBe('LOADED');
    expect(tables.delivery_orders[0].dispatched_at).toBeNull();
  });

  test('DISPATCHED → DRAFT restores stock', async () => {
    const { app } = revertApp({ doStatus: 'DISPATCHED' });
    const b = await bodyOf(await revert(app, 'DRAFT'));
    expect(b.inventoryReversed).toBe(true);
  });
});

describe('DO revert — downstream lock', () => {
  test('a delivery with a live Sales Invoice is refused', async () => {
    const { app } = revertApp({ doStatus: 'LOADED', hasInvoice: true });
    const res = await revert(app, 'DRAFT');
    expect(res.status).toBe(409);
    // doHasDownstream returns its own refusal shape; assert it did not proceed.
    const b = await bodyOf(res);
    expect(b.to).toBeUndefined();
    expect(b.inventoryReversed).toBeUndefined();
  });
});
