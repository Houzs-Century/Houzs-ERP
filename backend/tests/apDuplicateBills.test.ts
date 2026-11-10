/* GET /ap-invoices/duplicate-bills — the supplier bills booked twice before
   #5535 refused it. Pinned: the grouping key is the refusal's (company,
   supplier, table, AP doc kind, billRefKey), a cancelled copy never forms a
   group, another company's copy never joins one, the read needs a supplier-bill
   key, and each copy carries what paid it so a double payment shows. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { apInvoices } from '../src/scm/routes/ap-invoices';
import { groupDuplicateBills, type BillRow } from '../src/scm/lib/duplicate-supplier-bill-groups';

const CO = 1;
const OTHER = 2;

const pi = (id: string, ref: string | null, over: Row = {}): Row => ({
  id, company_id: CO, invoice_number: `HC-PI-${id}`, supplier_id: 'sup-a', supplier_invoice_ref: ref,
  invoice_date: '2026-09-01', currency: 'MYR', total_sen: 350000, paid_sen: 0, status: 'POSTED', ...over,
});
const api = (id: string, ref: string | null, over: Row = {}): Row => ({ ...pi(id, ref, over), invoice_number: `HCAPI-${id}`, doc_kind: 'INV', ...over });

function harness(tables: Record<string, Row[]>, perms: readonly string[] = ['scm.payment_voucher.create']) {
  const sb = fakeSb({
    suppliers: [
      { id: 'sup-a', company_id: CO, code: '400-A001', name: 'ALPHA' },
      { id: 'sup-b', company_id: CO, code: '400-B001', name: 'BETA' },
    ],
    purchase_invoices: [], ap_invoices: [], pv_allocations: [], acc_credit_note_allocations: [],
    payment_vouchers: [], acc_credit_notes: [],
    ...tables,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('companyCode' as never, 'HC' as never);
    await next();
  });
  app.route('/ap-invoices', apInvoices);
  return app;
}

const get = async (app: Hono) => {
  const res = await app.request('/ap-invoices/duplicate-bills');
  return { status: res.status, body: (await res.json()) as any };
};

describe('groupDuplicateBills', () => {
  const row = (over: Partial<BillRow>): BillRow => ({
    table: 'purchase_invoices', id: 'x', companyId: CO, supplierId: 'sup-a', supplierInvoiceRef: 'SB-001', docKind: 'INV', status: 'POSTED', ...over,
  });

  test('spacing and case are one bill, the same key the refusal uses', () => {
    const g = groupDuplicateBills([row({ id: '1', supplierInvoiceRef: 'sb 001' }), row({ id: '2', supplierInvoiceRef: ' SB001 ' })]);
    expect(g).toHaveLength(1);
    expect(g[0].billKey).toBe('SB001');
  });

  test('a cancelled copy, another supplier, company, table or doc kind never pairs', () => {
    const base = row({ id: '1' });
    expect(groupDuplicateBills([base, row({ id: '2', status: 'CANCELLED' })])).toEqual([]);
    expect(groupDuplicateBills([base, row({ id: '2', supplierId: 'sup-b' })])).toEqual([]);
    expect(groupDuplicateBills([base, row({ id: '2', companyId: OTHER })])).toEqual([]);
    expect(groupDuplicateBills([base, row({ id: '2', table: 'ap_invoices' })])).toEqual([]);
    expect(groupDuplicateBills([row({ id: '1', table: 'ap_invoices' }), row({ id: '2', table: 'ap_invoices', docKind: 'DN' })])).toEqual([]);
  });

  test('a blank bill number is not a bill number', () => {
    expect(groupDuplicateBills([row({ id: '1', supplierInvoiceRef: '  ' }), row({ id: '2', supplierInvoiceRef: '' })])).toEqual([]);
  });
});

describe('GET /ap-invoices/duplicate-bills', () => {
  test('lists both kinds of copies with what paid each, and flags a bill paid twice first', async () => {
    const app = harness({
      purchase_invoices: [pi('p1', 'SB-001', { paid_sen: 350000 }), pi('p2', 'sb - 001', { invoice_date: '2026-09-05', paid_sen: 350000 }), pi('p3', 'OTHER-9')],
      ap_invoices: [api('a1', 'R7', { supplier_id: 'sup-b' }), api('a2', 'r 7', { supplier_id: 'sup-b' })],
      pv_allocations: [
        { id: 'al1', company_id: CO, pv_id: 'pv1', pi_id: 'p1', ap_invoice_id: null, amount_sen: 350000 },
        { id: 'al2', company_id: CO, pv_id: 'pv2', pi_id: 'p2', ap_invoice_id: null, amount_sen: 350000 },
        { id: 'al3', company_id: CO, pv_id: 'pv3', pi_id: null, ap_invoice_id: 'a1', amount_sen: 100 },
      ],
      payment_vouchers: [
        { id: 'pv1', company_id: CO, pv_number: 'HC-PV-1', status: 'POSTED' },
        { id: 'pv2', company_id: CO, pv_number: 'HC-PV-2', status: 'POSTED' },
        { id: 'pv3', company_id: CO, pv_number: 'HC-PV-3', status: 'CANCELLED' },
      ],
    });
    const { status, body } = await get(app);
    expect(status).toBe(200);
    expect(body.groups).toHaveLength(2);
    const [first, second] = body.groups;
    expect(first).toMatchObject({ kind: 'PI', supplierName: 'ALPHA', billKey: 'SB-001', paidMoreThanOnce: true });
    expect(first.copies.map((r: any) => r.invoiceNumber)).toEqual(['HC-PI-p1', 'HC-PI-p2']);
    expect(first.copies[0].settlements).toEqual([{ kind: 'PV', id: 'pv1', number: 'HC-PV-1', status: 'POSTED', amountSen: 350000 }]);
    expect(second).toMatchObject({ kind: 'API', docKind: 'INV', supplierName: 'BETA', billKey: 'R7', paidMoreThanOnce: false });
    expect(second.copies.every((r: any) => r.settlements.length === 0)).toBe(true);
  });

  test('a credit note knock-off counts as money against the copy', async () => {
    const app = harness({
      ap_invoices: [api('a1', 'K-1'), api('a2', 'K-1', { paid_sen: 500 })],
      acc_credit_note_allocations: [{ id: 'k1', company_id: CO, note_id: 'n1', purchase_invoice_id: null, ap_invoice_id: 'a1', amount_sen: 900, applied_sen: 700 }],
      acc_credit_notes: [{ id: 'n1', company_id: CO, note_number: 'HC-SCN-1', status: 'POSTED' }],
    });
    const { body } = await get(app);
    expect(body.groups[0].paidMoreThanOnce).toBe(true);
    expect(body.groups[0].copies[0].settlements).toEqual([{ kind: 'CN', id: 'n1', number: 'HC-SCN-1', status: 'POSTED', amountSen: 700 }]);
  });

  test('another company\'s copy and a cancelled copy never make a group', async () => {
    const app = harness({
      purchase_invoices: [pi('p1', 'SB-001'), pi('p2', 'SB-001', { company_id: OTHER }), pi('p3', 'SB-001', { status: 'CANCELLED' })],
    });
    const { status, body } = await get(app);
    expect(status).toBe(200);
    expect(body.groups).toEqual([]);
  });

  test('without a supplier-bill key the read is refused', async () => {
    const app = harness({ purchase_invoices: [pi('p1', 'SB-001'), pi('p2', 'SB-001')] }, ['scm.access']);
    const { status } = await get(app);
    expect(status).toBe(403);
  });

  test('any of the supplier-bill keys opens it', async () => {
    const app = harness({ purchase_invoices: [pi('p1', 'SB-001'), pi('p2', 'SB-001')] }, ['scm.payment_voucher.cancel']);
    const { status, body } = await get(app);
    expect(status).toBe(200);
    expect(body.groups).toHaveLength(1);
  });
});
