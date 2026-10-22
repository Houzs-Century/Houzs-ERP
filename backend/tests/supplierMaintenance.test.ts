/* Supplier Maintenance (owner 2026-10-02): A1 Finance's own supplier list in
   Money out; A2a a supplier Finance opens is Finance's alone — purchasing does
   not see it; A3a the supplier's bank, in the Finance part.
   Pinned, on the real handlers over fake PostgREST:
     • a Finance-only supplier (for_purchasing false) is not in a purchaser's
       list — legacy and paged — not on its page, and not theirs to edit;
       Finance sees and edits it;
     • the bank and the purchasing tick are the Finance part: Finance writes
       them (blank clears the bank), a purchaser's body cannot, and a supplier
       a purchaser opens is shared;
     • the maintenance list: "owed" is the supplier's balance in the books —
       its party lines on the AP controls, a reversed pair counting nowhere —
       beside its unspent advance, its credit notes' unused credit and its
       open invoices (a purchase invoice brought over from AutoCount apart);
       a caller who is not Finance reads it without the Finance part;
     • the detail: open invoices oldest first, advances and credit with
       something left, latest payments, the balance. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { createSupplierHandler, getSupplierHandler, listSuppliersHandler, patchSupplierHandler } from '../src/scm/routes/suppliers';
import { getSupplierMaintenanceHandler, listSupplierMaintenanceHandler } from '../src/scm/routes/supplier-maintenance';

const CO = 2;
const OTHER_CO = 1;
const FINANCE = { id: 7, name: 'Carrie Ong', position_name: 'Finance Executive', position_policy: { cohort: 'full', can_move_money: true }, permissions_set: new Set(['scm.so_payment.amend']) };
const PURCHASER = { id: 11, name: 'Sim', position_name: 'Operation Executive', position_policy: { cohort: 'full', can_move_money: false }, permissions_set: new Set<string>() };

const supplier = (id: string, code: string, over: Row = {}): Row => ({
  id, code, name: `Supplier ${code}`, company_id: CO, status: 'ACTIVE', currency: 'MYR', payment_terms: '30 days',
  tin_number: 'C1234567890', business_reg_no: null, registration_no: '201901000001', exemption_no: null,
  credit_limit_sen: 0, statement_type: 'OPEN_ITEM', aging_basis: 'INVOICE_DATE',
  for_purchasing: true, bank_name: null, bank_account_no: null, bank_account_name: null, ...over,
});

const gl = (id: string, code: string, party: string, dr: number, cr: number, over: Row = {}): Row => ({
  line_id: id, je_no: `JE-${id}`, entry_date: '2026-09-10', source_type: 'PI', source_doc_no: `PI-${id}`,
  account_code: code, party_type: 'SUPPLIER', party_code: party, party_name: party,
  debit_sen: dr, credit_sen: cr, posted: true, reversed: false, reversed_by_je: null, company_id: CO, ...over,
});

function harness(who: Row, extra: Record<string, Row[]> = {}) {
  const rows = [
    supplier('s-bed', '400-B001', { bank_name: 'Maybank', bank_account_no: '5123 4567 8901', bank_account_name: 'BEST BED SDN BHD' }),
    supplier('s-land', '405-L001', { for_purchasing: false, tin_number: null, registration_no: null }),
    supplier('s-x', '400-X001', { company_id: OTHER_CO }),
  ];
  const sb = fakeSb({
    suppliers: rows.map((r) => ({ ...r })),
    suppliers_with_derived_category: rows.map((r) => {
      const { for_purchasing: _f, bank_name: _b, bank_account_no: _n, bank_account_name: _a, ...viewCols } = r;
      return { ...viewCols, derived_category: null };
    }),
    supplier_material_bindings: [],
    acc_account_roles: [],
    v_gl_entries: [
      gl('1', '400-0000', '400-B001', 0, 1_000_000),
      gl('2', '400-0000', '400-B001', 200_000, 0, { source_type: 'PV', source_doc_no: 'PV-1' }),
      /* A posted bill and its contra — a pair counts nowhere. */
      gl('3', '400-0000', '400-B001', 0, 50_000, { reversed: true }),
      gl('4', '400-0000', '400-B001', 50_000, 0, { source_type: 'PI_REVERSAL', reversed_by_je: 'JE-3' }),
      gl('5', '405-0000', '405-L001', 0, 300_000, { source_type: 'API', source_doc_no: 'API-1' }),
      gl('6', '400-0000', '400-X001', 0, 999_999, { company_id: OTHER_CO }),
      /* A draft is not in the books. */
      gl('7', '405-0000', '405-L001', 0, 77_700, { posted: false }),
    ],
    purchase_invoices: [
      { id: 'pi-1', company_id: CO, supplier_id: 's-bed', invoice_number: 'PI-2609-002', supplier_invoice_ref: 'INV-9', invoice_date: '2026-09-10', due_date: null, currency: 'MYR', exchange_rate: 1, total_sen: 1_000_000, paid_sen: 200_000, status: 'PARTIALLY_PAID', migrated_no_stock: false },
      { id: 'pi-old', company_id: CO, supplier_id: 's-bed', invoice_number: 'PI-2405-001', supplier_invoice_ref: 'OLD-1', invoice_date: '2024-05-02', due_date: null, currency: 'MYR', exchange_rate: 1, total_sen: 40_000, paid_sen: 0, status: 'POSTED', migrated_no_stock: true },
      { id: 'pi-paid', company_id: CO, supplier_id: 's-bed', invoice_number: 'PI-2608-001', invoice_date: '2026-08-01', currency: 'MYR', exchange_rate: 1, total_sen: 10_000, paid_sen: 10_000, status: 'PAID', migrated_no_stock: false },
    ],
    ap_invoices: [
      { id: 'api-1', company_id: CO, supplier_id: 's-land', invoice_number: 'API-2609-001', supplier_invoice_ref: 'RENT-SEP', invoice_date: '2026-09-01', due_date: '2026-09-07', total_sen: 300_000, paid_sen: 0, status: 'POSTED' },
      { id: 'api-draft', company_id: CO, supplier_id: 's-land', invoice_number: 'API-2609-002', invoice_date: '2026-09-02', total_sen: 5_000, paid_sen: 0, status: 'DRAFT' },
    ],
    acc_supplier_advances: [
      { id: 1, company_id: CO, supplier_id: 's-bed', pv_id: 'pv-adv', pv_number: 'PV-2609-003', amount_sen: 50_000, applied_sen: 20_000, created_at: '2026-09-12T02:00:00Z' },
      { id: 2, company_id: CO, supplier_id: 's-bed', pv_id: 'pv-spent', pv_number: 'PV-2608-009', amount_sen: 10_000, applied_sen: 10_000, created_at: '2026-08-12T02:00:00Z' },
    ],
    acc_credit_notes: [
      { id: 'cn-1', company_id: CO, supplier_id: 's-bed', kind: 'SCN', status: 'POSTED', note_number: 'SCN-2609-001', note_date: '2026-09-20', total_sen: 30_000 },
      { id: 'cn-draft', company_id: CO, supplier_id: 's-bed', kind: 'SCN', status: 'DRAFT', note_number: null, note_date: '2026-09-21', total_sen: 9_000 },
    ],
    acc_credit_note_allocations: [
      { id: 'a-1', company_id: CO, note_id: 'cn-1', applied_sen: 10_000 },
    ],
    payment_vouchers: [
      { id: 'pv-1', company_id: CO, supplier_id: 's-bed', pv_number: 'PV-2609-001', voucher_date: '2026-09-15', total_sen: 200_000, currency: 'MYR', exchange_rate: 1, status: 'POSTED', purpose: 'SUPPLIER_PAYMENT' },
      { id: 'pv-0', company_id: CO, supplier_id: 's-bed', pv_number: 'PV-2608-004', voucher_date: '2026-08-15', total_sen: 10_000, currency: 'MYR', exchange_rate: 1, status: 'POSTED', purpose: 'SUPPLIER_PAYMENT' },
    ],
    purchase_orders: [], grns: [], purchase_returns: [],
    purchase_consignment_orders: [], purchase_consignment_receives: [], purchase_consignment_returns: [],
    journal_entry_lines: [],
    ...extra,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, who as never);
    await next();
  });
  app.get('/suppliers', listSuppliersHandler as never);
  app.get('/suppliers/:id', getSupplierHandler as never);
  app.post('/suppliers', createSupplierHandler as never);
  app.patch('/suppliers/:id', patchSupplierHandler as never);
  app.get('/supplier-maintenance', listSupplierMaintenanceHandler as never);
  app.get('/supplier-maintenance/:id', getSupplierMaintenanceHandler as never);
  return { app, sb };
}

const send = (app: Hono, method: 'POST' | 'PATCH', url: string, body: Row) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('a supplier Finance keeps to itself', () => {
  test('is not in a purchaser\'s list, legacy or paged; Finance lists it', async () => {
    const buyer = harness(PURCHASER).app;
    const legacy = await (await buyer.request('/suppliers')).json() as { suppliers: Row[] };
    expect(legacy.suppliers.map((s) => s.code)).toEqual(['400-B001']);
    const paged = await (await buyer.request('/suppliers?page=0&pageSize=50')).json() as { suppliers: Row[]; total: number };
    expect(paged.suppliers.map((s) => s.code)).toEqual(['400-B001']);
    expect(paged.total).toBe(1);

    const fin = await (await harness(FINANCE).app.request('/suppliers')).json() as { suppliers: Row[] };
    expect(fin.suppliers.map((s) => s.code).sort()).toEqual(['400-B001', '405-L001']);
  });

  test('is not on a purchaser\'s screen and not theirs to edit; Finance opens and edits it', async () => {
    const { app, sb } = harness(PURCHASER);
    expect((await app.request('/suppliers/s-land')).status).toBe(404);
    expect((await send(app, 'PATCH', '/suppliers/s-land', { name: 'Renamed' })).status).toBe(404);
    expect(sb.tables.suppliers.find((s) => s.id === 's-land')?.name).toBe('Supplier 405-L001');

    const fin = harness(FINANCE);
    const detail = await (await fin.app.request('/suppliers/s-land')).json() as { supplier: Row };
    expect(detail.supplier).toMatchObject({ code: '405-L001', for_purchasing: false });
    expect((await send(fin.app, 'PATCH', '/suppliers/s-land', { name: 'Landlord Sdn Bhd' })).status).toBe(200);
    expect(fin.sb.tables.suppliers.find((s) => s.id === 's-land')?.name).toBe('Landlord Sdn Bhd');
  });
});

describe('the bank and the purchasing tick are the Finance part', () => {
  test('Finance opens a supplier for itself, with its bank; blank clears the bank; the tick shares it', async () => {
    const { app, sb } = harness(FINANCE);
    const res = await send(app, 'POST', '/suppliers', {
      code: '405-T009', name: 'TNB', forPurchasing: false,
      bankName: ' Maybank ', bankAccountNo: '5123 0000 1111', bankAccountName: 'TENAGA NASIONAL BERHAD',
    });
    expect(res.status).toBe(201);
    const made = sb.tables.suppliers.find((s) => s.code === '405-T009')!;
    expect(made).toMatchObject({ for_purchasing: false, bank_name: 'Maybank', bank_account_no: '5123 0000 1111', bank_account_name: 'TENAGA NASIONAL BERHAD' });

    expect((await send(app, 'PATCH', `/suppliers/${made.id}`, { bankName: '  ', forPurchasing: true })).status).toBe(200);
    expect(sb.tables.suppliers.find((s) => s.code === '405-T009')).toMatchObject({ bank_name: null, for_purchasing: true, bank_account_no: '5123 0000 1111' });
  });

  test('a purchaser\'s body cannot hide a supplier or set its bank; what a purchaser opens is shared', async () => {
    const { app, sb } = harness(PURCHASER);
    expect((await send(app, 'POST', '/suppliers', { code: '400-N002', name: 'New Foam', forPurchasing: false, bankName: 'CIMB' })).status).toBe(201);
    expect(sb.tables.suppliers.find((s) => s.code === '400-N002')).toMatchObject({ for_purchasing: true, bank_name: null });

    expect((await send(app, 'PATCH', '/suppliers/s-bed', { forPurchasing: false, bankName: 'Fake Bank', name: 'Best Bed' })).status).toBe(200);
    expect(sb.tables.suppliers.find((s) => s.id === 's-bed')).toMatchObject({ for_purchasing: true, bank_name: 'Maybank', name: 'Best Bed' });

    const detail = await (await app.request('/suppliers/s-bed')).json() as { supplier: Row };
    expect('bank_name' in detail.supplier).toBe(false);
    expect('for_purchasing' in detail.supplier).toBe(false);
  });
});

describe('the maintenance list', () => {
  test('owed is the balance in the books, beside advances, credit left and open invoices', async () => {
    const res = await harness(FINANCE).app.request('/supplier-maintenance');
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: Row[]; finance: boolean };
    expect(body.finance).toBe(true);
    const bed = body.rows.find((r) => r.code === '400-B001')!;
    expect(bed).toMatchObject({
      controlKind: 'TRADE', controlCode: '400-0000',
      owedSen: 800_000,          // 10,000.00 billed − 2,000.00 paid; the reversed pair and the other company count nowhere
      advanceSen: 30_000,        // 500.00 advanced − 200.00 applied; the spent one is gone
      creditSen: 20_000,         // the posted note's 300.00 − 100.00 taken; the draft is not credit
      openInvoices: 2,           // the part-paid bill and the AutoCount one; the paid one is not open
      openSen: 800_000,
      preErpSen: 40_000,         // brought over from AutoCount: open, never booked here
      bankName: 'Maybank', forPurchasing: true, missingTax: false,
    });
    const land = body.rows.find((r) => r.code === '405-L001')!;
    expect(land).toMatchObject({ controlKind: 'OTHER', controlCode: '405-0000', owedSen: 300_000, openInvoices: 1, forPurchasing: false, missingTax: true });
    expect(body.rows.some((r) => r.code === '400-X001')).toBe(false);
  });

  test('a caller who is not Finance reads it without the Finance part', async () => {
    const body = await (await harness(PURCHASER).app.request('/supplier-maintenance')).json() as { rows: Row[]; finance: boolean };
    expect(body.finance).toBe(false);
    for (const r of body.rows) {
      for (const k of ['tinNumber', 'registrationNo', 'businessRegNo', 'bankName', 'bankAccountNo', 'bankAccountName', 'forPurchasing', 'missingTax']) expect(k in r).toBe(false);
      expect(typeof r.owedSen).toBe('number');
    }
  });

  test('the detail: open invoices oldest first, what is left of advances and credit, latest payments', async () => {
    const res = await harness(FINANCE).app.request('/supplier-maintenance/s-bed');
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(body.balanceSen).toBe(800_000);
    expect(body.controlCode).toBe('400-0000');
    expect((body.openInvoices as Row[]).map((i) => [i.number, i.outstandingSen, i.preErp])).toEqual([
      ['PI-2405-001', 40_000, true],
      ['PI-2609-002', 800_000, false],
    ]);
    expect(body.advances).toEqual([{ pvId: 'pv-adv', pvNumber: 'PV-2609-003', date: '2026-09-12', leftSen: 30_000 }]);
    expect(body.credits).toEqual([{ id: 'cn-1', noteNumber: 'SCN-2609-001', date: '2026-09-20', leftSen: 20_000 }]);
    expect((body.payments as Row[]).map((p) => p.pvNumber)).toEqual(['PV-2609-001', 'PV-2608-004']);
    expect(body.supplier).toMatchObject({ bank_name: 'Maybank', for_purchasing: true });

    expect((await harness(FINANCE).app.request('/supplier-maintenance/s-x')).status).toBe(404);
  });
});
