/* POST /hr/item-kpi/batch — a fabric series (13 rules) saved in one insert,
 * all or nothing (YH 2026-11-06). */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

vi.mock('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

const { hr } = await import('./hr');

function app(sb: ReturnType<typeof fakeSb>, perms: string[]) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('companyId', 2);
    c.set('supabase', sb as never);
    c.set('houzsUser' as never, { id: 9, name: 'HR', permissions_set: new Set(perms) } as never);
    await next();
  });
  a.route('/hr', hr);
  return a;
}

const post = (a: Hono<{ Bindings: Env; Variables: Variables }>, body: unknown) =>
  a.request('/hr/item-kpi/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

const series = Array.from({ length: 13 }, (_, i) => {
  const ref = `KN${String(i + 1).padStart(2, '0')}`;
  return { flagType: 'fabric', ref, label: ref, bonusSen: 12500 };
});

describe('POST /hr/item-kpi/batch', () => {
  it('saves every rule of a series in one call, in the company', async () => {
    const sb = fakeSb({ hr_item_kpi: [] });
    const res = await post(app(sb, ['scm.hr.manage']), { items: series });
    expect(res.status).toBe(201);
    const { items } = (await res.json()) as { items: { ref: string; bonusSen: number; active: boolean }[] };
    expect(items.map((i) => i.ref)).toEqual(series.map((s) => s.ref));
    expect(items.every((i) => i.bonusSen === 12500 && i.active)).toBe(true);
    const rows = (await sb.from('hr_item_kpi').select('ref, company_id')).data as { ref: string; company_id: number }[];
    expect(rows).toHaveLength(13);
    expect(rows.every((r) => r.company_id === 2)).toBe(true);
  });

  it('writes nothing when one rule is invalid', async () => {
    const sb = fakeSb({ hr_item_kpi: [] });
    const bad = [...series.slice(0, 5), { flagType: 'fabric', ref: '', bonusSen: 12500 }, ...series.slice(6)];
    const res = await post(app(sb, ['scm.hr.manage']), { items: bad });
    expect(res.status).toBe(400);
    expect((await sb.from('hr_item_kpi').select('ref')).data).toHaveLength(0);
  });

  it('refuses an empty list and a caller without scm.hr.manage', async () => {
    const sb = fakeSb({ hr_item_kpi: [] });
    expect((await post(app(sb, ['scm.hr.manage']), { items: [] })).status).toBe(400);
    expect((await post(app(sb, ['scm.hr.read']), { items: series })).status).toBe(403);
  });
});
