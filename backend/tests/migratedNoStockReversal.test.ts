/* A MIGRATED document must never un-post stock it never posted.
 *
 * WHAT migrated_no_stock MEANS (migration 0276, owner 2026-08-10). The goods
 * receipts and delivery orders carried over from AutoCount at the cutover are
 * real paperwork with NO inventory movement behind them, deliberately: on-hand
 * entered the ERP once through the AutoCount BALANCE SNAPSHOT, which already
 * counts every past receipt as IN and every past delivery as OUT. A movement
 * behind these documents would apply the same units a second time.
 *
 * THE DEFECT. `PATCH /grns/:id/cancel` builds its reversal from the GRN's
 * LINES (buildGrnCancelReversals reads grn_items), not from the movements the
 * document actually wrote. So cancelling a migrated receipt writes a reversing
 * OUT per line for stock this document never brought in. `resyncInventoryForDo`
 * has the same shape from the other end: its delta is
 * `target_qty - current_net_out`, and a migrated DO's current_net_out is 0, so
 * editing one line on it writes a full OUT for EVERY line.
 *
 * WHY THE EXISTING GUARD CANNOT SEE IT. `grnReverseWouldGoNegative` asks
 * whether the units are on the shelf. They are — they just did not come from
 * this document. The guard passes, which is exactly why it reads as safe. The
 * fixture below is built that way on purpose: `inventory_balances` covers the
 * reversal in full and `inventory_movements` is empty.
 *
 * The DO cancel path is deliberately NOT tested here: it is movement-derived
 * (fn_reverse_do_out and buildDoReversalRows both read
 * inventory_movements WHERE source_doc_type='DO'), so zero movements already
 * produce zero reversal rows. That asymmetry is the finding, and pinning it
 * would pin the harness, not the code.
 *
 * Harness mirrors doOverDeliveryUnlinkedRoute.test.ts — a fake PostgREST driven
 * through real Hono, so the assertion is over the rows the handler tried to
 * WRITE, which is the only place this bug is visible. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { cancelGrnCommand } from '../src/scm/routes/grns';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  upsert(v: Row | Row[]) { return this.insert(v); }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  is(col: string, val: unknown) {
    if (val === null) this.preds.push((r) => r[col] === null || r[col] === undefined);
    else this.preds.push((r) => r[col] === val);
    return this;
  }
  order() { return this; } limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const sb = {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      /* true = the audit sink is writable. The pre-flight must not be the
         reason a cancel stops, or this suite would prove nothing about stock. */
      rpc: async () => ({ data: true, error: null }),
    };
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/grns/:id/cancel', async (c) => cancelGrnCommand(c, c.get('supabase' as never)));
  return app;
}

/** A POSTED goods receipt whose two lines are covered on hand, with `migrated`
 *  deciding only the one column this suite is about. */
function fixture(migrated: boolean) {
  const tables: Record<string, Row[]> = {
    grns: [{
      id: 'grn-1', company_id: CO, status: 'POSTED', grn_number: 'GRN-2608-001',
      warehouse_id: 'wh-1', migrated_no_stock: migrated,
      linked_ac_docno: migrated ? 'PO-AC-0001' : null,
    }],
    grn_items: [
      {
        id: 'gi-1', grn_id: 'grn-1', purchase_order_item_id: 'poi-1', qty_accepted: 5,
        item_code: 'MATT-A', material_name: 'Mattress A', unit_price_sen: 10_000,
        item_group: 'MATTRESS', variants: null, invoiced_qty: 0, returned_qty: 0,
      },
      {
        id: 'gi-2', grn_id: 'grn-1', purchase_order_item_id: 'poi-2', qty_accepted: 3,
        item_code: 'MATT-B', material_name: 'Mattress B', unit_price_sen: 20_000,
        item_group: 'MATTRESS', variants: null, invoiced_qty: 0, returned_qty: 0,
      },
    ],
    /* THE UNITS ARE ON THE SHELF — put there by the AutoCount balance snapshot,
       not by this receipt. This is what makes grnReverseWouldGoNegative pass. */
    inventory_balances: [
      { warehouse_id: 'wh-1', item_code: 'MATT-A', variant_key: '', qty: 40 },
      { warehouse_id: 'wh-1', item_code: 'MATT-B', variant_key: '', qty: 40 },
    ],
    /* EMPTY — the migrated_no_stock claim, measured true on production
       2026-09-07: 0 rows and 0 units behind all 320 migrated receipts. */
    inventory_movements: [],
  };
  return tables;
}

const movementsOn = (tables: Record<string, Row[]>) =>
  (tables.inventory_movements ?? []).filter((m) => m.source_doc_id === 'grn-1');

describe('PATCH /grns/:id/cancel — migrated_no_stock', () => {
  test('a MIGRATED receipt reverses NOTHING: it never posted stock', async () => {
    const tables = fixture(true);
    const res = await harness(tables).request('/grns/grn-1/cancel', { method: 'PATCH' });

    expect(res.status).toBe(200);
    // The cancel itself still happens — the owner's rule is cancel, never delete.
    expect(tables.grns[0]!.status).toBe('CANCELLED');
    /* THE ASSERTION. Before the guard this was two OUT rows for 8 units that
       never had an IN — 879 units across the 320 documents on production. */
    expect(movementsOn(tables)).toEqual([]);
  });

  test('a NORMAL posted receipt still writes its reversing OUT per line', async () => {
    /* The guard must not swallow the real reversal. Same fixture, same guards,
       one column different. */
    const tables = fixture(false);
    const res = await harness(tables).request('/grns/grn-1/cancel', { method: 'PATCH' });

    expect(res.status).toBe(200);
    expect(tables.grns[0]!.status).toBe('CANCELLED');
    const movs = movementsOn(tables);
    expect(movs).toHaveLength(2);
    expect(movs.every((m) => m.movement_type === 'OUT')).toBe(true);
    expect(movs.map((m) => m.qty).sort((a, b) => a - b)).toEqual([3, 5]);
  });
});
