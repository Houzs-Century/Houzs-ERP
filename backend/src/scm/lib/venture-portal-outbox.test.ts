// THE VENTURE PORTAL FEED: what the five-minute sweep does with a queued order.
//
// WHY THIS FILE IS THE ARGUMENT FOR THE WHOLE DESIGN. The portal's hand-off
// contract put this sender in pg_cron + pg_net, inside the database. Neither
// extension is installed on production (measured 2026-09-12; the query is in
// the migration header), and had they been, NONE of the properties below could
// be asserted by anything this repo runs. Every test here is a property that a
// SQL-only sender would have had to be trusted on:
//
//   • a 401 must NOT burn the row's attempts, or enabling the feed a week after
//     queueing starts would find every order already parked as failed;
//   • a 422 must park AT ONCE, because the contract's own table says it "will
//     not fix itself" and retrying it forever hides it;
//   • an order outside the enabled companies must be refused WITHOUT a request,
//     or turning the feed on for one company leaks the other's sales;
//   • a deleted order must still be DELIVERED, because that is how the portal
//     learns to stop paying commission on a cancelled sale;
//   • three independent off switches must each, alone, stop every delivery.
import { describe, expect, test, beforeEach, vi } from 'vitest';

/* The module reads its client through getSupabaseService(env), as the AutoCount
   drain beside it does. autocountRelinkSweep.test.ts's seam, verbatim. */
let currentSb: ReturnType<typeof import('./fake-postgrest').fakeSb>;
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => currentSb }));

const { fakeSb } = await import('./fake-postgrest');
const {
  VP_DRAIN_BATCH,
  VP_KICK_DELAY_MS,
  VP_KICK_MAX_SWEEPS,
  VP_MAX_ATTEMPTS,
  VP_SECRET_ALPHABET,
  VP_SECRET_LENGTH,
  classifyVpResponse,
  drainVenturePortalOutbox,
  kickVenturePortalDrain,
  mintVpSecret,
  readVpConfig,
  resetVpKick,
  vpKickSweepAgain,
} = await import('./venture-portal-outbox');
const { resetFeedFlagCache } = await import('./venture-portal-feed-flag');

type Row = Record<string, unknown>;

/** VpDrainSummary's shape, spelled locally because the module is reached through
 *  a dynamic import (the getSupabaseService seam) and a type cannot come out of
 *  one. The field list is pinned by every drain test in this file. */
type VpDrainSummaryShape = {
  skipped?: string;
  processed: number;
  sent: number;
  failed: number;
  retried: number;
  outOfScope: number;
};

const URL_ROW = { k: 'vp.url', v: 'https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders' };
const SECRET_ROW = { k: 'vp.secret', v: 'x'.repeat(40) };

/**
 * A database with the feed wired up: flag value, config rows, one pending row
 * and the order it points at.
 *
 * `flag` null means the app_config row is absent, which the migration's seed
 * makes impossible in production but is exactly what an unreachable config
 * looks like — and it must read as OFF.
 */
function db(opts: {
  flag: string | null;
  config?: Row[];
  outbox?: Row[];
  orders?: Row[];
  /** Columns a table does NOT have. Asking for one fails the WHOLE query with
   *  42703, exactly as PostgREST does — the fake's own seam for simulating a
   *  read that errors rather than returns nothing. */
  missing?: Record<string, string[]>;
}) {
  return fakeSb(
    {
      app_config: opts.flag == null ? [] : [{ key: 'scm.venture_portal_feed', value: opts.flag }],
      sync_config: opts.config ?? [URL_ROW, SECRET_ROW],
      venture_portal_outbox: opts.outbox ?? [
        { id: 'vp-1', doc_no: 'HC-SO-013403', op: 'UPDATE', status: 'pending', attempts: 0, created_at: '2026-09-12T01:00:00Z' },
      ],
      mfg_sales_orders: opts.orders ?? [{ doc_no: 'HC-SO-013403', company_id: 1, so_date: '2026-09-01' }],
    },
    opts.missing ?? {},
    /* The migration's venture_portal_outbox_pending_doc_idx: one PENDING row
       per document. Declared so the fake constrains what production constrains. */
    [{ table: 'venture_portal_outbox', column: 'doc_no', covers: (r) => r.status === 'pending' }],
  );
}

const outbox = (sb: { tables: Record<string, Row[]> }) =>
  (sb.tables.venture_portal_outbox ?? []) as Row[];

/** The builder's answer for a live order. */
const payloadFor = (docNo: string) => ({
  docNo,
  snapshotAt: '2026-09-12T02:00:00.000Z',
  deleted: false,
  header: { doc_no: docNo, status: 'OPEN', company_id: 1, local_total_sen: 500000 },
  items: [{ line_no: 1, item_code: 'SKU-1', line_cost_sen: 120000, cancelled: false }],
  payments: [],
  salesperson: { id: 'staff-1', name: 'Lucas Tan' },
});

function withBuilder(sb: ReturnType<typeof fakeSb>, rows: unknown[]) {
  sb.rpcHandlers.vp_build_payloads = () => rows;
  return sb;
}

const res = (status: number, body: unknown = { outcome: 'applied' }) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const env = {} as never;

/* BRACES, not a concise arrow: vitest treats a value returned from beforeEach as
   that test's teardown, and these two return undefined today but a future one
   might not. resetVpKick with no argument also restores the REAL clock and sleep,
   so a seam set by one test cannot leak into the next. */
beforeEach(() => {
  resetFeedFlagCache();
  resetVpKick();
});

// ---------------------------------------------------------------------------

describe('the response taxonomy', () => {
  /* THIS IS A DELIBERATE DIVERGENCE FROM THE CONTRACT and the reason it is
     tested first. The contract says every non-2xx keeps the row pending and
     retries it forever. Two of those cases must not consume an attempt and two
     must not be retried at all, and getting it backwards is silent in both
     directions. */
  test('a 2xx is delivered, whatever the portal decided to do with it', () => {
    for (const s of [200, 201, 204, 299]) {
      expect(classifyVpResponse(s).outcome).toBe('sent');
    }
  });

  test('a 401 retries and does NOT consume an attempt', () => {
    const v = classifyVpResponse(401);
    expect(v.outcome).toBe('retry');
    expect(v.attempt).toBe(false);
    expect(v.note).toMatch(/secret/i);
  });

  test('a 503 — the portal has no secret yet — retries and does NOT consume an attempt', () => {
    const v = classifyVpResponse(503);
    expect(v.outcome).toBe('retry');
    expect(v.attempt).toBe(false);
  });

  test('a 400 or 422 parks at once: the same bytes will be refused again', () => {
    for (const s of [400, 422]) {
      expect(classifyVpResponse(s).outcome).toBe('failed');
    }
  });

  test('a 500 and a transport failure both retry, and both cost an attempt', () => {
    for (const s of [500, 502, 0]) {
      const v = classifyVpResponse(s);
      expect(v.outcome).toBe('retry');
      expect(v.attempt).toBe(true);
    }
  });
});

describe('the three off switches', () => {
  test('the flag off sends nothing, and does not even look at the queue', async () => {
    const sb = withBuilder(db({ flag: 'off' }), [payloadFor('HC-SO-013403')]);
    currentSb = sb;
    const fetchImpl = vi.fn() as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.skipped).toBe('feed_off');
    expect(r.sent).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outbox(sb)[0].status).toBe('pending');
  });

  test('an ABSENT flag row reads as off — an unreachable config never starts sending', async () => {
    currentSb = withBuilder(db({ flag: null }), [payloadFor('HC-SO-013403')]);
    const fetchImpl = vi.fn() as never;

    expect((await drainVenturePortalOutbox(env, 25, fetchImpl)).skipped).toBe('feed_off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a value nobody can parse reads as off, not as `all`', async () => {
    /* The shared parser resolves a malformed write FREEZE to 'all', because
       freezing too much is loud. Here 'all' would mean start sending every
       company outward on the strength of a typo, so this flag falls the other
       way. The `1-sales_orders` shape is the freeze row's grammar pasted into
       the neighbouring key — one row apart in the same table. */
    for (const bad of ['1-sales_orders', 'yes please', '1.5']) {
      resetFeedFlagCache();
      currentSb = withBuilder(db({ flag: bad }), [payloadFor('HC-SO-013403')]);
      const fetchImpl = vi.fn() as never;
      expect((await drainVenturePortalOutbox(env, 25, fetchImpl)).skipped).toBe('feed_off');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  test('no URL and no secret means not configured — the queue simply waits', async () => {
    for (const config of [[], [URL_ROW], [SECRET_ROW]]) {
      resetFeedFlagCache();
      const sb = withBuilder(db({ flag: '1', config }), [payloadFor('HC-SO-013403')]);
      currentSb = sb;
      const fetchImpl = vi.fn() as never;

      expect((await drainVenturePortalOutbox(env, 25, fetchImpl)).skipped).toBe('not_configured');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(outbox(sb)[0].status).toBe('pending');
    }
  });
});

describe('delivering', () => {
  test('a delivered order is marked sent and keeps the portal`s own word for what it did', async () => {
    const sb = withBuilder(db({ flag: '1' }), [payloadFor('HC-SO-013403')]);
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(200, { outcome: 'applied' })) as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.sent).toBe(1);
    expect(outbox(sb)[0].status).toBe('sent');
    expect(outbox(sb)[0].portal_outcome).toBe('applied');
    expect(outbox(sb)[0].last_error).toBe(null);
  });

  /* A 200 the portal chose NOT to apply is still a successful DELIVERY. The
     contract warns against conflating the two twice, because a `held` month
     replayed later depends on our side having marked it delivered. */
  test('a 200 whose outcome is `held` is still a delivery, and says so', async () => {
    const sb = withBuilder(db({ flag: '1' }), [payloadFor('HC-SO-013403')]);
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(200, { outcome: 'held' })) as never;

    expect((await drainVenturePortalOutbox(env, 25, fetchImpl)).sent).toBe(1);
    expect(outbox(sb)[0].status).toBe('sent');
    expect(outbox(sb)[0].portal_outcome).toBe('held');
  });

  test('the secret travels as x-sync-secret and the body is the built payload', async () => {
    currentSb = withBuilder(db({ flag: '1' }), [payloadFor('HC-SO-013403')]);
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (u: string, init: RequestInit) => {
      calls.push([u, init]);
      return res(200);
    }) as never;

    await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(URL_ROW.v);
    expect((init.headers as Record<string, string>)['x-sync-secret']).toBe(SECRET_ROW.v);
    expect(JSON.parse(String(init.body)).docNo).toBe('HC-SO-013403');
    /* The costing the portal's margin layer was waiting for. */
    expect(JSON.parse(String(init.body)).items[0].line_cost_sen).toBe(120000);
  });

  /* CANCELLATION, the path the owner named. An order that no longer exists is
     not "out of scope" — the portal needs the delete to stop paying on it. */
  test('a deleted order is still delivered, so the portal stops paying commission on it', async () => {
    const sb = withBuilder(
      db({
        flag: '1',
        outbox: [{ id: 'vp-9', doc_no: 'HC-SO-GONE', op: 'DELETE', status: 'pending', attempts: 0, created_at: '2026-09-12T01:00:00Z' }],
        orders: [],
      }),
      [{ docNo: 'HC-SO-GONE', deleted: true, snapshotAt: '2026-09-12T02:00:00.000Z' }],
    );
    currentSb = sb;
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return res(200, { outcome: 'applied' });
    }) as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.sent).toBe(1);
    expect(r.outOfScope).toBe(0);
    expect(JSON.parse(bodies[0]).deleted).toBe(true);
    expect(outbox(sb)[0].status).toBe('sent');
  });
});

describe('refusing to send', () => {
  test('a company nobody enabled is skipped WITHOUT a request', async () => {
    const sb = withBuilder(
      db({ flag: '1', orders: [{ doc_no: 'HC-SO-013403', company_id: 2, so_date: '2026-09-01' }] }),
      [payloadFor('HC-SO-013403')],
    );
    currentSb = sb;
    const fetchImpl = vi.fn() as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.outOfScope).toBe(1);
    expect(r.sent).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outbox(sb)[0].status).toBe('skipped');
    expect(String(outbox(sb)[0].last_error)).toMatch(/company/i);
  });

  test('an order older than vp.since is skipped WITHOUT a request', async () => {
    const sb = withBuilder(
      db({
        flag: '1',
        config: [URL_ROW, SECRET_ROW, { k: 'vp.since', v: '2026-08-01' }],
        orders: [{ doc_no: 'HC-SO-013403', company_id: 1, so_date: '2026-07-31' }],
      }),
      [payloadFor('HC-SO-013403')],
    );
    currentSb = sb;
    const fetchImpl = vi.fn() as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.outOfScope).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outbox(sb)[0].status).toBe('skipped');
    expect(String(outbox(sb)[0].last_error)).toMatch(/since/i);
  });

  /* THE MOST IMPORTANT TEST IN THIS FILE, and it exists because
     audit:swallowed-reads found the bug it pins.

     The scope check is a read of mfg_sales_orders. That read's error was
     originally not bound, so a five-second database blip returned no rows, every
     lookup came back undefined, the `if (so)` guard was false — and the row fell
     through to the deliverable list WITH NO SCOPE CHECK AT ALL. A blip would have
     delivered another company's sales order, with its costs and its margins, to
     an external portal, and nothing would have said so.

     The fix aborts the sweep. What this test pins is the CONSEQUENCE, not the
     implementation: on a failed scope read, nothing is sent and nothing is
     marked. Leave this test in place even if the mechanism changes. */
  test('a FAILED scope read sends nothing — a blip must not bypass the company check', async () => {
    const sb = withBuilder(
      db({ flag: '1', missing: { mfg_sales_orders: ['company_id'] } }),
      [payloadFor('HC-SO-013403')],
    );
    currentSb = sb;
    const fetchImpl = vi.fn() as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.skipped).toBe('scope_read_failed');
    expect(r.sent).toBe(0);
    expect(r.outOfScope).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    /* Still pending, so the next sweep retries it once the database answers. */
    expect(outbox(sb)[0].status).toBe('pending');
    expect(outbox(sb)[0].attempts).toBe(0);
  });

  test('`all` sends for every company', async () => {
    const sb = withBuilder(
      db({ flag: 'all', orders: [{ doc_no: 'HC-SO-013403', company_id: 7, so_date: '2026-09-01' }] }),
      [payloadFor('HC-SO-013403')],
    );
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(200)) as never;

    expect((await drainVenturePortalOutbox(env, 25, fetchImpl)).sent).toBe(1);
  });
});

describe('what a refusal does to the row', () => {
  test('a 401 leaves the row pending with its attempts UNTOUCHED', async () => {
    const sb = withBuilder(db({ flag: '1' }), [payloadFor('HC-SO-013403')]);
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(401, { error: 'unauthorized' })) as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.retried).toBe(1);
    expect(outbox(sb)[0].status).toBe('pending');
    /* THE PROPERTY. Six 401s while somebody is still filling in the secret must
       not park six orders. */
    expect(outbox(sb)[0].attempts).toBe(0);
    expect(String(outbox(sb)[0].last_error)).toMatch(/401/);
  });

  test('a 422 parks the row immediately, without spending six attempts on it', async () => {
    const sb = withBuilder(db({ flag: '1' }), [payloadFor('HC-SO-013403')]);
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(422, { error: 'docNo missing' })) as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.failed).toBe(1);
    expect(outbox(sb)[0].status).toBe('failed');
    expect(outbox(sb)[0].attempts).toBe(1);
  });

  test('a 500 retries until the attempts run out, then parks', async () => {
    const sb = withBuilder(
      db({
        flag: '1',
        outbox: [{ id: 'vp-1', doc_no: 'HC-SO-013403', op: 'UPDATE', status: 'pending', attempts: VP_MAX_ATTEMPTS - 1, created_at: '2026-09-12T01:00:00Z' }],
      }),
      [payloadFor('HC-SO-013403')],
    );
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(500, { error: 'boom' })) as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.failed).toBe(1);
    expect(outbox(sb)[0].status).toBe('failed');
    expect(outbox(sb)[0].attempts).toBe(VP_MAX_ATTEMPTS);
    expect(String(outbox(sb)[0].last_error)).toMatch(/gave up/);
  });

  test('a row that has already exhausted its attempts is not picked up again', async () => {
    const sb = withBuilder(
      db({
        flag: '1',
        outbox: [{ id: 'vp-1', doc_no: 'HC-SO-013403', op: 'UPDATE', status: 'pending', attempts: VP_MAX_ATTEMPTS, created_at: '2026-09-12T01:00:00Z' }],
      }),
      [payloadFor('HC-SO-013403')],
    );
    currentSb = sb;
    const fetchImpl = vi.fn() as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.processed).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a transport failure is an outcome, not a crash', async () => {
    const sb = withBuilder(db({ flag: '1' }), [payloadFor('HC-SO-013403')]);
    currentSb = sb;
    const fetchImpl = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.retried).toBe(1);
    expect(outbox(sb)[0].status).toBe('pending');
    expect(outbox(sb)[0].attempts).toBe(1);
    expect(String(outbox(sb)[0].last_error)).toMatch(/network unreachable/);
  });

  /* The builder answering for every other document but not this one is a
     CONTRADICTION, not a delivery problem. Sending something invented here
     would put a payload the database never produced into somebody's commission. */
  test('a document the builder did not answer for is left pending, never invented', async () => {
    const sb = withBuilder(db({ flag: '1' }), []);
    currentSb = sb;
    const fetchImpl = vi.fn() as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.retried).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outbox(sb)[0].status).toBe('pending');
    expect(String(outbox(sb)[0].last_error)).toMatch(/no payload/);
  });
});

describe('readVpConfig', () => {
  test('answers null until BOTH the url and the secret are set', async () => {
    for (const config of [[], [URL_ROW], [SECRET_ROW]]) {
      const sb = db({ flag: '1', config });
      expect(await readVpConfig(sb as never)).toBeNull();
    }
  });

  test('reads the url, the secret and the optional date floor', async () => {
    const sb = db({ flag: '1', config: [URL_ROW, SECRET_ROW, { k: 'vp.since', v: '2026-08-01' }] });
    expect(await readVpConfig(sb as never)).toEqual({
      url: URL_ROW.v,
      secret: SECRET_ROW.v,
      since: '2026-08-01',
    });
  });

  test('a missing date floor is null, not an empty string', async () => {
    const sb = db({ flag: '1' });
    expect((await readVpConfig(sb as never))?.since).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE KEY THIS SIDE MINTS
//
// Two properties, and only one of them is about length. The other is that the
// sampling is UNBIASED, which no amount of eyeballing the output would show:
// `byte & 63` is uniform only while the alphabet is exactly 64 symbols long, and
// shortening it to 62 (the obvious "alphanumeric only" edit) makes the first two
// symbols 4/256 likelier than the rest, silently and forever.
// ---------------------------------------------------------------------------

describe('minting a key', () => {
  test('the alphabet is exactly 64 URL-safe symbols, which is what makes it unbiased', () => {
    expect(VP_SECRET_ALPHABET.length).toBe(64);
    expect(new Set(VP_SECRET_ALPHABET).size).toBe(64);
    /* URL-safe: nothing here needs escaping in a header, a form field or a
       query string, which is the whole reason the alphabet is not plain base64. */
    expect(VP_SECRET_ALPHABET).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('a key is 48 URL-safe characters, well over the portal 32-character floor', () => {
    const key = mintVpSecret();
    expect(key.length).toBe(VP_SECRET_LENGTH);
    expect(key.length).toBe(48);
    expect(key).toMatch(/^[A-Za-z0-9_-]{48}$/);
    /* The route's own MIN_SECRET_LEN and the portal's ERP_SYNC_SECRET_MIN_LENGTH
       are both 32. A generated key must never be refused by the thing that
       stores it. */
    expect(key.length).toBeGreaterThanOrEqual(32);
  });

  test('two keys are never the same', () => {
    const keys = new Set(Array.from({ length: 200 }, () => mintVpSecret()));
    expect(keys.size).toBe(200);
  });

  test('every symbol it produces comes from the declared alphabet', () => {
    /* Guards the indexing itself: a `& 64` or an off-by-one on the alphabet
       length would yield `undefined` characters, and "undefined" in a shared
       secret is a string the portal would happily accept. */
    const chars = new Set(Array.from({ length: 100 }, () => mintVpSecret()).join(''));
    for (const ch of chars) expect(VP_SECRET_ALPHABET).toContain(ch);
  });
});

// ---------------------------------------------------------------------------
// SECONDS INSTEAD OF FIVE MINUTES — the kick
//
// WHAT THESE TESTS ARE REALLY PROTECTING. The kick runs inside waitUntil, after
// the response has gone, on every non-GET write in the whole SCM surface. That
// is the worst possible place for a bug to be visible: it cannot fail a request,
// so nothing tells anybody. Each property below is one that would be silent in
// production.
//
//   - a kick must never throw into the request that scheduled it;
//   - a burst of writes must schedule ONE drain, or saving a sales order with
//     four lines would POST the same document four times;
//   - a kick whose waitUntil REFUSED must not leave the debounce armed, or one
//     failed schedule would swallow the next 1.5 s of real ones;
//   - the sweep loop must stop when a sweep achieved nothing, or a mismatched
//     key would send 100 POSTs per kick for as long as it stayed mismatched.
// ---------------------------------------------------------------------------

/** A waitUntil that hands the scheduled work back so a test can await it. */
function fakeCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { scheduled.push(p); } },
    settle: () => Promise.all(scheduled),
    count: () => scheduled.length,
  };
}

/** N pending rows for N documents that belong to a company nobody enabled.
 *
 *  WHY OUT OF SCOPE: the drain clears such a row WITHOUT a request (asserted in
 *  'refusing to send'), so these tests exercise the kick's scheduling and its
 *  sweep loop end-to-end with ZERO network and no fetch to stub. What lands in
 *  the table is the proof the drain really ran inside waitUntil. */
function outOfScopeQueue(n: number) {
  const docs = Array.from({ length: n }, (_, i) => `HC-SO-9${String(i).padStart(4, '0')}`);
  return db({
    flag: '1',
    outbox: docs.map((doc_no, i) => ({
      id: `vp-${i}`,
      doc_no,
      op: 'UPDATE',
      status: 'pending',
      attempts: 0,
      created_at: `2026-09-12T00:${String(i % 60).padStart(2, '0')}:00Z`,
    })),
    orders: docs.map((doc_no) => ({ doc_no, company_id: 9, so_date: '2026-09-01' })),
  });
}

describe('deciding whether to sweep again', () => {
  const summary = (over: Partial<VpDrainSummaryShape>): VpDrainSummaryShape => ({
    processed: 0, sent: 0, failed: 0, retried: 0, outOfScope: 0, ...over,
  });

  test('a full batch that LEFT the queue means there is probably more', () => {
    expect(vpKickSweepAgain(summary({ processed: 25, sent: 25 }))).toBe(true);
    expect(vpKickSweepAgain(summary({ outOfScope: 25 }))).toBe(true);
    expect(vpKickSweepAgain(summary({ sent: 20, failed: 5 }))).toBe(true);
  });

  /* THE TRAP THIS FUNCTION EXISTS FOR. A 401 keeps its row pending and costs it
     no attempts, so a full batch is `processed` on every sweep for as long as
     the two keys disagree. Counting `processed` would send 100 POSTs per kick,
     forever, at exactly the moment somebody is mid-way through pasting the key
     on the portal. */
  test('a full batch that stayed pending does NOT earn another sweep', () => {
    expect(vpKickSweepAgain(summary({ processed: 25, retried: 25 }))).toBe(false);
  });

  test('a part-full batch stops the kick and leaves the rest to the sweep', () => {
    expect(vpKickSweepAgain(summary({ processed: 24, sent: 24 }))).toBe(false);
    expect(vpKickSweepAgain(summary({ processed: 0 }))).toBe(false);
  });

  /* Every `skipped` code means the drain did not get as far as the queue — off,
     unconfigured, or a failed read. Sweeping again would repeat the same refusal
     three more times. */
  test('a drain that never reached the queue is never swept again', () => {
    for (const skipped of ['feed_off', 'not_configured', 'query_failed', 'scope_read_failed']) {
      expect(vpKickSweepAgain(summary({ skipped, sent: 25 }))).toBe(false);
    }
  });
});

describe('kicking the drain', () => {
  test('the drain really runs, after the wait, inside waitUntil', async () => {
    currentSb = outOfScopeQueue(1);
    let waited = -1;
    resetVpKick({ sleep: async (ms) => { waited = ms; } });
    const { ctx, settle, count } = fakeCtx();

    expect(kickVenturePortalDrain(env, ctx)).toBe('scheduled');
    expect(count()).toBe(1);
    /* Nothing has happened YET — the work is queued, not run, which is the
       property that keeps it off the request's critical path. */
    expect(outbox(currentSb)[0].status).toBe('pending');

    await settle();
    expect(waited).toBe(VP_KICK_DELAY_MS);
    expect(outbox(currentSb)[0].status).toBe('skipped');
  });

  /* SAVING ONE SALES ORDER IS SEVERAL REQUESTS. Without the debounce each would
     schedule its own drain and the portal would upsert the same document once
     per request — the payload is built at SEND time precisely so they collapse
     into one delivery, and that only works if the delivery waits. */
  test('writes inside the window schedule ONE drain', async () => {
    currentSb = outOfScopeQueue(1);
    let clock = 1_000_000;
    resetVpKick({ now: () => clock, sleep: async () => {} });
    const { ctx, settle, count } = fakeCtx();

    expect(kickVenturePortalDrain(env, ctx)).toBe('scheduled');
    clock += 200;
    expect(kickVenturePortalDrain(env, ctx)).toBe('debounced');
    clock += 200;
    expect(kickVenturePortalDrain(env, ctx)).toBe('debounced');
    expect(count()).toBe(1);

    /* And a write AFTER the window gets its own drain — the debounce is a
       collapse, not a rate limit that drops work. */
    clock += VP_KICK_DELAY_MS;
    expect(kickVenturePortalDrain(env, ctx)).toBe('scheduled');
    expect(count()).toBe(2);
    await settle();
  });

  test('a context with no waitUntil is reported, not silently ignored', () => {
    currentSb = outOfScopeQueue(1);
    resetVpKick({ sleep: async () => {} });
    expect(kickVenturePortalDrain(env, null)).toBe('no_execution_context');
    expect(outbox(currentSb)[0].status).toBe('pending');
  });

  /* THE ONE THAT IS ONLY A BUG IF YOU GET THE ORDER WRONG. Stamping the
     debounce before waitUntil succeeds would mean one refused schedule ate the
     next 1.5 s of real ones — invisible, because a refused schedule is already
     silent. */
  test('a waitUntil that refuses leaves the next kick free to try', () => {
    currentSb = outOfScopeQueue(1);
    resetVpKick({ sleep: async () => {} });
    const angry = { waitUntil: () => { throw new Error('this context is dead'); } };

    expect(kickVenturePortalDrain(env, angry)).toBe('no_execution_context');

    const { ctx } = fakeCtx();
    expect(kickVenturePortalDrain(env, ctx)).toBe('scheduled');
  });

  /* NEVER INTO THE REQUEST. The person who pressed Save already has their 200;
     a broken accelerator must not turn into an unhandled rejection in their
     isolate. */
  test('a failure inside the scheduled work never rejects', async () => {
    currentSb = outOfScopeQueue(1);
    resetVpKick({ sleep: async () => { throw new Error('boom'); } });
    const { ctx, settle } = fakeCtx();

    expect(kickVenturePortalDrain(env, ctx)).toBe('scheduled');
    await expect(settle()).resolves.toBeDefined();
    expect(outbox(currentSb)[0].status).toBe('pending');
  });

  /* THE BACKFILL, which is why one kick sweeps more than once: 30 waiting
     documents clear in one kick instead of taking two five-minute sweeps. */
  test('one kick sweeps again while a full batch keeps leaving the queue', async () => {
    currentSb = outOfScopeQueue(30);
    resetVpKick({ sleep: async () => {} });
    const { ctx, settle } = fakeCtx();

    expect(kickVenturePortalDrain(env, ctx)).toBe('scheduled');
    await settle();

    /* A single sweep is capped at VP_DRAIN_BATCH, so all 30 being cleared is the
       proof that the loop ran twice. */
    expect(outbox(currentSb).filter((r) => r.status === 'skipped')).toHaveLength(30);
    expect(outbox(currentSb).filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  /* AND IT IS BOUNDED. A kick is not a backfill tool — 4 sweeps, then it hands
     the rest back to the five-minute cron, so one save can never turn into an
     unbounded run inside somebody's waitUntil. */
  test('a kick stops at VP_KICK_MAX_SWEEPS and leaves the rest to the cron', async () => {
    const total = VP_DRAIN_BATCH * VP_KICK_MAX_SWEEPS + 25;
    currentSb = outOfScopeQueue(total);
    resetVpKick({ sleep: async () => {} });
    const { ctx, settle } = fakeCtx();

    expect(kickVenturePortalDrain(env, ctx)).toBe('scheduled');
    await settle();

    expect(outbox(currentSb).filter((r) => r.status === 'skipped'))
      .toHaveLength(VP_DRAIN_BATCH * VP_KICK_MAX_SWEEPS);
    expect(outbox(currentSb).filter((r) => r.status === 'pending')).toHaveLength(25);
  });
});
