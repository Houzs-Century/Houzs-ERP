// THE VENTURE PORTAL CATALOGUE PUSH: when the catalogue is sent, where, in how
// many posts, and what the portal's answer does to the record of what it holds.
//
// What is NOT here is the body itself — that no price leaves is a property of
// the SQL, and tests-pg/vpCatalogueFeed.pg.test.ts runs that SQL. Every
// property below is one a wrong line of TypeScript would break silently:
//
//   • an unchanged catalogue must cost one md5, not a megabyte;
//   • a catalogue the portal REFUSED must not be re-sent every five minutes,
//     and one it may or may not have applied must not be trusted as delivered;
//   • a section must never be split across two posts, because `full: true`
//     retires whatever a carried section does not mention;
//   • a vp.url of the wrong shape must stop the push, not be guessed at.
import { describe, expect, test, beforeEach, vi } from 'vitest';
import type { Env } from '../env';

/* The module reads its client through getSupabaseService(env), exactly like
   the order feed's sender; venture-portal-outbox.test.ts's seam, verbatim. */
let currentSb: ReturnType<typeof import('./fake-postgrest').fakeSb>;
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => currentSb }));

const { fakeSb } = await import('./fake-postgrest');
const {
  VP_CATALOGUE_MAX_POST_BYTES,
  VP_CATALOGUE_SECTIONS,
  classifyVpCatalogueResponse,
  planVpCatalogueParts,
  pushVenturePortalCatalogue,
  pushVenturePortalCatalogueOnChange,
  vpCatalogueDecision,
  vpCatalogueUrl,
  vpCatalogueVerdict,
} = await import('./venture-portal-catalogue');
const { resetFeedFlagCache } = await import('./venture-portal-feed-flag');

type Row = Record<string, unknown>;
type Body = { companyId: number; full: boolean } & Record<string, unknown>;

const ORDERS_URL = 'https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders';
const PRODUCTS_URL = 'https://venture-portal-chi.vercel.app/api/erp/v1/products';
const URL_ROW = { k: 'vp.url', v: ORDERS_URL };
const SECRET_ROW = { k: 'vp.secret', v: 's'.repeat(48) };

/** A small but complete body, in scm.vp_build_catalogue's shape. */
const catalogue = (companyId: number, over: Row = {}): Body => ({
  companyId,
  full: true,
  products: [{ id: 'mfg-1', code: '8030-1A(LHF)', name: '8030 SOFFIO 1A', status: 'ACTIVE' }],
  models: [{ id: '00000000-0000-0000-0000-00000000000a', model_code: '8030', allowed_options: { sizes: ['Q'] } }],
  maintenance: { effective_from: '2026-09-17', pools: { gaps: ['12"'] } },
  specials: [{ id: 's-1', code: 'LEFT_DRAWER', label: 'Left Drawer', categories: ['BEDFRAME'] }],
  fabrics: [{ id: 'fab-1', fabric_code: 'BF-01', sofa_price_tier: 'PRICE_2' }],
  combos: [{ id: 'c-1', base_model: '8030', heights: ['24'], modules: [['1A(LHF)']] }],
  ...over,
});

/**
 * A database with the feed wired up, and the two catalogue functions answering.
 * `digests` is what scm.vp_catalogue_digest returns per company right now;
 * the snapshot answers the same digest unless `snapshotDigests` says otherwise
 * (the catalogue changing between the two calls).
 */
function db(opts: {
  flag: string | null;
  config?: Row[];
  state?: Row[];
  companies?: Row[];
  digests?: Record<number, string>;
  snapshotDigests?: Record<number, string>;
  bodies?: Record<number, Body>;
  missing?: Record<string, string[]>;
  /** scm.venture_portal_catalogue_changes — the marks the triggers leave. */
  changes?: Row[];
}) {
  const sb = fakeSb(
    {
      app_config: opts.flag == null ? [] : [{ key: 'scm.venture_portal_feed', value: opts.flag }],
      sync_config: opts.config ?? [URL_ROW, SECRET_ROW],
      venture_portal_catalogue_state: opts.state ?? [],
      companies: opts.companies ?? [{ id: 1 }, { id: 2 }],
      venture_portal_catalogue_changes: opts.changes ?? [],
    },
    opts.missing ?? {},
  );
  const digests = opts.digests ?? { 1: 'd-new', 2: 'd-two' };
  sb.rpcHandlers.vp_catalogue_digest = (args) => digests[Number(args.p_company_id)] ?? null;
  sb.rpcHandlers.vp_catalogue_snapshot = (args) => {
    const co = Number(args.p_company_id);
    return {
      digest: (opts.snapshotDigests ?? digests)[co],
      body: opts.bodies?.[co] ?? catalogue(co),
    };
  };
  return sb;
}

/* Partial: a table nobody has written yet is absent, as the fake keeps it. */
const state = (sb: { tables: Partial<Record<string, Row[]>> }, companyId: number): Row | undefined =>
  (sb.tables.venture_portal_catalogue_state ?? []).find((r) => Number(r.company_id) === companyId);

const rpcNames = (sb: { rpcCalls: Array<{ fn: string }> }) => sb.rpcCalls.map((c) => c.fn);

const res = (status: number, body: unknown = { ok: true, outcome: 'applied', products: 1 }) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

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

// ---------------------------------------------------------------------------

describe('the receiver is the order feed`s sibling', () => {
  test('/sales-orders becomes /products', () => {
    expect(vpCatalogueUrl(ORDERS_URL)).toBe(PRODUCTS_URL);
  });

  test('a trailing slash, a path prefix and a port are the same endpoint', () => {
    expect(vpCatalogueUrl(`${ORDERS_URL}/`)).toBe(PRODUCTS_URL);
    expect(vpCatalogueUrl('https://portal.example:8443/x/api/erp/v1/sales-orders'))
      .toBe('https://portal.example:8443/x/api/erp/v1/products');
    expect(vpCatalogueUrl(`  ${ORDERS_URL}  `)).toBe(PRODUCTS_URL);
  });

  /* NOT GUESSED. A receiver URL of any other shape might be a proxy, a
     different deployment or a typo — posting the catalogue to a guess is how
     it ends up somewhere nobody meant. */
  test('anything that does not end in /sales-orders answers null', () => {
    for (const bad of [
      'https://venture-portal-chi.vercel.app/api/erp/v1/orders',
      'https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders-v2',
      'https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders/extra',
      'https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders?x=1',
      'https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders#frag',
      'http://venture-portal-chi.vercel.app/api/erp/v1/sales-orders',
      'not a url',
      '',
    ]) {
      expect(vpCatalogueUrl(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// LIVE: the SCM write kick runs pushVenturePortalCatalogueOnChange after the
// order drain. It must send when a catalogue table was marked — the owner's
// "live, not five minutes" — and cost next to nothing when none was.

const marks = (sb: { tables: Partial<Record<string, Row[]>> }) =>
  (sb.tables.venture_portal_catalogue_changes ?? []).map((r) => Number(r.id));
const MARK = (id: number): Row => ({ id, source: 'mfg_products' });

describe('live: the kick sends the catalogue when a catalogue table changed', () => {
  test('a mark sends the changed catalogue at once and clears the mark', async () => {
    const sb = db({ flag: '1', changes: [MARK(1), MARK(2)] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogueOnChange(env, fetchImpl);

    expect(r.companies).toEqual([expect.objectContaining({ companyId: 1, action: 'sent' })]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(PRODUCTS_URL);
    expect(marks(sb)).toEqual([]);
  });

  /* THE COMMON CASE. Every SCM write ends in this step, and almost none of them
     touched the catalogue: no mark must mean no digest and no post. */
  test('no mark: no digest is asked and nothing is posted', async () => {
    const sb = db({ flag: '1' });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogueOnChange(env, fetchImpl);

    expect(r).toEqual({ skipped: 'unchanged', companies: [] });
    expect(rpcNames(sb)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('the feed off: the marks are not even read, let alone sent', async () => {
    const sb = db({ flag: 'off', changes: [MARK(1)] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    expect(await pushVenturePortalCatalogueOnChange(env, fetchImpl)).toEqual({ skipped: 'feed_off', companies: [] });
    expect(calls).toHaveLength(0);
    expect(marks(sb)).toEqual([1]);
  });

  /* A mark on a column the digest does not see (the trigger lists only what
     the catalogue sends, so this is a race or a no-op UPDATE) still costs one
     digest — and sends nothing. */
  test('a mark on an unchanged catalogue asks the digest, posts nothing, and clears the mark', async () => {
    const sb = db({
      flag: '1',
      changes: [MARK(1)],
      state: [{ company_id: 1, delivered_digest: 'd-new', last_digest: 'd-new', last_outcome: 'sent' }],
    });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogueOnChange(env, fetchImpl);

    expect(r.companies).toEqual([expect.objectContaining({ companyId: 1, action: 'unchanged' })]);
    expect(calls).toHaveLength(0);
    expect(marks(sb)).toEqual([]);
  });

  /* A Save that lands while the catalogue is being built must not be lost:
     the run clears only the marks that were there when it started, so the new
     one earns the next push. */
  test('a mark written while the run builds survives it', async () => {
    const sb = db({ flag: '1', changes: [MARK(1)] });
    currentSb = sb;
    const asked = sb.rpcHandlers.vp_catalogue_digest!;
    sb.rpcHandlers.vp_catalogue_digest = (args) => {
      sb.tables.venture_portal_catalogue_changes!.push(MARK(2));
      return asked(args);
    };

    await pushVenturePortalCatalogueOnChange(env, portal(200).fetchImpl);

    expect(marks(sb)).toEqual([2]);
  });

  /* The cron runs the same push every five minutes whatever the flag says, so
     marks written while the feed is off cannot pile up. */
  test('every push clears the marks it covers — the cron too, with the feed off', async () => {
    const sb = db({ flag: 'off', changes: [MARK(1), MARK(2), MARK(3)] });
    currentSb = sb;

    expect(await pushVenturePortalCatalogue(env, { force: false }, portal(200).fetchImpl))
      .toEqual({ skipped: 'feed_off', companies: [] });
    expect(marks(sb)).toEqual([]);
  });
});

describe('the digest decides whether anything is sent', () => {
  const delivered = (d: string) => ({ delivered_digest: d, last_digest: d, last_outcome: 'sent' });

  test('never delivered, or changed since, is sent; the same digest is not', () => {
    expect(vpCatalogueDecision('d1', null, false)).toBe('send');
    expect(vpCatalogueDecision('d2', delivered('d1'), false)).toBe('send');
    expect(vpCatalogueDecision('d1', delivered('d1'), false)).toBe('unchanged');
  });

  /* The portal refused THESE BYTES. Sending them every five minutes repeats
     the refusal 288 times a day and hides it behind a busy log. */
  test('bytes the portal refused (400/422) wait for a change', () => {
    const refused = { delivered_digest: 'd0', last_digest: 'd1', last_outcome: 'failed' };
    expect(vpCatalogueDecision('d1', refused, false)).toBe('refused_unchanged');
    expect(vpCatalogueDecision('d2', refused, false)).toBe('send');
  });

  test('a retryable answer (401/503/5xx) does not hold anything back', () => {
    expect(vpCatalogueDecision('d1', { delivered_digest: 'd0', last_digest: 'd1', last_outcome: 'retry' }, false)).toBe('send');
    expect(vpCatalogueDecision('d1', { delivered_digest: null, last_digest: 'd1', last_outcome: 'retry' }, false)).toBe('send');
  });

  test('a forced send goes whatever the record says', () => {
    expect(vpCatalogueDecision('d1', delivered('d1'), true)).toBe('send');
    expect(vpCatalogueDecision('d1', { delivered_digest: null, last_digest: 'd1', last_outcome: 'failed' }, true)).toBe('send');
  });

  test('an unchanged catalogue costs ONE rpc: no body is built and nothing is posted', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, ...delivered('d-new') }] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogue(env, { force: false }, fetchImpl);

    expect(r.companies).toEqual([expect.objectContaining({ companyId: 1, action: 'unchanged', digest: 'd-new' })]);
    expect(rpcNames(sb)).toEqual(['vp_catalogue_digest']);
    expect(calls).toHaveLength(0);
  });

  test('a changed catalogue is built once, posted once and recorded as delivered', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, ...delivered('d-old') }] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogue(env, { force: false }, fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'sent', digest: 'd-new', parts: 1, httpStatus: 200, note: null });
    expect(rpcNames(sb)).toEqual(['vp_catalogue_digest', 'vp_catalogue_snapshot']);
    expect(calls).toHaveLength(1);
    expect(state(sb, 1)).toMatchObject({
      delivered_digest: 'd-new', last_digest: 'd-new', last_outcome: 'sent', last_http_status: 200, last_error: null, last_parts: 1,
    });
    /* The portal's own answer is kept, per post. */
    expect(state(sb, 1)?.portal_result).toEqual([
      expect.objectContaining({ status: 200, result: expect.objectContaining({ outcome: 'applied' }) }),
    ]);
    expect(state(sb, 1)?.delivered_at).toEqual(expect.any(String));
  });

  /* THE RACE the snapshot exists for. The catalogue can change between the
     digest question and the build. Recording the digest that was ASKED would
     mark as delivered a catalogue the portal never received — and if the
     catalogue were then edited back, the portal's copy would never be fixed. */
  test('the digest recorded is the one of the bytes sent, not the one first asked for', async () => {
    const sb = db({ flag: '1', digests: { 1: 'd-asked' }, snapshotDigests: { 1: 'd-built' } });
    currentSb = sb;
    const { fetchImpl } = portal(200);

    const r = await pushVenturePortalCatalogue(env, { force: false }, fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'sent', digest: 'd-built' });
    expect(state(sb, 1)?.delivered_digest).toBe('d-built');
  });

  test('a forced send skips the question and sends an unchanged catalogue anyway', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, ...delivered('d-new') }] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogue(env, { force: true }, fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'sent', digest: 'd-new' });
    expect(rpcNames(sb)).toEqual(['vp_catalogue_snapshot']);
    expect(calls).toHaveLength(1);
  });
});

describe('what the portal`s answer means', () => {
  test('the order feed`s taxonomy, and a 413 parks like a 422', () => {
    for (const s of [200, 201, 299]) expect(classifyVpCatalogueResponse(s).outcome).toBe('sent');
    for (const s of [401, 503]) expect(classifyVpCatalogueResponse(s).outcome).toBe('retry');
    for (const s of [400, 413, 422]) expect(classifyVpCatalogueResponse(s).outcome).toBe('failed');
    for (const s of [500, 502, 504, 0]) expect(classifyVpCatalogueResponse(s).outcome).toBe('retry');
    expect(classifyVpCatalogueResponse(401).note).toMatch(/secret/i);
  });

  /* `delivered` must only ever describe what the portal HOLDS. A 4xx or a 503
     on the first post proves nothing was written; anything else does not. */
  test('the record of what the portal holds is replaced, kept or cleared', () => {
    expect(vpCatalogueVerdict([200], 1)).toMatchObject({ outcome: 'sent', delivered: 'replace' });
    expect(vpCatalogueVerdict([200, 200, 200], 3)).toMatchObject({ outcome: 'sent', delivered: 'replace' });
    for (const s of [401, 503]) expect(vpCatalogueVerdict([s], 1)).toMatchObject({ outcome: 'retry', delivered: 'keep' });
    for (const s of [400, 422, 413]) expect(vpCatalogueVerdict([s], 1)).toMatchObject({ outcome: 'failed', delivered: 'keep' });
    /* It may have committed before the answer was lost. */
    for (const s of [500, 502, 504, 0]) expect(vpCatalogueVerdict([s], 1)).toMatchObject({ outcome: 'retry', delivered: 'clear' });
    /* An earlier post of this run WAS applied. */
    expect(vpCatalogueVerdict([200, 422], 2)).toMatchObject({ outcome: 'failed', delivered: 'clear' });
    expect(vpCatalogueVerdict([200, 401], 3)).toMatchObject({ outcome: 'retry', delivered: 'clear' });
    expect(vpCatalogueVerdict([200, 401], 3).note).toMatch(/^post 2 of 3: /);
  });

  test('401: recorded, the old delivery still stands, and the next run tries again', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, delivered_digest: 'd-old', last_digest: 'd-old', last_outcome: 'sent' }] });
    currentSb = sb;

    const r = await pushVenturePortalCatalogue(env, { force: false }, portal(401).fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'retry', httpStatus: 401 });
    expect(state(sb, 1)).toMatchObject({ delivered_digest: 'd-old', last_digest: 'd-new', last_outcome: 'retry', last_http_status: 401 });
    expect(String(state(sb, 1)?.last_error)).toMatch(/secret/i);

    resetFeedFlagCache();
    const again = portal(200);
    await pushVenturePortalCatalogue(env, { force: false }, again.fetchImpl);
    expect(again.calls).toHaveLength(1);
    expect(state(sb, 1)).toMatchObject({ delivered_digest: 'd-new', last_outcome: 'sent' });
  });

  test('422: parked with the portal`s own words, not re-sent until the catalogue changes', async () => {
    const sb = db({ flag: '1' });
    currentSb = sb;

    const r = await pushVenturePortalCatalogue(env, { force: false }, portal(422).fetchImpl);
    expect(r.companies[0]).toMatchObject({ action: 'failed', httpStatus: 422 });
    expect(state(sb, 1)).toMatchObject({ last_digest: 'd-new', last_outcome: 'failed', last_http_status: 422 });
    expect(String(state(sb, 1)?.last_error)).toMatch(/portal said 422/);

    /* Same digest: no post at all. */
    resetFeedFlagCache();
    const quiet = portal(200);
    const r2 = await pushVenturePortalCatalogue(env, { force: false }, quiet.fetchImpl);
    expect(r2.companies[0]).toMatchObject({ action: 'refused_unchanged' });
    expect(quiet.calls).toHaveLength(0);

    /* Somebody fixed the catalogue: a new digest goes. */
    resetFeedFlagCache();
    sb.rpcHandlers.vp_catalogue_digest = () => 'd-fixed';
    sb.rpcHandlers.vp_catalogue_snapshot = () => ({ digest: 'd-fixed', body: catalogue(1) });
    const fixed = portal(200);
    const r3 = await pushVenturePortalCatalogue(env, { force: false }, fixed.fetchImpl);
    expect(r3.companies[0]).toMatchObject({ action: 'sent', digest: 'd-fixed' });
    expect(fixed.calls).toHaveLength(1);
  });

  /* A 5xx or a timeout can arrive AFTER the portal committed. If the record
     kept saying "d-old delivered", and the catalogue were then edited back to
     d-old, the push would skip it forever while the portal held the other one. */
  test('500: retried, and the delivery record is no longer trusted', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, delivered_digest: 'd-old', last_digest: 'd-old', last_outcome: 'sent' }] });
    currentSb = sb;

    await pushVenturePortalCatalogue(env, { force: false }, portal(500).fetchImpl);
    expect(state(sb, 1)).toMatchObject({ delivered_digest: null, last_outcome: 'retry', last_http_status: 500 });

    /* The catalogue is edited back to what was delivered before: it still goes. */
    resetFeedFlagCache();
    sb.rpcHandlers.vp_catalogue_digest = () => 'd-old';
    sb.rpcHandlers.vp_catalogue_snapshot = () => ({ digest: 'd-old', body: catalogue(1) });
    const again = portal(200);
    await pushVenturePortalCatalogue(env, { force: false }, again.fetchImpl);
    expect(again.calls).toHaveLength(1);
    expect(state(sb, 1)).toMatchObject({ delivered_digest: 'd-old', last_outcome: 'sent' });
  });

  test('a transport failure is an outcome, not a crash', async () => {
    const sb = db({ flag: '1' });
    currentSb = sb;

    const r = await pushVenturePortalCatalogue(env, { force: false }, portal(new Error('connection reset')).fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'retry', httpStatus: 0 });
    expect(String(state(sb, 1)?.last_error)).toMatch(/connection reset/);
    expect(state(sb, 1)?.delivered_digest).toBeNull();
  });

  test('a forced send retries a catalogue the portal refused', async () => {
    const sb = db({ flag: '1', state: [{ company_id: 1, delivered_digest: null, last_digest: 'd-new', last_outcome: 'failed' }] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogue(env, { force: true }, fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'sent' });
    expect(calls).toHaveLength(1);
    expect(state(sb, 1)).toMatchObject({ delivered_digest: 'd-new', last_outcome: 'sent', last_error: null });
  });
});

describe('the post itself', () => {
  test('to /products, with the order feed`s secret header, JSON, full: true and one snapshotAt', async () => {
    currentSb = db({ flag: '1' });
    const { fetchImpl, calls } = portal(200);

    await pushVenturePortalCatalogue(env, { force: false }, fetchImpl);

    expect(calls).toHaveLength(1);
    const [{ url, init, body }] = calls;
    expect(url).toBe(PRODUCTS_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-sync-secret']).toBe(SECRET_ROW.v);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body.companyId).toBe(1);
    expect(body.full).toBe(true);
    expect(Date.parse(String(body.snapshotAt))).not.toBeNaN();
    for (const s of VP_CATALOGUE_SECTIONS) expect(body[s]).toEqual(catalogue(1)[s]);
  });
});

describe('splitting a body that is too big for one post', () => {
  const AT = '2026-09-24T02:00:00.000Z';
  const sectionsOf = (parts: Array<{ body: string }>) => parts.map((p) => Object.keys(JSON.parse(p.body)));
  const utf8 = (s: string) => new TextEncoder().encode(s).length;

  test('a body under the budget is ONE post carrying every section', () => {
    const parts = planVpCatalogueParts(catalogue(1), AT, VP_CATALOGUE_MAX_POST_BYTES);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.sections).toEqual(['models', 'products', 'maintenance', 'specials', 'fabrics', 'combos']);
    const body = JSON.parse(parts[0]!.body) as Body;
    expect(body).toMatchObject({ companyId: 1, full: true, snapshotAt: AT });
    for (const s of VP_CATALOGUE_SECTIONS) expect(body[s]).toEqual(catalogue(1)[s]);
    expect(parts[0]!.bytes).toBe(utf8(parts[0]!.body));
  });

  /* THE RULE THAT MUST NOT BREAK. full:true retires every row of a carried
     section the post does not mention, so each section is whole in exactly
     one post, and each post is a complete delivery on its own. */
  test('over the budget: whole sections, each in exactly one post, every post full and within budget', () => {
    /* ~50 KB of products, ~49 KB of models, ~38 KB of fabrics: each fits the
       budget alone, no two big ones fit it together. */
    const big = catalogue(1, {
      products: Array.from({ length: 200 }, (_, i) => ({ id: `mfg-${i}`, code: `SKU-${i}`, name: 'x'.repeat(200) })),
      models: Array.from({ length: 200 }, (_, i) => ({ id: `m-${i}`, model_code: `M${i}`, name: 'y'.repeat(200) })),
      fabrics: Array.from({ length: 150 }, (_, i) => ({ id: `f-${i}`, fabric_code: `F${i}`, fabric_description: 'z'.repeat(200) })),
    });
    const budget = 70_000;
    const parts = planVpCatalogueParts(big, AT, budget);

    expect(parts.length).toBeGreaterThan(1);
    const seen = parts.flatMap((p) => p.sections);
    expect([...seen].sort()).toEqual([...VP_CATALOGUE_SECTIONS].sort());
    expect(new Set(seen).size).toBe(seen.length);
    for (const part of parts) {
      const body = JSON.parse(part.body) as Body;
      expect(body).toMatchObject({ companyId: 1, full: true, snapshotAt: AT });
      for (const s of part.sections) expect(body[s]).toEqual(big[s]);
      expect(part.bytes).toBe(utf8(part.body));
      expect(part.bytes).toBeLessThanOrEqual(budget);
    }
    /* Models go before products: the portal adopts a model from its SKUs only
       once the model row exists. */
    expect(seen.indexOf('models')).toBeLessThan(seen.indexOf('products'));
  });

  test('a section bigger than the budget goes alone and whole, never cut', () => {
    const huge = catalogue(1, {
      products: Array.from({ length: 50 }, (_, i) => ({ id: `mfg-${i}`, name: 'x'.repeat(1_000) })),
    });
    const parts = planVpCatalogueParts(huge, AT, 20_000);

    const withProducts = parts.filter((p) => p.sections.includes('products'));
    expect(withProducts).toHaveLength(1);
    expect(withProducts[0]!.sections).toEqual(['products']);
    expect(withProducts[0]!.bytes).toBeGreaterThan(20_000);
    expect((JSON.parse(withProducts[0]!.body) as Body).products).toEqual(huge.products);
    expect(sectionsOf(parts).flat().filter((k) => k === 'products')).toHaveLength(1);
  });

  test('the budget counts BYTES, not characters', () => {
    const wide = catalogue(1, { products: [{ id: 'mfg-1', name: '床架'.repeat(1_000) }] });
    const [part] = planVpCatalogueParts(wide, AT, VP_CATALOGUE_MAX_POST_BYTES);
    expect(part!.bytes).toBe(utf8(part!.body));
    expect(part!.bytes).toBeGreaterThan(part!.body.length);
  });

  test('a section the body does not carry is not invented', () => {
    /* A company with no effective maintenance row: the SQL leaves the key out. */
    const rest = catalogue(1);
    delete rest.maintenance;
    const [part] = planVpCatalogueParts(rest, AT, VP_CATALOGUE_MAX_POST_BYTES);
    expect(part!.sections).not.toContain('maintenance');
    expect(JSON.parse(part!.body)).not.toHaveProperty('maintenance');
  });

  test('a catalogue over 3 MB leaves in several posts, and a refused one stops the rest', async () => {
    /* ~3.2 MB of products: alone over the budget, so the run is three posts —
       [models], [products], [maintenance, specials, fabrics, combos]. */
    const big = catalogue(1, { products: [{ id: 'mfg-1', name: 'x'.repeat(3_200_000) }] });
    const sb = db({ flag: '1', state: [{ company_id: 1, delivered_digest: 'd-old', last_digest: 'd-old', last_outcome: 'sent' }], bodies: { 1: big } });
    currentSb = sb;
    const ok = portal(200, 200, 200);

    const r = await pushVenturePortalCatalogue(env, { force: false }, ok.fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'sent', parts: 3 });
    expect(ok.calls.map((c) => Object.keys(c.body).filter((k) => (VP_CATALOGUE_SECTIONS as readonly string[]).includes(k))))
      .toEqual([['models'], ['products'], ['maintenance', 'specials', 'fabrics', 'combos']]);
    expect(new Set(ok.calls.map((c) => c.body.snapshotAt)).size).toBe(1);
    expect(state(sb, 1)).toMatchObject({ delivered_digest: 'd-new', last_parts: 3 });
    expect(state(sb, 1)?.portal_result).toHaveLength(3);

    /* Next change: the second post is refused. The first WAS applied, so the
       portal now holds a mix — the record must stop claiming d-new. */
    resetFeedFlagCache();
    sb.rpcHandlers.vp_catalogue_digest = () => 'd-newer';
    sb.rpcHandlers.vp_catalogue_snapshot = () => ({ digest: 'd-newer', body: big });
    const refused = portal(200, 422, 200);
    const r2 = await pushVenturePortalCatalogue(env, { force: false }, refused.fetchImpl);

    expect(refused.calls).toHaveLength(2);
    expect(r2.companies[0]).toMatchObject({ action: 'failed', httpStatus: 422 });
    expect(r2.companies[0]!.note).toMatch(/^post 2 of 3: /);
    expect(state(sb, 1)).toMatchObject({ delivered_digest: null, last_digest: 'd-newer', last_outcome: 'failed' });
  });
});

describe('the gates are the order feed`s', () => {
  test('the switch off sends nothing and asks the database nothing', async () => {
    const sb = db({ flag: 'off' });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    expect((await pushVenturePortalCatalogue(env, { force: true }, fetchImpl)).skipped).toBe('feed_off');
    expect(sb.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('no url or no secret: not configured, nothing sent', async () => {
    for (const config of [[], [URL_ROW], [SECRET_ROW]]) {
      resetFeedFlagCache();
      const sb = db({ flag: '1', config });
      currentSb = sb;
      const { fetchImpl, calls } = portal(200);
      expect((await pushVenturePortalCatalogue(env, { force: true }, fetchImpl)).skipped).toBe('not_configured');
      expect(calls).toHaveLength(0);
    }
  });

  test('a vp.url that is not .../sales-orders stops the push and says so', async () => {
    const sb = db({ flag: '1', config: [{ k: 'vp.url', v: 'https://venture-portal-chi.vercel.app/hook' }, SECRET_ROW] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await pushVenturePortalCatalogue(env, { force: true }, fetchImpl);

    expect(r.skipped).toBe('catalogue_url_unknown');
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/\[vp-catalogue\].*sales-orders/));
    expect(sb.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    err.mockRestore();
  });

  test('only the companies in scope: another company`s catalogue is never even built', async () => {
    const sb = db({ flag: '1' });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogue(env, { force: false }, fetchImpl);

    expect(r.companies.map((c) => c.companyId)).toEqual([1]);
    expect(sb.rpcCalls.every((c) => Number(c.args.p_company_id) === 1)).toBe(true);
    expect(calls.map((c) => c.body.companyId)).toEqual([1]);
  });

  test('`all` means every company in the companies master', async () => {
    const sb = db({ flag: 'all', companies: [{ id: 2 }, { id: 1 }] });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogue(env, { force: false }, fetchImpl);

    expect(r.companies.map((c) => c.companyId)).toEqual([1, 2]);
    expect(sb.schemaCalls).toContain('public');
    expect(calls.map((c) => c.body.companyId)).toEqual([1, 2]);
    expect(state(sb, 2)).toMatchObject({ delivered_digest: 'd-two', last_outcome: 'sent' });
  });

  /* Not knowing what was delivered is not a reason to send. */
  test('an unreadable delivery record sends nothing', async () => {
    const sb = db({ flag: '1', missing: { venture_portal_catalogue_state: ['last_outcome'] } });
    currentSb = sb;
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogue(env, { force: false }, fetchImpl);

    expect(r.skipped).toBe('state_read_failed');
    expect(sb.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('SQL that does not answer is reported per company and sends nothing', async () => {
    const sb = db({ flag: 'all' });
    currentSb = sb;
    sb.rpcHandlers.vp_catalogue_digest = (args) => {
      if (Number(args.p_company_id) === 1) throw new Error('canceling statement due to statement timeout');
      return 'd-two';
    };
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogue(env, { force: false }, fetchImpl);

    expect(r.companies[0]).toMatchObject({ companyId: 1, action: 'build_failed' });
    expect(r.companies[0]!.note).toMatch(/statement timeout/);
    /* One company's failure is not the other's. */
    expect(r.companies[1]).toMatchObject({ companyId: 2, action: 'sent' });
    expect(calls.map((c) => c.body.companyId)).toEqual([2]);
    expect(state(sb, 1)).toBeUndefined();
  });

  test('a snapshot that is not a catalogue is never posted', async () => {
    const sb = db({ flag: '1' });
    currentSb = sb;
    sb.rpcHandlers.vp_catalogue_snapshot = () => ({ digest: 'd-new', body: null });
    const { fetchImpl, calls } = portal(200);

    const r = await pushVenturePortalCatalogue(env, { force: false }, fetchImpl);

    expect(r.companies[0]).toMatchObject({ action: 'build_failed' });
    expect(calls).toHaveLength(0);
  });
});
