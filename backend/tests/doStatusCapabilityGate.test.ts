// The DO status endpoint's per-position capability gate (C1b, 2026-08-25).
//
// A caller admitted via scmAreaGuard's writeBypass — a storekeeper/driver who
// holds scm.do.load / scm.do.dispatch but NOT scm.sales.delivery edit — reaches
// patchDeliveryOrderStatusHandler with c.get('scmWriteBypassed')===true. The
// handler must then bind the verb to the transition: LOADED needs scm.do.load,
// DISPATCHED needs scm.do.dispatch, and a bypassed caller may do nothing else.
// A caller with REAL delivery access is unflagged and skips the gate entirely.
//
// This drives the real handler with a fake PostgREST (mirrors
// doOverDeliveryUnlinkedRoute.test.ts). The gate runs BEFORE the company/DB
// load, so deny cases return 403 with no fixtures; allow cases fall through
// past the gate and are asserted only to NOT be the capability refusal.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';

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
  is(col: string, val: unknown) {
    if (val === null) this.preds.push((r) => r[col] === null || r[col] === undefined);
    else this.preds.push((r) => r[col] === val);
    return this;
  }
  order() { return this; } limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } or() { return this; }
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

function makeApp(opts: { bypassed: boolean; caps?: string[]; wildcard?: boolean }) {
  const tables: Record<string, Row[]> = {
    // A DRAFT DO so an ALLOWED transition gets past the gate into real logic.
    delivery_orders: [{ id: 'do-1', do_number: 'DO-1', company_id: 1, status: 'DRAFT' }],
    delivery_order_items: [
      { id: 'doi-1', delivery_order_id: 'do-1', so_item_id: null, item_code: 'NTYR', qty: 1, parent: { status: 'DRAFT' } },
    ],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'sys' } as never);
    c.set('houzsUser' as never, {
      id: 9,
      name: 'Tester',
      permissions_set: new Set<string>(opts.wildcard ? ['*'] : []),
      position_capabilities: opts.caps ?? [],
    } as never);
    if (opts.bypassed) c.set('scmWriteBypassed' as never, true as never);
    await next();
  });
  app.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  return app;
}

function patch(app: Hono, status: string) {
  return app.request('/delivery-orders/do-1/status', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

async function errorOf(res: Response): Promise<string | undefined> {
  return (await res.json().catch(() => ({})) as { error?: string }).error;
}

describe('DO status PATCH — per-position capability gate', () => {
  test('bypassed + scm.do.load: LOADED passes the gate, DISPATCHED is refused', async () => {
    const app = makeApp({ bypassed: true, caps: ['scm.do.load'] });

    const loaded = await patch(app, 'LOADED');
    // Past the gate — whatever happens downstream, it is NOT the capability 403.
    expect(await errorOf(loaded)).not.toBe('capability_required');

    const dispatched = await patch(app, 'DISPATCHED');
    expect(dispatched.status).toBe(403);
    expect(await errorOf(dispatched)).toBe('capability_required');
  });

  test('bypassed + scm.do.dispatch: DISPATCHED passes the gate, LOADED is refused', async () => {
    const app = makeApp({ bypassed: true, caps: ['scm.do.dispatch'] });

    const dispatched = await patch(app, 'DISPATCHED');
    expect(await errorOf(dispatched)).not.toBe('capability_required');

    const loaded = await patch(app, 'LOADED');
    expect(loaded.status).toBe(403);
    expect(await errorOf(loaded)).toBe('capability_required');
  });

  test('bypassed caller may not reach any other transition (CANCELLED)', async () => {
    const app = makeApp({ bypassed: true, caps: ['scm.do.load', 'scm.do.dispatch'] });
    const cancelled = await patch(app, 'CANCELLED');
    expect(cancelled.status).toBe(403);
    expect(await errorOf(cancelled)).toBe('capability_required');
  });

  test('NOT bypassed (real delivery access / wildcard): the gate is skipped', async () => {
    const app = makeApp({ bypassed: false, wildcard: true });
    // No capability rows at all, yet every transition skips the gate — a caller
    // who passed the area guard on real access behaves exactly as before.
    for (const s of ['LOADED', 'DISPATCHED', 'CANCELLED']) {
      expect(await errorOf(await patch(app, s))).not.toBe('capability_required');
    }
  });
});
