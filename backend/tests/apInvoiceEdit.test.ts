/* Editing an AP invoice after it is posted (owner 2026-09-06: edit 这个不能
   全部都设成可以改吗 — yes, every field). Pinned:
     • a DRAFT simply changes, no journal touched;
     • a POSTED bill RE-POSTS — the old entry gets its contra dated as the
       old bill was, a fresh entry books the edited lines dated as the bill
       now is, and only ONE active entry stands for the document;
     • money already paid caps the new total, a bill with money on it keeps
       its supplier, a cancelled bill is left alone.
   Same fake-PostgREST harness as tests/apInvoices.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { apInvoices } from '../src/scm/routes/ap-invoices';

const CO = 2;
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const CHART: Row[] = [
  acct('900-0000', 'Operating Expense', 'EXPENSE'),
  acct('900-A001', 'RENTAL', 'EXPENSE', { parent_code: '900-0000' }),
  acct('900-A002', 'SERVICE FEE', 'EXPENSE', { parent_code: '900-0000' }),
  acct('400-0000', 'ACCOUNT PAYABLE', 'LIABILITY', { special_type: 'SCC' }),
  acct('405-0000', 'OTHER CREDITORS', 'LIABILITY', { special_type: 'SCC' }),
];
const SUPPLIERS: Row[] = [
  { id: 'sup-h', company_id: CO, code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' },
  { id: 'sup-t', company_id: CO, code: '400-T005', name: 'TODERN' },
];

function harness() {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    suppliers: SUPPLIERS.map((r) => ({ ...r })),
    companies: [{ id: CO, code: '2990' }],
    acc_account_roles: [], ap_invoices: [], ap_invoice_lines: [], journal_entries: [], journal_entry_lines: [],
    purchase_invoices: [], acc_vendor_memory: [],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    /* The pinned system-staff id: the router's supabaseAuth bridge steps
       aside and the hand-set client + houzsUser stay (docs/bugs/0648). */
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: PV_KEYS } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    await next();
  });
  app.route('/ap-invoices', apInvoices);
  return { app, sb };
}

const json = (app: Hono, path: string, method: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const BILL = {
  supplierId: 'sup-h', supplierInvoiceRef: 'HVH-0912', invoiceDate: '2026-09-01', dueDate: '2026-09-30', notes: 'Rent Sept',
  lines: [{ description: 'Rent Sept', debitAccountCode: '900-A001', amountSen: 400_000 }],
};

async function raise(app: Hono): Promise<string> {
  const res = await json(app, '/ap-invoices', 'POST', BILL);
  return ((await res.json()) as { invoice: Row }).invoice.id as string;
}

describe('editing a draft', () => {
  test('every header field and the lines change; no journal is touched', async () => {
    const { app, sb } = harness();
    const id = await raise(app);
    const res = await json(app, `/ap-invoices/${id}`, 'PATCH', {
      supplierId: 'sup-t', supplierInvoiceRef: 'T-1', invoiceDate: '2026-09-02', dueDate: null, notes: 'Service',
      lines: [{ description: 'Service', debitAccountCode: '900-A002', amountSen: 25_000 }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(sb.tables.ap_invoices[0]).toMatchObject({ supplier_id: 'sup-t', supplier_invoice_ref: 'T-1', invoice_date: '2026-09-02', due_date: null, notes: 'Service', total_sen: 25_000, status: 'DRAFT' });
    expect(sb.tables.ap_invoice_lines.map((l) => [l.debit_account_code, l.amount_sen])).toEqual([['900-A002', 25_000]]);
    expect(sb.tables.journal_entries).toHaveLength(0);
  });
});

describe('editing a posted bill re-posts', () => {
  test('the old entry gets its contra (dated as the old bill), a fresh entry books the new lines (dated as the bill now is), one active entry stands', async () => {
    const { app, sb } = harness();
    const id = await raise(app);
    expect((await json(app, `/ap-invoices/${id}/post`, 'POST')).status).toBe(200);
    const res = await json(app, `/ap-invoices/${id}`, 'PATCH', {
      invoiceDate: '2026-09-15',
      lines: [
        { description: 'Rent Sept', debitAccountCode: '900-A001', amountSen: 400_000 },
        { description: 'Cleaning', debitAccountCode: '900-A002', amountSen: 20_000 },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ reposted: true });
    expect(sb.tables.ap_invoices[0]).toMatchObject({ total_sen: 420_000, status: 'POSTED', invoice_date: '2026-09-15' });

    const bySource = (t: string) => sb.tables.journal_entries.filter((j) => j.source_type === t);
    expect(bySource('API_REVERSAL')).toHaveLength(1);
    expect(bySource('API_REVERSAL')[0]).toMatchObject({ entry_date: '2026-09-01' });
    const api = bySource('API');
    expect(api).toHaveLength(2);
    const active = api.filter((j) => j.posted === true && !j.reversed_by && j.status !== 'REVERSED');
    const fresh = api[api.length - 1]!;
    expect(fresh).toMatchObject({ entry_date: '2026-09-15' });
    const lines = sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === fresh.id);
    expect(lines.map((l) => [l.account_code, Number(l.debit_sen), Number(l.credit_sen)])).toEqual([
      ['900-A001', 400_000, 0], ['900-A002', 20_000, 0], ['405-0000', 0, 420_000],
    ]);
    expect(active.length).toBeGreaterThanOrEqual(1);
  });

  test('money on the bill caps the edit: a total below what is paid refuses, and the supplier cannot move; a cancelled bill refuses', async () => {
    const { app, sb } = harness();
    const id = await raise(app);
    await json(app, `/ap-invoices/${id}/post`, 'POST');
    sb.tables.ap_invoices[0]!.paid_sen = 100_000;
    sb.tables.ap_invoices[0]!.status = 'PARTIALLY_PAID';

    const low = await json(app, `/ap-invoices/${id}`, 'PATCH', { lines: [{ debitAccountCode: '900-A001', amountSen: 50_000 }] });
    expect(low.status).toBe(409);
    expect((await low.json() as { error: string }).error).toBe('total_below_paid');

    const moved = await json(app, `/ap-invoices/${id}`, 'PATCH', { supplierId: 'sup-t' });
    expect(moved.status).toBe(409);
    expect((await moved.json() as { error: string }).error).toBe('supplier_locked');

    /* Raising the total above what is paid is fine — the status follows. */
    const up = await json(app, `/ap-invoices/${id}`, 'PATCH', { lines: [{ debitAccountCode: '900-A001', amountSen: 500_000 }] });
    expect(up.status, await up.clone().text()).toBe(200);
    expect(sb.tables.ap_invoices[0]).toMatchObject({ total_sen: 500_000, status: 'PARTIALLY_PAID' });

    sb.tables.ap_invoices[0]!.paid_sen = 0;
    await json(app, `/ap-invoices/${id}/cancel`, 'POST');
    const dead = await json(app, `/ap-invoices/${id}`, 'PATCH', { notes: 'x' });
    expect(dead.status).toBe(409);
  });
});
