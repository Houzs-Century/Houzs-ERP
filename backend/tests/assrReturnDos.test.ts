import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';
import { qcInspectionFieldsError, returnDoError, tripToFillBackDate } from '../src/services/assrReturnDos';

/* Pending Item Ready (Operation Dept 2026-11-09): a case keeps several supplier
   DOs, and the first received date fills the current trip's back date so it is
   typed once. QC By / date / findings are case fields checked at the API. */

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

let sequence = 0;
async function createCaseWithTrip(): Promise<number> {
  const created = await mount().request(
    '/',
    json('POST', { doc_no: `SO-RETDO-${++sequence}`, items: [{ item_code: 'ITM-1' }], complaint_issue: 'Torn', issue_category: 'Product Defect' }),
    env,
  );
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: number };
  expect((await mount().request(`/${id}/supplier-returns`, json('POST', { reason: 'Bracket' }), env)).status).toBe(200);
  return id;
}

const tripBackDate = async (caseId: number) =>
  (await env.DB.prepare(`SELECT returned_at FROM assr_supplier_returns WHERE assr_id = ? AND archived_at IS NULL`).bind(caseId).first<{ returned_at: string | null }>())?.returned_at;

describe('return DO rules', () => {
  test('a new DO needs a number', () => {
    expect(returnDoError({ do_no: '  ' }, true)).toBe('do_no is required');
    expect(returnDoError({ do_no: 'DO-400-0002', do_date: '2026-10-24', received_at: '2026-10-24' }, true)).toBeNull();
  });
  test('dates are YYYY-MM-DD', () => {
    expect(returnDoError({ received_at: '24/10/2026' }, false)).toBe('received_at must be a YYYY-MM-DD date');
  });
  test('QC by and findings are bounded text, the QC date is YYYY-MM-DD', () => {
    expect(qcInspectionFieldsError({ qc_by: 'Farra', qc_inspected_at: '2026-10-25', qc_findings: 'Zipper smooth' })).toBeNull();
    expect(qcInspectionFieldsError({ qc_by: 'x'.repeat(121) })).toBe('qc_by must be text of at most 120 characters');
    expect(qcInspectionFieldsError({ qc_inspected_at: '25/10/2026' })).toBe('qc_inspected_at must be a YYYY-MM-DD date');
  });
  test('only an empty current trip back date gets filled', () => {
    const trips = [
      { id: 1, round_no: 1, returned_at: '2026-10-01' },
      { id: 2, round_no: 2, returned_at: null },
    ];
    expect(tripToFillBackDate(trips, '2026-10-24')?.id).toBe(2);
    expect(tripToFillBackDate([{ id: 1, round_no: 1, returned_at: '2026-10-01' }], '2026-10-24')).toBeNull();
    expect(tripToFillBackDate(trips, null)).toBeNull();
  });
});

describe('return DO routes', () => {
  test('two DOs on one case; the first received date fills the trip back date once', async () => {
    const caseId = await createCaseWithTrip();
    const first = await mount().request(`/${caseId}/return-dos`, json('POST', { do_no: 'DO-400-0002', received_at: '2026-10-24', received_by: 'Warehouse Team' }), env);
    expect(first.status).toBe(200);
    expect(await tripBackDate(caseId)).toBe('2026-10-24');

    const second = await mount().request(`/${caseId}/return-dos`, json('POST', { do_no: 'DO-400-0003', received_at: '2026-10-30' }), env);
    expect(second.status).toBe(200);
    expect(await tripBackDate(caseId)).toBe('2026-10-24');

    const rows = await env.DB.prepare(`SELECT do_no FROM assr_return_dos WHERE assr_id = ? AND archived_at IS NULL ORDER BY id`).bind(caseId).all();
    expect(rows.results?.map((row) => row.do_no)).toEqual(['DO-400-0002', 'DO-400-0003']);
  });

  test('a DO without a number is refused and nothing is written', async () => {
    const caseId = await createCaseWithTrip();
    expect((await mount().request(`/${caseId}/return-dos`, json('POST', { received_at: '2026-10-24' }), env)).status).toBe(400);
    expect(await tripBackDate(caseId)).toBeNull();
  });

  test('editing and removing a DO', async () => {
    const caseId = await createCaseWithTrip();
    const { id } = (await (await mount().request(`/${caseId}/return-dos`, json('POST', { do_no: 'DO-1' }), env)).json()) as { id: number };
    expect((await mount().request(`/${caseId}/return-dos/${id}`, json('PATCH', { remarks: 'Good condition' }), env)).status).toBe(200);
    expect((await mount().request(`/${caseId}/return-dos/${id}`, { method: 'DELETE' }, env)).status).toBe(200);
    expect((await mount().request(`/${caseId}/return-dos/${id}`, json('PATCH', { remarks: 'again' }), env)).status).toBe(404);
  });

  test('QC fields save on the case', async () => {
    const caseId = await createCaseWithTrip();
    const res = await mount().request(`/${caseId}`, json('PATCH', { qc_inspected_at: '2026-10-25', qc_by: 'Farra', qc_findings: 'Zipper smooth' }), env);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT qc_inspected_at, qc_by, qc_findings FROM assr_case_qc_notes WHERE assr_id = ?`).bind(caseId).first();
    expect(row).toEqual({ qc_inspected_at: '2026-10-25', qc_by: 'Farra', qc_findings: 'Zipper smooth' });
  });
});
