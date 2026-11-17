// More POD photos on a delivered Delivery Order (owner, 2026-11-17: every job can
// take a POD upload from the office). Pins: only a delivered DO, only the active
// company, appends to the DO's own POD store, a re-run adds nothing twice.
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/scm/middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

import { deliveryOrderPodPhotos } from '../src/scm/routes/delivery-order-pod-photos';
import { mergePodPhotoKeys } from '../src/scm/lib/do-pod-photos';

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  constructor(private rows: Row[]) {}
  select() { return this; }
  update(v: Row) { this.patch = v; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  private run(): Row[] {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

const upload = (k: string) => ({ id: k, r2_key: k, order_draft_id: 'field:u7:do:do-1', status: 'uploaded', promoted_to_order_id: null, company_id: 1 });

function app() {
  const tables: Record<string, Row[]> = {
    delivery_orders: [
      { id: 'do-1', company_id: 1, status: 'DELIVERED', pod_r2_key: 'slips/crew.jpg', pod_photo_keys: ['slips/crew.jpg'] },
      { id: 'do-2', company_id: 1, status: 'DISPATCHED', pod_r2_key: null, pod_photo_keys: [] },
      { id: 'do-9', company_id: 2, status: 'DELIVERED', pod_r2_key: null, pod_photo_keys: [] },
    ],
    pending_slip_uploads: [upload('slips/a.jpg'), upload('slips/b.jpg')],
  };
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])) } as never);
    c.set('companyId' as never, 1 as never);
    c.set('allowedCompanyIds' as never, [1] as never);
    c.set('houzsUser' as never, { id: 7 } as never);
    await next();
  });
  a.route('/', deliveryOrderPodPhotos);
  return { a, tables };
}
const post = (a: Hono, id: string, photoKeys: string[]) =>
  a.request(`/${id}/pod-photos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ photoKeys }) });

describe('POST /delivery-orders-mfg/:id/pod-photos', () => {
  test('appends to a delivered DO POD and claims the uploads; a re-run adds nothing', async () => {
    const { a, tables } = app();
    const res = await post(a, 'do-1', ['slips/a.jpg']);
    expect(res.status).toBe(200);
    expect(tables.delivery_orders[0]!.pod_photo_keys).toEqual(['slips/crew.jpg', 'slips/a.jpg']);
    expect(tables.delivery_orders[0]!.pod_r2_key).toBe('slips/crew.jpg');
    expect(tables.pending_slip_uploads[0]!.status).toBe('promoted');
    const again = await post(a, 'do-1', ['slips/a.jpg', 'slips/b.jpg']);
    expect(((await again.json()) as Row).added).toBe(1);
    expect(tables.delivery_orders[0]!.pod_photo_keys).toEqual(['slips/crew.jpg', 'slips/a.jpg', 'slips/b.jpg']);
  });

  test('a DO not delivered yet is refused: it is completed through its status', async () => {
    const { a, tables } = app();
    const res = await post(a, 'do-2', ['slips/a.jpg']);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('not_delivered');
    expect(tables.delivery_orders[1]!.pod_photo_keys).toEqual([]);
  });

  test('a DO of another company is not found and not written', async () => {
    const { a, tables } = app();
    expect((await post(a, 'do-9', ['slips/a.jpg'])).status).toBe(404);
    expect(tables.delivery_orders[2]!.pod_photo_keys).toEqual([]);
  });
});

describe('mergePodPhotoKeys (the DO status POD merges, never replaces)', () => {
  test('keeps what was there first and adds each new key once', () => {
    expect(mergePodPhotoKeys(['a', 'b'], ['b', 'c', 'c'])).toEqual(['a', 'b', 'c']);
    expect(mergePodPhotoKeys([], ['x'])).toEqual(['x']);
  });
});
