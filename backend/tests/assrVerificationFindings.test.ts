import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';

/* HC-0133 (Farra, Operation Dept, 2026-10-20): the Verification step records
   what the inspection found, the next action and who the case is pending with,
   next to the existing root cause. Pending With is a closed list refused at the
   API so a bad value never lands. */

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
  const docNo = `SO-HC0133-${++seq}`;
  const res = await mount().request(
    '/',
    json('POST', { doc_no: docNo, items: [{ item_code: 'ITM-1' }], complaint_issue: 'Torn', issue_category: 'Product Defect' }),
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

const patch = (id: number, body: Record<string, unknown>) => mount().request(`/${id}`, json('PATCH', body), env);
const readRow = (id: number) =>
  env.DB.prepare(`SELECT inspection_findings, next_action, pending_with FROM assr_cases WHERE id = ?`).bind(id).first();

describe('Verification findings fields (HC-0133)', () => {
  test('saves findings, next action and pending with', async () => {
    const id = await createCase();
    const res = await patch(id, {
      inspection_findings: 'Checked the seat, stitching torn at the seam, photos taken',
      next_action: 'Awaiting supplier confirmation for repair',
      pending_with: 'supplier',
    });
    expect(res.status).toBe(200);
    expect(await readRow(id)).toEqual({
      inspection_findings: 'Checked the seat, stitching torn at the seam, photos taken',
      next_action: 'Awaiting supplier confirmation for repair',
      pending_with: 'supplier',
    });
  });

  test('clearing a field with null is allowed', async () => {
    const id = await createCase();
    expect((await patch(id, { pending_with: 'management', next_action: 'Wait for approval' })).status).toBe(200);
    expect((await patch(id, { pending_with: null, next_action: null })).status).toBe(200);
    expect(await readRow(id)).toEqual({ inspection_findings: null, next_action: null, pending_with: null });
  });

  test.each([
    [{ pending_with: 'sales' }],
    [{ pending_with: 'Supplier' }],
    [{ inspection_findings: 42 }],
  ])('refuses %j with 400 and writes nothing', async (body) => {
    const id = await createCase();
    expect((await patch(id, body)).status).toBe(400);
    expect(await readRow(id)).toEqual({ inspection_findings: null, next_action: null, pending_with: null });
  });
});
