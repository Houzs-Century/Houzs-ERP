/* Owner decision A (2026-11-10): a company-1 hard-bound DO line is costed from
 * its OWN bound PO's receipt, not from the oldest lot of any PO in the bucket.
 *
 * PR #5614 (run 42832277079) measured 47 of 1,221 bound OUTs costed from another
 * PO's lot. The fix stamps batch_no = bound PO on the OUT (the sofa mechanism);
 * the FIFO trigger then consumes that PO's lot. The trigger is SQL, so this file
 * drives the real deductInventoryForDo / resyncInventoryForDo / recostFromGrn
 * against an in-memory table set whose INSERT on inventory_movements runs the
 * same consume rule as fn_inventory_movement_fifo (0307 + 0195): batch lots
 * first, then plain FIFO for the residual. */
import { describe, expect, test } from 'vitest';
import { deductInventoryForDo, resyncInventoryForDo } from '../src/scm/routes/delivery-orders-mfg';
import { recostFromGrn } from '../src/scm/lib/recost';
import {
  pickHardBoundCostBatches,
  resolveHardBoundCostBatches,
  HARD_BOUND_COST_NOTE,
} from '../src/scm/lib/hard-bound-cost-batch';
import { computeVariantKey } from '../src/scm/shared';

type Row = Record<string, any>;
let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private table: string, private db: Db) {}
  private get rows(): Row[] { return (this.db.tables[this.table] ||= []); }
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
  gt(col: string, val: number) { this.preds.push((r) => Number(r[col]) > val); return this; }
  not(col: string, op: string, val: unknown) {
    if (op === 'is' && val === null) this.preds.push((r) => r[col] !== null && r[col] !== undefined);
    return this;
  }
  order() { return this; } limit() { return this; } range() { return this; }
  gte() { return this; } lt() { return this; } lte() { return this; } like() { return this; } or() { return this; }
  private run(): Row[] {
    this.db.reads.push(this.table);
    if (this.op === 'insert') {
      const out = this.inserted.map((r) => ({ id: nextId(this.table), ...r }));
      for (const r of out) { this.rows.push(r); if (this.table === 'inventory_movements') fifoTrigger(this.db, r); }
      return out;
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

type Db = { tables: Record<string, Row[]>; reads: string[] };

/* fn_inventory_movement_fifo, OUT branch: batch lots first (fn_consume_fifo_batch),
   residual from any lot (0195), oldest first. */
function fifoTrigger(db: Db, m: Row) {
  if (m.movement_type !== 'OUT') return;
  const lots = (db.tables.inventory_lots ||= []);
  const cons = (db.tables.inventory_lot_consumptions ||= []);
  let need = Math.abs(Number(m.qty));
  let cost = 0;
  const take = (filter: (l: Row) => boolean) => {
    for (const l of lots.filter((l) => l.warehouse_id === m.warehouse_id && l.item_code === m.item_code
      && l.variant_key === m.variant_key && l.qty_remaining > 0 && filter(l))
      .sort((a, b) => a.received_at.localeCompare(b.received_at))) {
      if (need <= 0) break;
      const t = Math.min(need, l.qty_remaining);
      l.qty_remaining -= t; need -= t; cost += t * l.unit_cost_sen;
      cons.push({ id: nextId('cons'), lot_id: l.id, movement_id: m.id, qty_consumed: t, unit_cost_sen: l.unit_cost_sen,
        total_cost_sen: t * l.unit_cost_sen, source_doc_type: m.source_doc_type, source_doc_id: m.source_doc_id });
    }
  };
  if (m.batch_no) take((l) => l.batch_no === m.batch_no);
  take(() => true);
  m.total_cost_sen = cost;
  m.unit_cost_sen = Math.floor(cost / Math.abs(Number(m.qty)));
}

const VARIANTS = { fabricCode: 'BF-01', gap: '12"', divanHeight: '8"', legHeight: '4"' };
const VK = computeVariantKey('bedframe', VARIANTS);

/* Two lots of the same bedframe, same warehouse, same spec: the OLDER one was
   bought for another order (PO-A, RM100), the newer one for this order (PO-B,
   RM200). Plain FIFO takes PO-A. */
function fixture(companyId: number, opts: { ownLotWarehouse?: string } = {}) {
  const db: Db = { reads: [], tables: {
    delivery_orders: [{ id: 'do-1', company_id: companyId, do_number: 'DO-1', status: 'LOADED', warehouse_id: 'wh-1', is_dropship: false, migrated_no_stock: false }],
    delivery_order_items: [{ id: 'di-1', delivery_order_id: 'do-1', so_item_id: 'soi-1', item_code: 'CODY-(K)', description: 'CODY King',
      qty: 1, item_group: 'bedframe', variants: VARIANTS, committed_po_batch_no: null, line_total_sen: 50000, ship_cost_sen: null, company_id: companyId }],
    mfg_sales_order_items: [{ id: 'soi-1', allocated_batch_no: null, warehouse_id: 'wh-1', company_id: companyId }],
    purchase_orders: [
      { id: 'po-a', po_number: 'PO-A', status: 'RECEIVED', company_id: companyId },
      { id: 'po-b', po_number: 'PO-B', status: 'RECEIVED', company_id: companyId },
    ],
    purchase_order_items: [
      { id: 'poi-a', purchase_order_id: 'po-a', so_item_id: 'soi-other', item_code: 'CODY-(K)', received_qty: 1, created_at: '2026-09-01' },
      { id: 'poi-b', purchase_order_id: 'po-b', so_item_id: 'soi-1', item_code: 'CODY-(K)', received_qty: 1, created_at: '2026-10-01' },
    ],
    grns: [{ id: 'grn-b', exchange_rate: 1 }],
    grn_items: [{ id: 'gi-b', grn_id: 'grn-b', item_code: 'CODY-(K)', item_group: 'bedframe', variants: VARIANTS,
      unit_price_sen: 20000, qty_accepted: 1, allocated_charge_sen: 0, purchase_order_item_id: 'poi-b' }],
    inventory_lots: [
      { id: 'lot-a', warehouse_id: 'wh-1', item_code: 'CODY-(K)', variant_key: VK, batch_no: 'PO-A', qty_received: 1, qty_remaining: 1,
        unit_cost_sen: 10000, received_at: '2026-09-05T00:00:00Z', source_doc_type: 'GRN', source_doc_id: 'grn-a', movement_id: null, company_id: companyId },
      { id: 'lot-b', warehouse_id: opts.ownLotWarehouse ?? 'wh-1', item_code: 'CODY-(K)', variant_key: VK, batch_no: 'PO-B', qty_received: 1, qty_remaining: 1,
        unit_cost_sen: 20000, received_at: '2026-10-05T00:00:00Z', source_doc_type: 'GRN', source_doc_id: 'grn-b', movement_id: null, company_id: companyId },
    ],
    inventory_movements: [],
  } };
  const sb = { from: (t: string) => new FakeQuery(t, db), rpc: async () => ({ data: null, error: null }) };
  return { db, sb };
}

const outs = (db: Db) => db.tables.inventory_movements.filter((m) => m.source_doc_id === 'do-1' && m.movement_type === 'OUT');
const consumedLots = (db: Db) => (db.tables.inventory_lot_consumptions ?? []).map((c) => c.lot_id);
const doLine = (db: Db) => db.tables.delivery_order_items[0]!;

describe('company 1: a hard-bound line is costed from its own PO', () => {
  test('a bound bedframe line takes its own PO lot, not the older lot of another PO', async () => {
    const { db, sb } = fixture(1);
    expect(await deductInventoryForDo(sb, 'do-1', 'u1')).toEqual([]);
    const [out] = outs(db);
    expect(out!.batch_no).toBe('PO-B');
    expect(out!.notes).toBeUndefined();
    expect(consumedLots(db)).toEqual(['lot-b']);
    expect(doLine(db).unit_cost_sen).toBe(20000);
  });

  test('a PI price posted later re-costs that DO through the bound lot', async () => {
    const { db, sb } = fixture(1);
    await deductInventoryForDo(sb, 'do-1', 'u1');
    db.tables.purchase_invoice_items = [{ grn_item_id: 'gi-b', qty: 1, unit_price_sen: 25000, purchase_invoice_id: 'pi-1', allocated_charge_sen: 0 }];
    db.tables.purchase_invoices = [{ id: 'pi-1', status: 'POSTED', exchange_rate: 1 }];
    await recostFromGrn(sb, 'grn-b');
    expect(outs(db)[0]!.total_cost_sen).toBe(25000);
    // restampDoActualCost keys the line by the batch its OUT carries, so it finds the bucket
    expect(doLine(db).unit_cost_sen).toBe(25000);
    expect(doLine(db).ship_cost_sen).toBe(20000);
  });

  test('no own-PO lot in this warehouse: ships as before on plain FIFO and says why on the OUT', async () => {
    const { db, sb } = fixture(1, { ownLotWarehouse: 'wh-2' });
    expect(await deductInventoryForDo(sb, 'do-1', 'u1')).toEqual([]);
    const [out] = outs(db);
    expect(out!.batch_no).toBeUndefined();
    expect(out!.notes).toBe(`${HARD_BOUND_COST_NOTE} own-po-lot-not-here (PO-B)`);
    expect(consumedLots(db)).toEqual(['lot-a']);
    expect(doLine(db).unit_cost_sen).toBe(10000);
  });

  test('a line edit after the ship keeps the batch the OUT was stamped with', async () => {
    const { db, sb } = fixture(1);
    await deductInventoryForDo(sb, 'do-1', 'u1');
    // a second unit of the own PO arrives, the line goes from 1 to 2
    db.tables.inventory_lots.push({ id: 'lot-b2', warehouse_id: 'wh-1', item_code: 'CODY-(K)', variant_key: VK, batch_no: 'PO-B', qty_received: 1,
      qty_remaining: 1, unit_cost_sen: 21000, received_at: '2026-10-06T00:00:00Z', source_doc_type: 'GRN', source_doc_id: 'grn-b', movement_id: null, company_id: 1 });
    doLine(db).qty = 2;
    await resyncInventoryForDo(sb, 'do-1', 'u1');
    const delta = outs(db).filter((m) => m.correction_seq === 1);
    expect(delta.map((m) => [m.batch_no, m.qty])).toEqual([['PO-B', 1]]);
    expect(consumedLots(db)).toEqual(['lot-b', 'lot-b2']);
  });
});

describe('company 2 (2990) pools exactly as before', () => {
  test('the same order ships on plain FIFO, no batch, no note', async () => {
    const { db, sb } = fixture(2);
    expect(await deductInventoryForDo(sb, 'do-1', 'u1')).toEqual([]);
    const [out] = outs(db);
    const { id: _id, movement_date: _d, total_cost_sen: _t, unit_cost_sen: _u, ...shape } = out!;
    expect(shape).toEqual({
      movement_type: 'OUT', warehouse_id: 'wh-1', item_code: 'CODY-(K)', variant_key: VK, product_name: 'CODY King',
      qty: 1, source_doc_type: 'DO', source_doc_id: 'do-1', source_doc_no: 'DO-1', performed_by: 'u1', company_id: 2,
    });
    expect(consumedLots(db)).toEqual(['lot-a']);
  });

  test('the resolver reads nothing and adds nothing for company 2', async () => {
    const sb = { from: () => { throw new Error('company 2 must not read'); } };
    for (const mode of ['ship', 'resync', 'restamp'] as const) {
      const r = await resolveHardBoundCostBatches(sb, {
        companyId: 2, deliveryOrderId: 'do-1', already: new Map(), mode,
        lines: [{ soItemId: 'soi-1', itemCode: 'CODY-(K)', itemGroup: 'bedframe', variantKey: VK, warehouseId: 'wh-1', qty: 1 }],
      });
      expect(r.batchBySoItem.size).toBe(0);
      expect(r.notes).toEqual([]);
    }
  });
});

describe('pickHardBoundCostBatches', () => {
  const line = { soItemId: 's1', itemCode: 'X', itemGroup: 'bedframe', variantKey: 'v', warehouseId: 'w', qty: 2 };
  const base = { companyId: 1, already: new Map<string, string>(), stamped: null, allowDecide: true,
    boundPos: new Map([['s1', [{ itemCode: 'X', poNumber: 'P1' }]]]), openQty: new Map([['w::X::v::P1', 2]]) };

  test('pooled categories are never bound', () => {
    const r = pickHardBoundCostBatches({ ...base, lines: [{ ...line, itemGroup: 'mattress' }] });
    expect(r.batchBySoItem.size).toBe(0);
    expect(r.notes).toEqual([]);
  });

  test('an (SP) mattress binds like a bedframe', () => {
    const r = pickHardBoundCostBatches({ ...base, lines: [{ ...line, itemGroup: 'mattress', itemCode: 'X (SP)' }],
      boundPos: new Map([['s1', [{ itemCode: 'X (SP)', poNumber: 'P1' }]]]), openQty: new Map([['w::X (SP)::v::P1', 2]]) });
    expect(r.batchBySoItem.get('s1')).toBe('P1');
  });

  test('a sofa / commitment batch already decided wins', () => {
    const r = pickHardBoundCostBatches({ ...base, already: new Map([['s1', 'DYE-7']]), lines: [line] });
    expect(r.batchBySoItem.size).toBe(0);
  });

  test('own lot short: still stamped, and noted', () => {
    const r = pickHardBoundCostBatches({ ...base, openQty: new Map([['w::X::v::P1', 1]]), lines: [line] });
    expect(r.batchBySoItem.get('s1')).toBe('P1');
    expect(r.notes.map((n) => n.reason)).toEqual(['own-po-lot-short']);
  });

  test('no received bound PO: unbatched, noted', () => {
    const r = pickHardBoundCostBatches({ ...base, boundPos: new Map(), lines: [line] });
    expect(r.batchBySoItem.size).toBe(0);
    expect(r.notes.map((n) => n.reason)).toEqual(['no-received-bound-po']);
  });

  test('two lines of one item + spec under different POs stay unbatched (one OUT row per pair)', () => {
    const r = pickHardBoundCostBatches({ ...base,
      lines: [line, { ...line, soItemId: 's2' }],
      boundPos: new Map([['s1', [{ itemCode: 'X', poNumber: 'P1' }]], ['s2', [{ itemCode: 'X', poNumber: 'P2' }]]]),
      openQty: new Map([['w::X::v::P1', 2], ['w::X::v::P2', 2]]) });
    expect(r.batchBySoItem.size).toBe(0);
    expect(r.notes.map((n) => n.reason).sort()).toEqual(['shared-bucket', 'shared-bucket']);
  });

  test('after the ship, the stamped batch is the answer, even null', () => {
    const lines = [line];
    expect(pickHardBoundCostBatches({ ...base, stamped: new Map([['w::X::v', 'P9']]), lines }).batchBySoItem.get('s1')).toBe('P9');
    const r = pickHardBoundCostBatches({ ...base, stamped: new Map([['w::X::v', null]]), lines });
    expect(r.batchBySoItem.size).toBe(0);
    expect(r.notes).toEqual([]);
  });

  test('restamp never decides', () => {
    const r = pickHardBoundCostBatches({ ...base, stamped: new Map(), allowDecide: false, lines: [line] });
    expect(r.batchBySoItem.size).toBe(0);
  });
});
