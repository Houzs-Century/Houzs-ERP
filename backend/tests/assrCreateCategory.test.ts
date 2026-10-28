import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';

/* Owner ruling (2026-07): Issue Category is REQUIRED and must be enforced on
   the SERVER, not only by the FE button gate — the create route previously
   accepted a null/blank category (createAssrCase types it `issue_category?`
   and writes `?? null`). These tests drive the REAL assr router's POST "/"
   through a bare Hono parent that injects an authorised `user` (so the
   requireServiceCaseAccess gate passes) — the category guard returns its 400
   before any DB / AutoCount work, so no seeding is needed. */

// A caller that clears the service-cases create gate.
const CREATOR = { id: 1, permissions_set: new Set(['service_cases.create']) } as any;

function mount(user: unknown) {
  const parent = new Hono();
  parent.use('*', async (c, next) => {
    (c as any).set('user', user);
    await next();
  });
  parent.route('/', assrApp);
  return parent;
}

async function postCreate(body: Record<string, unknown>) {
  const app = mount(CREATOR);
  return app.request(
    '/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

const baseBody = {
  doc_no: 'SO-CAT-1',
  items: [{ item_code: 'ITM-1' }],
  complaint_issue: 'Broken slat',
};

describe('POST /api/assr — issue_category is required server-side', () => {
  test('rejects a create with NO issue_category (400)', async () => {
    const res = await postCreate(baseBody);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('issue_category');
  });

  test('rejects a null issue_category (400)', async () => {
    const res = await postCreate({ ...baseBody, issue_category: null });
    expect(res.status).toBe(400);
  });

  test('rejects a whitespace-only issue_category (400)', async () => {
    const res = await postCreate({ ...baseBody, issue_category: '   ' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('issue_category');
  });

  // NOTE: we deliberately do NOT drive the happy path (a present category) here.
  // The guard returns its 400 BEFORE any DB work, so the three rejection cases
  // above fully pin the new behaviour without seeding. Sending a request that
  // CLEARS the guard would fall through into the real create path (SO getSingle
  // / creditor resolution), which is unseeded in the test env and crashes
  // miniflare's isolated storage — a harness failure unrelated to the guard.
  // That a non-blank category is accepted follows directly from the guard being
  // the sole added check (`!category || !category.trim()`).
});
