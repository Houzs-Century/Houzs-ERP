/* ---------------------------------------------------------------------------
 * The convert ceiling is keyed on the LINK, not on a flag.
 *
 * Two things this pins, both of which have already cost real money once:
 *
 *  1. MIGRATED DOCUMENTS MUST COUNT. `scm.delivery_orders.migrated_no_stock` and
 *     `scm.grns.migrated_no_stock` (migration 0276) mark AutoCount paperwork that
 *     carries quantities but posts NO inventory movement — the units already left
 *     (or arrived) through the balance snapshot. It would be an easy and very
 *     plausible mistake to read "no movement" as "not delivered / not received"
 *     and filter these rows out of the ceiling. That is exactly wrong: a migrated
 *     partial DO of 3 units against a 5-unit SO line must leave 2 deliverable,
 *     not 5, or the same three units ship a second time.
 *
 *  2. AN UNLINKED LINE IS INVISIBLE TO THE CEILING. soDeliverableRemaining counts
 *     a DO line only through so_item_id; recomputePoReceived counts a GRN line
 *     only through purchase_order_item_id. A line carrying NULL there still moves
 *     stock (deductInventoryForDo / postGrnAndRollup read the document's OWN
 *     lines) but consumes no quota. That is the mechanism behind the DO-2607-005
 *     double-ship on 2990-SO-2606-019: six unlinked lines shipped, and the
 *     over-delivery guard stayed blind because it had nothing to count them
 *     against. The write path now refuses this shape at create/add time
 *     (do-unlinked-so-lines.ts), but the COUNTING side is unchanged and still
 *     blind — historical rows, and any row written outside those two handlers,
 *     remain uncounted. These tests state that plainly rather than implying the
 *     hole is closed.
 *
 * Driven through a minimal fake PostgREST client, the same technique the repo
 * already uses for resolveExpectedBatchBySoItem (src/scm/lib/dropship-batch.test.ts):
 * the scm side rides Supabase Postgres and this harness binds no database, so a
 * route-level test is not available. What IS tested here is the real production
 * function, not a re-implementation of its rule.
 * ------------------------------------------------------------------------- */
import { describe, expect, test } from 'vitest';
import { soDeliverableRemaining } from '../src/scm/routes/delivery-orders-mfg';
import { recomputePoReceived } from '../src/scm/routes/grns';

type Row = Record<string, unknown>;

/** Chainable, awaitable PostgREST stand-in. Supports only the operators the two
 *  functions under test actually use; anything else is a no-op passthrough so a
 *  future `.order()` cannot silently change what a test asserts. */
function fakeSb(tables: Record<string, Row[]>, updates: Array<{ table: string; patch: Row; where: Row }> = []) {
  class Q {
    rows: Row[];
    table: string;
    mode: 'select' | 'update' = 'select';
    patch: Row = {};
    where: Row = {};
    constructor(table: string, rows: Row[]) { this.table = table; this.rows = [...rows]; }
    select() { return this; }
    update(patch: Row) { this.mode = 'update'; this.patch = patch; return this; }
    eq(col: string, val: unknown) {
      this.where[col] = val;
      this.rows = this.rows.filter((r) => r[col] === val);
      return this;
    }
    neq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] !== val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    order() { return this; }
    /** paginateAll asks for [0,999]; one short page ends the loop. */
    range(from: number, to: number) { this.rows = this.rows.slice(from, to + 1); return this; }
    maybeSingle() { return Promise.resolve({ data: this.rows[0] ?? null, error: null }); }
    then<T>(onFulfilled: (v: { data: Row[]; error: null }) => T, onRejected?: (e: unknown) => T) {
      if (this.mode === 'update') updates.push({ table: this.table, patch: this.patch, where: { ...this.where } });
      return Promise.resolve({ data: this.rows, error: null }).then(onFulfilled, onRejected);
    }
  }
  return { from: (table: string) => new Q(table, tables[table] ?? []) };
}

const soLine = (id: string, qty: number): Row => ({
  id, doc_no: 'SO-1', item_code: 'AKEMI-Q', item_group: 'MATTRESS', qty,
  cancelled: false, unit_price_centi: 0, unit_cost_centi: 0, discount_centi: 0,
  divan_price_sen: 0, leg_price_sen: 0, special_order_price_sen: 0,
});
/** A DO line as PostgREST returns it with the parent status embedded. `migrated`
 *  rides along on the parent so a counterfactual run (one that filters migrated
 *  parents out of the ceiling) has the field it would filter on — otherwise
 *  these tests could not tell a correct implementation from a broken one. */
const doLine = (id: string, soItemId: string | null, qty: number, status: string, migrated = false): Row => ({
  id, so_item_id: soItemId, qty, parent: { status, migrated_no_stock: migrated },
});

describe('SO -> DO ceiling: migrated (no-stock) delivery orders COUNT', () => {
  test('a migrated partial DO of 3 leaves 2 of 5 deliverable, not 5', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soLine('so-1', 5)],
      mfg_sales_orders: [{ doc_no: 'SO-1', debtor_code: 'C1', debtor_name: 'Cust' }],
      // migrated_no_stock = true, DELIVERED, links to the SO line — exactly what
      // create-migrated-documents.mjs writes.
      delivery_order_items: [doLine('do-l1', 'so-1', 3, 'DELIVERED', true)],
      delivery_return_items: [],
    });
    const out = await soDeliverableRemaining(sb, ['SO-1']);
    expect(out.get('so-1')?.delivered).toBe(3);
    expect(out.get('so-1')?.remaining).toBe(2);
  });

  test('a migrated FULL DO closes the line — a second delivery has zero headroom', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soLine('so-1', 5)],
      mfg_sales_orders: [{ doc_no: 'SO-1', debtor_code: 'C1', debtor_name: 'Cust' }],
      delivery_order_items: [doLine('do-l1', 'so-1', 5, 'DELIVERED', true)],
      delivery_return_items: [],
    });
    expect((await soDeliverableRemaining(sb, ['SO-1'])).get('so-1')?.remaining).toBe(0);
  });
});

describe('SO -> DO ceiling: an UNLINKED DO line is invisible to it', () => {
  test('3 units shipped with so_item_id NULL leave the full 5 still deliverable', async () => {
    /* This is the DO-2607-005 shape. The stock left the warehouse; the ceiling
       cannot see it. Asserting 5 is NOT an endorsement — it is the exposure,
       pinned so a future change to soDeliverableRemaining cannot quietly alter
       which way it fails. */
    const sb = fakeSb({
      mfg_sales_order_items: [soLine('so-1', 5)],
      mfg_sales_orders: [{ doc_no: 'SO-1', debtor_code: 'C1', debtor_name: 'Cust' }],
      delivery_order_items: [doLine('do-l1', null, 3, 'DELIVERED')],
      delivery_return_items: [],
    });
    const out = await soDeliverableRemaining(sb, ['SO-1']);
    expect(out.get('so-1')?.delivered).toBe(0);
    expect(out.get('so-1')?.remaining).toBe(5);
  });

  test('the double-ship: one linked DO of 3 plus one unlinked DO of 3 still reports 2 open', async () => {
    // Six units are gone against a five-unit order and the guard reads "2 left".
    const sb = fakeSb({
      mfg_sales_order_items: [soLine('so-1', 5)],
      mfg_sales_orders: [{ doc_no: 'SO-1', debtor_code: 'C1', debtor_name: 'Cust' }],
      delivery_order_items: [
        doLine('do-l1', 'so-1', 3, 'DELIVERED'),
        doLine('do-l2', null, 3, 'DELIVERED'),
      ],
      delivery_return_items: [],
    });
    expect((await soDeliverableRemaining(sb, ['SO-1'])).get('so-1')?.remaining).toBe(2);
  });

  test('CANCELLED and DRAFT parents are the only statuses excluded — not migrated ones', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [soLine('so-1', 10)],
      mfg_sales_orders: [{ doc_no: 'SO-1', debtor_code: 'C1', debtor_name: 'Cust' }],
      delivery_order_items: [
        doLine('do-l1', 'so-1', 1, 'CANCELLED'),
        doLine('do-l2', 'so-1', 2, 'DRAFT'),
        doLine('do-l3', 'so-1', 4, 'DELIVERED'),
      ],
      delivery_return_items: [],
    });
    // Only the DELIVERED 4 counts: 10 - 4 = 6.
    expect((await soDeliverableRemaining(sb, ['SO-1'])).get('so-1')?.remaining).toBe(6);
  });
});

describe('PO -> GRN ceiling: migrated (no-stock) GRNs COUNT', () => {
  test('a POSTED migrated GRN of 3 recounts received_qty to 3, not 0', async () => {
    /* The dangerous direction is a filter that drops migrated GRNs: the recount
       would write received_qty = 0 and the whole PO would become receivable
       again, on top of stock that is already on hand. */
    const updates: Array<{ table: string; patch: Row; where: Row }> = [];
    const sb = fakeSb({
      grn_items: [{ purchase_order_item_id: 'poi-1', qty_accepted: 3, returned_qty: 0, grn_id: 'grn-mig' }],
      grns: [{ id: 'grn-mig', status: 'POSTED', migrated_no_stock: true }],
      purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1', qty: 5, received_qty: 3 }],
      purchase_orders: [{ id: 'po-1', received_at: null, status: 'SUBMITTED' }],
    }, updates);

    const res = await recomputePoReceived(sb, ['poi-1']);
    expect(res.ok).toBe(true);
    const poiWrite = updates.find((u) => u.table === 'purchase_order_items');
    expect(poiWrite?.patch.received_qty).toBe(3);
  });

  test('an UNLINKED GRN line (purchase_order_item_id NULL) recounts the PO line to 0', async () => {
    /* The receiving mirror of the DO hole: the goods are on hand, the PO line
       reads "nothing received" and can be received again. */
    const updates: Array<{ table: string; patch: Row; where: Row }> = [];
    const sb = fakeSb({
      grn_items: [{ purchase_order_item_id: null, qty_accepted: 3, returned_qty: 0, grn_id: 'grn-1' }],
      grns: [{ id: 'grn-1', status: 'POSTED' }],
      purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1', qty: 5, received_qty: 0 }],
      purchase_orders: [{ id: 'po-1', received_at: null, status: 'SUBMITTED' }],
    }, updates);

    await recomputePoReceived(sb, ['poi-1']);
    const poiWrite = updates.find((u) => u.table === 'purchase_order_items');
    expect(poiWrite?.patch.received_qty).toBe(0);
  });

  test('a DRAFT GRN does not count, a POSTED one does', async () => {
    const updates: Array<{ table: string; patch: Row; where: Row }> = [];
    const sb = fakeSb({
      grn_items: [
        { purchase_order_item_id: 'poi-1', qty_accepted: 2, returned_qty: 0, grn_id: 'grn-draft' },
        { purchase_order_item_id: 'poi-1', qty_accepted: 4, returned_qty: 0, grn_id: 'grn-posted' },
      ],
      grns: [{ id: 'grn-draft', status: 'DRAFT' }, { id: 'grn-posted', status: 'POSTED' }],
      purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1', qty: 9, received_qty: 0 }],
      purchase_orders: [{ id: 'po-1', received_at: null, status: 'SUBMITTED' }],
    }, updates);

    await recomputePoReceived(sb, ['poi-1']);
    expect(updates.find((u) => u.table === 'purchase_order_items')?.patch.received_qty).toBe(4);
  });
});
