// attachOrderPurchaseOrders — the Service Case "Order PO" merge. A case's own
// po_no is the SERVICE purchase order (generate-po, costing); this is a
// different fact: the supplier purchase orders raised from the case's SALES
// ORDER lines. Pinned through a minimal fake PostgREST client, the same shape
// as scm/lib/so-converted-po.test.ts, because the D1 test harness has no scm.
import { describe, expect, test } from 'vitest';
import { attachOrderPurchaseOrders } from './assrOrderPos';

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
