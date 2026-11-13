import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';

/* HC-0228: a PO/SO-filled creditor_code is an ERP supplier code, while a hand
   or older auto pick is an AutoCount creditor code, and the two lists can hold
   different companies under one code (400-H004: ERP Hookka Industries,
   AutoCount Hao Hua Furniture). The supplier reports must not merge them into
   one row. The ERP name itself is swapped in by applyErpSupplierNames (no scm
   here, so names stay as the creditors mirror has them). */

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

type Group = { creditor_code: string; creditor_source: string | null; creditor_name: string | null; total: number; email: string | null };

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
  test('by-creditor keeps PO/SO-filled cases apart from the AutoCount pick, and searches after naming', async () => {
    const { rows } = await get<{ rows: Group[] }>('/by-creditor');
    const h004 = rows.filter((r) => r.creditor_code === '400-H004');
    expect(h004.map((r) => [r.creditor_source, r.total])).toEqual([['po', 2], [null, 1]]);
    expect(h004[1]).toMatchObject({ creditor_name: 'HAO HUA FURNITURE', email: 'hh@example.test' });
    expect((await get<{ rows: Group[] }>('/by-creditor?search=hao')).rows).toHaveLength(2);
    expect((await get<{ rows: Group[] }>('/by-creditor?search=400-h004')).rows).toHaveLength(2);
    expect((await get<{ rows: Group[] }>('/by-creditor?search=nothing')).rows).toHaveLength(0);
  });

  test('metrics creditor performance splits the same way and still names the row', async () => {
    const m = await get<{ creditor_performance: Array<{ creditor_code: string; creditor_source: string | null; name: string | null; total_cases: number }> }>('/metrics?since_days=30');
    const h004 = m.creditor_performance.filter((r) => r.creditor_code === '400-H004');
    expect(h004.map((r) => [r.creditor_source, r.total_cases, r.name])).toEqual([['po', 2, 'HAO HUA FURNITURE'], [null, 1, 'HAO HUA FURNITURE']]);
  });
});
