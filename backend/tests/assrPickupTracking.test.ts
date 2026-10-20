import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';

/* HC-0129 (Farra, Operation Dept, 2026-10-20): the Pickup / Return step tracks
   the customer pickup itself — status, actual date, who collects it (PIC) and
   where the item is now. Status and location are closed lists and the actual
   date is a plain YYYY-MM-DD, refused at the API so a bad value never lands. */

const USER = {
  id: 1,
  permissions_set: new Set(['service_cases.create', 'service_cases.write', 'service_cases.manage']),
} as any;

function mount() {
  const parent = new Hono();
  parent.use('*', async (c, next) => {
    (c as any).set('user', USER);
    await next();
  });
  parent.route('/', assrApp);
  return parent;
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let seq = 0;
async function createCase() {
  const docNo = `SO-HC0129-${++seq}`;
  const res = await mount().request(
    '/',
    json('POST', { doc_no: docNo, items: [{ item_code: 'ITM-1' }], complaint_issue: 'Torn', issue_category: 'Product Defect' }),
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

const patch = (id: number, body: Record<string, unknown>) => mount().request(`/${id}`, json('PATCH', body), env);

describe('Pickup / Return tracking fields (HC-0129)', () => {
  test('saves status, actual date, PIC and item location', async () => {
    const id = await createCase();
    const res = await patch(id, {
      pickup_status: 'completed',
      actual_pickup_at: '2026-10-21',
      pickup_pic: 'Ali (lorry 2)',
      item_location: 'warehouse',
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT pickup_status, actual_pickup_at, pickup_pic, item_location FROM assr_cases WHERE id = ?`,
    )
      .bind(id)
      .first();
    expect(row).toEqual({
      pickup_status: 'completed',
      actual_pickup_at: '2026-10-21',
      pickup_pic: 'Ali (lorry 2)',
      item_location: 'warehouse',
    });
  });

  test('clearing a field with null is allowed', async () => {
    const id = await createCase();
    expect((await patch(id, { pickup_status: 'scheduled', item_location: 'customer' })).status).toBe(200);
    expect((await patch(id, { pickup_status: null, item_location: null, actual_pickup_at: null })).status).toBe(200);
    const row = await env.DB.prepare(`SELECT pickup_status, item_location FROM assr_cases WHERE id = ?`).bind(id).first();
    expect(row).toEqual({ pickup_status: null, item_location: null });
  });

  test.each([
    [{ pickup_status: 'done' }],
    [{ item_location: 'lorry' }],
    [{ actual_pickup_at: '21/10/2026' }],
    [{ actual_pickup_at: '2026-10-21T10:00:00Z' }],
    [{ pickup_pic: 'x'.repeat(121) }],
  ])('refuses %j with 400 and writes nothing', async (body) => {
    const id = await createCase();
    const res = await patch(id, body);
    expect(res.status).toBe(400);
    const row = await env.DB.prepare(
      `SELECT pickup_status, actual_pickup_at, pickup_pic, item_location FROM assr_cases WHERE id = ?`,
    )
      .bind(id)
      .first();
    expect(row).toEqual({ pickup_status: null, actual_pickup_at: null, pickup_pic: null, item_location: null });
  });
});
