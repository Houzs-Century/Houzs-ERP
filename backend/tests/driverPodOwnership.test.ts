// Driver POD authorization (2026-08-25). A driver holding scm.do.dispatch may
// complete (IN_TRANSIT / SIGNED / DELIVERED) ONLY their OWN, already-dispatched
// delivery — enforced in patchDeliveryOrderStatusHandler after the DO's crew is
// known. This drives the real handler with a fake PostgREST (mirrors
// doOverDeliveryUnlinkedRoute.test.ts) so the ownership + prev-shipped rules are
// pinned against the route. The pure capability map is unit-tested at the end.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';
import {
  statusCapabilityRefusal,
  statusCapabilityFor,
  POD_STATES,
} from '../src/scm/lib/do-status-capability';

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

/** A driver (user 7 → scm.drivers 'drv-7') holding scm.do.dispatch, bypassed. */
function driverApp(opts: { doStatus: string; doDriverId: string | null }) {
  const tables: Record<string, Row[]> = {
    drivers: [{ id: 'drv-7', user_id: 7 }],
    helpers: [],
    delivery_orders: [
      { id: 'do-1', do_number: 'DO-1', company_id: 1, status: opts.doStatus, so_doc_no: 'SO-1', driver_id: opts.doDriverId },
    ],
    delivery_order_crew: [
      { do_id: 'do-1', driver_1_id: opts.doDriverId, driver_2_id: null, helper_1_id: null, helper_2_id: null },
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
      id: 7,
      name: 'Faslie',
      position_name: 'Driver',
      department_name: 'Operation',
      permissions_set: new Set<string>(),
      position_capabilities: ['scm.do.dispatch'],
    } as never);
    c.set('scmWriteBypassed' as never, true as never);
    await next();
  });
  app.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  return app;
}

function patch(app: Hono, status: string) {
  return app.request('/delivery-orders/do-1/status', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, signatureData: 'sig', podKey: 'k' }),
  });
}
const errorOf = async (r: Response) => (await r.json().catch(() => ({})) as { error?: string }).error;

describe('driver POD — ownership + prev-shipped enforcement (route-level)', () => {
  test('a driver may POD their OWN dispatched delivery (past the gate)', async () => {
    const app = driverApp({ doStatus: 'DISPATCHED', doDriverId: 'drv-7' });
    const res = await patch(app, 'DELIVERED');
    const err = await errorOf(res);
    expect(err).not.toBe('not_your_job');
    expect(err).not.toBe('capability_required');
    expect(err).not.toBe('illegal_status_transition');
  });

  test("a driver may NOT POD another crew's delivery", async () => {
    const app = driverApp({ doStatus: 'DISPATCHED', doDriverId: 'drv-OTHER' });
    const res = await patch(app, 'DELIVERED');
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('not_your_job');
  });

  test('a driver may NOT POD a delivery that has not shipped yet (DRAFT)', async () => {
    const app = driverApp({ doStatus: 'DRAFT', doDriverId: 'drv-7' });
    const res = await patch(app, 'DELIVERED');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('illegal_status_transition');
  });

  test('IN_TRANSIT on their own dispatched DO also passes the gate', async () => {
    const app = driverApp({ doStatus: 'DISPATCHED', doDriverId: 'drv-7' });
    expect(await errorOf(await patch(app, 'IN_TRANSIT'))).not.toBe('not_your_job');
  });
});

describe('statusCapabilityFor / statusCapabilityRefusal (pure)', () => {
  test('the capability map: LOADED→load, DISPATCHED + POD chain→dispatch', () => {
    expect(statusCapabilityFor('LOADED')).toBe('scm.do.load');
    expect(statusCapabilityFor('DISPATCHED')).toBe('scm.do.dispatch');
    for (const s of POD_STATES) expect(statusCapabilityFor(s)).toBe('scm.do.dispatch');
    expect(statusCapabilityFor('CANCELLED')).toBeNull();
  });

  test('a dispatch holder is refused LOADED (needs load) and cleared for the POD chain', () => {
    const dispatcher = { position_capabilities: ['scm.do.dispatch'] };
    expect(statusCapabilityRefusal(dispatcher, 'DELIVERED')).toBeNull();
    expect(statusCapabilityRefusal(dispatcher, 'DISPATCHED')).toBeNull();
    expect(statusCapabilityRefusal(dispatcher, 'LOADED')?.error).toBe('capability_required');
    expect(statusCapabilityRefusal(dispatcher, 'CANCELLED')?.error).toBe('capability_required');
  });

  test('fails closed with no caps / no caller', () => {
    expect(statusCapabilityRefusal({}, 'DELIVERED')?.error).toBe('capability_required');
    expect(statusCapabilityRefusal(null, 'DISPATCHED')?.error).toBe('capability_required');
  });
});
