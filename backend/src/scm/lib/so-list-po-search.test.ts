// Unit tests for soDocNosByPoNumber — the reverse of so-converted-po's forward
// walk, behind the Sales Order list's "search by PO number" (owner 2026-11-11).
// Route-level coverage isn't possible in this harness (scm rides Supabase
// Postgres, the harness rebuilds only the D1 side), so these pin the pure
// resolution rules through a minimal fake PostgREST client (same shape as
// so-converted-po.test.ts, extended with ilike / limit / range for chunkIn).
import { describe, expect, test } from 'vitest';
import { soDocNosByPoNumber } from './so-list-po-search';

type Row = Record<string, unknown>;

/** A fake PostgREST builder: each method narrows `rows` and `then` resolves it.
 *  `errorOn` makes the read of a named table return an error, to prove the
 *  resolver throws rather than dropping matches. */
function fakeSb(tables: Record<string, Row[]>, errorOn?: string) {
  class Q {
    rows: Row[];
    table: string;
    constructor(table: string, rows: Row[]) { this.table = table; this.rows = [...rows]; }
    select() { return this; }
    ilike(col: string, pattern: string) {
      const needle = pattern.replace(/%/g, '').toLowerCase();
      this.rows = this.rows.filter((r) => String(r[col] ?? '').toLowerCase().includes(needle));
      return this;
    }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => (vals as unknown[]).includes(r[col])); return this; }
    not(col: string, op: string, val: unknown) {
      if (op === 'is' && val === null) this.rows = this.rows.filter((r) => r[col] != null);
      return this;
    }
    limit(n: number) { this.rows = this.rows.slice(0, n); return this; }
    range(from: number, to: number) { this.rows = this.rows.slice(from, to + 1); return this; }
    then<T>(onF: (v: { data: Row[] | null; error: { message: string } | null }) => T, onR?: (e: unknown) => T) {
      const result = errorOn === this.table
        ? { data: null, error: { message: 'boom' } }
        : { data: this.rows, error: null };
      return Promise.resolve(result).then(onF, onR);
    }
  }
  return { from: (table: string) => new Q(table, tables[table] ?? []) };
}

/** A company context: `companyId` resolved to `id`, nothing else. `null` leaves
 *  the legacy unresolved state (scopeToCompany adds no predicate). */
const ctx = (id: number | null) => ({ get: (k: string) => (k === 'companyId' && id != null ? id : undefined) });

const po = (id: string, poNumber: string, status: string, companyId?: number): Row =>
  companyId == null ? { id, po_number: poNumber, status } : { id, po_number: poNumber, status, company_id: companyId };
const poItem = (poId: string, soItemId: string | null, companyId?: number): Row =>
  companyId == null ? { purchase_order_id: poId, so_item_id: soItemId } : { purchase_order_id: poId, so_item_id: soItemId, company_id: companyId };
const soItem = (id: string, docNo: string, companyId?: number): Row =>
  companyId == null ? { id, doc_no: docNo } : { id, doc_no: docNo, company_id: companyId };

describe('soDocNosByPoNumber', () => {
  test('a PO number resolves to the SO it was raised for', async () => {
    const sb = fakeSb({
      purchase_orders: [po('po-1', 'HC-PO-010200', 'SUBMITTED')],
      purchase_order_items: [poItem('po-1', 'si-1')],
      mfg_sales_order_items: [soItem('si-1', 'HC-SO-013341')],
    });
    expect(await soDocNosByPoNumber(sb, ctx(null), 'HC-PO-010200')).toEqual(['HC-SO-013341']);
  });

  test('a substring matches several POs, all on one SO -> that SO once', async () => {
    const sb = fakeSb({
      purchase_orders: [po('po-1', 'HC-PO-010200', 'SUBMITTED'), po('po-2', 'HC-PO-010201', 'PARTIAL')],
      purchase_order_items: [poItem('po-1', 'si-1'), poItem('po-2', 'si-2')],
      mfg_sales_order_items: [soItem('si-1', 'HC-SO-1'), soItem('si-2', 'HC-SO-1')],
    });
    expect(await soDocNosByPoNumber(sb, ctx(null), 'HC-PO-0102')).toEqual(['HC-SO-1']);
  });

  test('drops CANCELLED POs, matching what the "PO No." column shows', async () => {
    const sb = fakeSb({
      purchase_orders: [po('po-dead', 'HC-PO-009000', 'CANCELLED'), po('po-live', 'HC-PO-009001', 'DRAFT')],
      purchase_order_items: [poItem('po-dead', 'si-1'), poItem('po-live', 'si-2')],
      mfg_sales_order_items: [soItem('si-1', 'HC-SO-DEAD'), soItem('si-2', 'HC-SO-LIVE')],
    });
    // Only the DRAFT PO's order surfaces; the CANCELLED one's does not.
    expect(await soDocNosByPoNumber(sb, ctx(null), 'HC-PO-0090')).toEqual(['HC-SO-LIVE']);
  });

  test('a stock PO line (no SO link) yields nothing', async () => {
    const sb = fakeSb({
      purchase_orders: [po('po-1', 'HC-PO-010200', 'SUBMITTED')],
      purchase_order_items: [poItem('po-1', null)],
      mfg_sales_order_items: [],
    });
    expect(await soDocNosByPoNumber(sb, ctx(null), 'HC-PO-010200')).toEqual([]);
  });

  test('nothing matches -> empty, never a throw', async () => {
    const sb = fakeSb({
      purchase_orders: [po('po-1', 'HC-PO-010200', 'SUBMITTED')],
      purchase_order_items: [poItem('po-1', 'si-1')],
      mfg_sales_order_items: [soItem('si-1', 'HC-SO-1')],
    });
    expect(await soDocNosByPoNumber(sb, ctx(null), 'NOPE')).toEqual([]);
  });

  test('a blank term short-circuits without a query', async () => {
    let touched = false;
    const sb = { from: () => { touched = true; return {}; } } as unknown as Parameters<typeof soDocNosByPoNumber>[0];
    expect(await soDocNosByPoNumber(sb, ctx(null), '   ')).toEqual([]);
    expect(touched).toBe(false);
  });

  test('a read error throws, so the caller can refuse rather than drop matches', async () => {
    const sb = fakeSb({
      purchase_orders: [po('po-1', 'HC-PO-010200', 'SUBMITTED')],
    }, 'purchase_orders');
    await expect(soDocNosByPoNumber(sb, ctx(null), 'HC-PO-010200')).rejects.toThrow(/PO number lookup failed/);
  });

  test('a company id scopes every read — no other company leaks through', async () => {
    // Both companies carry a PO whose number starts HC-PO-5; with company 2
    // named, only company 2's order may answer. A row of company 1 leaking
    // through ANY of the three reads would add HC-SO-C1.
    const sb = fakeSb({
      purchase_orders: [
        po('po-1', 'HC-PO-5001', 'SUBMITTED', 1),
        po('po-2', 'HC-PO-5002', 'SUBMITTED', 2),
      ],
      purchase_order_items: [
        poItem('po-1', 'si-1', 1),
        poItem('po-2', 'si-2', 2),
      ],
      mfg_sales_order_items: [
        soItem('si-1', 'HC-SO-C1', 1),
        soItem('si-2', 'HC-SO-C2', 2),
      ],
    });
    expect(await soDocNosByPoNumber(sb, ctx(2), 'HC-PO-5')).toEqual(['HC-SO-C2']);
  });
});
