import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

let currentSb: unknown;
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => currentSb }));

const { fakeSb } = await import('./fake-postgrest');
const { resetVpKick } = await import('./venture-portal-outbox');
const { venturePortalKick } = await import('./venture-portal-kick');
const { resetFeedFlagCache } = await import('./venture-portal-feed-flag');

function feedOff() {
  return fakeSb({ app_config: [{ key: 'scm.venture_portal_feed', value: 'off' }] }, {}, []);
}

type KickCtx = Pick<ExecutionContext, 'waitUntil' | 'passThroughOnException'>;

function fakeCtx() {
  const scheduled: Promise<unknown>[] = [];
  const ctx: KickCtx = {
    waitUntil: (p: Promise<unknown>) => { scheduled.push(p); },
    passThroughOnException: () => {},
  };
  return { ctx, settle: () => Promise.all(scheduled), count: () => scheduled.length };
}

function app() {
  const a = new Hono();
  a.use('/*', venturePortalKick());
  a.get('/rows', (c) => c.json({ rows: [] }));
  a.post('/connection', (c) => c.json({ ok: true }));
  a.patch('/thing', (c) => c.json({ ok: true }));
  a.post('/forbidden', (c) => c.json({ error: 'forbidden' }, 403));
  a.post('/refused', (c) => c.json({ error: 'write_frozen' }, 503));
  a.post('/created', (c) => c.json({ ok: true }, 201));
  return a;
}

const env: Record<string, never> = {};

beforeEach(() => {
  currentSb = feedOff();
  resetFeedFlagCache();
  resetVpKick({ sleep: async () => {} });
});

function fetchWith(request: Request, ctx: KickCtx | undefined) {
  return app().fetch(request, env, ctx as unknown as ExecutionContext);
}

async function call(method: string, path: string, ctx: ReturnType<typeof fakeCtx>) {
  return fetchWith(new Request(`http://x${path}`, { method }), ctx.ctx);
}

describe('which requests earn a drain', () => {
  test('a successful write schedules one', async () => {
    const c = fakeCtx();
    const res = await call('POST', '/connection', c);
    expect(res.status).toBe(200);
    expect(c.count()).toBe(1);
    await c.settle();
  });

  test('a 201 counts as success — the whole 2xx range, not just 200', async () => {
    const c = fakeCtx();
    expect((await call('POST', '/created', c)).status).toBe(201);
    expect(c.count()).toBe(1);
    await c.settle();
  });

  test('a PATCH earns one too, because a line edit is how most of these arrive', async () => {
    const c = fakeCtx();
    expect((await call('PATCH', '/thing', c)).status).toBe(200);
    expect(c.count()).toBe(1);
    await c.settle();
  });

  test('a GET never schedules one', async () => {
    const c = fakeCtx();
    expect((await call('GET', '/rows', c)).status).toBe(200);
    expect(c.count()).toBe(0);
  });

  test('a refused write schedules nothing — 403 or the write-freeze 503', async () => {
    const forbidden = fakeCtx();
    expect((await call('POST', '/forbidden', forbidden)).status).toBe(403);
    expect(forbidden.count()).toBe(0);

    resetVpKick({ sleep: async () => {} });
    const frozen = fakeCtx();
    expect((await call('POST', '/refused', frozen)).status).toBe(503);
    expect(frozen.count()).toBe(0);
  });

  test('a request with no ExecutionContext still succeeds', async () => {
    const res = await fetchWith(new Request('http://x/connection', { method: 'POST' }), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('a successful write runs the catalogue step after the drain', async () => {
    currentSb = fakeSb(
      {
        app_config: [{ key: 'scm.venture_portal_feed', value: '1' }],
        venture_portal_catalogue_changes: [{ id: 1, source: 'mfg_products' }],
      },
      {},
      [],
    );
    resetFeedFlagCache();
    const c = fakeCtx();
    expect((await call('POST', '/connection', c)).status).toBe(200);
    expect(c.count()).toBe(1);
    await c.settle();
    const sb = currentSb as { tables: Record<string, unknown[] | undefined> };
    expect(sb.tables.venture_portal_catalogue_changes ?? []).toEqual([]);
  });

  test('a successful write runs the Sales Attending step too, even when the catalogue step fails', async () => {
    const sb = fakeSb(
      {
        app_config: [{ key: 'scm.venture_portal_feed', value: '1' }],
        venture_portal_attendance_changes: [{ id: 1, source: 'project_sales_attendees' }],
      },
      { venture_portal_catalogue_changes: ['id'] },
      [],
    );
    currentSb = sb;
    resetFeedFlagCache();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = fakeCtx();
    expect((await call('POST', '/connection', c)).status).toBe(200);
    await c.settle();
    expect(sb.tables.venture_portal_attendance_changes).toEqual([]);
    err.mockRestore();
  });

  test('a waitUntil that throws does not fail the request either', async () => {
    const angry: KickCtx = {
      waitUntil: () => { throw new Error('this context is dead'); },
      passThroughOnException: () => {},
    };
    const res = await fetchWith(new Request('http://x/connection', { method: 'POST' }), angry);
    expect(res.status).toBe(200);
  });
});
