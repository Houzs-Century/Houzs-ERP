import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';
import { getVerificationNotes } from '../src/services/assrVerificationNotes';

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
// The fields live in assr_case_verification_notes; the detail route merges
// getVerificationNotes onto the case. No row yet reads as all null.
const readRow = (id: number) => getVerificationNotes(env as any, id);

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

  test('a findings edit lands on the timeline; a pending-with pick does not', async () => {
    const id = await createCase();
    expect((await patch(id, { inspection_findings: 'Seam torn', pending_with: 'production' })).status).toBe(200);
    const notes = await env.DB.prepare(
      `SELECT note FROM assr_activity WHERE assr_id = ? AND action = 'field_change' ORDER BY id`,
    )
      .bind(id)
      .all<{ note: string }>();
    expect((notes.results ?? []).map((r) => r.note)).toEqual(['Inspection Findings / Action Taken: (empty) → Seam torn']);
  });

  test('saving notes alongside a case field writes both', async () => {
    const id = await createCase();
    expect((await patch(id, { verified_root_cause: 'Weak seam', next_action: 'Pickup for service' })).status).toBe(200);
    const row = await env.DB.prepare(`SELECT verified_root_cause FROM assr_cases WHERE id = ?`).bind(id).first();
    expect(row).toEqual({ verified_root_cause: 'Weak seam' });
    expect((await readRow(id)).next_action).toBe('Pickup for service');
  });

  test('notes on a case that does not exist answer 404', async () => {
    expect((await patch(999999, { next_action: 'x' })).status).toBe(404);
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
