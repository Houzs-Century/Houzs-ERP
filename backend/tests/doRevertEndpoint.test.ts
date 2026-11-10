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
  insert(v: Row | Row[]) { this.op = 'insert' as never; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  private inserted: Row[] = [];
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
    if ((this.op as string) === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
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
  hasIssue?: boolean;
  soStatus?: string;
  otherDo?: Row;
}) {
  const tables: Record<string, Row[]> = {
    delivery_orders: [
      {
        id: 'do-1', do_number: 'DO-1', company_id: 1, status: opts.doStatus ?? 'LOADED', so_doc_no: 'SO-1',
        dispatched_at: '2026-08-26T00:00:00Z', delivered_at: '2026-08-27T03:00:00Z', signed_at: null,
        signature_data: 'data:image/png;base64,AAAA', pod_r2_key: 'pod/a.jpg', pod_photo_keys: ['pod/a.jpg', 'pod/b.jpg'],
        customer_delivered_date: null,
      },
      ...(opts.otherDo ? [opts.otherDo] : []),
    ],
    delivery_issues: opts.hasIssue ? [{ id: 'iss-1', company_id: 1, delivery_order_id: 'do-1', assr_no: 'SC-9' }] : [],
    mfg_sales_orders: [{ doc_no: 'SO-1', company_id: 1, status: opts.soStatus ?? 'SHIPPED', version: 1 }],
    mfg_so_status_changes: [],
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
    expect((await bodyOf(await revert(app, 'DELIVERED'))).error).toBe('invalid_target');
    expect((await bodyOf(await revert(app, 'CANCELLED'))).error).toBe('invalid_target');
  });
});

describe('DO revert — legal transitions', () => {
  test('a DELIVERED order goes back one step only — not straight to DRAFT or LOADED', async () => {
    for (const to of ['DRAFT', 'LOADED']) {
      const { app, tables } = revertApp({ doStatus: 'DELIVERED' });
      const res = await revert(app, to);
      expect(res.status).toBe(409);
      expect((await bodyOf(res)).error).toBe('not_backward');
      expect(tables.delivery_orders[0].status).toBe('DELIVERED');
    }
  });

  test('an INVOICED order is not revertable', async () => {
    const { app } = revertApp({ doStatus: 'INVOICED' });
    const res = await revert(app, 'DISPATCHED');
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe('not_revertable');
  });

  test('DISPATCHED is not a target for a not-yet-delivered order', async () => {
    const { app } = revertApp({ doStatus: 'LOADED' });
    expect((await bodyOf(await revert(app, 'DISPATCHED'))).error).toBe('not_backward');
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

describe('DO revert — undo a wrong Delivered', () => {
  test('DELIVERED → DISPATCHED: no stock, stamps cleared, POD moved to a prior attempt, audited with the reason', async () => {
    const { app, tables } = revertApp({ doStatus: 'DELIVERED' });
    const res = await revert(app, 'DISPATCHED', 'driver tapped the wrong order');
    expect(res.status).toBe(200);
    const b = await bodyOf(res);
    expect(b.to).toBe('DISPATCHED');
    expect(b.inventoryReversed).toBe(false);
    const d = tables.delivery_orders[0];
    expect(d.status).toBe('DISPATCHED');
    expect(d.delivered_at).toBeNull();
    expect(d.signed_at).toBeNull();
    expect(d.dispatched_at).toBe('2026-08-26T00:00:00Z');
    expect(d.signature_data).toBeNull();
    expect(d.pod_photo_keys).toEqual([]);
    expect(tables.delivery_order_pod_attempts?.[0]).toMatchObject({
      delivery_order_id: 'do-1', company_id: 1, attempt_no: 1, reason: 'driver tapped the wrong order',
      signature_data: 'data:image/png;base64,AAAA', pod_photo_keys: ['pod/a.jpg', 'pod/b.jpg'],
    });
    expect(tables.inventory_movements).toHaveLength(0);
  });

  test('SIGNED → DISPATCHED is allowed too (SIGNED reads Delivered)', async () => {
    const { app, tables } = revertApp({ doStatus: 'SIGNED' });
    expect((await revert(app, 'DISPATCHED')).status).toBe(200);
    expect(tables.delivery_orders[0].status).toBe('DISPATCHED');
  });

  test('the reason is still required', async () => {
    const { app, tables } = revertApp({ doStatus: 'DELIVERED' });
    const res = await revert(app, 'DISPATCHED', '');
    expect(res.status).toBe(400);
    expect(tables.delivery_orders[0].status).toBe('DELIVERED');
  });

  test('a caller without scm.do.revert is refused', async () => {
    const { app, tables } = revertApp({ doStatus: 'DELIVERED', caps: ['scm.do.dispatch'] });
    expect((await revert(app, 'DISPATCHED')).status).toBe(403);
    expect(tables.delivery_orders[0].status).toBe('DELIVERED');
  });

  test('refused while a Sales Invoice stands on the delivery', async () => {
    const { app, tables } = revertApp({ doStatus: 'DELIVERED', hasInvoice: true });
    expect((await revert(app, 'DISPATCHED')).status).toBe(409);
    expect(tables.delivery_orders[0].status).toBe('DELIVERED');
    expect(tables.delivery_orders[0].delivered_at).toBe('2026-08-27T03:00:00Z');
  });

  test('refused while the crew reported a delivery issue on it', async () => {
    const { app, tables } = revertApp({ doStatus: 'DELIVERED', hasIssue: true });
    const res = await revert(app, 'DISPATCHED');
    expect(res.status).toBe(409);
    const b = await bodyOf(res);
    expect(b.error).toBe('delivery_issue_reported');
    expect(b.reason).toContain('SC-9');
    expect(tables.delivery_orders[0].status).toBe('DELIVERED');
  });

  test('the sales order this POD delivered steps back to SHIPPED', async () => {
    const { app, tables } = revertApp({ doStatus: 'DELIVERED', soStatus: 'DELIVERED' });
    const b = await bodyOf(await revert(app, 'DISPATCHED'));
    expect(b.salesOrder).toBe('stepped_back');
    expect(tables.mfg_sales_orders[0].status).toBe('SHIPPED');
    expect(tables.mfg_so_status_changes[0]).toMatchObject({ from_status: 'DELIVERED', to_status: 'SHIPPED' });
  });

  test('the sales order stays DELIVERED while another of its deliveries is delivered', async () => {
    const otherDo = { id: 'do-2', do_number: 'DO-2', company_id: 1, status: 'DELIVERED', so_doc_no: 'SO-1', customer_delivered_date: null };
    const { app, tables } = revertApp({ doStatus: 'DELIVERED', soStatus: 'DELIVERED', otherDo });
    const b = await bodyOf(await revert(app, 'DISPATCHED'));
    expect(b.salesOrder).toBe('still_delivered');
    expect(tables.mfg_sales_orders[0].status).toBe('DELIVERED');
  });
});
