/* 2990-DO-2611-016, CODY-(K), KL WAREHOUSE, 2026-11-10 — the exact sequence.
 *
 * 02:28  ship: OUT 1 under "BF-01, Gap 12, Divan 8, Leg 4" (consumed the GRN
 *        2990-GRN-2611-010 lot, PO 2990-PO-2610-028).
 * 02:48  the line's spec is edited to add "Total 24" (same goods, same rack).
 *        resyncInventoryForDo sees two buckets: the old one is 1 over, the new
 *        one is 1 short. It returns 1 from the old bucket and takes 1 in the new.
 *
 * The return went through scm.fn_return_do_units_at_cost, which never ran: the
 * route sent p_item_code to a function whose parameter is p_product_code. The
 * route then wrote a plain IN, and the FIFO trigger made it a new lot sourced
 * from the DO, with no GRN and no PO (lot 4fd703ae in production). The planner
 * for the source-PO stamp then found the rack but no PO.
 *
 * Now: the return is called with the function's own parameter names, the route
 * itself never writes an IN, and a failed return writes nothing at all. */
import { describe, expect, test } from 'vitest';
import { resyncInventoryForDo } from '../src/scm/routes/delivery-orders-mfg';
import { computeVariantKey } from '../src/scm/shared';

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

const SHIPPED = { fabricCode: 'BF-01', gap: '12"', divanHeight: '8"', legHeight: '4"' };
/* DO-016's own edit (adding Total 24) is no longer a bucket change: the total is
   derived and stays out of the key (shared/variant-key.ts). A real spec edit, a
   different leg, still is, and still goes back through the return function. */
const EDITED = { ...SHIPPED, legHeight: '6"' };
const VK_SHIPPED = computeVariantKey('bedframe', SHIPPED);
const VK_EDITED = computeVariantKey('bedframe', EDITED);

function fixture(returnError: { message: string } | null, editedVariants: Row = EDITED) {
  const tables: Record<string, Row[]> = {
    delivery_orders: [{
      id: 'do-016', company_id: 2, do_number: '2990-DO-2611-016', status: 'LOADED',
      warehouse_id: 'wh-kl', is_dropship: false, migrated_no_stock: false,
    }],
    delivery_order_items: [{
      id: 'di-016', delivery_order_id: 'do-016', so_item_id: null, item_code: 'CODY-(K)',
      description: 'CODY King', qty: 1, item_group: 'bedframe', variants: editedVariants,
      committed_po_batch_no: null, company_id: 2,
    }],
    inventory_movements: [{
      id: 'mov-a55b', movement_type: 'OUT', warehouse_id: 'wh-kl', item_code: 'CODY-(K)',
      variant_key: VK_SHIPPED, qty: 1, unit_cost_sen: 55000, total_cost_sen: 55000,
      product_name: 'CODY King', source_doc_type: 'DO', source_doc_id: 'do-016',
      source_doc_no: '2990-DO-2611-016', correction_seq: null, company_id: 2,
    }],
  };
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const sb = {
    from: (t: string) => new FakeQuery((tables[t] ||= [])),
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      if (fn === 'fn_return_do_units_at_cost') return { data: null, error: returnError };
      return { data: null, error: null };
    },
  };
  return { tables, sb, rpcCalls };
}

const written = (tables: Record<string, Row[]>) =>
  (tables.inventory_movements ?? []).filter((m) => m.source_doc_id === 'do-016' && m.id !== 'mov-a55b');

describe('resyncInventoryForDo — a spec edit on a shipped DO (2990-DO-2611-016)', () => {
  test('the shipped and the edited spec are two buckets (the premise)', () => {
    expect(VK_SHIPPED).not.toBe(VK_EDITED);
  });

  test('the old bucket goes back through the return function, named as the function names its parameters', async () => {
    const { tables, sb, rpcCalls } = fixture(null);
    await resyncInventoryForDo(sb, 'do-016', 'u1');
    const ret = rpcCalls.filter((c) => c.fn === 'fn_return_do_units_at_cost');
    expect(ret).toHaveLength(1);
    expect(ret[0].args).toEqual({
      p_do_id: 'do-016', p_warehouse_id: 'wh-kl', p_product_code: 'CODY-(K)', p_variant_key: VK_SHIPPED,
      p_batch_no: null, p_qty: 1, p_correction_seq: 1, p_performed_by: 'u1',
      p_notes: 'Resync: line qty reduced / line deleted (shipped DO).',
    });
    expect(ret[0].args).not.toHaveProperty('p_item_code');
    // The route writes only the new bucket's OUT. The balancing IN is the
    // function's own, and its lot is closed there: no lot without an origin.
    const rows = written(tables);
    expect(rows.map((m) => [m.movement_type, m.variant_key, m.qty, m.correction_seq])).toEqual([['OUT', VK_EDITED, 1, 1]]);
  });

  test('when the return fails, as it did in production, nothing is written and the failure is audited', async () => {
    const { tables, sb } = fixture({ message: 'Could not find the function scm.fn_return_do_units_at_cost(p_batch_no, p_correction_seq, p_do_id, p_item_code, ...) in the schema cache' });
    await resyncInventoryForDo(sb, 'do-016', 'u1');
    // Before: an IN under the old spec (which minted the PO-less lot) plus the
    // new bucket's OUT. Now neither, so a re-save retries the whole delta.
    expect(written(tables)).toEqual([]);
    const audits = Object.values(tables).flat().filter((r) => r.action === 'RECOUNT_FAILED');
    expect(audits.length).toBe(1);
    expect(String(audits[0].note)).toMatch(/could not be returned to its lots/);
  });
});

describe('resyncInventoryForDo — adding a derived Total Height is the same bucket', () => {
  test('DO-016 replayed: no return, no new OUT', async () => {
    const { tables, sb, rpcCalls } = fixture(null, { ...SHIPPED, totalHeight: '24"' });
    await resyncInventoryForDo(sb, 'do-016', 'u-1');
    expect(rpcCalls.filter((r) => r.fn === 'fn_return_do_units_at_cost')).toEqual([]);
    expect(written(tables)).toEqual([]);
  });

  test('a DO shipped under an old key with the total, edited without it, is not re-booked', async () => {
    const { tables, sb, rpcCalls } = fixture(null, SHIPPED);
    tables.inventory_movements![0]!.variant_key = `${VK_SHIPPED}|totalheight=24"`;
    await resyncInventoryForDo(sb, 'do-016', 'u-1');
    expect(rpcCalls.filter((r) => r.fn === 'fn_return_do_units_at_cost')).toEqual([]);
    expect(written(tables)).toEqual([]);
  });
});
