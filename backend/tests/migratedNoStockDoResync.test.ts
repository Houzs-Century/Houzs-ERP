/* The DELIVERY-ORDER half of the migrated_no_stock sweep — and the worse half.
 *
 * The GRN defect needs a CANCEL. This one needs only a line edit.
 * `resyncInventoryForDo` corrects an already-shipped DO's ledger by walking
 * `delta = target_qty − current_net_out` per bucket, where current_net_out is
 * summed from that DO's own inventory_movements. A migrated DO (migration 0276)
 * was created DELIVERED with NO movements — the AutoCount balance snapshot
 * already counted its units as gone — so current_net_out is 0 for every bucket
 * and the delta is the FULL line quantity. Editing one line therefore writes a
 * fresh OUT for EVERY line on the document, deducting the whole delivery a
 * second time.
 *
 * Three route handlers reach it: POST /:id/items, PATCH /:id/items/:itemId and
 * DELETE /:id/items/:itemId (delivery-orders-mfg.ts). The helper is tested
 * directly because it is the chokepoint all three share.
 *
 * Contrast, and the reason the DO CANCEL path needed no fix: reverseInventoryForDo
 * and fn_reverse_do_out are MOVEMENT-derived — they read
 * `inventory_movements WHERE source_doc_type='DO'`, so zero movements already
 * produce zero reversal rows. Line-derived versus movement-derived is the whole
 * difference between the two, and it is not visible from either function's name. */
import { describe, expect, test } from 'vitest';
import { resyncInventoryForDo } from '../src/scm/routes/delivery-orders-mfg';

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

/** A DELIVERED delivery order with two goods lines and an empty ledger — the
 *  production shape of a migrated DO. `migrated` decides one column. */
function fixture(migrated: boolean) {
  const tables: Record<string, Row[]> = {
    delivery_orders: [{
      id: 'do-1', company_id: 1, do_number: 'DO-2608-001', status: 'DELIVERED',
      warehouse_id: 'wh-1', is_dropship: false, migrated_no_stock: migrated,
    }],
    delivery_order_items: [
      {
        id: 'di-1', delivery_order_id: 'do-1', so_item_id: null, item_code: 'MATT-A',
        description: 'Mattress A', qty: 5, item_group: 'MATTRESS', variants: null,
        committed_po_batch_no: null,
      },
      {
        id: 'di-2', delivery_order_id: 'do-1', so_item_id: null, item_code: 'MATT-B',
        description: 'Mattress B', qty: 3, item_group: 'MATTRESS', variants: null,
        committed_po_batch_no: null,
      },
    ],
    /* EMPTY — no primary posting to correct. This is the whole defect: the
       resync reads that as "the ledger is 8 units behind", not as "this
       document has no ledger". */
    inventory_movements: [],
  };
  const sb = {
    from: (t: string) => new FakeQuery((tables[t] ||= [])),
    // fn_return_do_units_at_cost / fn_reverse_do_out are never reached here.
    rpc: async () => ({ data: null, error: null }),
  };
  return { tables, sb };
}

const movementsOn = (tables: Record<string, Row[]>) =>
  (tables.inventory_movements ?? []).filter((m) => m.source_doc_id === 'do-1');

describe('resyncInventoryForDo — migrated_no_stock', () => {
  test('a MIGRATED delivery order writes no movement: there is no posting to correct', async () => {
    const { tables, sb } = fixture(true);
    await resyncInventoryForDo(sb, 'do-1', 'u1');
    /* Before the guard this was two OUT rows for the FULL 8 units — the whole
       delivery deducted a second time, from a single line edit. */
    expect(movementsOn(tables)).toEqual([]);
  });

  test('a NORMAL shipped delivery order with no movements still resyncs', async () => {
    /* The control. A live DO whose OUT genuinely failed to write is exactly the
       state this function exists to repair, and it looks identical in the
       ledger. Only the flag separates them, which is why the flag has to be
       read — no amount of looking at inventory_movements can tell them apart. */
    const { tables, sb } = fixture(false);
    await resyncInventoryForDo(sb, 'do-1', 'u1');
    const movs = movementsOn(tables);
    expect(movs).toHaveLength(2);
    expect(movs.every((m) => m.movement_type === 'OUT')).toBe(true);
    expect(movs.map((m) => m.qty).sort((a, b) => a - b)).toEqual([3, 5]);
  });
});
