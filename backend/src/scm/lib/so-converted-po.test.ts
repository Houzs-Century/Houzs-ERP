// Unit tests for soConvertedPoNumbers — the SO doc_no → system PO numbers
// resolver behind the Sales Orders list "PO No." column. Route-level coverage
// isn't possible in this harness (scm rides Supabase Postgres, the harness
// rebuilds only the D1 side), so these pin the pure resolution rules through a
// minimal fake PostgREST client (same shape as dropship-batch.test.ts).
import { describe, expect, test } from 'vitest';
import { soConvertedPoNumbers, soConvertedPos } from './so-converted-po';

type Row = Record<string, unknown>;

function fakeSb(tables: Record<string, Row[]>) {
  class Q {
    rows: Row[];
    constructor(rows: Row[]) { this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) {
      this.rows = this.rows.filter((r) => r[col] === val);
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.rows = this.rows.filter((r) => (vals as unknown[]).includes(r[col]));
      return this;
    }
    not(col: string, op: string, val: unknown) {
      if (op === 'is' && val === null) this.rows = this.rows.filter((r) => r[col] != null);
      return this;
    }
    then<T>(onFulfilled: (v: { data: Row[]; error: null }) => T, onRejected?: (e: unknown) => T) {
      return Promise.resolve({ data: this.rows, error: null }).then(onFulfilled, onRejected);
    }
  }
  return { from: (table: string) => new Q(tables[table] ?? []) };
}

const soItem = (id: string, docNo: string): Row => ({ id, doc_no: docNo });
const poItem = (soItemId: string, poId: string): Row => ({ so_item_id: soItemId, purchase_order_id: poId });
const po = (id: string, poNumber: string, status: string): Row => ({ id, po_number: poNumber, status });

describe('soConvertedPoNumbers', () => {
  test('maps an SO to the live PO it was converted into', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', 'SO-1')],
      purchase_order_items: [poItem('si-1', 'po-1')],
      purchase_orders: [po('po-1', 'PO-2607-010', 'SUBMITTED')],
    });
    const out = await soConvertedPoNumbers(sb, ['SO-1'], null);
    expect(out.get('SO-1')).toEqual(['PO-2607-010']);
  });

  test('one SO with several lines → several POs, sorted + de-duped', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', 'SO-1'), soItem('si-2', 'SO-1'), soItem('si-3', 'SO-1')],
      purchase_order_items: [
        poItem('si-1', 'po-2'),   // PO-2607-014
        poItem('si-2', 'po-1'),   // PO-2607-013
        poItem('si-3', 'po-1'),   // same PO again — must de-dupe
      ],
      purchase_orders: [
        po('po-1', 'PO-2607-013', 'SUBMITTED'),
        po('po-2', 'PO-2607-014', 'PARTIAL'),
      ],
    });
    const out = await soConvertedPoNumbers(sb, ['SO-1'], null);
    // numeric-aware sort keeps 013 before 014, and the duplicate collapses.
    expect(out.get('SO-1')).toEqual(['PO-2607-013', 'PO-2607-014']);
  });

  test('drops CANCELLED POs but keeps DRAFT and live stages', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', 'SO-1'), soItem('si-2', 'SO-1')],
      purchase_order_items: [poItem('si-1', 'po-dead'), poItem('si-2', 'po-draft')],
      purchase_orders: [
        po('po-dead', 'PO-2607-001', 'CANCELLED'),
        po('po-draft', 'PO-2607-002', 'DRAFT'),
      ],
    });
    const out = await soConvertedPoNumbers(sb, ['SO-1'], null);
    // CANCELLED is misleading (no live conversion); DRAFT is a real raised PO.
    expect(out.get('SO-1')).toEqual(['PO-2607-002']);
  });

  test('an SO with no PO is simply absent from the map (column shows —)', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', 'SO-1'), soItem('si-9', 'SO-9')],
      purchase_order_items: [poItem('si-1', 'po-1')],
      purchase_orders: [po('po-1', 'PO-2607-010', 'SUBMITTED')],
    });
    const out = await soConvertedPoNumbers(sb, ['SO-1', 'SO-9'], null);
    expect(out.get('SO-1')).toEqual(['PO-2607-010']);
    expect(out.has('SO-9')).toBe(false);
  });

  test('empty input short-circuits without a query', async () => {
    let touched = false;
    const sb = { from: () => { touched = true; return {}; } };
    const out = await soConvertedPoNumbers(sb, [], null);
    expect(out.size).toBe(0);
    expect(touched).toBe(false);
  });

  test('a read error yields an empty map, never a throw', async () => {
    const sb = {
      from: () => ({
        select() { return this; },
        in() { return this; },
        not() { return this; },
        then<T>(onF: (v: { data: null; error: { message: string } }) => T) {
          return Promise.resolve({ data: null, error: { message: 'boom' } }).then(onF);
        },
      }),
    };
    const out = await soConvertedPoNumbers(sb, ['SO-1'], null);
    expect(out.size).toBe(0);
  });

  test('soConvertedPos carries the PO id beside its number, so a screen can link it', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', 'SO-1'), soItem('si-2', 'SO-1')],
      purchase_order_items: [poItem('si-1', 'po-2'), poItem('si-2', 'po-1')],
      purchase_orders: [po('po-1', 'PO-2607-013', 'SUBMITTED'), po('po-2', 'PO-2607-014', 'DRAFT')],
    });
    const out = await soConvertedPos(sb, ['SO-1'], null);
    expect(out.get('SO-1')).toEqual([
      { id: 'po-1', po_number: 'PO-2607-013' },
      { id: 'po-2', po_number: 'PO-2607-014' },
    ]);
  });

  test('a company id puts company_id = <id> on the three reads', async () => {
    // Both companies carry an "SO-1" whose line raised a PO. With company 2
    // named, only company 2's line, PO line and PO may answer — a row of
    // company 1 leaking through any ONE of the three reads adds a PO-1-*.
    const sb = fakeSb({
      mfg_sales_order_items: [
        { id: 'si-a', doc_no: 'SO-1', company_id: 1 },
        { id: 'si-b', doc_no: 'SO-1', company_id: 2 },
      ],
      purchase_order_items: [
        { so_item_id: 'si-a', purchase_order_id: 'po-a', company_id: 1 },
        { so_item_id: 'si-b', purchase_order_id: 'po-b', company_id: 2 },
        { so_item_id: 'si-b', purchase_order_id: 'po-x', company_id: 1 },
        { so_item_id: 'si-b', purchase_order_id: 'po-y', company_id: 2 },
      ],
      purchase_orders: [
        { id: 'po-a', po_number: 'PO-1-A', status: 'SUBMITTED', company_id: 1 },
        { id: 'po-b', po_number: 'PO-2-B', status: 'SUBMITTED', company_id: 2 },
        { id: 'po-x', po_number: 'PO-1-X', status: 'SUBMITTED', company_id: 2 },
        { id: 'po-y', po_number: 'PO-1-Y', status: 'SUBMITTED', company_id: 1 },
      ],
    });
    const out = await soConvertedPoNumbers(sb, ['SO-1'], 2);
    expect(out.get('SO-1')).toEqual(['PO-2-B']);
  });
});
