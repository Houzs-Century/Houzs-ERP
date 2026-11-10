// Undo delivered keeps the first POD (owner-approved 2026-11-10). Before this, an
// undone Delivered kept its photos on the order only until the driver's real
// POD wrote new pod_photo_keys over them, after which the first set could no
// longer be opened from anywhere. Drives the REAL revert handler, the REAL
// status PATCH (the driver's POD) and the REAL read routes over one fake
// PostgREST, so the whole round trip is pinned: undo -> new POD -> both sets
// readable, with the company predicate on every read.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { revertDeliveryOrderHandler } from '../src/scm/routes/delivery-order-revert';
import { patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';
import { deliveryOrderPodAttempts } from '../src/scm/routes/delivery-order-pod-attempts';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';

type Row = Record<string, any>;
let seq = 0;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  private sortCol: string | null = null;
  private sortAsc = true;
  constructor(private rows: Row[]) {}
  select() { return this; }
  insert(v: Row | Row[]) {
    this.op = 'insert';
    this.inserted = (Array.isArray(v) ? v : [v]).map((r) => ({ id: `row-${++seq}`, ...r }));
    return this;
  }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  is(col: string, val: unknown) {
    this.preds.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) { this.sortCol = col; this.sortAsc = o?.ascending !== false; return this; }
  limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } ilike() { return this; } or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    let hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    if (this.sortCol) {
      const k = this.sortCol;
      hit = [...hit].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (this.sortAsc ? 1 : -1));
    }
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), count: null, error: null }).then(res, rej);
  }
}

const FIRST = ['slips/first-1.jpg', 'slips/first-2.jpg'];
const SECOND = ['slips/second-1.jpg'];

function world(activeCompany = 1) {
  const tables: Record<string, Row[]> = {
    delivery_orders: [{
      id: 'do-1', do_number: 'HC-DO-1', company_id: 1, status: 'DELIVERED', so_doc_no: null,
      dispatched_at: '2026-11-09T01:00:00Z', departure_at: '2026-11-09T02:00:00Z', arrival_at: '2026-11-09T03:00:00Z',
      delivered_at: '2026-11-09T03:10:00Z', signed_at: null,
      signature_data: 'data:image/png;base64,FIRST', pod_r2_key: FIRST[0], pod_photo_keys: [...FIRST],
      pod_lat: 3.1, pod_lng: 101.6, pod_accuracy_m: 12, pod_located_at: '2026-11-09T03:09:00Z',
    }],
    pending_slip_uploads: SECOND.map((k, i) => ({
      id: `slip-${i}`, r2_key: k, status: 'uploaded', promoted_to_order_id: null, staff_id: SCM_SYSTEM_STAFF_ID, company_id: 1,
    })),
  };
  const bucket = new Map<string, string>([...FIRST, ...SECOND].map((k) => [k, `bytes of ${k}`]));
  const deleted: string[] = [];
  const env = {
    POD_BUCKET: {
      get: async (k: string) => (bucket.has(k)
        ? { body: bucket.get(k), httpMetadata: { contentType: 'image/jpeg' }, uploaded: new Date('2026-11-09T03:00:00Z') }
        : null),
      delete: async (k: string) => { deleted.push(k); bucket.delete(k); },
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, activeCompany as never);
    c.set('allowedCompanyIds' as never, [activeCompany] as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, {
      id: 42, name: 'Ops Lead', permissions_set: new Set(['*']), position_capabilities: ['scm.do.revert', 'scm.do.dispatch'],
    } as never);
    await next();
  });
  app.post('/delivery-orders-mfg/:id/revert', revertDeliveryOrderHandler as never);
  app.patch('/delivery-orders-mfg/:id/status', patchDeliveryOrderStatusHandler as never);
  app.route('/delivery-orders-mfg', deliveryOrderPodAttempts);
  const req = (path: string, init?: RequestInit) => app.request(path, init, env as never);
  return { req, tables, deleted };
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('Undo delivered keeps the earlier POD as a prior attempt', () => {
  test('the undo copies photos, signature, GPS and times into attempt 1 and clears them off the order', async () => {
    const { req, tables, deleted } = world();
    const res = await req('/delivery-orders-mfg/do-1/revert', json({ toStatus: 'DISPATCHED', reason: 'wrong order tapped' }));
    expect(res.status).toBe(200);
    const [a] = tables.delivery_order_pod_attempts!;
    expect(a).toMatchObject({
      company_id: 1, delivery_order_id: 'do-1', attempt_no: 1, undone_by: 42, undone_by_name: 'Ops Lead',
      reason: 'wrong order tapped', from_status: 'DELIVERED', pod_photo_keys: FIRST, pod_r2_key: FIRST[0],
      signature_data: 'data:image/png;base64,FIRST', pod_lat: 3.1, pod_lng: 101.6, pod_accuracy_m: 12,
      delivered_at: '2026-11-09T03:10:00Z', arrival_at: '2026-11-09T03:00:00Z',
    });
    const d = tables.delivery_orders[0]!;
    expect(d.status).toBe('DISPATCHED');
    expect(d.pod_photo_keys).toEqual([]);
    expect(d.pod_r2_key).toBeNull();
    expect(d.signature_data).toBeNull();
    expect(d.pod_lat).toBeNull();
    expect(d.arrival_at).toBe('2026-11-09T03:00:00Z');
    expect(deleted).toEqual([]);
  });

  test('undo, then the real POD: the order carries the new set and attempt 1 still serves the old photos', async () => {
    const { req, tables, deleted } = world();
    expect((await req('/delivery-orders-mfg/do-1/revert', json({ toStatus: 'DISPATCHED', reason: 'wrong order tapped' }))).status).toBe(200);
    const pod = await req('/delivery-orders-mfg/do-1/status', json({
      status: 'DELIVERED', signatureData: 'data:image/png;base64,SECOND', podKeys: SECOND,
    }, 'PATCH'));
    expect(pod.status).toBe(200);

    const d = tables.delivery_orders[0]!;
    expect(d.status).toBe('DELIVERED');
    expect(d.pod_photo_keys).toEqual(SECOND);
    expect(d.signature_data).toBe('data:image/png;base64,SECOND');

    const list = (await (await req('/delivery-orders-mfg/do-1/pod-attempts')).json()) as { attempts: Row[] };
    expect(list.attempts).toHaveLength(1);
    expect(list.attempts[0]).toMatchObject({ attempt_no: 1, photo_count: 2, undone_by_name: 'Ops Lead', reason: 'wrong order tapped' });
    expect(list.attempts[0]!.pod_photo_keys).toBeUndefined();

    const id = list.attempts[0]!.id as string;
    for (const [n, key] of FIRST.entries()) {
      const photo = await req(`/delivery-orders-mfg/do-1/pod-attempts/${id}/photo/${n}`);
      expect(photo.status).toBe(200);
      expect(await photo.text()).toBe(`bytes of ${key}`);
    }
    expect((await req(`/delivery-orders-mfg/do-1/pod-attempts/${id}/photo/2`)).status).toBe(404);
    expect(deleted).toEqual([]);
  });

  test('a second undo becomes attempt 2, listed newest first', async () => {
    const { req, tables } = world();
    await req('/delivery-orders-mfg/do-1/revert', json({ toStatus: 'DISPATCHED', reason: 'first mistake' }));
    await req('/delivery-orders-mfg/do-1/status', json({ status: 'DELIVERED', podKeys: SECOND }, 'PATCH'));
    expect((await req('/delivery-orders-mfg/do-1/revert', json({ toStatus: 'DISPATCHED', reason: 'second mistake' }))).status).toBe(200);
    expect(tables.delivery_order_pod_attempts!.map((a) => a.attempt_no)).toEqual([1, 2]);
    const list = (await (await req('/delivery-orders-mfg/do-1/pod-attempts')).json()) as { attempts: Row[] };
    expect(list.attempts.map((a) => [a.attempt_no, a.reason, a.photo_count])).toEqual([[2, 'second mistake', 1], [1, 'first mistake', 2]]);
  });

  test('a lost race drops the copy and leaves the order untouched', async () => {
    const { req, tables } = world();
    // The order moves on between the read and the flip: the guarded update matches nothing.
    const orig = tables.delivery_orders[0]!;
    Object.defineProperty(orig, 'status', {
      configurable: true, enumerable: true,
      get: () => (tables.delivery_order_pod_attempts?.length ? 'INVOICED' : 'DELIVERED'),
      set: () => {},
    });
    const res = await req('/delivery-orders-mfg/do-1/revert', json({ toStatus: 'DISPATCHED', reason: 'race' }));
    expect(res.status).toBe(409);
    expect(tables.delivery_order_pod_attempts).toEqual([]);
    expect(orig.pod_photo_keys).toEqual(FIRST);
  });
});

describe('earlier attempts are company-scoped', () => {
  test('another company sees no attempts and cannot stream their photos', async () => {
    const home = world(1);
    await home.req('/delivery-orders-mfg/do-1/revert', json({ toStatus: 'DISPATCHED', reason: 'wrong order tapped' }));
    const attemptId = home.tables.delivery_order_pod_attempts![0]!.id as string;

    const other = world(2);
    other.tables.delivery_order_pod_attempts = home.tables.delivery_order_pod_attempts!;
    const list = (await (await other.req('/delivery-orders-mfg/do-1/pod-attempts')).json()) as { attempts: Row[] };
    expect(list.attempts).toEqual([]);
    expect((await other.req(`/delivery-orders-mfg/do-1/pod-attempts/${attemptId}/photo/0`)).status).toBe(404);
  });

  test('an attempt id is only served under its own delivery order', async () => {
    const { req, tables } = world();
    await req('/delivery-orders-mfg/do-1/revert', json({ toStatus: 'DISPATCHED', reason: 'wrong order tapped' }));
    const attemptId = tables.delivery_order_pod_attempts![0]!.id as string;
    expect((await req(`/delivery-orders-mfg/do-OTHER/pod-attempts/${attemptId}/photo/0`)).status).toBe(404);
  });
});
