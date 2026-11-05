/* A supplier bill's planned payment date (the owner's Claude Design, Money out
   batch 4 step 7; scm.acc_bill_plans). PUT /ap-invoices/plans sets or clears
   it for a posted bill still owed — an AP bill or a purchase invoice — with
   the keys that raise bills; never on a past day; the list and the bill's
   own read carry it. It posts nothing. */

import { Hono } from 'hono';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { apInvoices } from '../src/scm/routes/ap-invoices';

const CO = 2;
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

function harness(tables: Record<string, Row[]> = {}, perms: readonly string[] = PV_KEYS) {
  const sb = fakeSb({
    suppliers: [{ id: 'sup-t', company_id: CO, code: '400-T005', name: 'TODERN' }],
    acc_account_roles: [], acc_bill_plans: [], ap_invoices: [], ap_invoice_lines: [], purchase_invoices: [],
    journal_entries: [], pv_allocations: [], acc_credit_note_allocations: [],
    ...tables,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    await next();
  });
  app.route('/ap-invoices', apInvoices);
  return { app, sb };
}

const put = (app: Hono, body: unknown) =>
  app.request('/ap-invoices/plans', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const BILLS = {
  ap_invoices: [
    { id: 'api-1', company_id: CO, invoice_number: '2990-API-2609-001', supplier_id: 'sup-t', invoice_date: '2026-09-01', due_date: '2026-10-01', total_sen: 50_000, paid_sen: 0, status: 'POSTED' },
    { id: 'api-d', company_id: CO, invoice_number: '2990-API-2609-002', supplier_id: 'sup-t', invoice_date: '2026-09-02', due_date: null, total_sen: 1, paid_sen: 0, status: 'DRAFT' },
  ],
  purchase_invoices: [
    { id: 'pi-1', company_id: CO, invoice_number: '2990-PI-2609-010', supplier_id: 'sup-t', invoice_date: '2026-09-03', due_date: '2026-10-03', total_sen: 9_000, paid_sen: 4_000, status: 'PARTIALLY_PAID' },
  ],
};

describe('PUT /ap-invoices/plans', () => {
  test('plans a posted bill still owed, moves it, and clears it; the list and the bill read it', async () => {
    const { app, sb } = harness(BILLS);
    expect((await put(app, { kind: 'API', id: 'api-1', plannedOn: '2099-01-15' })).status).toBe(200);
    expect((await put(app, { kind: 'PI', id: 'pi-1', plannedOn: '2099-02-01' })).status).toBe(200);
    /* One row per bill: a second plan moves it. */
    expect((await put(app, { kind: 'API', id: 'api-1', plannedOn: '2099-01-20' })).status).toBe(200);
    const plans = (sb.tables as Record<string, Row[]>).acc_bill_plans!;
    expect(plans.map((p) => [p.bill_kind, p.bill_id, p.planned_on, p.planned_by])).toEqual([
      ['API', 'api-1', '2099-01-20', 'Chew'],
      ['PI', 'pi-1', '2099-02-01', 'Chew'],
    ]);
    const list = await (await app.request('/ap-invoices')).json() as { rows: Row[] };
    expect(list.rows.map((r) => [r.invoiceNumber, r.plannedOn])).toEqual([
      ['2990-PI-2609-010', '2099-02-01'],
      ['2990-API-2609-002', null],
      ['2990-API-2609-001', '2099-01-20'],
    ]);
    const one = await (await app.request('/ap-invoices/api-1')).json() as { invoice: Row };
    expect(one.invoice.planned_on).toBe('2099-01-20');
    /* Cleared: paid by its due date again. */
    expect((await put(app, { kind: 'API', id: 'api-1', plannedOn: null })).status).toBe(200);
    /* The fake hands back a fresh array after a delete — read the table again. */
    expect((sb.tables as Record<string, Row[]>).acc_bill_plans!.map((p) => p.bill_id)).toEqual(['pi-1']);
  });

  test('refuses a past day, a draft, a bill of another company, a wrong kind, and a viewer without the bill keys', async () => {
    const { app } = harness(BILLS);
    const past = await put(app, { kind: 'API', id: 'api-1', plannedOn: '2000-01-01' });
    expect(past.status).toBe(400);
    expect((await past.json() as { error: string }).error).toBe('past_day');
    const draft = await put(app, { kind: 'API', id: 'api-d', plannedOn: '2099-01-15' });
    expect(draft.status).toBe(409);
    expect((await draft.json() as { error: string }).error).toBe('not_open');
    expect((await put(app, { kind: 'API', id: 'nope', plannedOn: '2099-01-15' })).status).toBe(404);
    expect((await put(app, { kind: 'SCN', id: 'api-1', plannedOn: '2099-01-15' })).status).toBe(400);
    const { app: viewer } = harness(BILLS, ['scm.payment_voucher.post']);
    expect((await put(viewer, { kind: 'API', id: 'api-1', plannedOn: '2099-01-15' })).status).toBe(403);
  });
});
