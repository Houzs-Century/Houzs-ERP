// Owner rule 2026-11-10 ("要确保知道拿的是什么PO，不会之后又乱乱给了，lock了之后
// rack number 也是"): the first ship stamps each goods line with the PO(s) of the
// lots it consumed and the rack(s) it left; nothing re-assigns them later. Runs
// the real stamp writer against a PostgREST-shaped fake that applies filters.
import { describe, expect, test } from 'vitest';
import { makeFakePostgrest, type Row } from './fakePostgrest';
import { computeVariantKey } from '../src/scm/shared';
import {
  stampDoShippedFrom, markDoShippedFromReturned, withShippedFromStamp,
} from '../src/scm/lib/do-shipped-from-stamp';

const VK = computeVariantKey('bedframe', null);
const DO_NO = '2990-DO-2611-016';

function world(companyId = 2): Record<string, Row[]> {
  return {
    delivery_orders: [{ id: 'do-1', do_number: DO_NO, company_id: companyId }],
    delivery_order_items: [
      { id: 'l1', delivery_order_id: 'do-1', company_id: companyId, line_no: 1, item_code: 'CODY-(K)', item_group: 'bedframe', variants: null, qty: 1, rack_id: null, so_item_id: null, committed_po_batch_no: null, shipped_from: null },
      { id: 'l2', delivery_order_id: 'do-1', company_id: companyId, line_no: 2, item_code: 'JAGER-(Q)', item_group: 'bedframe', variants: null, qty: 3, rack_id: null, so_item_id: null, committed_po_batch_no: null, shipped_from: null },
      { id: 'l3', delivery_order_id: 'do-1', company_id: companyId, line_no: 3, item_code: 'DELIVERY FEE', item_group: 'service', variants: null, qty: 1, rack_id: null, so_item_id: null, committed_po_batch_no: null, shipped_from: null },
    ],
    inventory_lot_consumptions: [
      { company_id: companyId, source_doc_type: 'DO', source_doc_id: 'do-1', lot_id: 'lot-a', item_code: 'CODY-(K)', variant_key: VK, qty_consumed: 1 },
      { company_id: companyId, source_doc_type: 'DO', source_doc_id: 'do-1', lot_id: 'lot-b', item_code: 'JAGER-(Q)', variant_key: VK, qty_consumed: 2 },
      { company_id: companyId, source_doc_type: 'DO', source_doc_id: 'do-1', lot_id: 'lot-c', item_code: 'JAGER-(Q)', variant_key: VK, qty_consumed: 1 },
    ],
    inventory_lots: [
      { id: 'lot-a', batch_no: '2990-PO-2610-044', source_doc_type: 'GRN', source_doc_id: 'grn-1' },
      { id: 'lot-b', batch_no: '2990-PO-2610-050', source_doc_type: 'GRN', source_doc_id: 'grn-2' },
      { id: 'lot-c', batch_no: null, source_doc_type: 'GRN', source_doc_id: 'grn-3' },
    ],
    grns: [{ id: 'grn-3', purchase_order_id: 'po-3' }],
    purchase_orders: [{ id: 'po-3', po_number: '2990-PO-2610-061', status: 'RECEIVED' }],
    purchase_order_items: [],
    inventory_movements: [],
    warehouse_rack_movements: [
      { company_id: companyId, movement_type: 'STOCK_OUT', source_doc_no: DO_NO, reason: 'Delivery order dispatch', item_code: 'CODY-(K)', rack_id: 'r-l82', rack_label: 'Rack L8.2', quantity: 1 },
      { company_id: companyId, movement_type: 'STOCK_OUT', source_doc_no: DO_NO, reason: 'Delivery order dispatch', item_code: 'JAGER-(Q)', rack_id: 'r-l41', rack_label: 'Rack L4.1', quantity: 2 },
      { company_id: companyId, movement_type: 'STOCK_OUT', source_doc_no: DO_NO, reason: 'Delivery order dispatch', item_code: 'JAGER-(Q)', rack_id: 'r-l51', rack_label: 'Rack L5.1', quantity: 1 },
    ],
  };
}

const line = (db: { tables: Record<string, Row[]> }, id: string) =>
  db.tables.delivery_order_items.find((r) => r.id === id) as Row & { shipped_from: Record<string, unknown> | null };

describe('stamp at the first ship', () => {
  test('single PO / rack and multi PO / rack lines are locked; the service line is not', async () => {
    const db = makeFakePostgrest(world(), []);
    expect(await stampDoShippedFrom(db, 'do-1', 2)).toBe(2);
    expect(line(db, 'l1').shipped_from).toMatchObject({
      v: 1, src: 'ship', item_code: 'CODY-(K)', qty: 1,
      pos: [{ po: '2990-PO-2610-044', qty: 1 }],
      racks: [{ rack_id: 'r-l82', label: 'Rack L8.2', qty: 1 }],
    });
    expect(line(db, 'l2').shipped_from).toMatchObject({
      pos: [{ po: '2990-PO-2610-050', qty: 2 }, { po: '2990-PO-2610-061', qty: 1 }],
      racks: [{ rack_id: 'r-l41', label: 'Rack L4.1', qty: 2 }, { rack_id: 'r-l51', label: 'Rack L5.1', qty: 1 }],
    });
    expect(line(db, 'l3').shipped_from).toBeNull();
  });

  test('a second ship call writes nothing, even after the ledger was relabelled', async () => {
    const db = makeFakePostgrest(world(), []);
    await stampDoShippedFrom(db, 'do-1', 2);
    const before = JSON.stringify(line(db, 'l2').shipped_from);
    db.tables.inventory_lots.find((l) => l.id === 'lot-b')!.batch_no = 'PO-RELABELLED';
    db.tables.warehouse_rack_movements[1].rack_label = 'Rack Z9.9';
    expect(await stampDoShippedFrom(db, 'do-1', 2)).toBe(0);
    expect(JSON.stringify(line(db, 'l2').shipped_from)).toBe(before);
  });

  test('another company\'s rack rows never reach the stamp', async () => {
    const t = world();
    t.warehouse_rack_movements.forEach((r) => { r.company_id = 1; });
    const db = makeFakePostgrest(t, []);
    await stampDoShippedFrom(db, 'do-1', 2);
    expect(line(db, 'l1').shipped_from).toMatchObject({ racks: [] });
  });

  test('company 1 hard-bound line locks its own received PO, as the screen named it (BUG-103)', async () => {
    const t = world(1);
    t.delivery_order_items[1].so_item_id = 'soi-1';
    t.purchase_order_items = [{ so_item_id: 'soi-1', item_code: 'JAGER-(Q)', purchase_order_id: 'po-bound', received_qty: 3 }];
    t.purchase_orders.push({ id: 'po-bound', po_number: 'HC-PO-009812', status: 'RECEIVED' });
    const db = makeFakePostgrest(t, []);
    await stampDoShippedFrom(db, 'do-1', 1);
    expect(line(db, 'l2').shipped_from).toMatchObject({ pos: [{ po: 'HC-PO-009812', qty: 3 }] });
  });
});

describe('reversal keeps the history coherent', () => {
  test('a revert notes the return once; the re-ship closes it and re-stamps nothing', async () => {
    const db = makeFakePostgrest(world(), []);
    await stampDoShippedFrom(db, 'do-1', 2);
    const pos = JSON.stringify(line(db, 'l1').shipped_from!.pos);
    await markDoShippedFromReturned(db, 'do-1', 2, 'revert');
    await markDoShippedFromReturned(db, 'do-1', 2, 'revert');
    expect((line(db, 'l1').shipped_from!.returns as unknown[]).length).toBe(1);
    db.tables.inventory_lots.find((l) => l.id === 'lot-a')!.batch_no = 'PO-AFTER-RESHIP';
    await stampDoShippedFrom(db, 'do-1', 2);
    const s = line(db, 'l1').shipped_from!;
    expect(JSON.stringify(s.pos)).toBe(pos);
    expect((s.returns as Array<{ why: string; reshipped_at?: string }>)[0]).toMatchObject({ why: 'revert' });
    expect((s.returns as Array<{ reshipped_at?: string }>)[0].reshipped_at).toBeTruthy();
  });
});

describe('readers prefer the stamp and mark the fallback', () => {
  test('locked line shows its stamp; an unstamped goods line keeps the worked-out answer and says so', () => {
    const stamp = { v: 1, at: 't', src: 'ship', item_code: 'CODY-(K)', qty: 1, pos: [{ po: 'PO-LOCKED', qty: 1 }], adj_qty: 0, racks: [{ rack_id: 'r', label: 'Rack L8.2', qty: 1 }] };
    const out = withShippedFromStamp([
      { item_code: 'CODY-(K)', item_group: 'bedframe', shipped_from: stamp, source_pos: ['PO-WORKED-OUT'], racks: ['L1.1'], source_adj: true },
      { item_code: 'JAGER-(Q)', item_group: 'bedframe', shipped_from: null, source_pos: ['PO-WALK'], racks: [] },
      { item_code: 'DELIVERY FEE', item_group: 'service', shipped_from: null, source_pos: [] },
    ]);
    expect(out[0]).toMatchObject({ source_pos: ['PO-LOCKED'], racks: ['Rack L8.2'], source_adj: false, source_state: 'locked' });
    expect(out[1]).toMatchObject({ source_pos: ['PO-WALK'], source_state: 'worked_out' });
    expect(out[2].source_state).toBeNull();
  });
});
