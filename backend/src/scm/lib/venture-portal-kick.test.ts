// THE MIDDLEWARE THAT MAKES THE FEED SECOND-LEVEL: which requests earn a drain.
//
// WHY THIS FILE EXISTS SEPARATELY from venture-portal-outbox.test.ts, which
// already covers the kick itself. That suite proves the kick debounces, sweeps
// and never throws. It cannot prove the kick is ever REACHED, and the middleware
// makes three decisions that are silent in both directions if they are wrong:
//
//   - a GET must not kick. Get it backwards and every list refresh on the busiest
//     SCM pages schedules a drain — no incorrect data, just load nobody asked for
//     on a path that is supposed to be free;
//   - a non-2xx must not kick. A write refused by a permission gate or by the
//     write freeze changed nothing, so a drain for it is work for a save that did
//     not happen;
//   - a successful write MUST kick, and this is the direction that is genuinely
//     invisible: get it wrong and the feed still works, still loses nothing, and
//     simply goes back to taking up to five minutes — the exact thing the owner
//     asked to be fixed, silently un-fixed.
//
// It is mounted after write-freeze, so the 503 case below is not hypothetical:
// that is what a frozen company's save looks like arriving here.
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

/* Same seam as the sender's suite: the module reads its client through
   getSupabaseService(env), so a fake is installed rather than a database. */
let currentSb: unknown;
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => currentSb }));

const { fakeSb } = await import('./fake-postgrest');
const { resetVpKick } = await import('./venture-portal-outbox');
const { venturePortalKick } = await import('./venture-portal-kick');
const { resetFeedFlagCache } = await import('./venture-portal-feed-flag');

/** The feed OFF, which is how it ships. A kick then costs one cached flag read
 *  and sends nothing — so these tests assert SCHEDULING, never delivery. */
function feedOff() {
  return fakeSb({ app_config: [{ key: 'scm.venture_portal_feed', value: 'off' }] }, {}, []);
}

/**
 * Exactly what this middleware uses of an ExecutionContext.
 *
 * `Pick`, not the whole type and not `as never`: the real ExecutionContext also
 * carries `exports` and `tracing`, which are RUNTIME capabilities a unit test
 * cannot honestly fabricate and which the middleware never touches. Inventing
 * them to satisfy the annotation would be the thing the `as never` rule exists to
 * stop, wearing a different badge. So the fake is typed as the subset it really
 * is, and the one widening happens at the Hono boundary in `fetchWith` below,
 * where it is visible and explained once.
 */
type KickCtx = Pick<ExecutionContext, 'waitUntil' | 'passThroughOnException'>;

/** An ExecutionContext that hands the scheduled work back to the test. */
function fakeCtx() {
  const scheduled: Promise<unknown>[] = [];
  const ctx: KickCtx = {
    waitUntil: (p: Promise<unknown>) => { scheduled.push(p); },
    passThroughOnException: () => {},
  };
  return { ctx, settle: () => Promise.all(scheduled), count: () => scheduled.length };
}

/**
 * The SCM mount, in miniature: the kick on '/*', then the handlers.
 *
 * `refused` answers 503 with no body work — the shape scmWriteFreeze returns for
 * a frozen company, which is the realistic non-2xx here rather than an invented
 * one.
 */
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

/* The kick reads `env` only to reach getSupabaseService, which is mocked above,
   so there is genuinely nothing for a real binding set to be. Typed as the empty
   object it is rather than cast past the check — `Record<string, never>` is what
   `{}` IS, and Hono's fetch takes the bindings as an unconstrained generic. */
const env: Record<string, never> = {};

beforeEach(() => {
  currentSb = feedOff();
  resetFeedFlagCache();
  /* No real 1.5 s wait, and a clean debounce clock per test. */
  resetVpKick({ sleep: async () => {} });
});

/**
 * The ONE place the partial context is widened for Hono's `fetch`, which asks for
 * a whole ExecutionContext. See KickCtx for why the fake is a subset; keeping the
 * widening here means there is a single line to read rather than one per test.
 */
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

  /* A refused write changed nothing, so a drain for it is work for a save that
     did not happen. 503 is the write-freeze shape specifically: this middleware
     sits behind scmWriteFreeze, so that is the refusal it will actually meet. */
  test('a refused write schedules nothing — 403 or the write-freeze 503', async () => {
    const forbidden = fakeCtx();
    expect((await call('POST', '/forbidden', forbidden)).status).toBe(403);
    expect(forbidden.count()).toBe(0);

    resetVpKick({ sleep: async () => {} });
    const frozen = fakeCtx();
    expect((await call('POST', '/refused', frozen)).status).toBe(503);
    expect(frozen.count()).toBe(0);
  });

  /* THE REQUEST IS NEVER THE VICTIM. Without an ExecutionContext, reading
     c.executionCtx THROWS — and that must reach the caller as a normal 200, not
     as a 500 on a save that already succeeded. */
  test('a request with no ExecutionContext still succeeds', async () => {
    const res = await fetchWith(new Request('http://x/connection', { method: 'POST' }), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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
