import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';

/* HC-0228: service cases name a supplier from the ERP list, whatever filled the
   code. The reports group one row per code, then applyErpSupplierNames swaps the
   name (no scm here, so names stay as the creditors mirror has them), and the
   by-creditor search runs after that naming so "hookka" finds 400-H004. */

const READER = {
  id: 1,
  permissions_set: new Set(['service_cases.create', 'service_cases.write', 'service_cases.manage', 'service_cases.read']),
} as any;

function mount() {
  const parent = new Hono();
  parent.use('*', async (c, next) => {
    (c as any).set('user', READER);
    await next();
  });
  parent.route('/', assrApp as any);
  return parent;
}

const get = async <T>(path: string): Promise<T> => {
  const res = await mount().request(path, {}, env);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

type Group = { creditor_code: string; creditor_name: string | null; total: number; email: string | null };

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM assr_cases`);
  await env.DB.exec(`DELETE FROM creditors`);
  await env.DB.prepare(`INSERT INTO creditors (creditor_code, company_name, email) VALUES ('400-H004', 'HAO HUA FURNITURE', 'hh@example.test')`).run();
  const seed = env.DB.prepare(`INSERT INTO assr_cases (assr_no, doc_no, creditor_code, creditor_source, created_by) VALUES (?, 'SO-1', '400-H004', ?, 1)`);
  await seed.bind('ASSR/T-1', 'po').run();
  await seed.bind('ASSR/T-2', 'so').run();
  await seed.bind('ASSR/T-3', 'manual').run();
});

describe('supplier reports on a code both lists use', () => {
  test('by-creditor gives one row per code, whatever filled it, and searches after naming', async () => {
    const { rows } = await get<{ rows: Group[] }>('/by-creditor');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ creditor_code: '400-H004', total: 3, creditor_name: 'HAO HUA FURNITURE', email: 'hh@example.test' });
    expect((await get<{ rows: Group[] }>('/by-creditor?search=hao')).rows).toHaveLength(1);
    expect((await get<{ rows: Group[] }>('/by-creditor?search=400-h004')).rows).toHaveLength(1);
    expect((await get<{ rows: Group[] }>('/by-creditor?search=nothing')).rows).toHaveLength(0);
  });

  test('metrics creditor performance gives one named row per code', async () => {
    const m = await get<{ creditor_performance: Array<{ creditor_code: string; name: string | null; total_cases: number }> }>('/metrics?since_days=30');
    expect(m.creditor_performance.map((r) => [r.creditor_code, r.total_cases, r.name])).toEqual([['400-H004', 3, 'HAO HUA FURNITURE']]);
  });
});
