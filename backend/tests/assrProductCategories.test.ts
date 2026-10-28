import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';
import { patchAssrCase } from '../src/services/assr';

/* Product Category is multi-select (2026-08): a complaint can be mattress AND
   bedframe. Two things must stay true, and they are easy to break because they
   live in different places:
     1. assr_case_categories gets one row per category — that is what counting
        "how many bedframe cases" reads, and a comma-joined string cannot count
        a Bedframe+Mattress case once on each side.
     2. assr_cases.service_category stays a DISPLAY string in lookup order,
        because ~50 read-only sites (list, CSV, print, portals, mobile) render
        it directly.
   Both are written by setCaseCategories/resolveCategories in services/assr.ts
   and nowhere else, so these tests are the guard against them drifting apart. */

const CREATOR = {
  id: 1,
  permissions_set: new Set(['service_cases.create', 'service_cases.write']),
} as any;

function mount() {
  const parent = new Hono();
  parent.use('*', async (c, next) => {
    (c as any).set('user', CREATOR);
    await next();
  });
  parent.route('/', assrApp);
  return parent;
}

async function createCase(serviceCategory: unknown, docNo: string) {
  const res = await mount().request(
    '/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc_no: docNo,
        items: [{ item_code: 'ITM-1' }],
        complaint_issue: 'Sagging',
        issue_category: 'Product Defect',
        service_category: serviceCategory,
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: number };
  return json.id;
}

async function readBack(id: number) {
  const row = await env.DB.prepare(
    `SELECT service_category FROM assr_cases WHERE id = ?`,
  )
    .bind(id)
    .first<{ service_category: string | null }>();
  const rows = await env.DB.prepare(
    `SELECT slug FROM assr_case_categories WHERE case_id = ? ORDER BY slug`,
  )
    .bind(id)
    .all<{ slug: string }>();
  return {
    display: row?.service_category ?? null,
    slugs: (rows.results ?? []).map((r) => r.slug),
  };
}

describe('Product Category — multi-select', () => {
  test('an array of names writes one row per category and a joined display string', async () => {
    const id = await createCase(['Mattress', 'Bedframe'], 'SO-MC-1');
    const got = await readBack(id);
    // Lookup order, not the order the caller happened to send.
    expect(got.display).toBe('Bedframe, Mattress');
    expect(got.slugs).toEqual(['bed_frame', 'mattress']);
  });

  test('a comma string from an older client takes the same path', async () => {
    const id = await createCase('mattress, bedframe', 'SO-MC-2');
    const got = await readBack(id);
    expect(got.display).toBe('Bedframe, Mattress');
    expect(got.slugs).toEqual(['bed_frame', 'mattress']);
  });

  /* Straight at patchAssrCase rather than through PATCH /:id — the route's
     company guard reads assr_cases.company_id, which the D1 test mirror does
     not carry, so it 500s here for reasons that have nothing to do with
     categories. The service function is where the category logic lives. */
  test('patch replaces the set — a de-selected category disappears', async () => {
    const id = await createCase(['Bedframe', 'Mattress'], 'SO-MC-3');
    await patchAssrCase(env as any, id, { service_category: ['Sofa'] }, 1);
    const got = await readBack(id);
    expect(got.display).toBe('Sofa');
    expect(got.slugs).toEqual(['sofa']);
  });

  test('patch to an empty selection clears both the string and the rows', async () => {
    const id = await createCase(['Sofa'], 'SO-MC-5');
    await patchAssrCase(env as any, id, { service_category: [] }, 1);
    const got = await readBack(id);
    expect(got.display).toBeNull();
    expect(got.slugs).toEqual([]);
  });

  test('an unknown value survives in the display string but claims no category', async () => {
    const id = await createCase(['Bedframe', 'Hammock'], 'SO-MC-4');
    const got = await readBack(id);
    // Known names first (lookup order), unrecognised text kept verbatim so
    // reopening the case never silently drops what someone typed.
    expect(got.display).toBe('Bedframe, Hammock');
    expect(got.slugs).toEqual(['bed_frame']);
  });
});
