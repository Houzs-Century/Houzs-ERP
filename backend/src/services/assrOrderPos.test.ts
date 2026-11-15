// attachOrderPurchaseOrders — the Service Case "Order PO" merge. A case's own
// po_no is the SERVICE purchase order (generate-po, costing); this is a
// different fact: the supplier purchase orders raised from the case's SALES
// ORDER lines. Pinned through a minimal fake PostgREST client, the same shape
// as scm/lib/so-converted-po.test.ts, because the D1 test harness has no scm.
import { describe, expect, test } from 'vitest';
import { applyErpSupplierNames, attachOrderPurchaseOrders, supplierPickerResults, orderPoSupplierCode, orderSupplierCode } from './assrOrderPos';

type Row = Record<string, unknown>;

function fakeSb(tables: Record<string, Row[]>, seen: string[] = []) {
  class Q {
    rows: Row[];
    constructor(public table: string, rows: Row[]) { this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) {
      seen.push(`${this.table}.${col}=${String(val)}`);
      this.rows = this.rows.filter((r) => r[col] === val);
      return this;
    }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    not(col: string, op: string, val: unknown) {
      if (op === 'is' && val === null) this.rows = this.rows.filter((r) => r[col] != null);
      return this;
    }
    order() { return this; }
    range(from: number, to: number) { this.rows = this.rows.slice(from, to + 1); return this; }
    then<T>(onF: (v: { data: Row[]; error: null }) => T) {
      return Promise.resolve({ data: this.rows, error: null }).then(onF);
    }
  }
  return { from: (t: string) => new Q(t, tables[t] ?? []) };
}

const HOUZS = 1;
const CO_2990 = 2;

const tables = {
  mfg_sales_order_items: [
    { id: 'hl-1', doc_no: 'HC-SO-011733', company_id: HOUZS },
    { id: 'hl-2', doc_no: 'HC-SO-011733', company_id: HOUZS },
    { id: 'tl-1', doc_no: 'SO-2607-001', company_id: CO_2990 },
    // Same doc number in the OTHER company: must never reach a Houzs case.
    { id: 'xl-1', doc_no: 'SO-2607-001', company_id: HOUZS },
  ],
  purchase_order_items: [
    { so_item_id: 'hl-1', purchase_order_id: 'po-h2', company_id: HOUZS },
    { so_item_id: 'hl-2', purchase_order_id: 'po-h1', company_id: HOUZS },
    { so_item_id: 'tl-1', purchase_order_id: 'po-t1', company_id: CO_2990 },
    { so_item_id: 'xl-1', purchase_order_id: 'po-x1', company_id: HOUZS },
  ],
  purchase_orders: [
    { id: 'po-h1', po_number: 'HC-PO-008783', status: 'SUBMITTED', company_id: HOUZS },
    { id: 'po-h2', po_number: 'HC-PO-008790', status: 'DRAFT', company_id: HOUZS },
    { id: 'po-t1', po_number: 'PO-2607-004', status: 'SUBMITTED', company_id: CO_2990 },
    { id: 'po-x1', po_number: 'HC-PO-000001', status: 'SUBMITTED', company_id: HOUZS },
  ],
};

describe('attachOrderPurchaseOrders', () => {
  test('fills order_pos per case from its SO lines, both companies, sorted', async () => {
    const rows: Row[] = [
      { id: 10, doc_no: 'HC-SO-011733', company_id: HOUZS, po_no: 'SVC-PO-1' },
      { id: 11, doc_no: 'SO-2607-001', company_id: CO_2990, po_no: null },
    ];
    await attachOrderPurchaseOrders(fakeSb(tables), rows);
    expect(rows[0].order_pos).toEqual([
      { id: 'po-h1', po_number: 'HC-PO-008783' },
      { id: 'po-h2', po_number: 'HC-PO-008790' },
    ]);
    expect(rows[1].order_pos).toEqual([{ id: 'po-t1', po_number: 'PO-2607-004' }]);
    // The case's own service PO is a different field and is never touched.
    expect(rows[0].po_no).toBe('SVC-PO-1');
    expect(rows[1].po_no).toBeNull();
  });

  test("a case reads only its OWN company's books", async () => {
    // A 2990 case on SO-2607-001 must not pick up HC-PO-000001, raised from
    // the Houzs line that happens to carry the same doc number.
    const seen: string[] = [];
    const rows: Row[] = [{ id: 11, doc_no: 'SO-2607-001', company_id: CO_2990 }];
    await attachOrderPurchaseOrders(fakeSb(tables, seen), rows);
    expect(rows[0].order_pos).toEqual([{ id: 'po-t1', po_number: 'PO-2607-004' }]);
    expect(seen).toEqual(expect.arrayContaining([
      'mfg_sales_order_items.company_id=2',
      'purchase_order_items.company_id=2',
      'purchase_orders.company_id=2',
    ]));
  });

  test('a case with no company or no SO gets an empty list and issues no read', async () => {
    let touched = false;
    const sb = { from: () => { touched = true; return {}; } };
    const rows: Row[] = [
      { id: 1, doc_no: 'HC-SO-1', company_id: null },
      { id: 2, doc_no: null, company_id: HOUZS },
      { id: 3, doc_no: '', company_id: '0' },
    ];
    await attachOrderPurchaseOrders(sb, rows);
    expect(touched).toBe(false);
    expect(rows.map((r) => r.order_pos)).toEqual([[], [], []]);
  });

  test('a case whose SO raised no PO reads as an empty list', async () => {
    const rows: Row[] = [{ id: 12, doc_no: 'HC-SO-NOPO', company_id: HOUZS }];
    await attachOrderPurchaseOrders(fakeSb(tables), rows);
    expect(rows[0].order_pos).toEqual([]);
  });

  test('company_id arriving as a string (raw SQL bigint) still scopes', async () => {
    const seen: string[] = [];
    const rows: Row[] = [{ id: 10, doc_no: 'HC-SO-011733', company_id: '1' }];
    await attachOrderPurchaseOrders(fakeSb(tables, seen), rows);
    expect((rows[0].order_pos as unknown[]).length).toBe(2);
    expect(seen).toContain('purchase_orders.company_id=1');
  });
});

// HC-0130 — the Solution step's SUPPLIER defaults to the supplier on the PO
// raised from the case item's SO line, so Service Team stops typing it.
describe('orderPoSupplierCode', () => {
  const po = {
    mfg_sales_order_items: [
      { id: 'l-bed', doc_no: 'HC-SO-1', item_code: 'BED-1', company_id: HOUZS },
      { id: 'l-sofa', doc_no: 'HC-SO-1', item_code: 'SOFA-1', company_id: HOUZS },
      { id: 'l-other-co', doc_no: 'HC-SO-1', item_code: 'BED-1', company_id: CO_2990 },
    ],
    purchase_order_items: [
      { so_item_id: 'l-bed', purchase_order_id: 'po-old', company_id: HOUZS },
      { so_item_id: 'l-bed', purchase_order_id: 'po-new', company_id: HOUZS },
      { so_item_id: 'l-bed', purchase_order_id: 'po-void', company_id: HOUZS },
      { so_item_id: 'l-sofa', purchase_order_id: 'po-sofa', company_id: HOUZS },
      { so_item_id: 'l-other-co', purchase_order_id: 'po-x', company_id: CO_2990 },
    ],
    purchase_orders: [
      { id: 'po-old', po_number: 'HC-PO-1', po_date: '2026-09-01', status: 'RECEIVED', company_id: HOUZS, supplier: { code: '400-A001' } },
      { id: 'po-new', po_number: 'HC-PO-2', po_date: '2026-10-01', status: 'SUBMITTED', company_id: HOUZS, supplier: { code: '400-O002' } },
      { id: 'po-void', po_number: 'HC-PO-3', po_date: '2026-10-09', status: 'CANCELLED', company_id: HOUZS, supplier: { code: '400-Z999' } },
      { id: 'po-sofa', po_number: 'HC-PO-4', po_date: '2026-10-05', status: 'SUBMITTED', company_id: HOUZS, supplier: { code: '400-S001' } },
      { id: 'po-x', po_number: 'PO-9', po_date: '2026-10-10', status: 'SUBMITTED', company_id: CO_2990, supplier: { code: '400-X001' } },
    ],
  };

  test("the item's latest live PO wins: not another item's, not a cancelled one", async () => {
    expect(await orderPoSupplierCode(fakeSb(po), 'HC-SO-1', 'BED-1', HOUZS)).toBe('400-O002');
    expect(await orderPoSupplierCode(fakeSb(po), 'HC-SO-1', 'SOFA-1', HOUZS)).toBe('400-S001');
  });

  test("reads only the case's own company", async () => {
    expect(await orderPoSupplierCode(fakeSb(po), 'HC-SO-1', 'BED-1', CO_2990)).toBe('400-X001');
  });

  test('no SO, no item, no company or no PO reads as null', async () => {
    expect(await orderPoSupplierCode(fakeSb(po), 'HC-SO-1', 'CHAIR-1', HOUZS)).toBeNull();
    expect(await orderPoSupplierCode(fakeSb(po), null, 'BED-1', HOUZS)).toBeNull();
    expect(await orderPoSupplierCode(fakeSb(po), 'HC-SO-1', 'BED-1', null)).toBeNull();
  });
});

// HC-0130 reopen (Farra, 21 Oct): no PO -> the supplier the SO item is bound
// to (a mattress is often never PO'd); neither -> null, Service Team picks.
describe('orderSupplierCode', () => {
  const t = {
    mfg_sales_order_items: [
      { id: 'l-bed', doc_no: 'HC-SO-2', item_code: 'BED-1', company_id: HOUZS },
      { id: 'l-mat', doc_no: 'HC-SO-2', item_code: 'MAT-1', company_id: HOUZS },
      { id: 'l-two', doc_no: 'HC-SO-2', item_code: 'MAT-2', company_id: HOUZS },
      { id: 'l-nob', doc_no: 'HC-SO-2', item_code: 'MAT-3', company_id: HOUZS },
    ],
    purchase_order_items: [{ so_item_id: 'l-bed', purchase_order_id: 'po-bed', company_id: HOUZS }],
    purchase_orders: [
      { id: 'po-bed', po_number: 'HC-PO-9', po_date: '2026-10-01', status: 'SUBMITTED', company_id: HOUZS, supplier: { code: '400-PO01' } },
    ],
    supplier_material_bindings: [
      { item_code: 'BED-1', material_kind: 'mfg_product', company_id: HOUZS, is_main_supplier: true, supplier: { code: '400-BIND' } },
      { item_code: 'MAT-1', material_kind: 'mfg_product', company_id: HOUZS, is_main_supplier: false, supplier: { code: '400-ALT' } },
      { item_code: 'MAT-1', material_kind: 'mfg_product', company_id: HOUZS, is_main_supplier: true, supplier: { code: '400-MAT' } },
      { item_code: 'MAT-1', material_kind: 'mfg_product', company_id: CO_2990, is_main_supplier: true, supplier: { code: '400-OTHER' } },
      { item_code: 'MAT-2', material_kind: 'mfg_product', company_id: HOUZS, is_main_supplier: false, supplier: { code: '400-A' } },
      { item_code: 'MAT-2', material_kind: 'mfg_product', company_id: HOUZS, is_main_supplier: false, supplier: { code: '400-B' } },
      { item_code: 'MAT-9', material_kind: 'mfg_product', company_id: HOUZS, is_main_supplier: true, supplier: { code: '400-NOSO' } },
    ],
  };

  test('a PO supplier beats the SO binding', async () => {
    expect(await orderSupplierCode(fakeSb(t), 'HC-SO-2', 'BED-1', HOUZS)).toEqual({ code: '400-PO01', source: 'po' });
  });

  test("no PO -> the SO item's main bound supplier, in the case's own company", async () => {
    const seen: string[] = [];
    expect(await orderSupplierCode(fakeSb(t, seen), 'HC-SO-2', 'MAT-1', HOUZS)).toEqual({ code: '400-MAT', source: 'so' });
    expect(seen).toContain('supplier_material_bindings.company_id=1');
  });

  test('SO line in the ERP but several suppliers and no main, or no binding -> null (blank)', async () => {
    expect(await orderSupplierCode(fakeSb(t), 'HC-SO-2', 'MAT-2', HOUZS)).toBeNull();
    expect(await orderSupplierCode(fakeSb(t), 'HC-SO-2', 'MAT-3', HOUZS)).toBeNull();
  });

  test('SO or SO line not in the ERP -> so-missing (the caller keeps the supplier)', async () => {
    expect(await orderSupplierCode(fakeSb(t), 'HC-SO-2', 'MAT-9', HOUZS)).toBe('so-missing');
    expect(await orderSupplierCode(fakeSb(t), 'SO-001911', 'MAT-1', HOUZS)).toBe('so-missing');
    expect(await orderSupplierCode(fakeSb(t), 'HC-SO-2', 'MAT-1', null)).toBe('so-missing');
  });
});

// HC-0228: PO HC-PO-2610-185 is Hookka Industries (ERP 400-H004), but the
// AutoCount creditors mirror has Hao Hua Furniture under 400-H004.
describe('applyErpSupplierNames', () => {
  const sb = () => fakeSb({
    suppliers: [
      { code: '400-H004', name: 'HOOKKA INDUSTRIES SDN. BHD.', email: 'siti@hookka.com', phone: '+60 11-6133 3173', contact_person: 'MS VIOLET', company_id: HOUZS },
      { code: '400-H004', name: 'OTHER CO SUPPLIER', email: null, phone: null, contact_person: null, company_id: CO_2990 },
    ],
  });
  const hh = { creditor_code: '400-H004', creditor_name: 'HAO HUA FURNITURE ', creditor_mobile: '+6075564463', company_id: HOUZS };

  test('a PO- or SO-filled case and its trips show the ERP supplier', async () => {
    const po = { ...hh, creditor_source: 'po' };
    const so = { ...hh, creditor_source: 'so' };
    const trips = [{ creditor_code: '400-H004', creditor_name: 'HAO HUA FURNITURE ' }, { creditor_code: '400-X001', creditor_name: 'X' }];
    await applyErpSupplierNames(sb(), [po, so], trips);
    expect(po).toMatchObject({ creditor_name: 'HOOKKA INDUSTRIES SDN. BHD.', creditor_email: 'siti@hookka.com', creditor_mobile: null, creditor_attention: 'MS VIOLET' });
    expect(so.creditor_name).toBe('HOOKKA INDUSTRIES SDN. BHD.');
    expect(trips.map((t) => t.creditor_name)).toEqual(['HOOKKA INDUSTRIES SDN. BHD.', 'X']);
  });

  test('a hand or auto pick shows the ERP supplier too; a code the ERP lacks keeps its name', async () => {
    const manual = { ...hh, creditor_source: 'manual' };
    const auto = { ...hh, creditor_source: 'auto' };
    const man = { creditor_code: 'MAN-0001', creditor_name: 'WALK-IN REPAIRER', creditor_source: 'manual', company_id: HOUZS };
    await applyErpSupplierNames(sb(), [manual, auto, man], null);
    expect([manual.creditor_name, auto.creditor_name, man.creditor_name]).toEqual(['HOOKKA INDUSTRIES SDN. BHD.', 'HOOKKA INDUSTRIES SDN. BHD.', 'WALK-IN REPAIRER']);
  });
});

describe('supplierPickerResults', () => {
  const sb = () => fakeSb({
    suppliers: [
      { code: '400-H004', name: 'HOOKKA INDUSTRIES SDN. BHD.', phone: '+601161333173', company_id: HOUZS },
      { code: '400-H003', name: 'HOOKKA MANUFACTURING SDN. BHD.', phone: null, company_id: HOUZS },
      { code: '400-Z999', name: 'HOOKKA OTHER COMPANY', phone: null, company_id: CO_2990 },
    ],
  });
  const hits = [
    { creditor_code: '400-H004', company_name: 'HAO HUA FURNITURE ', phone1: '+6075564463' },
    { creditor_code: 'MAN-0001', company_name: 'HAPPY REPAIRS', phone1: null },
  ];

  test('offers the ERP supplier, never the AutoCount company on the same code, plus AutoCount-only codes', async () => {
    const out = await supplierPickerResults(sb(), [HOUZS], 'h', hits);
    expect(out.map((r) => [r.creditor_code, r.company_name])).toEqual([
      ['MAN-0001', 'HAPPY REPAIRS'],
      ['400-H004', 'HOOKKA INDUSTRIES SDN. BHD.'],
      ['400-H003', 'HOOKKA MANUFACTURING SDN. BHD.'],
    ]);
  });

  test('searches ERP code and name, stays in the caller companies', async () => {
    expect((await supplierPickerResults(sb(), [HOUZS], '400-h003', [])).map((r) => r.creditor_code)).toEqual(['400-H003']);
    expect(await supplierPickerResults(sb(), [HOUZS], 'other company', [])).toEqual([]);
  });
});
