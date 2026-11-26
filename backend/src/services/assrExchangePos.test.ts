import { describe, expect, test } from 'vitest';
import { attachExchangePurchaseOrders } from './assrOrderPos';

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
    then<T>(onF: (v: { data: Row[]; error: null }) => T) {
      return Promise.resolve({ data: this.rows, error: null }).then(onF);
    }
  }
  return { from: (t: string) => new Q(t, tables[t] ?? []) };
}

const HOUZS = 1;
const CO_2990 = 2;

const tables = {
  purchase_orders: [
    { id: 'po-a', po_number: 'HC-PO-009002', status: 'SUBMITTED', company_id: HOUZS, assr_case_id: 10 },
    { id: 'po-b', po_number: 'HC-PO-009001', status: 'DRAFT', company_id: HOUZS, assr_case_id: 10 },
    { id: 'po-c', po_number: 'PO-2611-007', status: 'DRAFT', company_id: CO_2990, assr_case_id: 11 },
    { id: 'po-d', po_number: 'HC-PO-009100', status: 'SUBMITTED', company_id: HOUZS, assr_case_id: null },
  ],
};

describe('attachExchangePurchaseOrders', () => {
  test('fills exchange_pos per case, both companies, sorted by po_number', async () => {
    const rows: Row[] = [
      { id: 10, company_id: HOUZS },
      { id: 11, company_id: CO_2990 },
    ];
    await attachExchangePurchaseOrders(fakeSb(tables), rows);
    expect(rows[0].exchange_pos).toEqual([
      { id: 'po-b', po_number: 'HC-PO-009001', status: 'DRAFT' },
      { id: 'po-a', po_number: 'HC-PO-009002', status: 'SUBMITTED' },
    ]);
    expect(rows[1].exchange_pos).toEqual([
      { id: 'po-c', po_number: 'PO-2611-007', status: 'DRAFT' },
    ]);
  });

  test("a case reads only its OWN company's books", async () => {
    const seen: string[] = [];
    const rows: Row[] = [{ id: 11, company_id: CO_2990 }];
    await attachExchangePurchaseOrders(fakeSb(tables, seen), rows);
    expect(rows[0].exchange_pos).toEqual([{ id: 'po-c', po_number: 'PO-2611-007', status: 'DRAFT' }]);
    expect(seen).toContain('purchase_orders.company_id=2');
  });

  test('a case with no company or no id gets an empty list and issues no read', async () => {
    let touched = false;
    const sb = { from: () => { touched = true; return {}; } };
    const rows: Row[] = [
      { id: 1, company_id: null },
      { id: null, company_id: HOUZS },
      { id: 0, company_id: HOUZS },
    ];
    await attachExchangePurchaseOrders(sb, rows);
    expect(touched).toBe(false);
    expect(rows.map((r) => r.exchange_pos)).toEqual([[], [], []]);
  });

  test('a case that raised no exchange PO reads as an empty list', async () => {
    const rows: Row[] = [{ id: 99, company_id: HOUZS }];
    await attachExchangePurchaseOrders(fakeSb(tables), rows);
    expect(rows[0].exchange_pos).toEqual([]);
  });

  test('company_id arriving as a string (raw SQL bigint) still scopes', async () => {
    const seen: string[] = [];
    const rows: Row[] = [{ id: 10, company_id: '1' }];
    await attachExchangePurchaseOrders(fakeSb(tables, seen), rows);
    expect((rows[0].exchange_pos as unknown[]).length).toBe(2);
    expect(seen).toContain('purchase_orders.company_id=1');
  });
});
