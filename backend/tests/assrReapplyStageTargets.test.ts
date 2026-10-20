import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';
import portalApp from '../src/routes/assrPortal';

/* A stage target is a snapshot taken when a case enters the stage, so a new
   value in Service Maintenance only reached cases that moved afterwards; the
   owner changed the SLA and the dashboard stayed red (2026-10-20). Saving a
   target now re-reads it for the open cases already in that stage. */

const MANAGER = {
  id: 1,
  permissions_set: new Set(['service_cases.create', 'service_cases.write', 'service_cases.manage', 'service_cases.read']),
} as any;

function mount(app: Hono<any>) {
  const parent = new Hono();
  parent.use('*', async (c, next) => {
    (c as any).set('user', MANAGER);
    await next();
  });
  parent.route('/', app);
  return parent;
}

async function createCase(docNo: string) {
  const res = await mount(assrApp as any).request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc_no: docNo, items: [{ item_code: 'ITM-1' }], complaint_issue: 'Sagging', issue_category: 'Product Defect', priority: 'normal' }),
  }, env);
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

const read = (id: number) => env.DB.prepare(
  `SELECT c.stage, c.stage_target_days AS onCase,
          (SELECT h.target_days FROM assr_stage_history h WHERE h.assr_id = c.id AND h.stage = c.stage AND h.exited_at IS NULL) AS onHistory
     FROM assr_cases c WHERE c.id = ?`,
).bind(id).first<{ stage: string; onCase: number | null; onHistory: number | null }>();

describe('a saved stage target reaches the open cases already in that stage', () => {
  test('the normal priority cell for the case\'s stage: case and open history row both follow', async () => {
    const id = await createCase('SO-REAPPLY-1');
    const before = await read(id);
    const normal = await env.DB.prepare(`SELECT id FROM assr_priorities WHERE slug = 'normal'`).first<{ id: number }>();
    const res = await mount(portalApp as any).request('/priority-targets', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority_id: normal!.id, stage: before!.stage, target_days: 11 }),
    }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cases_updated: number }).cases_updated).toBeGreaterThanOrEqual(1);
    const after = await read(id);
    expect(after).toMatchObject({ stage: before!.stage, onCase: 11 });
    if (before!.onHistory != null) expect(after!.onHistory).toBe(11);
  });
});
