// Unit tests for soPoLocked — "a live Purchase Order already claims this SO".
// Route-level coverage isn't possible in this harness (scm rides Supabase
// Postgres, the harness rebuilds only the D1 side), so these pin the rules
// through a minimal fake PostgREST client — same shape as
// so-converted-po.test.ts, which walks the same SO→PO chain.
import { describe, expect, test } from 'vitest';
import { soPoLocked } from './so-po-lock';

type Row = Record<string, unknown>;

function fakeSb(tables: Record<string, Row[]>, failOn?: string) {
  class Q {
    rows: Row[];
    table: string;
    constructor(table: string, rows: Row[]) { this.table = table; this.rows = [...rows]; }
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
    then<T>(onFulfilled: (v: { data: Row[] | null; error: unknown }) => T, onRejected?: (e: unknown) => T) {
      const res = this.table === failOn
        ? { data: null, error: { message: 'boom' } }
        : { data: this.rows, error: null };
      return Promise.resolve(res).then(onFulfilled, onRejected);
    }
  }
  return { from: (table: string) => new Q(table, tables[table] ?? []) };
}

const MIRRORED = '2990-SO-2608-017';   // 2990 — in scope
const HOUZS = 'HC-SO-011196';          // Houzs — deliberately out of scope

const soItem = (id: string, docNo: string): Row => ({ id, doc_no: docNo });
const poItem = (soItemId: string, poId: string | null): Row => ({ so_item_id: soItemId, purchase_order_id: poId });
const po = (id: string, status: string): Row => ({ id, status });

describe('soPoLocked', () => {
  test('locks a 2990 SO whose line is claimed by a submitted PO', async () => {
    // The 2990-SO-2608-017 shape exactly: MRP raised 2990-PO-2608-011 against
    // both sofa lines, then a salesperson edited the SO with no amendment.
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', MIRRORED), soItem('si-2', MIRRORED)],
      purchase_order_items: [poItem('si-1', 'po-1'), poItem('si-2', 'po-1')],
      purchase_orders: [po('po-1', 'SUBMITTED')],
    });
    expect(await soPoLocked(sb, MIRRORED)).toBe(true);
  });

  test('does not lock when the SO has no PO at all', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', MIRRORED)],
      purchase_order_items: [],
      purchase_orders: [],
    });
    expect(await soPoLocked(sb, MIRRORED)).toBe(false);
  });

  test('a CANCELLED PO releases the SO', async () => {
    // Cancelling the PO is the sanctioned way to unlock a PO-locked SO (the
    // header PATCH deliberately refuses the remove-Processing-Date hatch under
    // this lock), so this case is load-bearing, not incidental.
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', MIRRORED)],
      purchase_order_items: [poItem('si-1', 'po-1')],
      purchase_orders: [po('po-1', 'CANCELLED')],
    });
    expect(await soPoLocked(sb, MIRRORED)).toBe(false);
  });

  test('one live PO among cancelled ones still locks', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', MIRRORED), soItem('si-2', MIRRORED)],
      purchase_order_items: [poItem('si-1', 'po-dead'), poItem('si-2', 'po-live')],
      purchase_orders: [po('po-dead', 'CANCELLED'), po('po-live', 'RECEIVED')],
    });
    expect(await soPoLocked(sb, MIRRORED)).toBe(true);
  });

  test('a DRAFT PO locks — diverging from recomputeSoPicked on purpose', async () => {
    // recomputeSoPicked excludes DRAFT so a draft can't drop a line off the
    // From-SO picker. Different question: a purchaser mid-draft is exactly when
    // a silent line edit does the most damage.
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', MIRRORED)],
      purchase_order_items: [poItem('si-1', 'po-1')],
      purchase_orders: [po('po-1', 'DRAFT')],
    });
    expect(await soPoLocked(sb, MIRRORED)).toBe(true);
  });

  test('SCOPE: a Houzs SO is never PO-locked, even with a live PO', async () => {
    // Owner 2026-08-12 scoped this rule to 2990. 302 Houzs orders carry a live
    // PO with no processing date; locking them is a separate decision. If this
    // test ever needs changing, that decision is what changed.
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', HOUZS)],
      purchase_order_items: [poItem('si-1', 'po-1')],
      purchase_orders: [po('po-1', 'SUBMITTED')],
    });
    expect(await soPoLocked(sb, HOUZS)).toBe(false);
  });

  test('an SO with no lines is not locked', async () => {
    const sb = fakeSb({ mfg_sales_order_items: [], purchase_order_items: [], purchase_orders: [] });
    expect(await soPoLocked(sb, MIRRORED)).toBe(false);
  });

  test('a PO line pointing at ANOTHER SO does not lock this one', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soItem('si-1', MIRRORED), soItem('si-other', '2990-SO-2608-099')],
      purchase_order_items: [poItem('si-other', 'po-1')],
      purchase_orders: [po('po-1', 'SUBMITTED')],
    });
    expect(await soPoLocked(sb, MIRRORED)).toBe(false);
  });

  test('missing / blank doc numbers answer false rather than throwing', async () => {
    const sb = fakeSb({});
    expect(await soPoLocked(sb, null)).toBe(false);
    expect(await soPoLocked(sb, undefined)).toBe(false);
    expect(await soPoLocked(sb, '')).toBe(false);
  });

  describe('fails CLOSED on a read error', () => {
    // The opposite of so-converted-po.ts's best-effort empty map: that one feeds
    // a display column, this one is a guard. An unreadable PO link cannot prove
    // the SO is free, and a wrong "unlocked" ships an unapproved spec change to
    // a supplier.
    const tables = {
      mfg_sales_order_items: [soItem('si-1', MIRRORED)],
      purchase_order_items: [poItem('si-1', 'po-1')],
      purchase_orders: [po('po-1', 'SUBMITTED')],
    };
    for (const table of ['mfg_sales_order_items', 'purchase_order_items', 'purchase_orders']) {
      test(`when ${table} errors`, async () => {
        expect(await soPoLocked(fakeSb(tables, table), MIRRORED)).toBe(true);
      });
    }
    test('when the client throws outright', async () => {
      const sb = { from: () => { throw new Error('connection reset'); } };
      expect(await soPoLocked(sb, MIRRORED)).toBe(true);
    });
  });
});
