// THE VENTURE PORTAL SALES ATTENDING PUSH: when the list is sent, where, and
// what the portal's answer does to the record of what it holds.
//
// The body itself is SQL (tests-pg/vpSalesAttending.pg.test.ts runs it). What
// is here is what a wrong line of TypeScript would break silently:
//
//   • an unchanged list must cost one md5, not a post;
//   • a list the portal REFUSED must not be re-sent every five minutes, and one
//     it may or may not have applied must not be trusted as delivered;
//   • a vp.url of the wrong shape must stop the push, not be guessed at;
//   • the kick must send when Sales Attending changed and cost nothing when not.
import { describe, expect, test, beforeEach, vi } from 'vitest';
import type { Env } from '../env';

/* The module reads its client through getSupabaseService(env), like the
   catalogue's sender; the same seam. */
let currentSb: ReturnType<typeof import('./fake-postgrest').fakeSb>;
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => currentSb }));

const { fakeSb } = await import('./fake-postgrest');
const {
  pushVenturePortalAttendance,
  pushVenturePortalAttendanceOnChange,
  vpAttendanceUrl,
} = await import('./venture-portal-attendance');
const { vpCatalogueUrl } = await import('./venture-portal-catalogue');
const { resetFeedFlagCache } = await import('./venture-portal-feed-flag');

type Row = Record<string, unknown>;
type Body = { companyId: number; since: string; snapshotAt?: string; booths: Row[] };

const ORDERS_URL = 'https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders';
const ATTENDING_URL = 'https://venture-portal-chi.vercel.app/api/erp/v1/sales-attending';
const URL_ROW = { k: 'vp.url', v: ORDERS_URL };
const SECRET_ROW = { k: 'vp.secret', v: 's'.repeat(48) };

/** A small body, in scm.vp_attendance_snapshot's shape (snapshotAt added by the SQL). */
const list = (companyId: number): Body => ({
  companyId,
  since: '2026-04-01',
  snapshotAt: '2026-10-12T08:00:00.000+00:00',
  booths: [
    {
      projectId: 363, code: 'PRJ-363', name: 'BIGHOME MID VALLEY', brand: 'AKEMI', venue: 'MID VALLEY',
      organizer: 'BIGHOME', startDate: '2026-10-02', endDate: '2026-10-04', status: 'confirmed', eventType: 'exhibition',
      attendees: [{ salesRepId: 54, code: 'SR-015', name: 'Chea Huan', salespersonId: 'b7eabf08-7f43-3afe-66ef-d4d20a87f64a' }],
    },
    {
      projectId: 2264, code: 'PRJ-2264', name: 'PERFECT LIVING MVEC', brand: 'ZANOTTI', venue: 'MVEC SOUTHKEY',
      organizer: 'PERFECT LIVING', startDate: '2026-10-02', endDate: '2026-10-04', status: 'confirmed', eventType: 'exhibition',
      attendees: [],
    },
  ],
});

/**
 * A database with the feed wired up and the two Sales Attending functions
 * answering. `digests` is what scm.vp_attendance_digest returns per company;
 * the snapshot answers the same digest unless `snapshotDigests` says otherwise.
 */
function db(opts: {
  flag: string | null;
  config?: Row[];
  state?: Row[];
  companies?: Row[];
  digests?: Record<number, string>;
  snapshotDigests?: Record<number, string>;
  missing?: Record<string, string[]>;
  changes?: Row[];
}) {
  const sb = fakeSb(
    {
      app_config: opts.flag == null ? [] : [{ key: 'scm.venture_portal_feed', value: opts.flag }],
      sync_config: opts.config ?? [URL_ROW, SECRET_ROW],
      venture_portal_attendance_state: opts.state ?? [],
      companies: opts.companies ?? [{ id: 1 }, { id: 2 }],
      venture_portal_attendance_changes: opts.changes ?? [],
    },
    opts.missing ?? {},
  );
  const digests = opts.digests ?? { 1: 'a-new', 2: 'a-two' };
  sb.rpcHandlers.vp_attendance_digest = (args) => digests[Number(args.p_company_id)] ?? null;
  sb.rpcHandlers.vp_attendance_snapshot = (args) => {
    const co = Number(args.p_company_id);
    return { digest: (opts.snapshotDigests ?? digests)[co], body: list(co) };
  };
  return sb;
}

const state = (sb: { tables: Partial<Record<string, Row[]>> }, companyId: number): Row | undefined =>
  (sb.tables.venture_portal_attendance_state ?? []).find((r) => Number(r.company_id) === companyId);
const rpcNames = (sb: { rpcCalls: Array<{ fn: string }> }) => sb.rpcCalls.map((c) => c.fn);
const marks = (sb: { tables: Partial<Record<string, Row[]>> }) =>
  (sb.tables.venture_portal_attendance_changes ?? []).map((r) => Number(r.id));
const MARK = (id: number): Row => ({ id, source: 'project_sales_attendees' });
const delivered = (d: string) => ({ delivered_digest: d, last_digest: d, last_outcome: 'sent' });

const res = (status: number, body: unknown = { ok: true, outcome: 'applied', booths: 2 }) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers `statuses` in turn and records every call. */
function portal(...statuses: Array<number | Error>) {
  const calls: Array<{ url: string; init: RequestInit; body: Body }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Body });
    const answer = statuses[Math.min(i++, statuses.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer >= 200 && answer <= 299 ? res(answer) : res(answer, { ok: false, error: `portal said ${answer}` });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/* Only ever handed to the mocked getSupabaseService above. */
const env = {} as Env;

beforeEach(() => {
  resetFeedFlagCache();
});

describe('the receiver is the order feed`s sibling', () => {
  test('/sales-orders becomes /sales-attending, beside the catalogue`s /products', () => {
    expect(vpAttendanceUrl(ORDERS_URL)).toBe(ATTENDING_URL);
    expect(vpAttendanceUrl(`  ${ORDERS_URL}/  `)).toBe(ATTENDING_URL);
    expect(vpCatalogueUrl(ORDERS_URL)).toBe('https://venture-portal-chi.vercel.app/api/erp/v1/products');
  });

  test('anything that does not end in /sales-orders answers null — never a guess', () => {
    for (const bad of [
      'https://venture-portal-chi.vercel.app/api/erp/v1/products',
      'https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders/extra',
      'https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders?x=1',
      'http://venture-portal-chi.vercel.app/api/erp/v1/sales-orders',
      'not a url',
      '',
    ]) {
      expect(vpAttendanceUrl(bad)).toBeNull();
    }
  });
});

describe('live: the kick sends the list when Sales Attending changed', () => {
  test('a mark sends the changed list at once and clears the mark', async () => {
    const sb = db({ flag: '1', changes: [MARK(1), MARK(2)] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalAttendanceOnChange(env, fetchImpl);

    expect(r.companies).toEqual([expect.objectContaining({ companyId: 1, action: 'sent' })]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ATTENDING_URL);
    expect(marks(sb)).toEqual([]);
  });

  test('no mark: no digest is asked and nothing is posted', async () => {
    const sb = db({ flag: '1' });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    expect(await pushVenturePortalAttendanceOnChange(env, fetchImpl)).toEqual({ skipped: 'unchanged', companies: [] });
    expect(rpcNames(sb)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('the feed off: the marks are not even read, let alone sent', async () => {
    const sb = db({ flag: 'off', changes: [MARK(1)] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    expect(await pushVenturePortalAttendanceOnChange(env, fetchImpl)).toEqual({ skipped: 'feed_off', companies: [] });
    expect(calls).toHaveLength(0);
    expect(marks(sb)).toEqual([1]);
  });

  test('a mark written while the run builds survives it', async () => {
    const sb = db({ flag: '1', changes: [MARK(1)] });
    currentSb = sb;
    const asked = sb.rpcHandlers.vp_attendance_digest!;
    sb.rpcHandlers.vp_attendance_digest = (args) => {
      sb.tables.venture_portal_attendance_changes!.push(MARK(2));
      return asked(args);
    };

    await pushVenturePortalAttendanceOnChange(env, portal(200).fetchImpl);

    expect(marks(sb)).toEqual([2]);
  });
});

describe('the digest decides whether anything is sent', () => {
  test('an unchanged list costs ONE rpc: nothing is built or posted', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, ...delivered('a-new') }] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalAttendance(env, { force: false }, fetchImpl);

    expect(r.companies).toEqual([expect.objectContaining({ companyId: 1, action: 'unchanged', digest: 'a-new' })]);
    expect(rpcNames(sb)).toEqual(['vp_attendance_digest']);
    expect(calls).toHaveLength(0);
  });

  test('a changed list is built once, posted once and recorded as delivered with the portal`s answer', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, ...delivered('a-old') }] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalAttendance(env, { force: false }, fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'sent', digest: 'a-new', httpStatus: 200, note: null });
    expect(r.companies[0]!.bytes).toBeGreaterThan(0);
    expect(rpcNames(sb)).toEqual(['vp_attendance_digest', 'vp_attendance_snapshot']);
    expect(calls).toHaveLength(1);
    expect(state(sb, 1)).toMatchObject({
      delivered_digest: 'a-new', last_digest: 'a-new', last_outcome: 'sent', last_http_status: 200, last_error: null,
      portal_result: { ok: true, outcome: 'applied', booths: 2 },
    });
    expect(state(sb, 1)?.delivered_at).toEqual(expect.any(String));
  });

  test('the digest recorded is the one of the list sent, not the one first asked for', async () => {
    const sb = db({ flag: '1', digests: { 1: 'a-asked' }, snapshotDigests: { 1: 'a-built' } });
    currentSb = sb;

    const r = await pushVenturePortalAttendance(env, { force: false }, portal(200).fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'sent', digest: 'a-built' });
    expect(state(sb, 1)?.delivered_digest).toBe('a-built');
  });

  test('a forced send skips the question and sends an unchanged list anyway', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, ...delivered('a-new') }] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalAttendance(env, { force: true }, fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'sent', digest: 'a-new' });
    expect(rpcNames(sb)).toEqual(['vp_attendance_snapshot']);
    expect(calls).toHaveLength(1);
  });
});

describe('what the portal`s answer means (the catalogue`s taxonomy, one post)', () => {
  test('401: recorded, the old delivery still stands, and the next run tries again', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, ...delivered('a-old') }] });
    currentSb = sb;

    const r = await pushVenturePortalAttendance(env, { force: false }, portal(401).fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'retry', httpStatus: 401 });
    expect(state(sb, 1)).toMatchObject({ delivered_digest: 'a-old', last_digest: 'a-new', last_outcome: 'retry' });

    resetFeedFlagCache();
    const again = portal(200);
    await pushVenturePortalAttendance(env, { force: false }, again.fetchImpl);
    expect(again.calls).toHaveLength(1);
    expect(state(sb, 1)).toMatchObject({ delivered_digest: 'a-new', last_outcome: 'sent' });
  });

  test('422 (or 413): parked with the portal`s own words, not re-sent until the list changes', async () => {
    for (const refused of [422, 413]) {
      resetFeedFlagCache();
      const sb = db({ flag: '1' });
      currentSb = sb;

      const r = await pushVenturePortalAttendance(env, { force: false }, portal(refused).fetchImpl);
      expect(r.companies[0]).toMatchObject({ action: 'failed', httpStatus: refused });
      expect(state(sb, 1)).toMatchObject({ last_digest: 'a-new', last_outcome: 'failed' });
      expect(String(state(sb, 1)?.last_error)).toMatch(new RegExp(`portal said ${refused}`));

      resetFeedFlagCache();
      const quiet = portal(200);
      const r2 = await pushVenturePortalAttendance(env, { force: false }, quiet.fetchImpl);
      expect(r2.companies[0]).toMatchObject({ action: 'refused_unchanged' });
      expect(quiet.calls).toHaveLength(0);
    }
  });

  test('500: retried, and the delivery record is no longer trusted', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, ...delivered('a-old') }] });
    currentSb = sb;

    await pushVenturePortalAttendance(env, { force: false }, portal(500).fetchImpl);

    expect(state(sb, 1)).toMatchObject({ delivered_digest: null, last_outcome: 'retry', last_http_status: 500 });
  });

  test('a transport failure is an outcome, not a crash', async () => {
    const sb = db({ flag: '1' });
    currentSb = sb;

    const r = await pushVenturePortalAttendance(env, { force: false }, portal(new Error('connection reset')).fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'retry', httpStatus: 0 });
    expect(String(state(sb, 1)?.last_error)).toMatch(/connection reset/);
    expect(state(sb, 1)?.delivered_digest).toBeNull();
  });
});

describe('the post itself', () => {
  test('to /sales-attending, with the order feed`s secret header, the SQL`s body verbatim', async () => {
    currentSb = db({ flag: '1' });
    const { fetchImpl, calls } = portal(200);

    await pushVenturePortalAttendance(env, { force: false }, fetchImpl);

    expect(calls).toHaveLength(1);
    const [{ url, init, body }] = calls;
    expect(url).toBe(ATTENDING_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-sync-secret']).toBe(SECRET_ROW.v);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(body).toEqual(list(1));
  });
});

describe('the gates are the order feed`s', () => {
  test('the switch off sends nothing and asks the database nothing', async () => {
    const sb = db({ flag: 'off' });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    expect((await pushVenturePortalAttendance(env, { force: true }, fetchImpl)).skipped).toBe('feed_off');
    expect(sb.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('no url or no secret: not configured, nothing sent', async () => {
    for (const config of [[], [URL_ROW], [SECRET_ROW]]) {
      resetFeedFlagCache();
      currentSb = db({ flag: '1', config });
      const { fetchImpl, calls } = portal(200);
      expect((await pushVenturePortalAttendance(env, { force: true }, fetchImpl)).skipped).toBe('not_configured');
      expect(calls).toHaveLength(0);
    }
  });

  test('a vp.url that is not .../sales-orders stops the push and says so', async () => {
    const sb = db({ flag: '1', config: [{ k: 'vp.url', v: 'https://venture-portal-chi.vercel.app/hook' }, SECRET_ROW] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await pushVenturePortalAttendance(env, { force: true }, fetchImpl);

    expect(r.skipped).toBe('attendance_url_unknown');
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/\[vp-attendance\].*sales-orders/));
    expect(sb.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    err.mockRestore();
  });

  test('only the companies in scope: another company`s list is never even built', async () => {
    const sb = db({ flag: '1' });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalAttendance(env, { force: false }, fetchImpl);

    expect(r.companies.map((c) => c.companyId)).toEqual([1]);
    expect(sb.rpcCalls.every((c) => Number(c.args.p_company_id) === 1)).toBe(true);
    expect(calls.map((c) => c.body.companyId)).toEqual([1]);
  });

  test('an unreadable delivery record sends nothing', async () => {
    const sb = db({ flag: '1', missing: { venture_portal_attendance_state: ['last_outcome'] } });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalAttendance(env, { force: false }, fetchImpl);

    expect(r.skipped).toBe('state_read_failed');
    expect(sb.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('SQL that does not answer is reported per company and sends nothing for it', async () => {
    const sb = db({ flag: 'all' });
    currentSb = sb;
    sb.rpcHandlers.vp_attendance_digest = (args) => {
      if (Number(args.p_company_id) === 1) throw new Error('canceling statement due to statement timeout');
      return 'a-two';
    };
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalAttendance(env, { force: false }, fetchImpl);

    expect(r.companies[0]).toMatchObject({ companyId: 1, action: 'build_failed' });
    expect(r.companies[0]!.note).toMatch(/statement timeout/);
    expect(r.companies[1]).toMatchObject({ companyId: 2, action: 'sent' });
    expect(calls.map((c) => c.body.companyId)).toEqual([2]);
  });

  test('a snapshot that is not a list is never posted', async () => {
    const sb = db({ flag: '1' });
    currentSb = sb;
    sb.rpcHandlers.vp_attendance_snapshot = () => ({ digest: 'a-new', body: null });
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalAttendance(env, { force: false }, fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'build_failed' });
    expect(calls).toHaveLength(0);
  });
});
