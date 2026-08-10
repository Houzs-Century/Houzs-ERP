// End-to-end behaviour of scmWriteFreeze() inside the REAL mount shape.
//
// The parser tests pin what a value MEANS. This suite pins what the middleware
// DOES with it, in a Hono app assembled exactly like production:
//
//   app.use('/api/scm/*', <global auth>)   <- sets `user` (the Houzs AuthUser)
//   scm.use('/*', scmWriteFreeze())        <- scm/index.ts, the freeze
//   scm.route('/x', sub)                   <- sub.use('*', supabaseAuth) sets
//                                             `houzsUser` and REPLACES `user`
//
// That ordering is the whole reason this file exists. The freeze runs a full
// routing step BEFORE any sub-router middleware, so it sees `user` and NOT
// `houzsUser`. Reading the wrong one is what made the bypass grant nobody
// anything (BUG-HISTORY.md, 2026-08-11) — every assertion in "the bypass" below
// failed with 503 before that fix.
//
// NO vi.mock, DELIBERATELY — under the Cloudflare Workers pool it does not
// reliably intercept module imports (the same finding is recorded in
// tests/pvRateFromPayment.test.ts and so-revision.reviseBoundPo.test.ts). The
// freeze value is supplied through primeWriteFreezeCache instead, which also
// proves a warm cache needs no Supabase client: these apps are dispatched with
// no env at all, so any attempt to build one would throw.
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { scmWriteFreeze, primeWriteFreezeCache, resetWriteFreezeCache } from '../src/scm/lib/write-freeze';

type Caller = { permissions?: string[] } | undefined;

/** The production composition, parameterised by who is calling and from where. */
function makeApp(caller: Caller, companyId: number | undefined) {
  const app = new Hono();

  // backend/src/index.ts — global auth + companyContext, both on /api/*.
  app.use('/api/scm/*', async (c, next) => {
    if (caller) c.set('user' as never, caller as never);
    if (companyId != null) c.set('companyId' as never, companyId as never);
    await next();
  });

  const scm = new Hono();
  scm.use('/*', scmWriteFreeze());

  for (const prefix of ['/mfg-sales-orders', '/mfg-purchase-orders', '/grns', '/hr', '/staff']) {
    const sub = new Hono();
    // scm/middleware/auth.ts supabaseAuth: stashes the real caller in
    // `houzsUser`, then OVERWRITES `user` with the pinned scm.staff identity,
    // which carries no permissions at all.
    sub.use('*', async (c, next) => {
      if (caller) c.set('houzsUser' as never, caller as never);
      c.set('user' as never, { id: 'scm-system-staff-uuid' } as never);
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

async function post(app: Hono, path: string) {
  const res = await app.request(path, { method: 'POST' });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

beforeEach(() => resetWriteFreezeCache());

describe("value '1' — the row as it stands today", () => {
  beforeEach(() => primeWriteFreezeCache('1'));

  it('refuses a Houzs write with 503 and the paused sentence', async () => {
    const { status, body } = await post(makeApp(STAFF, 1), '/api/scm/mfg-sales-orders');
    expect(status).toBe(503);
    expect(body.error).toBe('write_frozen');
    // Byte-identical to the message that shipped in #1936: no area is named
    // while every area is shut, because naming one would be noise.
    expect(body.reason).toBe(
      'Saving is paused while the AutoCount data is brought across. '
      + 'Nothing is broken and retrying will not help. '
      + 'Editing reopens after the cutover — ask IT if something must change today.',
    );
    expect(body.message).toBe(body.reason);
    expect(body.area).toBeUndefined();
  });

  it('never reads as an outage, and never invites the client to retry', async () => {
    const { body } = await post(makeApp(STAFF, 1), '/api/scm/mfg-sales-orders');
    expect(String(body.reason)).not.toMatch(/briefly unavailable|try again in a moment|warming up/i);
  });

  it('refuses every write method, not just POST', async () => {
    const app = makeApp(STAFF, 1);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await app.request('/api/scm/mfg-sales-orders', { method });
      expect(res.status, method).toBe(503);
    }
  });

  it('lets 2990 save', async () => {
    expect((await post(makeApp(STAFF, 2), '/api/scm/mfg-sales-orders')).status).toBe(200);
  });

  it('lets every READ through', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await makeApp(STAFF, 1).request('/api/scm/mfg-sales-orders', { method });
      expect(res.status, method).toBe(200);
    }
  });

  it('refuses the unguarded routers too — they have no area to lift', async () => {
    for (const p of ['/api/scm/hr', '/api/scm/staff']) {
      expect((await post(makeApp(STAFF, 1), p)).status, p).toBe(503);
    }
  });

  it('lets an unattributable request through rather than guessing', async () => {
    expect((await post(makeApp(STAFF, undefined), '/api/scm/mfg-sales-orders')).status).toBe(200);
  });
});

describe('the bypass', () => {
  beforeEach(() => primeWriteFreezeCache('1'));

  it('lets the owner (wildcard) save while Houzs is frozen', async () => {
    // Also covers the GOD POSITION accounts: hydrateAuthUser pushes '*' into
    // permissions for a Super Admin / Owner position, so they arrive as this.
    expect((await post(makeApp(OWNER, 1), '/api/scm/mfg-sales-orders')).status).toBe(200);
  });

  it('lets scm.admin (IT) save while Houzs is frozen', async () => {
    expect((await post(makeApp(IT, 1), '/api/scm/mfg-sales-orders')).status).toBe(200);
  });

  it('reads the identity that actually exists this early in the chain', async () => {
    /* THE REGRESSION GUARD. `houzsUser` is not set until the sub-router's own
       supabaseAuth, which runs after this middleware — so a bypass that reads
       only `houzsUser` grants nobody anything. Prove the ordering directly. */
    let houzsUserAtFreeze: unknown = 'not-observed';
    const app = new Hono();
    app.use('/api/scm/*', async (c, next) => {
      c.set('user' as never, OWNER as never);
      c.set('companyId' as never, 1 as never);
      await next();
    });
    const scm = new Hono();
    scm.use('/*', async (c, next) => { houzsUserAtFreeze = c.get('houzsUser' as never); await next(); });
    scm.use('/*', scmWriteFreeze());
    const sub = new Hono();
    sub.use('*', async (c, next) => { c.set('houzsUser' as never, OWNER as never); await next(); });
    sub.all('/', (c) => c.json({ saved: true }));
    scm.route('/mfg-sales-orders', sub);
    app.route('/api/scm', scm);

    expect((await post(app, '/api/scm/mfg-sales-orders')).status).toBe(200);
    expect(houzsUserAtFreeze).toBeUndefined();
  });

  it('still works AFTER supabaseAuth has swapped the identities', async () => {
    /* The other half of reading both: if the mount order ever changes so the
       freeze runs later, `user` becomes the permission-less scm.staff row and
       `houzsUser` becomes the real caller. The bypass must survive that too. */
    const app = new Hono();
    app.use('/api/scm/*', async (c, next) => { c.set('companyId' as never, 1 as never); await next(); });
    const scm = new Hono();
    const sub = new Hono();
    sub.use('*', async (c, next) => {
      c.set('houzsUser' as never, OWNER as never);
      c.set('user' as never, { id: 'scm-system-staff-uuid' } as never);
      await next();
    });
    sub.use('*', scmWriteFreeze());
    sub.all('/', (c) => c.json({ saved: true }));
    scm.route('/mfg-sales-orders', sub);
    app.route('/api/scm', scm);

    expect((await post(app, '/api/scm/mfg-sales-orders')).status).toBe(200);
  });

  it('is the ONLY hole — no other permission gets through', async () => {
    for (const perms of [
      ['scm.access'],
      ['scm.sales.write'],
      ['scm.config.write'],
      ['projects.write'],
      ['admin'],
      ['owner'],
      ['is_owner'],
      ['scm.admin.read'],
      ['scm.administrator'],
      ['*.*'],
      ['**'],
      [],
    ]) {
      const { status } = await post(makeApp({ permissions: perms }, 1), '/api/scm/mfg-sales-orders');
      expect(status, JSON.stringify(perms)).toBe(503);
    }
  });

  it('an unauthenticated caller is refused, not bypassed', async () => {
    expect((await post(makeApp(undefined, 1), '/api/scm/mfg-sales-orders')).status).toBe(503);
  });
});

describe('the staged lift, through the middleware', () => {
  it("'1 - scm.sales.orders' opens sales orders and nothing else", async () => {
    primeWriteFreezeCache('1 - scm.sales.orders');
    const app = makeApp(STAFF, 1);
    expect((await post(app, '/api/scm/mfg-sales-orders')).status).toBe(200);
    expect((await post(app, '/api/scm/mfg-purchase-orders')).status).toBe(503);
    expect((await post(app, '/api/scm/grns')).status).toBe(503);
    expect((await post(app, '/api/scm/hr')).status).toBe(503);
  });

  it('names the area that is still shut, once some areas have reopened', async () => {
    primeWriteFreezeCache('1 - scm.sales.orders');
    const { body } = await post(makeApp(STAFF, 1), '/api/scm/mfg-purchase-orders');
    expect(String(body.reason)).toMatch(/purchase orders/i);
    expect(String(body.reason)).toMatch(/other areas have reopened/i);
    expect(body.area).toBe('scm.procurement.po');
    expect(String(body.reason).length).toBeLessThan(200);
  });

  it('opens every router the area covers, not just the headline one', async () => {
    primeWriteFreezeCache('1 - scm.procurement.po');
    // scm.procurement.po carries PO amendments as well as the PO API.
    expect((await post(makeApp(STAFF, 1), '/api/scm/mfg-purchase-orders/PO-1/lines')).status).toBe(200);
  });

  it('a two-stage lift opens both', async () => {
    primeWriteFreezeCache('1 - scm.sales.orders, scm.procurement.po');
    const app = makeApp(STAFF, 1);
    expect((await post(app, '/api/scm/mfg-sales-orders')).status).toBe(200);
    expect((await post(app, '/api/scm/mfg-purchase-orders')).status).toBe(200);
    expect((await post(app, '/api/scm/grns')).status).toBe(503);
  });

  it('an operator sentence still wins over the area sentence', async () => {
    primeWriteFreezeCache('1 - scm.sales.orders', 'PO is still closed. Ask Ah Meng.');
    const { body } = await post(makeApp(STAFF, 1), '/api/scm/mfg-purchase-orders');
    expect(body.reason).toBe('PO is still closed. Ask Ah Meng.');
  });

  it('a lift does not reach the other company', async () => {
    primeWriteFreezeCache('2 - scm.sales.orders');
    expect((await post(makeApp(STAFF, 1), '/api/scm/mfg-purchase-orders')).status).toBe(200);
    expect((await post(makeApp(STAFF, 2), '/api/scm/mfg-purchase-orders')).status).toBe(503);
    expect((await post(makeApp(STAFF, 2), '/api/scm/mfg-sales-orders')).status).toBe(200);
  });
});

describe('fail closed / fail open, through the middleware', () => {
  it('a value nobody can parse refuses BOTH companies', async () => {
    primeWriteFreezeCache('houzs only');
    expect((await post(makeApp(STAFF, 1), '/api/scm/mfg-sales-orders')).status).toBe(503);
    expect((await post(makeApp(STAFF, 2), '/api/scm/mfg-sales-orders')).status).toBe(503);
    // Even a request we cannot attribute to a company is refused when the
    // instruction itself was unreadable.
    expect((await post(makeApp(STAFF, undefined), '/api/scm/mfg-sales-orders')).status).toBe(503);
  });

  it('a mistyped area leaves the freeze exactly where it was', async () => {
    primeWriteFreezeCache('1 - scm.sales.order');
    const app = makeApp(STAFF, 1);
    expect((await post(app, '/api/scm/mfg-sales-orders')).status).toBe(503);
    expect((await post(app, '/api/scm/mfg-purchase-orders')).status).toBe(503);
  });

  it('an ABSENT row is open — a fresh environment is not frozen', async () => {
    primeWriteFreezeCache(null);
    expect((await post(makeApp(STAFF, 1), '/api/scm/mfg-sales-orders')).status).toBe(200);
  });

  it("'off' is open", async () => {
    primeWriteFreezeCache('off');
    expect((await post(makeApp(STAFF, 1), '/api/scm/mfg-sales-orders')).status).toBe(200);
  });

  it('the bypass still applies when the value is malformed', async () => {
    // Fail-closed must not lock IT out of fixing the row that caused it.
    primeWriteFreezeCache('nonsense');
    expect((await post(makeApp(IT, 1), '/api/scm/mfg-sales-orders')).status).toBe(200);
    expect((await post(makeApp(OWNER, 1), '/api/scm/mfg-sales-orders')).status).toBe(200);
  });
});

describe('cost', () => {
  it('builds no Supabase client while the cache is warm', async () => {
    /* These apps are dispatched with no env, so getSupabaseService would throw
       on `env.SUPABASE_URL`. A 503 rather than a 500 proves the cached value
       was used and the client was never constructed — it used to be built
       eagerly as the call argument, once per write request. */
    primeWriteFreezeCache('1');
    const app = makeApp(STAFF, 1);
    for (let i = 0; i < 5; i += 1) {
      expect((await post(app, '/api/scm/mfg-sales-orders')).status).toBe(503);
    }
  });

  it('does not touch the config at all for a GET', async () => {
    resetWriteFreezeCache();
    const res = await makeApp(STAFF, 1).request('/api/scm/mfg-sales-orders', { method: 'GET' });
    expect(res.status).toBe(200);
  });
});
