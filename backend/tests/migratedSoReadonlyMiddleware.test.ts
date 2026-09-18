// End-to-end behaviour of the migrated-SO guards inside the REAL mount shape.
//
// migratedSoLock.test.ts pins what a VALUE means. This suite pins what the two
// middlewares DO with it, in a Hono app assembled exactly like production:
//
//   app.use('/api/scm/*', <global auth>)          <- sets `user` + companyId
//   scm.use('/mfg-sales-orders/*', migratedSoReadonly())
//   scm.use('/so-amendments/*',    migratedSoAmendmentReadonly())
//   scm.route('/x', sub)                          <- sub.use('*', supabaseAuth)
//                                                    sets `houzsUser`, REPLACES
//                                                    `user`, and puts the
//                                                    supabase client in context
//
// That ordering is why this file exists rather than more unit tests. Both guards
// run a full routing step BEFORE any sub-router middleware, so they see `user`
// and NOT `houzsUser` — reading the wrong one is what made the write freeze's
// identical bypass grant nobody anything (docs/bugs, 2026-08-11).
//
// THE HOLE THIS SUITE WAS WRITTEN FOR. The lock shipped guarding
// `/mfg-sales-orders/*` only. Every amendment GATE lives on `/so-amendments/*`,
// and `approve-so` there runs applySoAmendment, which rewrites the bound Sales
// Order's header and lines. `describe('the hole, reproduced')` below is that
// defect as an executable assertion: with only the sales-order guard mounted, a
// PATCH to an amendment on a migrated order goes STRAIGHT THROUGH. It is kept
// permanently so the fix cannot be quietly undone by unmounting one line.
//
// NO vi.mock, DELIBERATELY — under the Cloudflare Workers pool it does not
// reliably intercept module imports (recorded in tests/pvRateFromPayment.test.ts
// and writeFreezeMiddleware.test.ts). The switch is supplied through
// primeMigratedSoLockCache and the database through a hand-written client, so
// these apps are dispatched with no env at all: any attempt to build a real
// Supabase client would throw, which is itself part of the assertion.
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  migratedSoReadonly,
  migratedSoAmendmentReadonly,
  primeMigratedSoLockCache,
  resetMigratedSoLockCache,
  amendmentIdFromPath,
  amendmentSoDocNo,
} from '../src/scm/lib/migrated-so-readonly';

type Caller = { permissions?: string[] } | undefined;

/* Two migrated documents and two native ones, plus the amendments bound to
   them. `linked_ac_docno` is the ONLY predicate the lock uses — nothing was
   stamped on a migrated row, by the owner's ruling. */
const MIGRATED_DOC = 'HC-SO-012929';
const NATIVE_DOC = 'HC-SO-030001';
const AMD_ON_MIGRATED = '11111111-2222-4333-8444-555555555555';
const AMD_ON_NATIVE = '99999999-8888-4777-8666-555555555555';
const AMD_UNKNOWN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type Fail = 'none' | 'so' | 'amendment';

/** The two reads the guards make, and nothing else. */
function fakeSupabase(fail: Fail = 'none') {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, value: string) {
              return {
                maybeSingle: async () => {
                  if (table === 'mfg_sales_orders') {
                    if (fail === 'so') return { data: null, error: { message: 'read failed' } };
                    if (value === MIGRATED_DOC) return { data: { linked_ac_docno: 'SO-00099' }, error: null };
                    if (value === NATIVE_DOC) return { data: { linked_ac_docno: null }, error: null };
                    return { data: null, error: null }; // no such order
                  }
                  if (table === 'so_amendments') {
                    if (fail === 'amendment') return { data: null, error: { message: 'read failed' } };
                    if (value === AMD_ON_MIGRATED) return { data: { so_doc_no: MIGRATED_DOC }, error: null };
                    if (value === AMD_ON_NATIVE) return { data: { so_doc_no: NATIVE_DOC }, error: null };
                    return { data: null, error: null }; // no such amendment
                  }
                  throw new Error(`unexpected table read: ${table}`);
                },
              };
            },
          };
        },
      };
    },
  };
}

/** The production composition, parameterised by who calls and what is mounted. */
function makeApp(
  caller: Caller,
  companyId: number | undefined,
  opts: { amendmentGuard?: boolean; fail?: Fail } = {},
) {
  const { amendmentGuard = true, fail = 'none' } = opts;
  const app = new Hono();

  /* backend/src/index.ts — global auth + companyContext, both on /api/*. The
     supabase client is set HERE as well because the guards run before the
     sub-router's supabaseAuth and would otherwise reach for
     getSupabaseService(c.env), which these env-less apps cannot build. */
  app.use('/api/scm/*', async (c, next) => {
    if (caller) c.set('user' as never, caller as never);
    if (companyId != null) c.set('companyId' as never, companyId as never);
    c.set('supabase' as never, fakeSupabase(fail) as never);
    await next();
  });

  const scm = new Hono();
  scm.use('/mfg-sales-orders/*', migratedSoReadonly());
  if (amendmentGuard) scm.use('/so-amendments/*', migratedSoAmendmentReadonly());

  for (const prefix of ['/mfg-sales-orders', '/so-amendments']) {
    const sub = new Hono();
    // scm/middleware/auth.ts supabaseAuth: stashes the real caller in
    // `houzsUser`, OVERWRITES `user` with the pinned scm.staff identity (which
    // carries no permissions at all), and puts the client in the context.
    sub.use('*', async (c, next) => {
      if (caller) c.set('houzsUser' as never, caller as never);
      c.set('user' as never, { id: 'scm-system-staff-uuid' } as never);
      c.set('supabase' as never, fakeSupabase(fail) as never);
      await next();
    });
    sub.all('/', (c) => c.json({ saved: true }));
    sub.all('/*', (c) => c.json({ saved: true }));
    scm.route(prefix, sub);
  }

  app.route('/api/scm', scm);
  return app;
}

const STAFF: Caller = { permissions: ['scm.access'] };
const IT: Caller = { permissions: ['scm.access', 'scm.admin'] };
const OWNER: Caller = { permissions: ['*'] };

async function send(app: Hono, path: string, method = 'PATCH') {
  const res = await app.request(path, { method });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

const AMEND = (id: string) => `/api/scm/so-amendments/${id}/approve-so`;

beforeEach(() => resetMigratedSoLockCache());

describe("the hole, reproduced — guard on /mfg-sales-orders only", () => {
  beforeEach(() => primeMigratedSoLockCache('1'));

  /* This is the state that shipped in #3151 / #3158, and the reason this PR
     exists. Keep it: it is the only assertion that fails if somebody unmounts
     migratedSoAmendmentReadonly and everything else still passes. */
  it('approve-so on a MIGRATED order goes straight through', async () => {
    const { status } = await send(makeApp(STAFF, 1, { amendmentGuard: false }), AMEND(AMD_ON_MIGRATED));
    expect(status).toBe(200);
  });

  it('...while the same order refuses a direct SO write — the two doors disagreed', async () => {
    const app = makeApp(STAFF, 1, { amendmentGuard: false });
    expect((await send(app, `/api/scm/mfg-sales-orders/${MIGRATED_DOC}`)).status).toBe(409);
  });
});

describe("value '1' — company 1 locked, the row as it stands today", () => {
  beforeEach(() => primeMigratedSoLockCache('1'));

  it('refuses approve-so on a migrated order with 409 so_migrated_readonly', async () => {
    const { status, body } = await send(makeApp(STAFF, 1), AMEND(AMD_ON_MIGRATED));
    expect(status).toBe(409);
    expect(body.error).toBe('so_migrated_readonly');
    // BOTH fields: the vendored SCM client reads `reason`, core api/client.ts
    // reads `message`. Sending one is how a refusal rendered as an outage line.
    expect(body.reason).toBe(body.message);
    expect(String(body.reason)).toMatch(/AutoCount/);
    // The refusal names the ORDER, not the amendment — that is what the
    // salesperson is looking at.
    expect(body.docNo).toBe(MIGRATED_DOC);
  });

  it('409, never 503 — api/client.ts retries a 503 four times', async () => {
    const { status } = await send(makeApp(STAFF, 1), AMEND(AMD_ON_MIGRATED));
    expect(status).not.toBe(503);
  });

  it('refuses every amendment GATE, not just approve-so', async () => {
    const app = makeApp(STAFF, 1);
    for (const gate of ['supplier-confirm', 'approve-so', 'approve-po', 'send', 'reject', 'withdraw']) {
      const res = await app.request(`/api/scm/so-amendments/${AMD_ON_MIGRATED}/${gate}`, { method: 'PATCH' });
      expect(res.status, gate).toBe(409);
    }
  });

  it('lets an amendment on a NATIVE order through — 「只开新单」', async () => {
    expect((await send(makeApp(STAFF, 1), AMEND(AMD_ON_NATIVE))).status).toBe(200);
  });

  it('lets every READ through, on both prefixes', async () => {
    const app = makeApp(STAFF, 1);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect((await app.request(AMEND(AMD_ON_MIGRATED), { method })).status, method).toBe(200);
      expect((await app.request(`/api/scm/mfg-sales-orders/${MIGRATED_DOC}`, { method })).status, method).toBe(200);
    }
  });

  it('lets 2990 through — the lock names company 1 only', async () => {
    expect((await send(makeApp(STAFF, 2), AMEND(AMD_ON_MIGRATED))).status).toBe(200);
  });

  it('an UNKNOWN amendment passes the guard — the handler answers 404, nothing is written', async () => {
    expect((await send(makeApp(STAFF, 1), AMEND(AMD_UNKNOWN))).status).toBe(200);
  });

  it('the collection route is never gated — it names no amendment', async () => {
    const app = makeApp(STAFF, 1);
    expect((await send(app, '/api/scm/so-amendments', 'POST')).status).toBe(200);
    expect((await send(app, '/api/scm/so-amendments/', 'POST')).status).toBe(200);
  });

  /* The bypass cohort is the write freeze's, deliberately: one answer to "who
     can still save", not two. */
  it('IT (scm.admin) and the owner (*) still get through', async () => {
    expect((await send(makeApp(IT, 1), AMEND(AMD_ON_MIGRATED))).status).toBe(200);
    expect((await send(makeApp(OWNER, 1), AMEND(AMD_ON_MIGRATED))).status).toBe(200);
  });
});

describe('a read that did not run LOCKS — the answer that decides whether this is a gate or theatre', () => {
  beforeEach(() => primeMigratedSoLockCache('1'));

  it('the AMENDMENT read failing locks: we cannot even tell which order this is', async () => {
    const { status, body } = await send(makeApp(STAFF, 1, { fail: 'amendment' }), AMEND(AMD_ON_MIGRATED));
    expect(status).toBe(409);
    expect(body.docNo).toBeNull();
  });

  it('the SALES ORDER read failing locks: "not migrated" is the permissive answer', async () => {
    const { status } = await send(makeApp(STAFF, 1, { fail: 'so' }), AMEND(AMD_ON_MIGRATED));
    expect(status).toBe(409);
  });
});

describe("value 'off' — the state this whole file is built to be retired into", () => {
  beforeEach(() => primeMigratedSoLockCache('off'));

  it('everything saves, migrated or not', async () => {
    const app = makeApp(STAFF, 1);
    expect((await send(app, AMEND(AMD_ON_MIGRATED))).status).toBe(200);
    expect((await send(app, `/api/scm/mfg-sales-orders/${MIGRATED_DOC}`)).status).toBe(200);
  });
});

describe('amendmentIdFromPath', () => {
  it('resolves the id from a gate path, top-level or nested', () => {
    expect(amendmentIdFromPath(`/api/scm/so-amendments/${AMD_ON_MIGRATED}/approve-so`)).toBe(AMD_ON_MIGRATED);
    expect(amendmentIdFromPath(`/api/scm/so-amendments/${AMD_ON_MIGRATED}`)).toBe(AMD_ON_MIGRATED);
    expect(amendmentIdFromPath(`/so-amendments/${AMD_ON_MIGRATED}/lines/3`)).toBe(AMD_ON_MIGRATED);
  });

  it('a query string is not part of the id', () => {
    expect(amendmentIdFromPath(`/api/scm/so-amendments/${AMD_ON_MIGRATED}?dry=1`)).toBe(AMD_ON_MIGRATED);
  });

  /* The collection route, a trailing slash, and — the one that matters — a
     STATIC segment. scm.so_amendments.id is a uuid column, so a non-uuid
     segment addresses no row; asking anyway would raise `invalid input syntax
     for type uuid`, which the guard reads as "the read failed", i.e. LOCK. A
     static non-GET route added later must not arrive as an unexplainable 409. */
  it.each([
    '/api/scm/so-amendments',
    '/api/scm/so-amendments/',
    '/api/scm/so-amendments/command-diag',
    '/api/scm/so-amendments/not-a-uuid/approve-so',
  ])('%s names no amendment', (p) => {
    expect(amendmentIdFromPath(p)).toBeNull();
  });
});

describe('amendmentSoDocNo — three answers, not two', () => {
  const read = (data: unknown, error: unknown = null) => async () => ({ data, error });

  it('a bound amendment answers its Sales Order', async () => {
    expect(await amendmentSoDocNo(read({ so_doc_no: MIGRATED_DOC }), AMD_ON_MIGRATED)).toBe(MIGRATED_DOC);
  });

  /* PostgREST has already been caught serving camelCase where this repo expected
     snake_case. Here that mistake would read as "no amendment" — open, not shut. */
  it('camelCase from PostgREST is the same answer, not "no amendment"', async () => {
    expect(await amendmentSoDocNo(read({ soDocNo: MIGRATED_DOC }), AMD_ON_MIGRATED)).toBe(MIGRATED_DOC);
  });

  it('no such amendment answers null — the handler will 404 and write nothing', async () => {
    expect(await amendmentSoDocNo(read(null), AMD_UNKNOWN)).toBeNull();
  });

  it('a FAILED read throws — it must never look like "no such amendment"', async () => {
    await expect(amendmentSoDocNo(read(null, { message: 'boom' }), AMD_ON_MIGRATED)).rejects.toThrow(/boom/);
  });

  it('a row present but unreadable throws — "could not tell" is not "not migrated"', async () => {
    await expect(amendmentSoDocNo(read({ so_doc_no: null }), AMD_ON_MIGRATED)).rejects.toThrow(/so_doc_no/);
  });
});
