/* Where payments of the opening bills read in the Cash Flow, as Finance keeps it
   (owner 2026-11-25, 「要，做 A」): a bill's own choice first, then its
   supplier's, then the supplier's own ERP bills, else the creditor control.
   The settings doors: the list (counts, what is owed, the choice, what the ERP
   bills give, the pick lists), one supplier's bills, and the write — each read
   and write carrying the company. Real handlers, fake PostgREST; every name and
   figure is made up. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { receiptsPaymentsReport } from '../src/scm/routes/accounting-rp';
import { billText, openingBillPlacePut, openingBillsGet, openingBillsOfSupplier, readPlaceBody } from '../src/scm/routes/accounting-opening-bill-places';

const CO = 2;
const OTHER_CO = 3;
const BANK = '310-0010';
let n = 0;
const acct = (code: string, name: string, extra: Row = {}): Row =>
  ({ company_id: CO, account_code: code, account_name: name, acc_money: false, is_active: true, account_type: 'EXPENSE', section: 'EXPENSES', ...extra });
const bill = (id: string, supplier: string, status: string, total: number, paid: number, opening = true, company = CO): Row =>
  ({ id, company_id: company, invoice_number: id.toUpperCase(), invoice_date: '2026-08-31', supplier_id: supplier, status, total_sen: total, paid_sen: paid, opening, notes: `OPENING 31/08 FROM AUTOCOUNT: AUTOCOUNT PI-${id} — MADE-UP TEXT` });
const pay = (je: string, pv: string, party: string, sen: number): Row[] => [
  { line_id: ++n, company_id: CO, je_no: je, entry_date: '2026-09-10', source_type: 'PV', source_doc_no: pv, account_code: '400-0000', account_name: 'ACCOUNT PAYABLE', debit_sen: sen, credit_sen: 0, party_type: 'SUPPLIER', party_name: party, notes: null, posted: true, reversed: false },
  { line_id: ++n, company_id: CO, je_no: je, entry_date: '2026-09-10', source_type: 'PV', source_doc_no: pv, account_code: BANK, account_name: 'CASH AT BANK', debit_sen: 0, credit_sen: sen, party_type: null, party_name: null, notes: null, posted: true, reversed: false },
];
const alloc = (pv: string, invoice: string, sen: number): Row => ({ id: `al-${++n}`, company_id: CO, pv_id: pv, pi_id: null, ap_invoice_id: invoice, amount_sen: sen, applied_sen: sen, from_advance: false });
const net = (code: string) => ({ kind: 'account', code, flow: 'net' });

const TREE = {
  version: 1,
  blocks: {
    accounts: [{
      kind: 'category', id: 'cf:out', label: 'OUTFLOWS', flow: 'out', children: [
        { kind: 'category', id: 'cf:ap', label: 'CREDITORS', children: [net('400-0000')] },
        { kind: 'category', id: 'cf:buy', label: 'PURCHASES', children: [net('601-0001')] },
        { kind: 'category', id: 'cf:exh', label: 'EXHIBITION', children: [net('900-X001'), net('900-X002'), { kind: 'category', id: 'cf:exh:lorry', label: 'TRANSPORT', children: [net('900-X003')] }] },
        { kind: 'category', id: 'cf:hidden', label: 'NOT FOR THIS COMPANY', hiddenFor: [CO], children: [net('900-X008')] },
      ],
    }],
  },
};

const tables = (): Record<string, Row[]> => ({
  accounts: [
    acct(BANK, 'CASH AT BANK', { acc_money: true, account_type: 'ASSET', section: 'CURRENT ASSETS' }),
    acct('400-0000', 'ACCOUNT PAYABLE', { account_type: 'LIABILITY', section: 'CURRENT LIABILITIES' }),
    acct('190-0000', 'OPENING BALANCE CLEARING', { account_type: 'EQUITY', section: 'EQUITY' }),
    acct('601-0001', 'PURCHASE OF BEDDING', { section: 'COST OF GOODS SOLD' }),
    acct('900-X001', 'STAND BUILD'), acct('900-X002', 'HALL RENTAL'), acct('900-X003', 'LORRY HIRE'),
    acct('900-X009', 'RETIRED ACCOUNT', { is_active: false }),
    acct('900-X001', 'STAND BUILD', { company_id: OTHER_CO }),
  ],
  suppliers: [
    { id: 'sup-a', company_id: CO, code: 'A001', name: 'ALPHA STANDS' },
    { id: 'sup-b', company_id: CO, code: 'B001', name: 'BETA MIXED' },
    { id: 'sup-c', company_id: CO, code: 'C001', name: 'GAMMA NONE' },
    { id: 'sup-x', company_id: OTHER_CO, code: 'X001', name: 'OTHER COMPANY SUPPLIER' },
  ],
  ap_invoices: [
    bill('ob-a1', 'sup-a', 'POSTED', 10000, 4000), bill('ob-a2', 'sup-a', 'PAID', 5000, 5000),
    bill('ob-b1', 'sup-b', 'PAID', 3000, 3000), bill('ob-b2', 'sup-b', 'PAID', 2000, 2000),
    bill('ob-c1', 'sup-c', 'PARTIALLY_PAID', 8000, 3000),
    bill('api-a', 'sup-a', 'PAID', 700, 700, false),
    bill('ob-x', 'sup-x', 'POSTED', 900, 0, true, OTHER_CO),
  ],
  ap_invoice_lines: [
    ...['ob-a1', 'ob-a2', 'ob-b1', 'ob-b2', 'ob-c1'].map((id) => ({ id: `l-${id}`, company_id: CO, invoice_id: id, debit_account_code: '190-0000', amount_sen: 100 })),
    { id: 'l-api-a', company_id: CO, invoice_id: 'api-a', debit_account_code: '900-X001', amount_sen: 700 },
  ],
  /* Finance's choices: BETA by the category, its second bill on its own; GAMMA on an account. */
  acc_opening_supplier_places: [
    { company_id: CO, supplier_id: 'sup-b', account_code: null, category_id: 'cf:exh' },
    { company_id: CO, supplier_id: 'sup-c', account_code: '900-X002', category_id: null },
    { company_id: OTHER_CO, supplier_id: 'sup-a', account_code: '601-0001', category_id: null },
  ],
  acc_opening_bill_places: [{ company_id: CO, ap_invoice_id: 'ob-b2', account_code: '601-0001', category_id: null }],
  v_gl_entries: [...pay('JE-A', 'PV-A', 'ALPHA STANDS', 4000), ...pay('JE-B', 'PV-B', 'BETA MIXED', 5000), ...pay('JE-C', 'PV-C', 'GAMMA NONE', 3000)],
  payment_vouchers: ['A', 'B', 'C'].map((x) => ({ id: `pv-${x}`, company_id: CO, pv_number: `PV-${x}`, status: 'POSTED' })),
  pv_allocations: [alloc('pv-A', 'ob-a1', 4000), alloc('pv-B', 'ob-b1', 3000), alloc('pv-B', 'ob-b2', 2000), alloc('pv-C', 'ob-c1', 3000)],
  purchase_invoices: [],
  acc_account_roles: [],
  acc_acquirers: [],
  acc_report_layouts: [{ report: 'rp', tree: TREE, updated_at: '2026-11-25T00:00:00Z', updated_by: 'test' }],
});

function harness(t = tables()) {
  const app = new Hono();
  const sb = fakeSb(t);
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: ['scm.payment_voucher.post'] } as never);
    await next();
  });
  app.get('/rp', receiptsPaymentsReport as never);
  app.get('/ob', openingBillsGet as never);
  app.get('/ob/:supplierId', openingBillsOfSupplier as never);
  app.put('/ob/place', openingBillPlacePut as never);
  return { app, t };
}
const put = (app: Hono, body: unknown) => app.request('/ob/place', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('Cash Flow: opening bills placed as Finance keeps them (owner 2026-11-25)', () => {
  test('a bill\'s own choice first, then its supplier\'s, then its ERP bills', async () => {
    const res = await harness().app.request('/rp?from=2026-09-01&to=2026-09-30');
    expect(res.status, await res.clone().text()).toBe(200);
    const r = await res.json() as { payments: Array<{ key: string; code: string | null; cells: Record<string, number> }> };
    const row = (key: string) => r.payments.find((p) => p.key === key);
    expect(row('900-X001')?.cells).toEqual({ [BANK]: 4000 });           // ALPHA: no choice, its ERP bill's account
    expect(row('OPENING-BILLS:cf:exh')?.cells).toEqual({ [BANK]: 3000 }); // BETA's first bill: its supplier's category
    expect(row('601-0001')?.cells).toEqual({ [BANK]: 2000 });           // BETA's second bill: its own account
    expect(row('900-X002')?.cells).toEqual({ [BANK]: 3000 });           // GAMMA: no ERP bill, its supplier's account
    expect(row('400-0000')).toBeUndefined();
  });

  test('the list: this company\'s suppliers, what is owed, the choice, what the ERP bills give, the pick lists', async () => {
    const res = await harness().app.request('/ob');
    expect(res.status, await res.clone().text()).toBe(200);
    const p = await res.json() as {
      suppliers: Array<Record<string, unknown>>; accounts: Array<{ code: string }>; categories: Array<{ id: string; path: string }>;
    };
    expect(p.suppliers.map((s) => s.name)).toEqual(['ALPHA STANDS', 'BETA MIXED', 'GAMMA NONE']);
    expect(p.suppliers[0]).toMatchObject({ code: 'A001', bills: 2, openBills: 1, owingSen: 6000, paidSen: 9000, billsSet: 0, set: null, auto: { kind: 'account', code: '900-X001', name: 'STAND BUILD' } });
    expect(p.suppliers[1]).toMatchObject({ bills: 2, openBills: 0, owingSen: 0, billsSet: 1, set: { kind: 'category', id: 'cf:exh', label: 'EXHIBITION' }, auto: null });
    expect(p.suppliers[2]).toMatchObject({ openBills: 1, owingSen: 5000, set: { kind: 'account', code: '900-X002', name: 'HALL RENTAL' }, auto: null });
    expect(p.accounts.map((a) => a.code)).toEqual(['190-0000', '400-0000', '601-0001', '900-X001', '900-X002', '900-X003']);
    expect(p.categories.find((k) => k.id === 'cf:exh:lorry')?.path).toBe('OUTFLOWS › EXHIBITION › TRANSPORT');
    expect(p.categories.some((k) => k.id === 'cf:hidden')).toBe(false);
  });

  test('one supplier\'s bills with their own choice; another company\'s supplier is not found', async () => {
    const { app } = harness();
    const res = await app.request('/ob/sup-b');
    expect(res.status).toBe(200);
    const p = await res.json() as { bills: Array<{ id: string; text: string; set: unknown }> };
    expect(p.bills.map((b) => b.id)).toEqual(['ob-b1', 'ob-b2']);
    expect(p.bills[0]!.set).toBeNull();
    expect(p.bills[1]!.set).toEqual({ kind: 'account', code: '601-0001', name: 'PURCHASE OF BEDDING' });
    expect(p.bills[0]!.text).toBe('AUTOCOUNT PI-ob-b1 — MADE-UP TEXT');
    expect((await app.request('/ob/sup-x')).status).toBe(404);
  });

  test('the write: a supplier or a bill of this company, an active non-bank account or a category it prints; clearing removes the row', async () => {
    const { app, t } = harness();
    expect((await put(app, { supplierId: 'sup-a', billId: null, account: null, category: 'cf:exh:lorry' })).status).toBe(200);
    expect(t.acc_opening_supplier_places!.find((r) => r.company_id === CO && r.supplier_id === 'sup-a')).toMatchObject({ account_code: null, category_id: 'cf:exh:lorry', updated_by: 'Tester' });
    expect((await put(app, { supplierId: 'sup-a', billId: null, account: '900-X003', category: null })).status).toBe(200);
    expect(t.acc_opening_supplier_places!.filter((r) => r.company_id === CO && r.supplier_id === 'sup-a')).toHaveLength(1);
    expect((await put(app, { supplierId: 'sup-a', billId: null, account: null, category: null })).status).toBe(200);
    expect(t.acc_opening_supplier_places!.find((r) => r.company_id === CO && r.supplier_id === 'sup-a')).toBeUndefined();
    /* Another company's choice for the same supplier id is never touched. */
    expect(t.acc_opening_supplier_places!.find((r) => r.company_id === OTHER_CO)).toBeDefined();
    expect((await put(app, { supplierId: null, billId: 'ob-a1', account: '601-0001', category: null })).status).toBe(200);
    expect(t.acc_opening_bill_places!.find((r) => r.ap_invoice_id === 'ob-a1')).toMatchObject({ company_id: CO, account_code: '601-0001' });

    const refused = async (body: unknown) => (await put(app, body)).status;
    expect(await refused({ supplierId: 'sup-x', billId: null, account: '900-X001', category: null })).toBe(404);
    expect(await refused({ supplierId: null, billId: 'api-a', account: '900-X001', category: null })).toBe(404);
    expect(await refused({ supplierId: null, billId: 'ob-x', account: '900-X001', category: null })).toBe(404);
    expect(await refused({ supplierId: 'sup-a', billId: null, account: '900-X009', category: null })).toBe(400);
    expect(await refused({ supplierId: 'sup-a', billId: null, account: BANK, category: null })).toBe(400);
    expect(await refused({ supplierId: 'sup-a', billId: null, account: null, category: 'cf:hidden' })).toBe(400);
    expect(await refused({ supplierId: 'sup-a', billId: null, account: null, category: 'cf:nowhere' })).toBe(400);
  });

  test('the body: one target, at most one place, every field text or null', () => {
    expect(readPlaceBody({ supplierId: 's', billId: null, account: 'A', category: null })).toEqual({ ok: true, supplierId: 's', billId: null, place: { account: 'A', category: null } });
    expect(readPlaceBody({ supplierId: null, billId: 'b', account: null, category: null })).toEqual({ ok: true, supplierId: null, billId: 'b', place: null });
    expect(readPlaceBody({ supplierId: 's', billId: 'b', account: 'A', category: null }).ok).toBe(false);
    expect(readPlaceBody({ supplierId: null, billId: null, account: 'A', category: null }).ok).toBe(false);
    expect(readPlaceBody({ supplierId: 's', billId: null, account: 'A', category: 'c' }).ok).toBe(false);
    expect(readPlaceBody({ supplierId: 's', billId: null, account: 'A' }).ok).toBe(false);
    expect(billText('OPENING 31/08 FROM AUTOCOUNT: AUTOCOUNT PI-1 — WAREHOUSE STORAGE')).toBe('AUTOCOUNT PI-1 — WAREHOUSE STORAGE');
  });
});
