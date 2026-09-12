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
  VP_MAX_ATTEMPTS,
  classifyVpResponse,
  drainVenturePortalOutbox,
  readVpConfig,
} = await import('./venture-portal-outbox');
const { resetFeedFlagCache } = await import('./venture-portal-feed-flag');

type Row = Record<string, unknown>;

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

beforeEach(() => resetFeedFlagCache());

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
