import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';

/* Quality Overview, "What the cases are about": clicking a slice of the Issue
   Categories or Resolution Method donut lists that slice's cases under it
   (owner 2026-10-20). The drill must count what the donut counts: categories
   merged case-insensitively, a blank resolution as "unset". */

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

async function createCase(docNo: string, category: string) {
  const res = await mount().request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc_no: docNo, items: [{ item_code: 'ITM-1' }], complaint_issue: 'Sagging', issue_category: category, priority: 'normal' }),
  }, env);
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

const drill = async (q: string) => {
  const res = await mount().request(`/metrics/drill?${q}&since_days=30&limit=500`, {}, env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { cases: Array<{ id: number }> }).cases.map((c) => c.id);
};

describe('the cases behind a "What the cases are about" slice', () => {
  test('a category matches whatever its case, a blank resolution is "unset"', async () => {
    const a = await createCase('SO-WHY-1', 'Product Defect');
    const b = await createCase('SO-WHY-2', 'product defect');
    const other = await createCase('SO-WHY-3', 'Warranty Service Request');
    const byCat = await drill('metric=category_cases&category=Product%20Defect');
    expect(byCat).toEqual(expect.arrayContaining([a, b]));
    expect(byCat).not.toContain(other);
    const unset = await drill('metric=resolution_cases&method=unset');
    expect(unset).toEqual(expect.arrayContaining([a, b, other]));
  });

  test('no category or method chosen is refused', async () => {
    expect((await mount().request('/metrics/drill?metric=category_cases', {}, env)).status).toBe(400);
    expect((await mount().request('/metrics/drill?metric=resolution_cases', {}, env)).status).toBe(400);
  });
});
