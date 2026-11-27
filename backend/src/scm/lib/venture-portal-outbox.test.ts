import { describe, expect, test, beforeEach, vi } from 'vitest';

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
  vpUrlAllowed,
  vpKickSweepAgain,
} = await import('./venture-portal-outbox');
const { resetFeedFlagCache } = await import('./venture-portal-feed-flag');

type Row = Record<string, unknown>;

type VpDrainSummaryShape = {
  skipped?: string;
  processed: number;
  sent: number;
  failed: number;
  retried: number;
  outOfScope: number;
  changed: number;
};

const URL_ROW = { k: 'vp.url', v: 'https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders' };
const SECRET_ROW = { k: 'vp.secret', v: 'x'.repeat(40) };

function db(opts: {
  flag: string | null;
  config?: Row[];
  outbox?: Row[];
  orders?: Row[];
  missing?: Record<string, string[]>;
}) {
  return fakeSb(
    {
      app_config: opts.flag == null ? [] : [{ key: 'scm.venture_portal_feed', value: opts.flag }],
      sync_config: opts.config ?? [URL_ROW, SECRET_ROW],
      venture_portal_outbox: opts.outbox ?? [
        { id: 'vp-1', doc_no: 'HC-SO-013403', op: 'UPDATE', status: 'pending', attempts: 0, revision: 0, created_at: '2026-09-12T01:00:00Z' },
      ],
      mfg_sales_orders: opts.orders ?? [{ doc_no: 'HC-SO-013403', company_id: 1, so_date: '2026-09-01' }],
    },
    opts.missing ?? {},
    [{ table: 'venture_portal_outbox', column: 'doc_no', covers: (r) => r.status === 'pending' }],
  );
}

const outbox = (sb: { tables: Record<string, Row[]> }) =>
  (sb.tables.venture_portal_outbox ?? []) as Row[];

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

beforeEach(() => {
  resetFeedFlagCache();
  resetVpKick();
});


describe('the response taxonomy', () => {
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
    expect(JSON.parse(String(init.body)).items[0].line_cost_sen).toBe(120000);
  });

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

  test('a save that lands while its order is in flight goes again, never folded into the delivery that missed it', async () => {
    const sb = db({ flag: '1' });
    let builds = 0;
    sb.rpcHandlers.vp_build_payloads = () => {
      builds += 1;
      if (builds === 1) {
        const rows = outbox(sb);
        rows[0] = { ...rows[0], revision: Number(rows[0].revision) + 1 };
      }
      return [{ ...payloadFor('HC-SO-013403'), snapshotAt: `2026-09-12T02:00:0${builds}.000Z` }];
    };
    currentSb = sb;
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return res(200, { outcome: 'applied' });
    }) as never;

    const first = await drainVenturePortalOutbox(env, 25, fetchImpl);
    expect(first.sent).toBe(0);
    expect(first.changed).toBe(1);
    expect(outbox(sb)[0].status).toBe('pending');

    const second = await drainVenturePortalOutbox(env, 25, fetchImpl);
    expect(second.sent).toBe(1);
    expect(second.changed).toBe(0);
    expect(outbox(sb)[0].status).toBe('sent');
    expect(bodies.map((b) => JSON.parse(b).snapshotAt)).toEqual([
      '2026-09-12T02:00:01.000Z',
      '2026-09-12T02:00:02.000Z',
    ]);
  });

  test('a save made before the row was read is in the payload already, so the row is sent', async () => {
    const sb = withBuilder(
      db({
        flag: '1',
        outbox: [{ id: 'vp-1', doc_no: 'HC-SO-013403', op: 'UPDATE', status: 'pending', attempts: 0, revision: 3, created_at: '2026-09-12T01:00:00Z' }],
      }),
      [payloadFor('HC-SO-013403')],
    );
    currentSb = sb;

    const r = await drainVenturePortalOutbox(env, 25, vi.fn(async () => res(200)) as never);

    expect(r.sent).toBe(1);
    expect(r.changed).toBe(0);
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
    sb.rpcHandlers.vp_old_orders_wanted = () => [];
    currentSb = sb;
    const fetchImpl = vi.fn() as never;

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl);

    expect(r.outOfScope).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outbox(sb)[0].status).toBe('skipped');
    expect(String(outbox(sb)[0].last_error)).toMatch(/since/i);
    expect(sb.rpcCalls.filter((c) => c.fn === 'vp_old_orders_wanted')).toEqual([
      { fn: 'vp_old_orders_wanted', args: { p_doc_nos: ['HC-SO-013403'], p_since: '2026-08-01' } },
    ]);
  });

  /* The one exception to the date floor (owner 2026-11-07): the portal pays the
     colleague who collected the top-up of a departed salesperson's order that
     was under its deposit when the portal started paying. HC-SO-010734 (paper
     ZNT4813, sold 2026-03-10 by a salesperson who has since left) took RM 3,200
     from a colleague on 2026-11-02, and every delivery of that day used to be
     skipped here. */
  test('an old order the portal wants is delivered after all', async () => {
    const sb = withBuilder(
      db({
        flag: '1',
        config: [URL_ROW, SECRET_ROW, { k: 'vp.since', v: '2026-08-01' }],
        outbox: [
          { id: 'vp-1', doc_no: 'HC-SO-010734', op: 'INSERT:mfg_sales_order_payments', status: 'pending', attempts: 0, revision: 0, created_at: '2026-11-02T12:03:14Z' },
          { id: 'vp-2', doc_no: 'HC-SO-010735', op: 'UPDATE', status: 'pending', attempts: 0, revision: 0, created_at: '2026-11-02T12:04:00Z' },
        ],
        orders: [
          { doc_no: 'HC-SO-010734', company_id: 1, so_date: '2026-03-10' },
          { doc_no: 'HC-SO-010735', company_id: 1, so_date: '2026-03-11' },
        ],
      }),
      [payloadFor('HC-SO-010734')],
    );
    sb.rpcHandlers.vp_old_orders_wanted = () => ['HC-SO-010734'];
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(200, { outcome: 'applied' }));

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl as unknown as typeof fetch);

    expect(r).toMatchObject({ sent: 1, outOfScope: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).docNo).toBe('HC-SO-010734');
    expect(outbox(sb).map((row) => [row.doc_no, row.status, row.portal_outcome ?? null])).toEqual([
      ['HC-SO-010734', 'sent', 'applied'],
      ['HC-SO-010735', 'skipped', null],
    ]);
    expect(sb.rpcCalls.filter((c) => c.fn === 'vp_old_orders_wanted')).toEqual([
      { fn: 'vp_old_orders_wanted', args: { p_doc_nos: ['HC-SO-010734', 'HC-SO-010735'], p_since: '2026-08-01' } },
    ]);
  });

  test('a FAILED old-order question sends nothing and marks nothing', async () => {
    const sb = withBuilder(
      db({
        flag: '1',
        config: [URL_ROW, SECRET_ROW, { k: 'vp.since', v: '2026-08-01' }],
        outbox: [
          { id: 'vp-1', doc_no: 'HC-SO-010734', op: 'UPDATE', status: 'pending', attempts: 0, revision: 0, created_at: '2026-11-02T12:03:14Z' },
          { id: 'vp-2', doc_no: 'HC-SO-013403', op: 'UPDATE', status: 'pending', attempts: 0, revision: 0, created_at: '2026-11-02T12:04:00Z' },
        ],
        orders: [
          { doc_no: 'HC-SO-010734', company_id: 1, so_date: '2026-03-10' },
          { doc_no: 'HC-SO-013403', company_id: 1, so_date: '2026-09-01' },
        ],
      }),
      [payloadFor('HC-SO-010734'), payloadFor('HC-SO-013403')],
    );
    sb.rpcHandlers.vp_old_orders_wanted = () => { throw new Error('canceling statement due to statement timeout'); };
    currentSb = sb;
    const fetchImpl = vi.fn();

    const r = await drainVenturePortalOutbox(env, 25, fetchImpl as unknown as typeof fetch);

    expect(r.skipped).toBe('scope_read_failed');
    expect(r.sent + r.outOfScope).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outbox(sb).map((row) => [row.status, row.attempts])).toEqual([['pending', 0], ['pending', 0]]);
  });

  test('nothing too old in the sweep, nothing asked', async () => {
    const sb = withBuilder(
      db({
        flag: '1',
        config: [URL_ROW, SECRET_ROW, { k: 'vp.since', v: '2026-08-01' }],
        outbox: [
          { id: 'vp-1', doc_no: 'HC-SO-013403', op: 'UPDATE', status: 'pending', attempts: 0, revision: 0, created_at: '2026-09-12T01:00:00Z' },
          { id: 'vp-2', doc_no: 'HC2990-SO-000101', op: 'UPDATE', status: 'pending', attempts: 0, revision: 0, created_at: '2026-09-12T01:01:00Z' },
        ],
        orders: [
          { doc_no: 'HC-SO-013403', company_id: 1, so_date: '2026-09-01' },
          { doc_no: 'HC2990-SO-000101', company_id: 2, so_date: '2026-03-01' },
        ],
      }),
      [payloadFor('HC-SO-013403')],
    );
    currentSb = sb;

    const r = await drainVenturePortalOutbox(env, 25, vi.fn(async () => res(200)) as unknown as typeof fetch);

    expect(r).toMatchObject({ sent: 1, outOfScope: 1 });
    expect(sb.rpcCalls.map((c) => c.fn)).not.toContain('vp_old_orders_wanted');
    expect(outbox(sb)[1].status).toBe('skipped');
  });

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
      expect(await readVpConfig(sb as never, null)).toBeNull();
    }
  });

  test('reads the url, the secret and the optional date floor', async () => {
    const sb = db({ flag: '1', config: [URL_ROW, SECRET_ROW, { k: 'vp.since', v: '2026-08-01' }] });
    expect(await readVpConfig(sb as never, null)).toEqual({
      url: URL_ROW.v,
      secret: SECRET_ROW.v,
      since: '2026-08-01',
    });
  });

  test('a missing date floor is null, not an empty string', async () => {
    const sb = db({ flag: '1' });
    expect((await readVpConfig(sb as never, null))?.since).toBeNull();
  });

  test('staging never reads a prod portal url as configured (HC-SO-2611-088)', () => {
    expect(vpUrlAllowed(URL_ROW.v, 'staging')).toBe(false);
    expect(vpUrlAllowed('https://ERP.houzsventure.com/api/erp/v1/sales-orders', 'staging')).toBe(false);
    expect(vpUrlAllowed('not a url', 'staging')).toBe(false);
    expect(vpUrlAllowed('https://venture-portal-git-x.vercel.app/api', 'staging')).toBe(true);
    expect(vpUrlAllowed(URL_ROW.v, 'production')).toBe(true);
    expect(vpUrlAllowed(URL_ROW.v, null)).toBe(true);
  });

  test('a staging drain with a copied prod url sends nothing', async () => {
    const sb = withBuilder(db({ flag: '1' }), [payloadFor('HC-SO-013403')]);
    currentSb = sb;
    const fetchImpl = vi.fn<typeof fetch>();

    const r = await drainVenturePortalOutbox({ SENTRY_ENVIRONMENT: 'staging' } as never, 25, fetchImpl);

    expect(r.skipped).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outbox(sb)[0].status).toBe('pending');
  });
});


describe('what the sweep picks first', () => {
  const backfillRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `bf-${i}`,
      doc_no: `HC-SO-OLD-${String(i).padStart(4, '0')}`,
      op: 'RECONCILE',
      status: 'pending',
      attempts: 0,
      created_at: `2026-09-13T01:00:${String(i % 60).padStart(2, '0')}Z`,
    }));

  const liveRow = () => ({
    id: 'live-1',
    doc_no: 'HC-SO-NEW-0001',
    op: 'UPDATE',
    status: 'pending',
    attempts: 0,
    created_at: '2026-09-13T09:00:00Z',
  });

  const orderRowsFor = (rows: Row[]) =>
    rows.map((r) => ({ doc_no: r.doc_no, company_id: 1, so_date: '2026-09-01' }));

  test('a save just made goes out before a backfill queued hours earlier', async () => {
    const rows = [...backfillRows(60), liveRow()];
    const sb = withBuilder(
      db({ flag: '1', outbox: rows, orders: orderRowsFor(rows) }),
      [payloadFor(liveRow().doc_no), ...backfillRows(60).map((r) => payloadFor(String(r.doc_no)))],
    );
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(200)) as unknown as typeof fetch;

    await drainVenturePortalOutbox(env, VP_DRAIN_BATCH, fetchImpl);

    const live = outbox(sb).find((r) => r.id === 'live-1');
    expect(live?.status).toBe('sent');
  });

  test('the backfill still fills the rest of the batch, oldest first', async () => {
    const rows = [...backfillRows(60), liveRow()];
    const sb = withBuilder(
      db({ flag: '1', outbox: rows, orders: orderRowsFor(rows) }),
      [payloadFor(liveRow().doc_no), ...backfillRows(60).map((r) => payloadFor(String(r.doc_no)))],
    );
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(200)) as unknown as typeof fetch;

    const r = await drainVenturePortalOutbox(env, VP_DRAIN_BATCH, fetchImpl);

    expect(r.sent).toBe(VP_DRAIN_BATCH);
    const sentBackfill = outbox(sb).filter((x) => x.op === 'RECONCILE' && x.status === 'sent');
    expect(sentBackfill).toHaveLength(VP_DRAIN_BATCH - 1);
    expect(sentBackfill.map((x) => x.doc_no).sort()).toEqual(
      backfillRows(VP_DRAIN_BATCH - 1).map((x) => x.doc_no).sort(),
    );
  });

  test('with nothing live waiting, the backfill drains oldest-first as before', async () => {
    const rows = backfillRows(40);
    const sb = withBuilder(
      db({ flag: '1', outbox: rows, orders: orderRowsFor(rows) }),
      rows.map((r) => payloadFor(String(r.doc_no))),
    );
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(200)) as unknown as typeof fetch;

    const r = await drainVenturePortalOutbox(env, VP_DRAIN_BATCH, fetchImpl);

    expect(r.sent).toBe(VP_DRAIN_BATCH);
    expect(outbox(sb).filter((x) => x.status === 'sent').map((x) => x.doc_no).sort()).toEqual(
      backfillRows(VP_DRAIN_BATCH).map((x) => x.doc_no).sort(),
    );
  });

  test('several live saves go in their own order, oldest of them first', async () => {
    const live = [
      { ...liveRow(), id: 'live-a', doc_no: 'HC-SO-NEW-A', created_at: '2026-09-13T09:00:02Z' },
      { ...liveRow(), id: 'live-b', doc_no: 'HC-SO-NEW-B', created_at: '2026-09-13T09:00:01Z' },
    ];
    const rows = [...backfillRows(5), ...live];
    const sb = withBuilder(
      db({ flag: '1', outbox: rows, orders: orderRowsFor(rows) }),
      rows.map((r) => payloadFor(String(r.doc_no))),
    );
    currentSb = sb;
    const sentDocs: string[] = [];
    const fetchImpl = vi.fn(async (_u: unknown, init: { body?: string } = {}) => {
      sentDocs.push(JSON.parse(String(init.body ?? '{}')).docNo);
      return res(200);
    }) as unknown as typeof fetch;

    await drainVenturePortalOutbox(env, VP_DRAIN_BATCH, fetchImpl);

    expect(sentDocs.slice(0, 2)).toEqual(['HC-SO-NEW-B', 'HC-SO-NEW-A']);
  });

  test('a child-table edit counts as live, not as a backfill', async () => {
    const child = { ...liveRow(), id: 'live-child', doc_no: 'HC-SO-NEW-CHILD', op: 'UPDATE:mfg_sales_order_payments' };
    const rows = [...backfillRows(60), child];
    const sb = withBuilder(
      db({ flag: '1', outbox: rows, orders: orderRowsFor(rows) }),
      rows.map((r) => payloadFor(String(r.doc_no))),
    );
    currentSb = sb;
    const fetchImpl = vi.fn(async () => res(200)) as unknown as typeof fetch;

    await drainVenturePortalOutbox(env, VP_DRAIN_BATCH, fetchImpl);

    expect(outbox(sb).find((r) => r.id === 'live-child')?.status).toBe('sent');
  });
});


describe('minting a key', () => {
  test('the alphabet is exactly 64 URL-safe symbols, which is what makes it unbiased', () => {
    expect(VP_SECRET_ALPHABET.length).toBe(64);
    expect(new Set(VP_SECRET_ALPHABET).size).toBe(64);
    expect(VP_SECRET_ALPHABET).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('a key is 48 URL-safe characters, well over the portal 32-character floor', () => {
    const key = mintVpSecret();
    expect(key.length).toBe(VP_SECRET_LENGTH);
    expect(key.length).toBe(48);
    expect(key).toMatch(/^[A-Za-z0-9_-]{48}$/);
    expect(key.length).toBeGreaterThanOrEqual(32);
  });

  test('two keys are never the same', () => {
    const keys = new Set(Array.from({ length: 200 }, () => mintVpSecret()));
    expect(keys.size).toBe(200);
  });

  test('every symbol it produces comes from the declared alphabet', () => {
    const chars = new Set(Array.from({ length: 100 }, () => mintVpSecret()).join(''));
    for (const ch of chars) expect(VP_SECRET_ALPHABET).toContain(ch);
  });
});


function fakeCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { scheduled.push(p); } },
    settle: () => Promise.all(scheduled),
    count: () => scheduled.length,
  };
}

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
    processed: 0, sent: 0, failed: 0, retried: 0, outOfScope: 0, changed: 0, ...over,
  });

  test('an order that changed in flight earns another sweep, however small the batch', () => {
    expect(vpKickSweepAgain(summary({ processed: 1, changed: 1 }))).toBe(true);
    expect(vpKickSweepAgain(summary({ skipped: 'feed_off', changed: 1 }))).toBe(false);
  });

  test('a full batch that LEFT the queue means there is probably more', () => {
    expect(vpKickSweepAgain(summary({ processed: 25, sent: 25 }))).toBe(true);
    expect(vpKickSweepAgain(summary({ outOfScope: 25 }))).toBe(true);
    expect(vpKickSweepAgain(summary({ sent: 20, failed: 5 }))).toBe(true);
  });

  test('a full batch that stayed pending does NOT earn another sweep', () => {
    expect(vpKickSweepAgain(summary({ processed: 25, retried: 25 }))).toBe(false);
  });

  test('a part-full batch stops the kick and leaves the rest to the sweep', () => {
    expect(vpKickSweepAgain(summary({ processed: 24, sent: 24 }))).toBe(false);
    expect(vpKickSweepAgain(summary({ processed: 0 }))).toBe(false);
  });

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

    expect(kickVenturePortalDrain(env, ctx, null)).toBe('scheduled');
    expect(count()).toBe(1);
    expect(outbox(currentSb)[0].status).toBe('pending');

    await settle();
    expect(waited).toBe(VP_KICK_DELAY_MS);
    expect(outbox(currentSb)[0].status).toBe('skipped');
  });

  test('writes inside the window schedule ONE drain', async () => {
    currentSb = outOfScopeQueue(1);
    let clock = 1_000_000;
    resetVpKick({ now: () => clock, sleep: async () => {} });
    const { ctx, settle, count } = fakeCtx();

    expect(kickVenturePortalDrain(env, ctx, null)).toBe('scheduled');
    clock += 200;
    expect(kickVenturePortalDrain(env, ctx, null)).toBe('debounced');
    clock += 200;
    expect(kickVenturePortalDrain(env, ctx, null)).toBe('debounced');
    expect(count()).toBe(1);

    clock += VP_KICK_DELAY_MS;
    expect(kickVenturePortalDrain(env, ctx, null)).toBe('scheduled');
    expect(count()).toBe(2);
    await settle();
  });

  test('a context with no waitUntil is reported, not silently ignored', () => {
    currentSb = outOfScopeQueue(1);
    resetVpKick({ sleep: async () => {} });
    expect(kickVenturePortalDrain(env, null, null)).toBe('no_execution_context');
    expect(outbox(currentSb)[0].status).toBe('pending');
  });

  test('a waitUntil that refuses leaves the next kick free to try', () => {
    currentSb = outOfScopeQueue(1);
    resetVpKick({ sleep: async () => {} });
    const angry = { waitUntil: () => { throw new Error('this context is dead'); } };

    expect(kickVenturePortalDrain(env, angry, null)).toBe('no_execution_context');

    const { ctx } = fakeCtx();
    expect(kickVenturePortalDrain(env, ctx, null)).toBe('scheduled');
  });

  test('a failure inside the scheduled work never rejects', async () => {
    currentSb = outOfScopeQueue(1);
    resetVpKick({ sleep: async () => { throw new Error('boom'); } });
    const { ctx, settle } = fakeCtx();

    expect(kickVenturePortalDrain(env, ctx, null)).toBe('scheduled');
    await expect(settle()).resolves.toBeDefined();
    expect(outbox(currentSb)[0].status).toBe('pending');
  });

  /* THE CATALOGUE RIDES THE SAME TASK (owner 2026-09-24: live, not five
     minutes). One task per window, the orders first, and neither half can stop
     the other. */
  test('the step after the drain runs once the sweeps are done, in the same task', async () => {
    currentSb = outOfScopeQueue(1);
    resetVpKick({ sleep: async () => {} });
    const { ctx, settle, count } = fakeCtx();
    const seen: string[] = [];
    const after = vi.fn(async () => { seen.push(String(outbox(currentSb)[0].status)); });

    expect(kickVenturePortalDrain(env, ctx, after)).toBe('scheduled');
    expect(count()).toBe(1);
    expect(after).not.toHaveBeenCalled();

    await settle();
    expect(after).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['skipped']);
  });

  test('writes inside the window run the step ONCE, with the one drain', async () => {
    currentSb = outOfScopeQueue(1);
    let clock = 1_000_000;
    resetVpKick({ now: () => clock, sleep: async () => {} });
    const { ctx, settle } = fakeCtx();
    const after = vi.fn(async () => {});

    expect(kickVenturePortalDrain(env, ctx, after)).toBe('scheduled');
    clock += 200;
    expect(kickVenturePortalDrain(env, ctx, after)).toBe('debounced');
    await settle();
    expect(after).toHaveBeenCalledTimes(1);
  });

  test('a drain that fails still runs the step after it', async () => {
    currentSb = outOfScopeQueue(1);
    resetVpKick({ sleep: async () => { throw new Error('boom'); } });
    const { ctx, settle } = fakeCtx();
    const after = vi.fn(async () => {});

    expect(kickVenturePortalDrain(env, ctx, after)).toBe('scheduled');
    await expect(settle()).resolves.toBeDefined();
    expect(after).toHaveBeenCalledTimes(1);
  });

  test('a step that throws never rejects either', async () => {
    currentSb = outOfScopeQueue(1);
    resetVpKick({ sleep: async () => {} });
    const { ctx, settle } = fakeCtx();

    expect(kickVenturePortalDrain(env, ctx, async () => { throw new Error('catalogue down'); })).toBe('scheduled');
    await expect(settle()).resolves.toBeDefined();
    expect(outbox(currentSb)[0].status).toBe('skipped');
  });

  test('one kick sweeps again while a full batch keeps leaving the queue', async () => {
    currentSb = outOfScopeQueue(30);
    resetVpKick({ sleep: async () => {} });
    const { ctx, settle } = fakeCtx();

    expect(kickVenturePortalDrain(env, ctx, null)).toBe('scheduled');
    await settle();

    expect(outbox(currentSb).filter((r) => r.status === 'skipped')).toHaveLength(30);
    expect(outbox(currentSb).filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  test('an order saved again while its delivery was in flight is swept again after the same wait', async () => {
    const sb = db({ flag: '1' });
    let builds = 0;
    sb.rpcHandlers.vp_build_payloads = () => {
      builds += 1;
      if (builds === 1) {
        const rows = outbox(sb);
        rows[0] = { ...rows[0], revision: Number(rows[0].revision) + 1 };
      }
      return [payloadFor('HC-SO-013403')];
    };
    currentSb = sb;
    const waits: number[] = [];
    resetVpKick({ sleep: async (ms) => { waits.push(ms); } });
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { outcome: 'applied' })));
    try {
      const { ctx, settle } = fakeCtx();
      expect(kickVenturePortalDrain(env, ctx, null)).toBe('scheduled');
      await settle();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(builds).toBe(2);
    expect(waits).toEqual([VP_KICK_DELAY_MS, VP_KICK_DELAY_MS]);
    expect(outbox(sb)[0].status).toBe('sent');
  });

  test('a kick stops at VP_KICK_MAX_SWEEPS and leaves the rest to the cron', async () => {
    const total = VP_DRAIN_BATCH * VP_KICK_MAX_SWEEPS + 25;
    currentSb = outOfScopeQueue(total);
    resetVpKick({ sleep: async () => {} });
    const { ctx, settle } = fakeCtx();

    expect(kickVenturePortalDrain(env, ctx, null)).toBe('scheduled');
    await settle();

    expect(outbox(currentSb).filter((r) => r.status === 'skipped'))
      .toHaveLength(VP_DRAIN_BATCH * VP_KICK_MAX_SWEEPS);
    expect(outbox(currentSb).filter((r) => r.status === 'pending')).toHaveLength(25);
  });
});
