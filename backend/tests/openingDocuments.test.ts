/* The books' opening documents (mig 20261028T2100; Houzs, owner 2026-10-28:
   开账 = AutoCount 31/08, an Opening Balance page to maintain it). An opening
   bill, supplier credit note or other-debtor bill is posted as part of the
   opening — its journal flagged `opening`, so the books count it whatever its
   date (an other debtor AutoCount owes opens as a receipt not yet knocked
   off). Pinned: the NORMAL screens refuse to edit, post or cancel one, by
   name, writing nothing. Re-posted there it would be booked as an ordinary
   entry dated before the books start — and the books would silently lose it;
   the Opening Balance page is the one place it changes. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { apInvoices } from '../src/scm/routes/ap-invoices';
import { creditNotes } from '../src/scm/routes/credit-notes';
import { otherDebtors } from '../src/scm/routes/other-debtors';

const CO = 1;
const KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

function harness() {
  const sb = fakeSb({
    companies: [{ id: CO, code: 'HC' }],
    acc_account_roles: [],
    suppliers: [{ id: 'sup-d', company_id: CO, code: '400-D002', name: 'DIGLANT MANUFACTURING SDN BHD.' }],
    ap_invoices: [{
      id: 'api-1', company_id: CO, invoice_number: 'HC-API-2608-001', supplier_id: 'sup-d', supplier_invoice_ref: 'IV-2608-076',
      invoice_date: '2026-08-12', due_date: null, currency: 'MYR', exchange_rate: 1, total_sen: 238_000, paid_sen: 0, status: 'POSTED', opening: true,
    }],
    ap_invoice_lines: [{ id: 'apl-1', company_id: CO, invoice_id: 'api-1', line_no: 1, description: 'Opening', debit_account_code: '190-0000', amount_sen: 238_000 }],
    acc_credit_notes: [{
      id: 'scn-1', company_id: CO, note_number: 'HC-SCN-2608-001', kind: 'SCN', party_type: 'SUPPLIER', party_code: '400-D002', party_name: 'DIGLANT',
      supplier_id: 'sup-d', note_date: '2026-08-20', total_sen: 5_000, status: 'POSTED', opening: true,
    }],
    acc_credit_note_lines: [],
    acc_debtors: [{ id: 'deb-1', company_id: CO, name: 'TANGUANYU ENTERPRISE' }, { id: 'deb-2', company_id: CO, name: 'SPRINGCSY SDN. BHD.' }],
    acc_debtor_bills: [{
      id: 'odb-1', company_id: CO, bill_number: 'HC-ODB-2608-001', debtor_id: 'deb-1', bill_date: '2026-08-31', total_sen: 30_548_314,
      received_sen: 0, status: 'POSTED', notes: null, opening: true,
    }],
    acc_debtor_bill_lines: [],
    acc_debtor_receipts: [{
      id: 'odr-1', company_id: CO, receipt_number: 'HC-ODR-2608-001', debtor_id: 'deb-2', receipt_date: '2026-08-31', bank_account_code: '190-0000',
      total_sen: 240_000, status: 'POSTED', opening: true,
    }],
    acc_debtor_receipt_allocations: [],
    journal_entries: [],
    journal_entry_lines: [],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: KEYS } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('companyCode' as never, 'HC' as never);
    await next();
  });
  app.route('/ap-invoices', apInvoices);
  app.route('/credit-notes', creditNotes);
  app.route('/other-debtors', otherDebtors);
  return { app, sb };
}

const call = (app: Hono, path: string, method: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const refusedByName = async (res: Response, docNo: string) => {
  expect(res.status).toBe(409);
  const b = await res.json() as { error: string; message: string };
  expect(b.error).toBe('opening_document');
  expect(b.message).toContain(docNo);
  expect(b.message).toContain('Opening Balance');
  /* The client shows a refusal sentence only under 200 characters (docs/bugs/0821). */
  expect(b.message.length).toBeLessThan(200);
};

describe('an opening document is changed on the Opening Balance page, never on its normal screen', () => {
  test('an opening AP invoice: edit, post and cancel are refused; nothing is written', async () => {
    const { app, sb } = harness();
    await refusedByName(await call(app, '/ap-invoices/api-1', 'PATCH', { notes: 'x' }), 'HC-API-2608-001');
    await refusedByName(await call(app, '/ap-invoices/api-1/post', 'POST'), 'HC-API-2608-001');
    await refusedByName(await call(app, '/ap-invoices/api-1/cancel', 'POST'), 'HC-API-2608-001');
    expect(sb.tables.ap_invoices[0]).toMatchObject({ status: 'POSTED', total_sen: 238_000 });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  test('an opening supplier credit note: edit, post and cancel are refused', async () => {
    const { app, sb } = harness();
    await refusedByName(await call(app, '/credit-notes/scn-1', 'PATCH', { notes: 'x' }), 'HC-SCN-2608-001');
    await refusedByName(await call(app, '/credit-notes/scn-1/post', 'POST'), 'HC-SCN-2608-001');
    await refusedByName(await call(app, '/credit-notes/scn-1/cancel', 'POST'), 'HC-SCN-2608-001');
    expect(sb.tables.acc_credit_notes[0]).toMatchObject({ status: 'POSTED' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  test('an opening other-debtor bill: edit and cancel are refused', async () => {
    const { app, sb } = harness();
    await refusedByName(await call(app, '/other-debtors/bills/odb-1', 'PATCH', { notes: 'x' }), 'HC-ODB-2608-001');
    await refusedByName(await call(app, '/other-debtors/bills/odb-1/cancel', 'POST'), 'HC-ODB-2608-001');
    expect(sb.tables.acc_debtor_bills[0]).toMatchObject({ status: 'POSTED', total_sen: 30_548_314 });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  test('an opening other-debtor receipt (a debtor AutoCount owes): void is refused', async () => {
    const { app, sb } = harness();
    await refusedByName(await call(app, '/other-debtors/receipts/odr-1/void', 'POST'), 'HC-ODR-2608-001');
    expect(sb.tables.acc_debtor_receipts[0]).toMatchObject({ status: 'POSTED' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });
});
