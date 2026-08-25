import { describe, expect, test, vi } from 'vitest';
import { callAcRead, AC_READ_ROUTE } from './autocount-host-read';
import { AC_ROUTE } from './autocount-writeback';

const env = { AC_SYNC_URL: 'http://ac.local:8900/', AC_SYNC_KEY: 'k' } as never;
const res = (status: number, body: string, type = 'application/json') =>
  new Response(body, { status, headers: { 'content-type': type } });

describe('callAcRead — the read-only host routes', () => {
  test('a read route is NOT an AcOp, and the two vocabularies stay disjoint', () => {
    /* THE POINT OF THE SEPARATE CALLER. Every AcOp names something an outbox
       ROW can be — a document with a status, attempts and a retry policy. A log
       read is none of those. If a name ever appears in both maps, the queue's
       switches on `op` have quietly acquired a member that is not a document,
       which is the one-name-two-meanings defect this file exists to avoid. */
    const write = new Set(Object.keys(AC_ROUTE));
    for (const name of Object.keys(AC_READ_ROUTE)) {
      expect(write.has(name), `${name} is in BOTH AC_ROUTE and AC_READ_ROUTE`).toBe(false);
    }
  });

  test('it posts to the host route with the key and returns the body', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return res(200, JSON.stringify({ ok: true, path: 'C:\\Temp\\x.log', exists: true, lines: ['a', 'b'] }));
    }) as never;

    const r = await callAcRead(env, 'last_errors', { Lines: 5 }, f);
    expect(r.ok).toBe(true);
    expect(seen[0].url).toBe('http://ac.local:8900/last-errors');
    expect((seen[0].init.headers as Record<string, string>)['X-API-KEY']).toBe('k');
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ Lines: 5 });
    expect(r.body?.lines).toEqual(['a', 'b']);
  });

  test('a gateway status with a NON-JSON body says the host did not answer', async () => {
    /* #2686's lesson, applied to the read path before it can cost anything: the
       tunnel answers `error code: 502` for a stopped service, and calling that
       an AutoCount refusal sends the reader to the account book. */
    const f = vi.fn(async () => res(502, 'error code: 502', 'text/plain')) as never;
    const r = await callAcRead(env, 'last_errors', {}, f);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('did not answer');
    expect(r.error).toContain('AcSyncService is running');
    expect(r.error).not.toContain('error code: 502');
  });

  test('a gateway status WITH a JSON error keeps the service\'s own words', async () => {
    const f = vi.fn(async () => res(503, JSON.stringify({ ok: false, error: 'book is closed' }))) as never;
    const r = await callAcRead(env, 'last_errors', {}, f);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('book is closed');
  });

  test('no AC_SYNC_URL is reported, not thrown', async () => {
    const r = await callAcRead({} as never, 'last_errors', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('AC_SYNC_URL');
  });

  test('a transport failure is reported, not thrown', async () => {
    const f = vi.fn(async () => { throw new Error('fetch failed'); }) as never;
    const r = await callAcRead(env, 'last_errors', {}, f);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('could not be reached');
  });
});
