// The self-check's third finding: money on a document that never reached the
// ledger. A booking failure does not fail the operator's save, so before this
// the only trace was a server log — owner, asked whether the accounting page
// should say so: 要.
//
// What is pinned is the CUTOFF and that the page can SEE it. About 2,700
// historical payments are deliberately unbooked, so a card that listed
// "everything unbooked" would open on 2,700 rows and be scrolled past — and
// every real failure with it. The boundary is derived, and it is reported, so
// nobody has to guess which period the card is talking about.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { controlCheckHandler } from '../src/scm/routes/accounting';

const CO = 1;

const harness = (tables: Record<string, Row[]>) => {
  const sb = fakeSb({
    accounts: [
      { account_code: '300-0000', account_name: 'Trade Debtor', account_type: 'ASSET', is_active: true, company_id: CO },
      { account_code: '400-0000', account_name: 'Trade Creditor', account_type: 'LIABILITY', is_active: true, company_id: CO },
    ],
    acc_account_roles: [],
    journal_entries: [], journal_entry_lines: [], v_gl_entries: [],
    sales_invoices: [], purchase_invoices: [],
    mfg_sales_order_payments: [], sales_invoice_payments: [],
    ...tables,
  } as never);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: ['scm.payment_voucher.post'] } as never);
    await next();
  });
  app.get('/control-check', controlCheckHandler as never);
  return app;
};

const pay = (id: string, docNo: string, paidAt: string, sen: number): Row =>
  ({ id, so_doc_no: docNo, paid_at: paidAt, amount_sen: sen, method: 'merchant', company_id: CO });

const je = (docNo: string, entryDate: string): Row =>
  ({ id: `je-${docNo}`, je_no: `JE-${docNo}`, company_id: CO, source_type: 'SOPAY',
     source_doc_no: docNo, entry_date: entryDate, posted: true, reversed: false,
     total_debit_sen: 0, total_credit_sen: 0 });

describe('the self-check reports payments that never reached the ledger', () => {
  test('names the ones that failed, and the period it is speaking about', async () => {
    const app = harness({
      journal_entries: [je('p1', '2026-08-01')],
      mfg_sales_order_payments: [
        pay('old', 'SO-OLD', '2026-01-05', 900000),   // deliberately unbooked history
        pay('p1', 'SO-1', '2026-08-01', 50000),       // booked
        pay('p2', 'SO-2', '2026-08-05', 12345),       // FAILED
      ],
    });
    const body = await (await app.request('/control-check')).json() as any;

    expect(body.payments.ok).toBe(false);
    expect(body.payments.since).toBe('2026-08-01');
    expect(body.payments.rows).toHaveLength(1);
    expect(body.payments.rows[0].docNo).toBe('SO-2');
    expect(body.payments.totalSen).toBe(12345);
  });

  test('is quiet when every payment reached the ledger', async () => {
    const app = harness({
      journal_entries: [je('p1', '2026-08-01')],
      mfg_sales_order_payments: [pay('p1', 'SO-1', '2026-08-01', 50000)],
    });
    const body = await (await app.request('/control-check')).json() as any;
    expect(body.payments.ok).toBe(true);
    expect(body.payments.rows).toHaveLength(0);
    /* Still says which period, so "all clear" cannot be mistaken for
       "nothing was looked at". */
    expect(body.payments.since).toBe('2026-08-01');
  });

  /* The trial-period state. No entry exists, so there is no boundary and every
     payment would be listed — which is the noise that would kill the card. */
  test('lists nothing at all before this company has booked its first payment', async () => {
    const app = harness({
      mfg_sales_order_payments: [pay('a', 'SO-1', '2026-01-05', 900000), pay('b', 'SO-2', '2026-02-05', 700000)],
    });
    const body = await (await app.request('/control-check')).json() as any;
    expect(body.payments.since).toBeNull();
    expect(body.payments.rows).toHaveLength(0);
  });

  test('the control-account checks still answer alongside it — AR, AP, and the 0349 split’s AP_OTHER', async () => {
    const body = await (await harness({}).request('/control-check')).json() as any;
    expect(body.checks.map((c: any) => c.role)).toEqual(['AR', 'AP', 'AP_OTHER']);
  });
});
