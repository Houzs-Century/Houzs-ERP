/* The supplier master split between purchasing and Finance (owner 2026-09-30:
   采购只看采购的部分; finance 这里的权限最大; 代码只有 finance 能改; a supplier
   already on documents or the ledger waits for the change-code tool).
   Finance = the caller who may move money (scm.money.move): a Finance
   Executive here; a Purchaser (Operation Executive) may not.
   Pinned, on the real handlers over fake PostgREST:
     • a purchaser reads suppliers without the Finance part — list and detail —
       and Finance reads all of it;
     • a purchaser's save cannot touch the Finance part (the desktop form used
       to send every field back, a blank TIN included);
     • a purchaser opens a supplier with its code, but not its Finance part;
     • the code: the same code is no change; a purchaser may not change it; a
       blank one is refused; Finance changes it only while nothing carries it —
       a document naming the supplier, or a journal line carrying the code, in
       THIS company. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { createSupplierHandler, getSupplierHandler, listSuppliersHandler, patchSupplierHandler } from '../src/scm/routes/suppliers';

const CO = 2;
const OTHER_CO = 1;
const FINANCE = { id: 7, name: 'Carrie Ong', position_name: 'Finance Executive', position_policy: { cohort: 'full', can_move_money: true }, permissions_set: new Set(['scm.so_payment.amend']) };
const PURCHASER = { id: 11, name: 'Sim', position_name: 'Operation Executive', position_policy: { cohort: 'full', can_move_money: false }, permissions_set: new Set<string>() };

const FINANCE_PART = { credit_limit_sen: 500_000, tin_number: 'C1234567890', business_reg_no: '201901000001', registration_no: 'REG-1', exemption_no: 'EX-1', statement_type: 'OPEN_ITEM', aging_basis: 'INVOICE_DATE' };
const supplier = (id: string, code: string, over: Row = {}): Row => ({
  id, code, name: `Supplier ${code}`, company_id: CO, status: 'ACTIVE', currency: 'RMB', payment_terms: 'Net 30', contact_person: 'Ah Kow', ...FINANCE_PART, ...over,
});

function harness(who: Row, tables: Record<string, Row[]> = {}) {
  const rows = [supplier('s-new', '400-N001'), supplier('s-po', '400-P001'), supplier('s-je', '405-J001')];
  const sb = fakeSb({
    suppliers: rows.map((r) => ({ ...r })),
    suppliers_with_derived_category: rows.map((r) => ({ ...r, derived_category: 'Sofa' })),
    supplier_material_bindings: [],
    purchase_orders: [{ id: 'po-1', company_id: CO, supplier_id: 's-po' }, { id: 'po-x', company_id: OTHER_CO, supplier_id: 's-new' }],
    grns: [], purchase_invoices: [], purchase_returns: [],
    purchase_consignment_orders: [], purchase_consignment_receives: [], purchase_consignment_returns: [],
    ap_invoices: [], payment_vouchers: [], acc_credit_notes: [], acc_supplier_advances: [],
    journal_entry_lines: [
      { id: 'jl-1', company_id: CO, party_type: 'SUPPLIER', party_code: '405-J001', account_code: '405-0000', credit_sen: 10_000 },
      { id: 'jl-x', company_id: OTHER_CO, party_type: 'SUPPLIER', party_code: '400-N001', account_code: '400-0000', credit_sen: 10_000 },
    ],
    ...tables,
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
  return { app, sb };
}

const send = (app: Hono, method: 'POST' | 'PATCH', url: string, body: Row) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const financeKeysOf = (r: Row) => Object.keys(FINANCE_PART).filter((k) => k in r);

describe('who reads the Finance part', () => {
  test('a purchaser reads the list and the detail without it; code, currency and terms stay', async () => {
    const { app } = harness(PURCHASER);
    const list = await (await app.request('/suppliers')).json() as { suppliers: Row[] };
    expect(list.suppliers).toHaveLength(3);
    for (const s of list.suppliers) {
      expect(financeKeysOf(s)).toEqual([]);
      expect(s).toMatchObject({ currency: 'RMB', payment_terms: 'Net 30' });
      expect(String(s.code)).toMatch(/^40[05]-/);
    }
    const detail = await (await app.request('/suppliers/s-new')).json() as { supplier: Row };
    expect(financeKeysOf(detail.supplier)).toEqual([]);
    expect(detail.supplier).toMatchObject({ code: '400-N001', currency: 'RMB', payment_terms: 'Net 30' });
  });

  test('Finance reads all of it', async () => {
    const { app } = harness(FINANCE);
    const list = await (await app.request('/suppliers')).json() as { suppliers: Row[] };
    expect(list.suppliers.every((s) => financeKeysOf(s).length === 7)).toBe(true);
    const detail = await (await app.request('/suppliers/s-new')).json() as { supplier: Row };
    expect(detail.supplier).toMatchObject(FINANCE_PART);
  });
});

describe('who writes the Finance part', () => {
  test('a purchaser\'s save changes what it may and leaves the Finance part exactly as it was', async () => {
    const { app, sb } = harness(PURCHASER);
    const res = await send(app, 'PATCH', '/suppliers/s-new', {
      name: 'Renamed by purchasing', paymentTerms: 'Net 60', currency: 'MYR',
      tinNumber: '', businessRegNo: '', creditLimitSen: 0, statementType: 'NO_STATEMENT', agingBasis: 'DUE_DATE',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const row = sb.tables.suppliers.find((s) => s.id === 's-new')!;
    expect(row).toMatchObject({ name: 'Renamed by purchasing', payment_terms: 'Net 60', currency: 'MYR', ...FINANCE_PART });
    expect(financeKeysOf(((await res.json()) as { supplier: Row }).supplier)).toEqual([]);
  });

  test('Finance saves the Finance part', async () => {
    const { app, sb } = harness(FINANCE);
    const res = await send(app, 'PATCH', '/suppliers/s-new', { tinNumber: 'C9999999999', creditLimitSen: 100_000, agingBasis: 'DUE_DATE' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(sb.tables.suppliers.find((s) => s.id === 's-new')).toMatchObject({ tin_number: 'C9999999999', credit_limit_sen: 100_000, aging_basis: 'DUE_DATE' });
  });

  test('a purchaser opens a supplier with its code; the Finance part is not taken from them', async () => {
    const { app, sb } = harness(PURCHASER);
    const res = await send(app, 'POST', '/suppliers', { code: '400-Z001', name: 'New Maker', currency: 'MYR', tinNumber: 'C111', creditLimitSen: 900_000, statementType: 'NO_STATEMENT' });
    expect(res.status, await res.clone().text()).toBe(201);
    const row = sb.tables.suppliers.find((s) => s.code === '400-Z001')!;
    expect(row).toMatchObject({ name: 'New Maker', tin_number: null, credit_limit_sen: 0, statement_type: 'OPEN_ITEM', company_id: CO });
    expect(financeKeysOf(((await res.json()) as { supplier: Row }).supplier)).toEqual([]);
  });
});

describe('the code — only Finance changes it, and only while nothing carries it', () => {
  test('the same code (spaces and all) is no change, for anyone; a blank code is refused', async () => {
    const { app, sb } = harness(PURCHASER);
    const same = await send(app, 'PATCH', '/suppliers/s-po', { code: ' 400-P001 ', name: 'Same code' });
    expect(same.status, await same.clone().text()).toBe(200);
    expect(sb.tables.suppliers.find((s) => s.id === 's-po')).toMatchObject({ code: '400-P001', name: 'Same code' });
    const blank = await send(app, 'PATCH', '/suppliers/s-po', { code: '  ' });
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as Row).error).toBe('code_required');
  });

  test('a purchaser may not change a code — not even one nothing carries', async () => {
    const { app, sb } = harness(PURCHASER);
    const res = await send(app, 'PATCH', '/suppliers/s-new', { code: '400-N002' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Row).error).toBe('supplier_code_finance_only');
    expect(sb.tables.suppliers.find((s) => s.id === 's-new')!.code).toBe('400-N001');
  });

  test('Finance changes a code nothing carries in this company (another company\'s paper is not this supplier\'s)', async () => {
    const { app, sb } = harness(FINANCE);
    const res = await send(app, 'PATCH', '/suppliers/s-new', { code: '400-N002' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(sb.tables.suppliers.find((s) => s.id === 's-new')!.code).toBe('400-N002');
  });

  test('a supplier on a document, or a code on the ledger, waits for the change-code tool', async () => {
    const { app, sb } = harness(FINANCE);
    const onPo = await send(app, 'PATCH', '/suppliers/s-po', { code: '405-P001' });
    expect(onPo.status).toBe(409);
    const poBody = await onPo.json() as { error: string; message: string };
    expect(poBody.error).toBe('supplier_code_has_history');
    expect(poBody.message).toContain('purchase orders');
    expect(poBody.message.length).toBeLessThan(200);
    const onLedger = await send(app, 'PATCH', '/suppliers/s-je', { code: '400-J001' });
    expect(onLedger.status).toBe(409);
    expect(((await onLedger.json()) as { message: string }).message).toContain('journal entries');
    expect(sb.tables.suppliers.find((s) => s.id === 's-po')!.code).toBe('400-P001');
    expect(sb.tables.suppliers.find((s) => s.id === 's-je')!.code).toBe('405-J001');
  });
});
