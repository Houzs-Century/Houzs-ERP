import { describe, expect, test, vi } from 'vitest';
import { callAcRead, AC_READ_ROUTE } from './autocount-host-read';
import { REQUEUE_DOC_TYPES } from '../scm/lib/autocount-requeue';
import acSyncSrc from '../../scripts/autocount-service/AcSyncService.cs?raw';
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

/* ---------------------------------------------------------------------------
   REQUEUE_DOC_TYPES — the ERP's ONE list of AutoCount document types, pinned
   against the host's own.

   Named for the sweep because that is where it was first needed, but the
   question it answers is "which six documents does this ERP sync with
   AutoCount", and `/book-doc` asks the same one. The first draft of that route
   declared a `BOOK_DOC_TYPES` of its own; `audit:duplicated-decisions` refused
   it as a fifth home for one decision, correctly. This test is what makes the
   shared list safe to share: it proves the single answer still matches the
   book's.

   `/doc-read` turns this value into a TABLE NAME (`SO` -> `SO` + `SODTL`), so a
   list that drifts from the host's is not a cosmetic mismatch: it is either a
   400 for a document type the book can read, or a request the host has to
   refuse. The host guards itself; this pins that the ERP's copy still says the
   same thing, which is what makes the route's own 400 a real answer rather than
   a guess forwarded to a 500.
   ------------------------------------------------------------------------ */
describe('the document types the account book will read', () => {
  test('the ERP list matches AcSyncService.DocTypes exactly, in order', () => {
    /* READ OFF THE HOST'S SOURCE, not retyped. `?raw` rather than node:fs —
       backend/tsconfig.json types Workers only. */
    const m = acSyncSrc.match(/static readonly string\[\] DocTypes = \{([^}]*)\}/);
    expect(m, 'AcSyncService.DocTypes not found — did the host rename it?').toBeTruthy();
    const theirs = (m as RegExpMatchArray)[1]
      .split(',').map((t) => t.trim().replace(/^"|"$/g, '')).filter(Boolean);
    expect([...REQUEUE_DOC_TYPES]).toEqual(theirs);
  });

  test('every type is a table the host can name', () => {
    /* No lower case, no spaces, no punctuation: the host concatenates this into
       `[" + docType + "DTL]`, so anything else is a SQL identifier it never
       meant to build. The host also upper-cases the caller's value, and the
       route does the same, so the stored list must already be upper. */
    for (const t of REQUEUE_DOC_TYPES) expect(t).toMatch(/^[A-Z]{2}$/);
  });
});

/* THE ROUTE THAT SETTLES WHOSE NAME A LINE HAS.
 *
 * Owner, 2026-08-31: 「我们更改什么就 send 什么…为什么 AutoCount 要回传给我们呢?」
 * He is right that line identity ought to be ours. The way to have it is to
 * stamp our own reference INTO the account book and match on that — and whether
 * that is possible turns on one fact the reflected SDK dump cannot show (it was
 * taken DeclaredOnly, so an inherited `UDF` member on a detail is invisible):
 * does a document DETAIL table carry user-defined columns?
 *
 * `/table-columns` asks sys.columns on the live book. Read-only, names only.
 */
describe('/table-columns — can a document detail carry our own column', () => {
  test('asks the host for the detail table and passes the filter through', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      const sent = JSON.parse(String(init?.body ?? '{}'));
      expect(sent).toMatchObject({ Table: 'SODTL', Like: 'UDF_' });
      return res(200, JSON.stringify({ ok: true, table: 'SODTL', columns: ['UDF_PDate'] }));
    });

    const r = await callAcRead(env as never, 'table_columns', { Table: 'SODTL', Like: 'UDF_' }, fetchImpl as never);

    expect(r.ok).toBe(true);
    expect(r.body?.columns).toEqual(['UDF_PDate']);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/table-columns');
  });
});
