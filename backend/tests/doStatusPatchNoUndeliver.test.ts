// A delivered DO must not slide back to an earlier stage through the plain
// status PATCH. Before 2026-11-09 it could: the stock-out → pre-ship guard only
// refused a move to DRAFT, so DELIVERED → DISPATCHED (list menu "Mark Loaded")
// or → IN_TRANSIT went through with no reason, no audit and the delivered
// stamp left behind. The audited way back is POST /:id/revert.
//
// Harness mirrors doStatusCaseNormalisation.test.ts: the exported handler on a
// bare Hono app with a fake PostgREST builder.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  order() { return this; } limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } is() { return this; } or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(status: string) {
  const tables: Record<string, Row[]> = {
    delivery_orders: [{
      id: 'do-1', do_number: 'HC-DO-1', company_id: CO, status, so_doc_no: null,
      delivered_at: '2026-11-08T03:00:00Z', warehouse_id: 'w1',
    }],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  return { app, tables };
}

const patchStatus = (app: Hono, status: string) =>
  app.request('/delivery-orders/do-1/status', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });

describe('DO status PATCH — a delivered order does not move back', () => {
  for (const from of ['DELIVERED', 'SIGNED', 'INVOICED']) {
    for (const to of ['IN_TRANSIT', 'DISPATCHED', 'LOADED']) {
      test(`${from} → ${to} is refused and points at the revert`, async () => {
        const { app, tables } = harness(from);
        const res = await patchStatus(app, to);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error?: string }).error).toBe('use_revert');
        expect(tables.delivery_orders[0].status).toBe(from);
        expect(tables.delivery_orders[0].delivered_at).toBe('2026-11-08T03:00:00Z');
      });
    }
  }

  test('forward moves are untouched: DISPATCHED → IN_TRANSIT still writes', async () => {
    const { app, tables } = harness('DISPATCHED');
    const res = await patchStatus(app, 'IN_TRANSIT');
    expect(res.status).toBe(200);
    expect(tables.delivery_orders[0].status).toBe('IN_TRANSIT');
  });

  test('DISPATCHED → LOADED stays legal (both have their stock out)', async () => {
    const { app, tables } = harness('DISPATCHED');
    const res = await patchStatus(app, 'LOADED');
    expect(res.status).toBe(200);
    expect(tables.delivery_orders[0].status).toBe('LOADED');
  });
});
