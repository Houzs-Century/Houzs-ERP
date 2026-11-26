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
import { SEEDED_ITEM_GROUPS } from '../lib/fake-item-groups';
import type { Env, Variables } from '../env';

vi.mock('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

const { mrpLeadTimes } = await import('./mrp-lead-times');

const CO = 1;
const CALLER = { id: 'staff-uuid', email: 'x@houzs.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' } as unknown as User;

type Who = { perms: string[] };
const SALES: Who = { perms: ['scm.access', 'scm.so.view_all'] };
const CONFIG_WRITER: Who = { perms: ['scm.access', 'scm.config.write'] };
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
const put = (who: Who, body: unknown, env: Env = ENV) => app(who).request('/mrp-lead-times', { method: 'PUT', ...json(body) }, env);
const get = (who: Who) => app(who).request('/mrp-lead-times', undefined, ENV);

const VALID = { warehouseId: null, category: 'sofa', leadDays: 7 };

beforeEach(() => {
  tables = { mrp_category_lead_times: [], acc_item_groups: SEEDED_ITEM_GROUPS() };
  sb = fakeSb(tables);
});

describe('PUT /mrp-lead-times — config-write gated', () => {
  it('refuses a non-config-write SCM caller and writes nothing', async () => {
    const res = await put(SALES, VALID);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body).toMatchObject({ error: 'forbidden', reason: 'missing_scm_config_write' });
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

  it('lists every product category, a newly registered one included', async () => {
    tables.acc_item_groups = [...SEEDED_ITEM_GROUPS().filter((r) => r.code !== 'CARPET'), { code: 'OUTDOOR', name: 'Outdoor', is_active: true }, { code: 'CARPET', name: 'Rugs', is_active: true }];
    const body = (await (await get(SALES)).json()) as { categories: Array<{ key: string; label: string }> };
    const keys = body.categories.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['sofa', 'dining', 'fabric_accessory', 'carpet', 'outdoor']));
    expect(keys).not.toContain('service');
    expect(keys.at(-1)).toBe('others');
    expect(body.categories.find((c) => c.key === 'carpet')?.label).toBe('Rugs');
  });
});

describe('PUT /mrp-lead-times — only a listed category is stored', () => {
  it('stores a newly registered category', async () => {
    tables.acc_item_groups.push({ code: 'OUTDOOR', name: 'Outdoor', is_active: true });
    expect((await put(CONFIG_WRITER, { ...VALID, category: 'outdoor' })).status).toBe(200);
    expect(tables.mrp_category_lead_times).toHaveLength(1);
  });

  it('refuses a category nobody sells, so a typo cannot park a number', async () => {
    const res = await put(CONFIG_WRITER, { ...VALID, category: 'sofaa' });
    expect(res.status).toBe(400);
    expect(tables.mrp_category_lead_times).toHaveLength(0);
  });
});

/* HC-0145: Procurement Overview is cached in KV (swr:procov) with the lead-time
   settings inside it; a successful write must drop this company's copies. */
describe('PUT /mrp-lead-times — busts the Procurement Overview cache', () => {
  it("deletes this company's swr:procov keys only", async () => {
    const store = new Map<string, string>([
      ['swr:procov:v1:1:2026-10-29:a', '1'], ['swr:procov:v1:1:2026-10-29:b:refreshing', '1'],
      ['swr:procov:v1:10:2026-10-29:a', '1'], ['swr:procov:v1:2:2026-10-29:a', '1'],
    ]);
    const kv = {
      list: async ({ prefix }: { prefix: string }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
      delete: async (k: string) => { store.delete(k); },
    };
    const res = await put(CONFIG_WRITER, VALID, { SESSION_CACHE: kv } as unknown as Env);
    expect(res.status).toBe(200);
    expect([...store.keys()].sort()).toEqual(['swr:procov:v1:10:2026-10-29:a', 'swr:procov:v1:2:2026-10-29:a']);
  });

  it('leaves the cache alone when the write is refused', async () => {
    const store = new Map([['swr:procov:v1:1:x', '1']]);
    const kv = { list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }), delete: async (k: string) => { store.delete(k); } };
    expect((await put(SALES, VALID, { SESSION_CACHE: kv } as unknown as Env)).status).toBe(403);
    expect(store.size).toBe(1);
  });
});
