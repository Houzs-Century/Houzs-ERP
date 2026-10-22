// The driver's run-sheet, end to end on the server (2026-10-07). Two routes a
// driver (scm.do.dispatch, no office access) depends on and could not reach:
//   · PATCH /delivery-orders-mfg/:id/arrival — "Arrived" used the general PATCH
//     /:id, which answered 403 to every driver.
//   · GET /delivery-planning/do/:ref/pod — the POD screen read the DO through the
//     office list/detail routes, which a driver cannot read.
// Both must admit the crew on the job and refuse everyone else. Drives the real
// handlers over the same fake PostgREST as driverPodOwnership.test.ts.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchDeliveryOrderArrivalHandler } from '../src/scm/routes/delivery-orders-mfg';
import { doPodContextHandler, doPodPhotoHandler } from '../src/scm/routes/delivery-pod-context';

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
function app(opts: { doStatus: string; doDriverId: string | null; arrivalAt?: string | null; caps?: string[] }) {

  const tables: Record<string, Row[]> = {
    drivers: [{ id: 'drv-7', user_id: 7 }],
    helpers: [],
    delivery_orders: [{
      id: 'do-1', do_number: 'DO-1', company_id: 1, status: opts.doStatus, so_doc_no: 'SO-1',
      driver_id: opts.doDriverId, arrival_at: opts.arrivalAt ?? null, debtor_name: 'Customer A',
    }],
    delivery_order_crew: [
      { do_id: 'do-1', driver_1_id: opts.doDriverId, driver_2_id: null, helper_1_id: null, helper_2_id: null },
    ],
    delivery_order_items: [
      { id: 'li-1', delivery_order_id: 'do-1', so_item_id: 'si-1', item_code: 'BED', description: 'Bed', qty: 1 },
      { id: 'li-2', delivery_order_id: 'do-1', so_item_id: 'si-2', item_code: 'SOFA', description: 'Sofa', qty: 1 },
    ],
    mfg_sales_order_items: [{ id: 'si-1', cancelled: false }, { id: 'si-2', cancelled: true }],
  };
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])) } as never);
    c.set('companyId' as never, 1 as never);
    c.set('allowedCompanyIds' as never, [1] as never);
    c.set('user' as never, { id: 'sys' } as never);
    c.set('houzsUser' as never, {
      id: 7, name: 'Faslie', position_name: 'Driver', department_name: 'Operation',
      permissions_set: new Set<string>(), position_capabilities: opts.caps ?? ['scm.do.dispatch'],
    } as never);
    c.set('scmWriteBypassed' as never, true as never);
    await next();
  });
  a.patch('/delivery-orders/:id/arrival', patchDeliveryOrderArrivalHandler as never);
  a.get('/delivery-planning/do/:doRef/pod', doPodContextHandler as never);
  return { a, tables };
}
const arrive = (a: Hono) => a.request('/delivery-orders/do-1/arrival', { method: 'PATCH' });
const body = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, any>;

describe('PATCH /:id/arrival — the driver taps Arrived', () => {
  test('stamps arrival on their own delivery that is on the road', async () => {
    const { a, tables } = app({ doStatus: 'IN_TRANSIT', doDriverId: 'drv-7' });
    const res = await arrive(a);
    expect(res.status).toBe(200);
    expect(tables.delivery_orders[0]!.arrival_at).toBeTruthy();
  });

  test("refuses another crew's delivery", async () => {
    const { a, tables } = app({ doStatus: 'IN_TRANSIT', doDriverId: 'drv-OTHER' });
    const res = await arrive(a);
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe('not_your_job');
    expect(tables.delivery_orders[0]!.arrival_at).toBeNull();
  });

  test('refuses a delivery that has not left the warehouse', async () => {
    const { a } = app({ doStatus: 'DRAFT', doDriverId: 'drv-7' });
    const res = await arrive(a);
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('illegal_status_transition');
  });

  test('a second tap keeps the first arrival time', async () => {
    const first = '2026-10-07T02:00:00.000Z';
    const { a, tables } = app({ doStatus: 'IN_TRANSIT', doDriverId: 'drv-7', arrivalAt: first });
    expect((await arrive(a)).status).toBe(200);
    expect(tables.delivery_orders[0]!.arrival_at).toBe(first);
  });

  test('refuses a bypassed caller without the dispatch capability', async () => {
    const { a } = app({ doStatus: 'IN_TRANSIT', doDriverId: 'drv-7', caps: [] });
    const res = await arrive(a);
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe('capability_required');
  });
});

describe('GET /delivery-planning/do/:ref/pod — the POD screen read', () => {
  test('returns the header and live lines of their own delivery by DO number', async () => {
    const { a } = app({ doStatus: 'DISPATCHED', doDriverId: 'drv-7' });
    const res = await a.request('/delivery-planning/do/DO-1/pod');
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.deliveryOrder.id).toBe('do-1');
    expect(b.items.map((i: Row) => [i.item_code, i.cancelled])).toEqual([['BED', false], ['SOFA', true]]);
  });

  test("refuses another crew's delivery", async () => {
    const { a } = app({ doStatus: 'DISPATCHED', doDriverId: 'drv-OTHER' });
    const res = await a.request('/delivery-planning/do/DO-1/pod');
    expect(res.status).toBe(403);
  });

  test('answers 404 for a DO that does not exist', async () => {
    const { a } = app({ doStatus: 'DISPATCHED', doDriverId: 'drv-7' });
    expect((await a.request('/delivery-planning/do/DO-404/pod')).status).toBe(404);
  });
});

describe('GET /delivery-orders-mfg/:id/pod-photo — the POD photo on the DO page', () => {
  const photoApp = (podKey: string | null, stored: boolean, companyId = 1) => {
    const tables: Record<string, Row[]> = { delivery_orders: [{ id: 'do-1', company_id: companyId, pod_r2_key: podKey }] };
    const a = new Hono();
    a.use('*', async (c, next) => {
      c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])) } as never);
      c.set('allowedCompanyIds' as never, [1] as never);
      (c.env as Row) = { POD_BUCKET: { get: async (k: string) => (stored && k === podKey ? { body: 'JPEG', httpMetadata: { contentType: 'image/jpeg' } } : null) } };
      await next();
    });
    a.get('/delivery-orders/:id/pod-photo/:n', doPodPhotoHandler as never);
    return a;
  };

  test('streams the stored photo with its type', async () => {
    const res = await photoApp('slips/2026/10/a.jpg', true).request('/delivery-orders/do-1/pod-photo/0');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await res.text()).toBe('JPEG');
  });

  test('404 when the DO has no POD, the file is gone, or the DO is another company', async () => {
    expect((await photoApp(null, true).request('/delivery-orders/do-1/pod-photo/0')).status).toBe(404);
    expect((await photoApp('slips/x.jpg', false).request('/delivery-orders/do-1/pod-photo/0')).status).toBe(404);
    expect((await photoApp('slips/x.jpg', true, 2).request('/delivery-orders/do-1/pod-photo/0')).status).toBe(404);
  });
});
