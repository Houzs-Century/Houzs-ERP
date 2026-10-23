import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { cachedSwr, serveSwr, writeSwr, type SwrBuild } from '../src/scm/lib/kv-swr';
import { procurementOverviewKey, procurementOverviewParams } from '../src/scm/routes/procurement-overview';

function fakeKv() {
  const m = new Map<string, string>();
  return {
    m,
    get: vi.fn(async (k: string, opts?: { type: string }) => {
      const v = m.get(k);
      if (v == null) return null;
      return opts?.type === 'json' ? JSON.parse(v) : v;
    }),
    put: vi.fn(async (k: string, v: string) => { m.set(k, v); }),
    delete: vi.fn(async (k: string) => { m.delete(k); }),
  } as unknown as KVNamespace & { m: Map<string, string> };
}

type R = { ok: boolean; n: number };
const ok = (n: number): R => ({ ok: true, n });

/* HC-0145: the Procurement Overview is served stale-while-revalidate from KV.
   These pin when the report is computed and when it is not. */
describe('cachedSwr', () => {
  it('computes and stores on a miss', async () => {
    const kv = fakeKv();
    const compute = vi.fn(async () => ok(1));
    const r = await cachedSwr({ kv, key: 'k', softSeconds: 60, hardSeconds: 600, compute, cacheable: (x) => x.ok, waitUntil: null });
    expect(r).toMatchObject({ result: ok(1), source: 'miss' });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(kv.m.has('k')).toBe(true);
  });

  it('serves a fresh copy without computing', async () => {
    const kv = fakeKv();
    await writeSwr(kv, 'k', ok(7), 60, 600, 1_000);
    const compute = vi.fn(async () => ok(8));
    const r = await cachedSwr({ kv, key: 'k', softSeconds: 60, hardSeconds: 600, compute, cacheable: (x) => x.ok, waitUntil: null, now: () => 2_000 });
    expect(r).toMatchObject({ result: ok(7), source: 'fresh', at: new Date(1_000).toISOString() });
    expect(compute).not.toHaveBeenCalled();
  });

  it('serves a stale copy at once and refreshes it in the background', async () => {
    const kv = fakeKv();
    await writeSwr(kv, 'k', ok(7), 60, 600, 1_000);
    const bg: Promise<unknown>[] = [];
    const compute = vi.fn(async () => ok(8));
    const r = await cachedSwr({ kv, key: 'k', softSeconds: 60, hardSeconds: 600, compute, cacheable: (x) => x.ok, waitUntil: (p) => bg.push(p), now: () => 1_000 + 61_000 });
    expect(r).toMatchObject({ result: ok(7), source: 'stale' });
    await Promise.all(bg);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kv.m.get('k')!).v).toEqual(ok(8));
    expect(kv.m.has('k:refreshing')).toBe(false);
  });

  it('a stale read while a refresh is running starts no second one', async () => {
    const kv = fakeKv();
    await writeSwr(kv, 'k', ok(7), 60, 600, 1_000);
    kv.m.set('k:refreshing', '1');
    const bg: Promise<unknown>[] = [];
    const compute = vi.fn(async () => ok(8));
    await cachedSwr({ kv, key: 'k', softSeconds: 60, hardSeconds: 600, compute, cacheable: (x) => x.ok, waitUntil: (p) => bg.push(p), now: () => 100_000 });
    await Promise.all(bg);
    expect(compute).not.toHaveBeenCalled();
  });

  it('never stores a failed report', async () => {
    const kv = fakeKv();
    const r = await cachedSwr({ kv, key: 'k', softSeconds: 60, hardSeconds: 600, compute: async () => ({ ok: false, n: 0 }), cacheable: (x) => x.ok, waitUntil: null });
    expect(r.result.ok).toBe(false);
    expect(kv.m.has('k')).toBe(false);
  });

  it('bypasses the cache with no key or no KV', async () => {
    const compute = vi.fn(async () => ok(1));
    expect((await cachedSwr({ kv: fakeKv(), key: null, softSeconds: 60, hardSeconds: 600, compute, cacheable: () => true, waitUntil: null })).source).toBe('bypass');
    expect((await cachedSwr({ kv: undefined, key: 'k', softSeconds: 60, hardSeconds: 600, compute, cacheable: () => true, waitUntil: null })).source).toBe('bypass');
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe('procurement overview cache key', () => {
  const today = '2026-10-22';
  const page = procurementOverviewParams((k) => ({ from: '2026-10-01', to: '2026-10-22', dueTo: '2026-10-31', basis: 'original', scope: 'all' } as Record<string, string>)[k], today);
  const home = procurementOverviewParams((k) => ({ from: '2026-10-01', to: '2026-10-22' } as Record<string, string>)[k], today);

  it('the page and the home Overview resolve to the views the cron warms', () => {
    expect(page).toEqual(procurementOverviewParams((k) => (k === 'dueTo' ? '2026-10-31' : undefined), today));
    expect(home).toEqual(procurementOverviewParams(() => undefined, today));
  });

  it('carries the company and every input that changes the answer', () => {
    expect(procurementOverviewKey(1, page)).not.toBe(procurementOverviewKey(2, page));
    expect(procurementOverviewKey(1, page)).not.toBe(procurementOverviewKey(1, home));
    expect(procurementOverviewKey(1, page)).not.toBe(procurementOverviewKey(1, { ...page, today: '2026-10-23' }));
    expect(procurementOverviewKey(1, page)).not.toBe(procurementOverviewKey(1, { ...page, scope: 'warehouse' as never }));
  });
});

describe('serveSwr', () => {
  function app(build: () => Promise<SwrBuild>, companyId: number | undefined, kv: KVNamespace) {
    const a = new Hono<{ Bindings: { SESSION_CACHE: KVNamespace }; Variables: { companyId?: number } }>();
    a.use('*', async (c, next) => { if (companyId != null) c.set('companyId', companyId); await next(); });
    a.get('/r', (c) => serveSwr(c, { family: 't', parts: ['2026-10-23'], softSeconds: 300, hardSeconds: 600, build }));
    return (req = '/r') => a.request(req, {}, { SESSION_CACHE: kv });
  }

  it('the second reader of a company gets the stored copy', async () => {
    const kv = fakeKv();
    const build = vi.fn(async (): Promise<SwrBuild> => ({ ok: true, body: { n: 1 } }));
    const get = app(build, 1, kv);
    const first = await get();
    expect(first.headers.get('X-Cache')).toBe('miss');
    expect(await first.json()).toEqual({ n: 1 });
    const second = await get();
    expect(second.headers.get('X-Cache')).toBe('fresh');
    expect(await second.json()).toEqual({ n: 1 });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('companies never share a copy', async () => {
    const kv = fakeKv();
    await app(async () => ({ ok: true, body: { co: 1 } }), 1, kv)();
    const other = await app(async () => ({ ok: true, body: { co: 2 } }), 2, kv)();
    expect(await other.json()).toEqual({ co: 2 });
  });

  it('with no active company it builds every time and stores nothing', async () => {
    const kv = fakeKv();
    const res = await app(async () => ({ ok: true, body: { n: 1 } }), undefined, kv)();
    expect(res.headers.get('X-Cache')).toBe('bypass');
    expect(kv.m.size).toBe(0);
  });

  it('a failed build is answered as before and not stored', async () => {
    const kv = fakeKv();
    const res = await app(async () => ({ ok: false, status: 500, body: { error: 'load_failed', reason: 'x' } }), 1, kv)();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'load_failed', reason: 'x' });
    expect(kv.m.size).toBe(0);
  });
});
