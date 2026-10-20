/* SO Maintenance › Fair rules (owner 2026-10-19). "Venue differs" on a scanned
 * order — the slip's place is not where the order was placed — is a flag until
 * the owner or Finance turns this switch on, then a refusal at Confirm
 * (fair-binding.ts::fairConfirmProblems reads the row).
 *
 * The switch is not seeded, so its first write creates the row; only the owner
 * or Finance may flip it, and every flip is written to the audit ledger with the
 * REAL person (houzsUser), not the SCM bridge identity.
 *
 * Route-level over the in-memory PostgREST fake, supabaseAuth stubbed — the
 * same harness as mrp-lead-times.test.ts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { SupabaseClient, User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

vi.mock('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));
const audits = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../services/audit', () => ({ writeAudit: async (_env: unknown, e: Record<string, unknown>) => { audits.push(e); } }));

const { soSettings } = await import('./so-settings');

const CO = 1;
const KEY = 'fair_venue_differs_blocks';
const CALLER = { id: 'bridge-uuid', email: 'bridge@houzs.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' } as unknown as User;

type Who = { id: number; perms: string[] };
const FINANCE: Who = { id: 23, perms: ['scm.access', 'scm.finance.accounting'] };
const CONFIG_WRITER: Who = { id: 31, perms: ['scm.access', 'scm.config.write'] };
const OWNER: Who = { id: 1, perms: ['*'] };

let tables: Record<string, Array<Record<string, unknown>>>;
let sb: ReturnType<typeof fakeSb>;

function app(who: Who) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', CO);
    c.set('supabase', sb as unknown as SupabaseClient);
    c.set('houzsUser', { id: who.id, name: 'Tester', email: `u${who.id}@houzs.test`, permissions_set: new Set(who.perms), permissions: who.perms });
    await next();
  });
  a.route('/so-settings', soSettings);
  return a;
}

const flip = (who: Who, enabled: boolean, key = KEY) =>
  app(who).request(`/so-settings/${key}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  }, {} as Env);

beforeEach(() => {
  audits.length = 0;
  tables = { so_settings: [{ company_id: CO, key: 'pos_product_remark', enabled: true, label: 'Product page remark & extra charge (POS)' }] };
  sb = fakeSb(tables);
});

describe('PATCH /so-settings/fair_venue_differs_blocks — owner or Finance only, logged', () => {
  it('Finance turns it on: the row is created for this company, and the change is logged', async () => {
    const res = await flip(FINANCE, true);
    expect(res.status).toBe(200);
    expect(tables.so_settings.find((r) => r.key === KEY)).toMatchObject({ company_id: CO, enabled: true });
    expect(audits).toEqual([expect.objectContaining({
      action: 'so_settings.update', entityId: KEY, actorId: 23, meta: { companyId: CO, before: false, after: true },
    })]);
  });

  it('turning it off again updates the same row', async () => {
    await flip(OWNER, true);
    const res = await flip(OWNER, false);
    expect(res.status).toBe(200);
    expect(tables.so_settings.filter((r) => r.key === KEY)).toEqual([expect.objectContaining({ enabled: false })]);
    expect(audits.at(-1)).toMatchObject({ meta: { before: true, after: false } });
  });

  it('a config writer who is not Finance may not flip it', async () => {
    const res = await flip(CONFIG_WRITER, true);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'missing_finance_accounting' });
    expect(tables.so_settings.some((r) => r.key === KEY)).toBe(false);
    expect(audits).toEqual([]);
  });

  it('the other toggles keep their config-write rule and are not created on write', async () => {
    expect((await flip(FINANCE, false, 'pos_product_remark')).status).toBe(403);
    expect((await flip(CONFIG_WRITER, false, 'pos_product_remark')).status).toBe(200);
    expect((await flip(CONFIG_WRITER, true, 'no_such_switch')).status).toBe(404);
  });
});
