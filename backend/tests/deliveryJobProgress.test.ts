// The crew's run of a NON-delivery-order job (2026-10-08): On the way -> Arrived
// -> POD for Setup / Dismantle, Service Case legs and manual DP jobs, through
// scm/routes/delivery-job-progress.ts. Pins who may act, that a POD needs a
// photo, where the photos are filed, and the ONE step each job advances (owner:
// the step a person would otherwise click right after the job, only when the
// document is still sitting on it).
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const assrSvc = vi.hoisted(() => ({
  saveAttachment: vi.fn(async () => 1),
  logActivity: vi.fn(async () => undefined),
  patchAssrCase: vi.fn(async () => true),
  transitionStage: vi.fn(async () => true),
}));
const projectsSvc = vi.hoisted(() => ({ setChecklistStatus: vi.fn(async () => true) }));
const surveySvc = vi.hoisted(() => ({ sendCompletionSurvey: vi.fn(async () => undefined) }));
vi.mock('../src/services/assr', () => assrSvc);
vi.mock('../src/services/projects', () => projectsSvc);
vi.mock('../src/services/assrCompletionSurvey', () => surveySvc);
vi.mock('../src/scm/middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

import { deliveryJobProgress } from '../src/scm/routes/delivery-job-progress';

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'upsert' = 'select';
  private patch: Row = {};
  constructor(private rows: Row[]) {}
  select() { return this; }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  upsert(v: Row) { this.op = 'upsert'; this.patch = v; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  gte() { return this; } limit() { return this; } order() { return this; }
  private run(): Row[] {
    if (this.op === 'upsert') {
      const hit = this.rows.find((r) => r.source_type === this.patch.source_type && r.source_id === this.patch.source_id && r.leg === this.patch.leg);
      if (hit) { Object.assign(hit, this.patch); return [hit]; }
      const row = { ...this.patch }; this.rows.push(row); return [row];
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

/* env.DB (the public-schema shim): answers the three reads the route makes and
   records every statement it runs. */
function fakeDb(state: { project?: Row; assr?: Row; checklist?: Row[] }, ran: string[]) {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() {
          if (/FROM projects/.test(sql)) return state.project ?? null;
          if (/FROM assr_cases/.test(sql)) return state.assr ?? null;
          return null;
        },
        async all() {
          if (/FROM project_checklist/.test(sql)) return { results: (state.checklist ?? []).filter((r) => r.status !== 'done') };
          return { results: [] };
        },
        async run() { ran.push(`${sql.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(args)}`); return { meta: {} }; },
      };
      return stmt;
    },
  };
}

function app(opts: { caps?: string[]; tripDriver?: string; project?: Row; assr?: Row; checklist?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    drivers: [{ id: 'drv-7', user_id: 7 }],
    helpers: [],
    trips: [{ id: 'trip-1', driver_id: opts.tripDriver ?? 'drv-7', helper_1_id: null, helper_2_id: null, status: 'PLANNED' }],
    trip_stops: [{ trip_id: 'trip-1', assr_case_id: 31, stop_type: 'PICKUP' }],
    dp_orders: [
      { id: 'dp-1', company_id: 1, job_type: 'SUPPLIER_PICKUP', trip_id: 'trip-1', status: 'SCHEDULED', party_name: 'Supplier A' },
      { id: 'dp-2', company_id: 1, job_type: 'LORRY_SERVICE', trip_id: 'trip-1', status: 'SCHEDULED', work_order_id: 'wo-1' },
    ],
    lorry_work_orders: [{ id: 'wo-1', photo_refs: ['old.jpg'] }],
    job_progress: [],
  };
  const ran: string[] = [];
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])) } as never);
    c.set('allowedCompanyIds' as never, [1] as never);
    c.set('houzsUser' as never, {
      id: 7, name: 'Faslie', position_name: 'Driver', department_name: 'Operation',
      permissions_set: new Set<string>(), position_capabilities: opts.caps ?? ['scm.do.dispatch'],
    } as never);
    (c.env as Row) = { ...(c.env as Row | undefined), DB: fakeDb({ project: opts.project, assr: opts.assr, checklist: opts.checklist }, ran) };
    await next();
  });
  a.route('/', deliveryJobProgress);
  return { a, tables, ran };
}
const post = (a: Hono, path: string, body?: unknown) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const json = async (r: Response) => (await r.json().catch(() => ({}))) as Row;
const PHOTO = { photoKeys: ['slips/2026/10/a.jpg'] };

beforeEach(() => { for (const f of [...Object.values(assrSvc), ...Object.values(projectsSvc), ...Object.values(surveySvc)]) f.mockClear(); });

describe('who may run a job', () => {
  test('the crew on the trip stamps On the way, and the trip starts', async () => {
    const { a, tables } = app();
    const res = await post(a, '/dp/dp-1/SUPPLIER_PICKUP/depart');
    expect(res.status).toBe(200);
    expect(tables.job_progress[0]!.departed_at).toBeTruthy();
    expect(tables.trips[0]!.status).toBe('IN_PROGRESS');
  });

  test("another crew's job is refused", async () => {
    const { a, tables } = app({ tripDriver: 'drv-OTHER' });
    const res = await post(a, '/dp/dp-1/SUPPLIER_PICKUP/arrive');
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe('not_your_job');
    expect(tables.job_progress).toHaveLength(0);
  });

  test('a leg that does not match the job type is not found', async () => {
    const { a } = app();
    expect((await post(a, '/dp/dp-1/TRANSFER/depart')).status).toBe(404);
  });

  test('a project leg is admitted for that leg crew only', async () => {
    const project = { id: 9, setup_driver_user_id: 7, dismantle_driver_user_id: 99 };
    const { a } = app({ project });
    expect((await post(a, '/project/9/SETUP/depart')).status).toBe(200);
    expect((await post(a, '/project/9/DISMANTLE/depart')).status).toBe(403);
  });
});

describe('the POD', () => {
  test('needs at least one photo, and only keys from the upload pipeline', async () => {
    const { a } = app();
    expect((await json(await post(a, '/dp/dp-1/SUPPLIER_PICKUP/complete', { photoKeys: [] }))).error).toBe('photo_required');
    expect((await json(await post(a, '/dp/dp-1/SUPPLIER_PICKUP/complete', { photoKeys: ['assr/9/x.jpg'] }))).error).toBe('photo_required');
  });

  test('a DP job completes: progress stamped, DP order COMPLETED, a second complete refused', async () => {
    const { a, tables } = app();
    const res = await post(a, '/dp/dp-1/SUPPLIER_PICKUP/complete', { ...PHOTO, notes: 'two boxes' });
    expect(res.status).toBe(200);
    const p = tables.job_progress[0]!;
    expect([p.departed_at, p.arrived_at, p.completed_at].every(Boolean)).toBe(true);
    expect(p.pod_photo_keys).toEqual(PHOTO.photoKeys);
    expect(tables.dp_orders[0]!.status).toBe('COMPLETED');
    expect((await post(a, '/dp/dp-1/SUPPLIER_PICKUP/complete', PHOTO)).status).toBe(409);
  });

  test('a lorry service adds the photos to its work order', async () => {
    const { a, tables } = app();
    await post(a, '/dp/dp-2/LORRY_SERVICE/complete', PHOTO);
    expect(tables.lorry_work_orders[0]!.photo_refs).toEqual(['old.jpg', 'slips/2026/10/a.jpg']);
  });

  test('a project setup files the photos as setup phase photos and ticks the open Setup Image row', async () => {
    const project = { id: 9, setup_driver_user_id: 7 };
    const { a, ran } = app({ project, checklist: [{ id: 51, status: 'pending' }] });
    expect((await post(a, '/project/9/SETUP/complete', PHOTO)).status).toBe(200);
    expect(ran.some((s) => s.startsWith('INSERT INTO project_phase_photos') && s.includes('"setup"'))).toBe(true);
    expect(projectsSvc.setChecklistStatus).toHaveBeenCalledWith(expect.anything(), 51, 'done', 7);
  });
});

describe('a service case advances only from the step the leg belongs to', () => {
  const assr = (stage: string, sub_status: string | null) => ({ id: 31, stage, sub_status });

  test('pickup done: Pending Customer Pickup -> Pending Supplier Pickup, with the photo and a timeline note', async () => {
    const { a } = app({ assr: assr('pending_supplier_pickup', 'pending_customer_pickup') });
    expect((await post(a, '/assr/31/customer_pickup/complete', PHOTO)).status).toBe(200);
    expect(assrSvc.saveAttachment).toHaveBeenCalledWith(expect.anything(), 31, PHOTO.photoKeys[0], null, 'image/jpeg', 'completion', 7);
    expect(assrSvc.logActivity).toHaveBeenCalled();
    expect(assrSvc.patchAssrCase).toHaveBeenCalledWith(expect.anything(), 31, { sub_status: 'pending_supplier_pickup' }, 7);
  });

  test('a case already moved on is left where it is', async () => {
    const { a } = app({ assr: assr('pending_item_ready', null) });
    expect((await post(a, '/assr/31/customer_pickup/complete', PHOTO)).status).toBe(200);
    expect(assrSvc.patchAssrCase).not.toHaveBeenCalled();
    expect(assrSvc.transitionStage).not.toHaveBeenCalled();
  });

  test('delivery back done on the Delivery stage closes the case and sends the survey', async () => {
    const { a, tables } = app({ assr: assr('pending_delivery_service', null) });
    tables.trip_stops![0]!.stop_type = 'DELIVERY';
    expect((await post(a, '/assr/31/delivery/complete', PHOTO)).status).toBe(200);
    expect(assrSvc.transitionStage).toHaveBeenCalledWith(expect.anything(), 31, 'completed', 7, 'Delivered by the crew (POD)');
    expect(surveySvc.sendCompletionSurvey).toHaveBeenCalledWith(expect.anything(), 31);
  });
});

describe('after completion: more photos, viewing them, the Stock Transfer record', () => {
  test('add-photos needs a completed job, appends, files them, and moves nothing', async () => {
    const assr = { id: 31, stage: 'pending_supplier_pickup', sub_status: 'pending_customer_pickup' };
    const { a, tables } = app({ assr });
    expect((await json(await post(a, '/assr/31/customer_pickup/add-photos', PHOTO))).error).toBe('not_completed');
    await post(a, '/assr/31/customer_pickup/complete', PHOTO);
    assrSvc.patchAssrCase.mockClear(); assrSvc.saveAttachment.mockClear();
    const res = await post(a, '/assr/31/customer_pickup/add-photos', { photoKeys: ['slips/2026/10/b.jpg', 'slips/2026/10/c.jpg'] });
    expect(res.status).toBe(200);
    expect(tables.job_progress[0]!.pod_photo_keys).toEqual(['slips/2026/10/a.jpg', 'slips/2026/10/b.jpg', 'slips/2026/10/c.jpg']);
    expect(assrSvc.saveAttachment).toHaveBeenCalledTimes(2);
    expect(assrSvc.patchAssrCase).not.toHaveBeenCalled();
  });

  test('photo/:n streams the n-th POD photo of a job the caller may see', async () => {
    const { a } = app();
    await post(a, '/dp/dp-1/SUPPLIER_PICKUP/complete', { photoKeys: ['slips/2026/10/a.jpg', 'slips/2026/10/b.jpg'] });
    const env = { DB: fakeDb({}, []), POD_BUCKET: { get: async (k: string) => ({ body: `IMG:${k}`, httpMetadata: { contentType: 'image/jpeg' } }) } };
    const res = await a.request('/dp/dp-1/SUPPLIER_PICKUP/photo/1', {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('IMG:slips/2026/10/b.jpg');
    expect((await a.request('/dp/dp-1/SUPPLIER_PICKUP/photo/5', {}, env)).status).toBe(404);
  });
});
