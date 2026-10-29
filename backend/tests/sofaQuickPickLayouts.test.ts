import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { MiddlewareHandler } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: (async (_c, next) => next()) satisfies MiddlewareHandler,
}));

import { sofaQuickPicks } from '../src/scm/routes/sofa-quick-picks';
import { personalQuickPicks } from '../src/scm/routes/personal-quick-picks';

type Row = Record<string, unknown>;
function setup() {
  const records: Record<string, Row[]> = { sofa_quick_picks: [], personal_quick_picks: [] };
  const selected: string[] = [];
  const sb = {
    from: (table: string) => {
      const predicates: Array<(row: Row) => boolean> = [];
      let inserted: Row | null = null;
      const result = () => ({ data: inserted ?? records[table]!.filter((row) => predicates.every((p) => p(row))), error: null });
      const query = {
        select: (columns: string) => { selected.push(columns); return query; },
        insert: (row: Row) => { inserted = { id: 'pick', created_at: '2026-10-30', deleted_at: null, ...row }; records[table]!.push(inserted); return query; },
        eq: (column: string, value: unknown) => { predicates.push((row) => row[column] === value); return query; },
        is: (column: string, value: unknown) => { predicates.push((row) => (row[column] ?? null) === value); return query; },
        order: () => query,
        single: async () => result(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return query;
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, 2 as never);
    c.set('allowedCompanyIds' as never, [2] as never);
    c.set('user' as never, { id: 'system' } as never);
    c.set('houzsUser' as never, { id: 42, permissions: ['scm.config.write'] } as never);
    await next();
  });
  app.route('/global', sofaQuickPicks as never);
  app.route('/personal', personalQuickPicks as never);
  return { app, records, selected };
}
const layout = {
  depth: '24', cells: [{ id: 'seat', moduleId: '2NA', x: 40, y: 55, rot: 90 }],
  accessories: [{ id: 'cushion', modelId: 'BC06', cellId: 'seat', slot: 0 }],
};

describe('Quick Pick layout API round trip', () => {
  it.each(['global', 'personal'])('%s saves and reads attached accessories and source depth', async (path) => {
    const { app, records, selected } = setup();
    const response = await app.request(`/${path}`, {
      method: 'POST', body: JSON.stringify({ baseModel: '8210', modules: [['2NA']], depth: '24', layout }),
    });
    expect(response.status).toBe(201);
    expect((await response.json() as Row).layout).toEqual(layout);
    const table = path === 'global' ? 'sofa_quick_picks' : 'personal_quick_picks';
    expect(records[table]![0]!).toMatchObject({ company_id: 2, layout });
    if (path === 'personal') expect(records[table]![0]!.owner_user_id).toBe(42);
    const legacy = await app.request(`/${path}?baseModel=8210`);
    expect((await legacy.json() as { picks: Row[] }).picks).toEqual([]);
    const loaded = await app.request(`/${path}?baseModel=8210&includeAccessories=1`);
    expect((await loaded.json() as { picks: Row[] }).picks[0]!.layout).toEqual(layout);
    expect(selected.every((columns) => columns.split(', ').includes('layout'))).toBe(true);
  });

  it.each(['global', 'personal'])('%s keeps legacy and module-only layouts visible to older clients', async (path) => {
    const { app } = setup();
    for (const savedLayout of [undefined, { ...layout, accessories: [] }]) {
      const response = await app.request(`/${path}`, {
        method: 'POST', body: JSON.stringify({ baseModel: '8210', modules: [['2NA']], depth: '24', layout: savedLayout }),
      });
      expect(response.status).toBe(201);
    }
    const loaded = await app.request(`/${path}?baseModel=8210`);
    expect((await loaded.json() as { picks: Row[] }).picks.map((r) => r.layout)).toEqual([null, { ...layout, accessories: [] }]);
  });

  it.each(['global', 'personal'])('%s refuses an orphaned saved accessory before insert', async (path) => {
    const { app, records } = setup();
    const response = await app.request(`/${path}`, {
      method: 'POST', body: JSON.stringify({ baseModel: '8210', modules: [['2NA']], depth: '24',
        layout: { ...layout, accessories: [{ ...layout.accessories[0], cellId: 'missing' }] } }),
    });
    expect(response.status).toBe(400);
    expect(Object.values(records).flat()).toEqual([]);
  });
});
