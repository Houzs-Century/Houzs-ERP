// The crew share one stop (owner, 2026-11-10): the driver and the helper on the
// same delivery see the same pending photos (with who took each), either one's
// Complete files all of them, a driver or helper NOT on that crew cannot list or
// claim them, and the second Complete is told the stop is already done instead
// of filing a second delivery over the first.
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/scm/middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

import { crewStopPhotos, parseStopContext } from '../src/scm/routes/crew-stop-photos';
import { patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';
import { podPhotoClaimable } from '../src/scm/lib/pod-photo-claim';

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
  is(col: string, val: unknown) { this.preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; }
  like(col: string, pattern: string) {
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 's');
    this.preds.push((r) => typeof r[col] === 'string' && re.test(r[col]));
    return this;
  }
  gt(col: string, val: string) { this.preds.push((r) => String(r[col]) > val); return this; }
  order() { return this; } limit() { return this; } range() { return this; }
  gte() { return this; } lt() { return this; } lte() { return this; } not() { return this; } or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

const DO_ID = '11111111-2222-4333-8444-555555555555';
const CTX = `do:${DO_ID}`;
const LATER = '2099-01-01T00:00:00.000Z';
const USERS: Record<number, string> = { 7: 'Faslie', 8: 'Ali', 9: 'Other driver' };
const CALLERS = {
  driver: { id: 7, name: 'Faslie', position_name: 'Driver' },
  helper: { id: 8, name: 'Ali', position_name: 'Helper' },
  // A driver of the SAME company who is not on this delivery's crew.
  stranger: { id: 9, name: 'Other driver', position_name: 'Driver' },
} as const;

const slip = (session: string, uploader: number, context: string, over: Row = {}): Row => ({
  id: session, upload_session_id: session, r2_key: `slips/2026/11/${session}.jpg`, staff_id: 'sys', company_id: 1,
  status: 'uploaded', promoted_to_order_id: null, content_type: 'image/jpeg', created_at: `2026-11-10T01:0${session.length % 10}:00Z`,
  expires_at: LATER, order_draft_id: `field:u${uploader}:${context}`, ...over,
});

function world(doStatus = 'IN_TRANSIT') {
  return {
    drivers: [{ id: 'drv-7', user_id: 7 }, { id: 'drv-9', user_id: 9 }],
    helpers: [{ id: 'hlp-8', user_id: 8 }],
    delivery_orders: [{ id: DO_ID, do_number: 'DO-1', company_id: 1, status: doStatus, so_doc_no: null, driver_id: 'drv-7', delivered_at: null, pod_photo_keys: [] }],
    delivery_order_crew: [{ do_id: DO_ID, driver_1_id: 'drv-7', driver_2_id: null, helper_1_id: 'hlp-8', helper_2_id: null }],
    delivery_order_items: [],
    pending_slip_uploads: [
      slip('drv-a', 7, CTX),
      slip('hlp-b', 8, CTX),
      // Another stop's photo, taken by someone else: never part of this stop.
      slip('oth-c', 9, 'do:99999999-2222-4333-8444-555555555555'),
    ],
  } as Record<string, Row[]>;
}

function app(tables: Record<string, Row[]>, who: keyof typeof CALLERS) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])), rpc: async () => ({ data: true, error: null }) } as never);
    c.set('companyId' as never, 1 as never);
    c.set('allowedCompanyIds' as never, [1] as never);
    c.set('user' as never, { id: 'sys' } as never);
    c.set('houzsUser' as never, {
      ...CALLERS[who], department_name: 'Operation', permissions_set: new Set<string>(), position_capabilities: ['scm.do.dispatch'],
    } as never);
    c.set('scmWriteBypassed' as never, true as never);
    (c.env as Row) = {
      ...(c.env as Row | undefined),
      DB: {
        prepare: () => {
          let ids: number[] = [];
          const stmt = {
            bind: (...a: unknown[]) => { ids = a.map(Number); return stmt; },
            all: async () => ({ results: ids.filter((i) => USERS[i]).map((i) => ({ id: i, name: USERS[i] })) }),
            first: async () => null,
          };
          return stmt;
        },
      },
    };
    await next();
  });
  a.route('/delivery-jobs', crewStopPhotos);
  a.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  return a;
}

const list = (a: Hono) => a.request(`/delivery-jobs/stop-photos?context=${encodeURIComponent(CTX)}`);
const discard = (a: Hono, session: string) =>
  a.request(`/delivery-jobs/stop-photos/${session}/discard?context=${encodeURIComponent(CTX)}`, { method: 'POST' });
const complete = (a: Hono, keys: string[]) => a.request(`/delivery-orders/${DO_ID}/status`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'DELIVERED', podKeys: keys }),
});
const body = async (r: Response) => (await r.json().catch(() => ({}))) as Row;

describe('the crew see the same pending photos', () => {
  test('the driver and the helper list the same photos, each named with who took it', async () => {
    const tables = world();
    const asDriver = await body(await list(app(tables, 'driver')));
    const asHelper = await body(await list(app(tables, 'helper')));
    const shape = (p: Row) => [p.r2Key, p.uploadedBy.name];
    expect(asDriver.photos.map(shape)).toEqual([['slips/2026/11/drv-a.jpg', 'Faslie'], ['slips/2026/11/hlp-b.jpg', 'Ali']]);
    expect(asHelper.photos.map(shape)).toEqual(asDriver.photos.map(shape));
    expect(asHelper.photos.map((p: Row) => p.mine)).toEqual([false, true]);
  });

  test('a driver of the same company who is not on this crew cannot list them', async () => {
    const res = await list(app(world(), 'stranger'));
    expect(res.status).toBe(403);
    expect((await body(res)).photos).toBeUndefined();
  });

  test('a photo removed or completed elsewhere is no longer listed', async () => {
    const tables = world();
    tables.pending_slip_uploads!.find((r) => r.id === 'drv-a')!.status = 'promoted';
    const res = await body(await list(app(tables, 'helper')));
    expect(res.photos.map((p: Row) => p.r2Key)).toEqual(['slips/2026/11/hlp-b.jpg']);
  });
});

describe('Remove: the uploader, or the driver (the stop lead)', () => {
  test("the helper cannot remove the driver's photo", async () => {
    const tables = world();
    const res = await discard(app(tables, 'helper'), 'drv-a');
    expect(res.status).toBe(403);
    expect(tables.pending_slip_uploads!.find((r) => r.id === 'drv-a')!.expires_at).toBe(LATER);
  });

  test("the driver can remove the helper's photo, and it leaves the list", async () => {
    const tables = world();
    expect((await discard(app(tables, 'driver'), 'hlp-b')).status).toBe(200);
    const res = await body(await list(app(tables, 'helper')));
    expect(res.photos.map((p: Row) => p.r2Key)).toEqual(['slips/2026/11/drv-a.jpg']);
  });

  test('the helper can remove their own', async () => {
    expect((await discard(app(world(), 'helper'), 'hlp-b')).status).toBe(200);
  });
});

describe('Complete claims the whole stop, once', () => {
  test("the driver's Complete files the helper's photo too", async () => {
    const tables = world();
    const res = await complete(app(tables, 'driver'), ['slips/2026/11/drv-a.jpg', 'slips/2026/11/hlp-b.jpg']);
    expect((await body(res)).error).not.toBe('photo_not_accepted');
    expect(tables.delivery_orders![0]!.pod_photo_keys).toEqual(['slips/2026/11/drv-a.jpg', 'slips/2026/11/hlp-b.jpg']);
    expect(tables.pending_slip_uploads!.filter((r) => r.status === 'promoted').map((r) => r.id).sort()).toEqual(['drv-a', 'hlp-b']);
  });

  test("another stop's photo by someone else is refused and nothing is delivered", async () => {
    const tables = world();
    const res = await complete(app(tables, 'driver'), ['slips/2026/11/oth-c.jpg']);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('photo_not_accepted');
    expect(tables.delivery_orders![0]!.status).toBe('IN_TRANSIT');
  });

  test('a driver of the same company not on this crew cannot complete it, so cannot claim its photos', async () => {
    const tables = world();
    const res = await complete(app(tables, 'stranger'), ['slips/2026/11/drv-a.jpg']);
    expect(res.status).toBe(403);
    expect(tables.pending_slip_uploads!.find((r) => r.id === 'drv-a')!.status).toBe('uploaded');
  });

  test('the second Complete is told the stop is already done and changes nothing', async () => {
    const tables = world();
    expect((await complete(app(tables, 'driver'), ['slips/2026/11/drv-a.jpg'])).status).not.toBe(409);
    tables.delivery_orders![0]!.delivered_at = '2026-11-10T06:05:00.000Z';
    const second = await complete(app(tables, 'helper'), ['slips/2026/11/hlp-b.jpg']);
    expect(second.status).toBe(409);
    const b = await body(second);
    expect(b.error).toBe('already_completed');
    expect(b.reason).toMatch(/already marked delivered at 2026\/11\/10 14:05/);
    expect(tables.delivery_orders![0]!.pod_photo_keys).toEqual(['slips/2026/11/drv-a.jpg']);
    expect(tables.pending_slip_uploads!.find((r) => r.id === 'hlp-b')!.status).toBe('uploaded');
  });

  test('two Completes at the same moment: one delivers, the other gets a 409, never a second delivery', async () => {
    const tables = world();
    const [a, b] = await Promise.all([
      complete(app(tables, 'driver'), ['slips/2026/11/drv-a.jpg']),
      complete(app(tables, 'helper'), ['slips/2026/11/hlp-b.jpg']),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);
    expect(tables.delivery_orders![0]!.pod_photo_keys).toHaveLength(1);
  });
});

describe('who may claim a photo (pure)', () => {
  test('own upload anywhere; anyone\'s for this stop; nothing else', () => {
    const me = { houzsUserId: 7, stopContext: CTX };
    expect(podPhotoClaimable(`field:u7:`, me)).toBe(true);
    expect(podPhotoClaimable(`field:u8:${CTX}`, me)).toBe(true);
    expect(podPhotoClaimable(`field:u8:do:other`, me)).toBe(false);
    expect(podPhotoClaimable(`field:u8:${CTX}`, { houzsUserId: 7, stopContext: null })).toBe(false);
    // A row from before the uploader was recorded: only on a stop the route admitted the caller to.
    expect(podPhotoClaimable(null, me)).toBe(true);
    expect(podPhotoClaimable(null, { houzsUserId: 7, stopContext: null })).toBe(false);
  });

  test('stop contexts parse only to a real DO or job', () => {
    expect(parseStopContext(CTX)).toEqual({ kind: 'do', doId: DO_ID });
    expect(parseStopContext('job:assr:12:customer_pickup')).toEqual({ kind: 'job', sourceType: 'assr', sourceId: '12', leg: 'customer_pickup' });
    expect(parseStopContext('do:not-a-uuid')).toBeNull();
    expect(parseStopContext('job:assr:12')).toBeNull();
    expect(parseStopContext('job:project:7:LUNCH')).toBeNull();
  });
});
