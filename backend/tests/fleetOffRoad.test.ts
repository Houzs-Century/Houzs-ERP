/* Off the road from the lorry (backlog #5459): staff add and end an
   out-of-service window on scm.lorry_maintenance, the table Fleet Health, the
   delivery-planning fleet board and Lorry Capacity already read. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { makeFakePostgrest, type Row } from './fakePostgrest';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
const perms: string[] = [];
vi.mock('../src/scm/lib/houzs-perms', () => ({
  requireHouzsPerm: (p: string) => async (_c: unknown, next: () => Promise<void>) => { perms.push(p); await next(); },
}));

const { fleetOffRoad, OPEN_ENDED_TO } = await import('../src/scm/routes/fleet-off-road');

const LORRY = { id: 'l1', plate: 'VBA1234', company_id: 1 };
function app(windows: Row[] = [], companyId = 1) {
  const fake = makeFakePostgrest({ lorries: [LORRY], lorry_maintenance: windows, staff: [{ id: 's5', user_id: 5 }], entity_audit_log: [] }, []);
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, fake as never);
    c.set('companyId' as never, companyId as never);
    c.set('houzsUser' as never, { id: 5, name: 'Ah Kow' } as never);
    await next();
  });
  a.route('/', fleetOffRoad);
  return { a, tables: fake.tables };
}
const send = (a: Hono, method: string, path: string, body?: unknown) =>
  a.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { perms.length = 0; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T02:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('take a lorry off the road', () => {
  test('writes one window, stamps the company for provenance, audits who did it, and needs fleet.write', async () => {
    const { a, tables } = app();
    const res = await send(a, 'POST', '/vehicles/l1/off-road', { from: '2026-11-10', expectedReturn: '2026-11-14', reason: 'Gearbox' });
    expect(res.status).toBe(201);
    expect(perms).toEqual(['fleet.write']);
    expect(tables.lorry_maintenance).toHaveLength(1);
    expect(tables.lorry_maintenance![0]).toMatchObject({ lorry_id: 'l1', unavailable_from: '2026-11-10', unavailable_to: '2026-11-14', reason: 'Gearbox', company_id: 1, created_by: 's5' });
    const audit = tables.entity_audit_log![0]!;
    expect(audit).toMatchObject({ entity_type: 'LORRY_OFF_ROAD', entity_id: tables.lorry_maintenance![0]!.id, action: 'CREATE', actor_id: 's5', actor_name_snapshot: 'Ah Kow', entity_doc_no: 'VBA1234' });
  });

  test('no expected return stays off until someone ends it, and reads back as open-ended', async () => {
    const { a, tables } = app();
    expect((await send(a, 'POST', '/vehicles/l1/off-road', { from: '2026-11-10', expectedReturn: null, reason: 'Accident' })).status).toBe(201);
    expect(tables.lorry_maintenance![0]!.unavailable_to).toBe(OPEN_ENDED_TO);
    const got = await (await send(a, 'GET', '/vehicles/l1/off-road')).json() as { today: string; windows: Array<Record<string, unknown>> };
    expect(got.today).toBe('2026-11-10');
    expect(got.windows[0]).toMatchObject({ from: '2026-11-10', to: null, openEnded: true, reason: 'Accident', source: 'manual' });
  });

  test.each([
    [{ expectedReturn: null, reason: 'x' }, 'invalid_from'],
    [{ from: '2026-11-10', expectedReturn: '2026-11-09', reason: 'x' }, 'return_before_start'],
    [{ from: '2026-11-10', reason: '  ' }, 'reason_required'],
    [{ from: '2026-11-10', reason: 'DP lorry service — DP-0001' }, 'reserved_reason'],
    [{ from: '2026-11-10', reason: 'Repair days (dashboard)' }, 'reserved_reason'],
  ])('refuses %o with %s and writes nothing', async (body, code) => {
    const { a, tables } = app();
    const res = await send(a, 'POST', '/vehicles/l1/off-road', body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(code);
    expect(tables.lorry_maintenance).toHaveLength(0);
  });

  test('an unknown lorry is a 404', async () => {
    const { a, tables } = app();
    expect((await send(a, 'POST', '/vehicles/nope/off-road', { from: '2026-11-10', reason: 'x' })).status).toBe(404);
    expect(tables.lorry_maintenance).toHaveLength(0);
  });
});

describe('put it back on the road', () => {
  const W = (over: Row): Row => ({ id: 'w1', lorry_id: 'l1', company_id: 1, unavailable_from: '2026-11-05', unavailable_to: OPEN_ENDED_TO, reason: 'Gearbox', ...over });

  test('a window that began before today ends yesterday, so the lorry is usable today', async () => {
    const { a, tables } = app([W({})]);
    const res = await send(a, 'PATCH', '/off-road/w1/end');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('ended');
    expect(tables.lorry_maintenance![0]!.unavailable_to).toBe('2026-11-09');
    expect(tables.entity_audit_log![0]).toMatchObject({ entity_type: 'LORRY_OFF_ROAD', entity_id: 'w1', action: 'UPDATE' });
  });

  test('one that starts today or later is removed, and the audit row keeps what it was', async () => {
    const { a, tables } = app([W({ unavailable_from: '2026-11-10', unavailable_to: '2026-11-12' })]);
    expect(((await (await send(a, 'PATCH', '/off-road/w1/end')).json()) as { outcome: string }).outcome).toBe('removed');
    expect(tables.lorry_maintenance).toHaveLength(0);
    expect(tables.entity_audit_log![0]).toMatchObject({ action: 'DELETE', entity_id: 'w1' });
  });

  test('a window ended by another company\'s staff still ends: the fleet is shared', async () => {
    const { a, tables } = app([W({ company_id: 2 })], 1);
    expect((await send(a, 'PATCH', '/off-road/w1/end')).status).toBe(200);
    expect(tables.lorry_maintenance![0]!.unavailable_to).toBe('2026-11-09');
  });

  test.each([
    [W({ reason: 'DP lorry service — DP-0042' }), 409, 'owned_by_dp_job'],
    [W({ reason: 'Repair days (dashboard)' }), 409, 'owned_by_repair_days'],
    [W({ unavailable_to: '2026-11-08' }), 409, 'already_ended'],
  ])('refuses a window it does not own or that is over (%#)', async (row, status, code) => {
    const { a, tables } = app([row]);
    const res = await send(a, 'PATCH', '/off-road/w1/end');
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toBe(code);
    expect(tables.lorry_maintenance![0]).toMatchObject(row);
    expect(tables.entity_audit_log).toHaveLength(0);
  });

  test('an unknown window is a 404', async () => {
    const { a } = app();
    expect((await send(a, 'PATCH', '/off-road/none/end')).status).toBe(404);
  });
});

describe('the readers already treat these windows as off the road', () => {
  /* Fleet Health's dashboard and the delivery-planning fleet board ask
     `unavailable_from <= today AND unavailable_to >= today`. Pin that both still
     do, so an open-ended window (OPEN_ENDED_TO) and an ended one (to = yesterday)
     keep meaning what this route says they mean. */
  const src = (p: string) => readFileSync(join(__dirname, '..', 'src', 'scm', p), 'utf8');
  test.each([
    ['routes/fleet-maintenance.ts', /from\("lorry_maintenance"\)\.select\("lorry_id, unavailable_from, unavailable_to, reason"\)\.lte\("unavailable_from", today\)\.gte\("unavailable_to", today\)/],
    ['lib/fleet-availability.ts', /from\('lorry_maintenance'\)\.select\('lorry_id, reason'\)\.lte\('unavailable_from', today\)\.gte\('unavailable_to', today\)/],
  ])('%s', (file, re) => { expect(src(file)).toMatch(re); });
});
