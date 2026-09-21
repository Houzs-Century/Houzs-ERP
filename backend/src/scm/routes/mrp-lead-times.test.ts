/* The PUT that rewrites per-category / per-warehouse MRP lead times is SCM
 * master-data, so it must be config-write gated on the wire — not only in the
 * FE "Lead Times" button (PR #4179).
 *
 * Symptom: any SCM user (e.g. a Sales Executive with scm.access) could PUT
 * /api/scm/mrp-lead-times and change the ordering lead times by direct call.
 * Cause: the route applied supabaseAuth only; its /mrp-lead-times/* area guard
 * (scm.procurement.mrp) FALLS THROUGH for a non-L2-configured caller, so the
 * coarse requireScmAccess umbrella was the only thing in front of the write.
 * Fix: gate PUT on canWriteScmConfig (flat scm.config.write OR the position
 * policy canWriteConfig flag) — the same predicate the FE reads as
 * scm_config_writer and the sibling config writes use. GET stays open.
 *
 * Route-level, over the in-memory PostgREST fake, with supabaseAuth stubbed to a
 * passthrough so this suite owns `supabase` / `houzsUser` (same shape as
 * document-cancel-routes.test.ts). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { SupabaseClient, User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

// supabaseAuth in production only attaches the scm service-role client; stub it so
// the test's own middleware sets the context the handler and canWriteScmConfig read.
vi.mock('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

const { mrpLeadTimes } = await import('./mrp-lead-times');

const CO = 1;
const CALLER = { id: 'staff-uuid', email: 'x@houzs.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' } as unknown as User;

type Who = { perms: string[] };
// An SCM user who can reach the module but is NOT a config writer.
const SALES: Who = { perms: ['scm.access', 'scm.so.view_all'] };
// Flat-key config writer (Owner grants scm.config.write to a role).
const CONFIG_WRITER: Who = { perms: ['scm.access', 'scm.config.write'] };
// Owner / IT Admin — the `*` wildcard.
const OWNER: Who = { perms: ['*'] };

let sb: ReturnType<typeof fakeSb>;
let tables: Record<string, Array<Record<string, unknown>>>;

function app(who: Who) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', CO);
    c.set('supabase', sb as unknown as SupabaseClient);
    c.set('houzsUser', { id: 1, name: 'Tester', permissions_set: new Set(who.perms), permissions: who.perms });
    await next();
  });
  a.route('/mrp-lead-times', mrpLeadTimes);
  return a;
}

const ENV = {} as Env;
const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (who: Who, body: unknown) => app(who).request('/mrp-lead-times', { method: 'PUT', ...json(body) }, ENV);
const get = (who: Who) => app(who).request('/mrp-lead-times', undefined, ENV);

const VALID = { warehouseId: null, category: 'sofa', leadDays: 7 };

beforeEach(() => {
  tables = { mrp_category_lead_times: [] };
  sb = fakeSb(tables);
});

describe('PUT /mrp-lead-times — config-write gated', () => {
  it('refuses a non-config-write SCM caller and writes nothing', async () => {
    const res = await put(SALES, VALID);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body).toMatchObject({ error: 'forbidden', reason: 'missing_scm_config_write' });
    // SCM humanApiError convention: refusal strings stay short (<200 chars).
    expect(body.reason.length).toBeLessThan(200);
    expect(tables.mrp_category_lead_times).toHaveLength(0);
  });

  it('accepts a flat scm.config.write caller and upserts the row', async () => {
    const res = await put(CONFIG_WRITER, VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, warehouseId: null, category: 'sofa', leadDays: 7 });
    expect(tables.mrp_category_lead_times).toHaveLength(1);
    expect(tables.mrp_category_lead_times[0]).toMatchObject({
      company_id: CO, warehouse_id: null, category: 'sofa', lead_days: 7,
    });
  });

  it('accepts an Owner / IT wildcard caller', async () => {
    const res = await put(OWNER, VALID);
    expect(res.status).toBe(200);
    expect(tables.mrp_category_lead_times).toHaveLength(1);
  });
});

describe('GET /mrp-lead-times — stays open (the MRP order-by-date read)', () => {
  it('serves a non-config-write caller', async () => {
    tables.mrp_category_lead_times.push({ company_id: CO, warehouse_id: null, category: 'sofa', lead_days: 3 });
    const res = await get(SALES);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leadTimes: Record<string, Record<string, number>> };
    expect(body.leadTimes['null'].sofa).toBe(3);
  });
});
