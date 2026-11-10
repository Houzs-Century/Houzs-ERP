// Owner rule 2026-11-10 ("要确保知道拿的是什么PO，不会之后又乱乱给了，lock了之后
// rack number 也是"): the first ship stamps each goods line with the PO(s) of the
// lots it consumed and the rack(s) it left; nothing re-assigns them later. Runs
// the real stamp writer against a PostgREST-shaped fake that applies filters.
import { describe, expect, test } from 'vitest';
import { makeFakePostgrest, type Row } from './fakePostgrest';
import { listDosWithOpenLines, retryOpenDoStamps, rotateWindow } from '../src/scm/lib/do-shipped-from-retry';
import { computeVariantKey } from '../src/scm/shared';
import { withAfterResponse } from '../src/lib/after-response';
import {
  queueDoShippedFromStamp, stampDoShippedFrom, markDoShippedFromReturned, withShippedFromStamp,
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

  test('another company\'s rack rows never reach the stamp (no rack of its own: the line stays open)', async () => {
    const t = world();
    t.warehouse_rack_movements.forEach((r) => { r.company_id = 1; });
    const db = makeFakePostgrest(t, []);
    await stampDoShippedFrom(db, 'do-1', 2);
    expect(line(db, 'l1').shipped_from).toBeNull();
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

describe('no dispatch rack: the rack comes from PO -> GRN -> GRN line rack (owner rule 2026-11-10)', () => {
  /* An older DO: lots consumed, but no 'Delivery order dispatch' STOCK_OUT rows. */
  function oldDo(grnCompany = 2): Record<string, Row[]> {
    const t = world();
    t.delivery_orders[0].warehouse_id = 'wh-kl';
    t.warehouse_rack_movements = [];
    t.purchase_orders.push({ id: 'po-44', po_number: '2990-PO-2610-044', company_id: grnCompany });
    t.purchase_order_items.push({ id: 'poi-44', purchase_order_id: 'po-44', company_id: grnCompany, item_code: 'CODY-(K)' });
    t.grns.push({ id: 'grn-44', grn_number: 'GRN-0101', warehouse_id: 'wh-kl', status: 'POSTED', received_at: '2026-10-20', purchase_order_id: 'po-44', company_id: grnCompany });
    t.grn_items = [{ id: 'gi-44', grn_id: 'grn-44', purchase_order_item_id: 'poi-44', item_code: 'CODY-(K)', item_group: 'bedframe', variants: null, rack_id: 'r-l82', qty_accepted: 2, company_id: grnCompany }];
    t.grn_item_racks = [];
    t.warehouse_racks = [{ id: 'r-l82', rack: 'Rack L8.2', warehouse_id: 'wh-kl' }, { id: 'r-l83', rack: 'Rack L8.3', warehouse_id: 'wh-kl' }];
    t.mfg_sales_order_items = [];
    t.warehouses = [];
    return t;
  }

  test("the line locks the rack its PO's GRN recorded, marked via grn", async () => {
    const db = makeFakePostgrest(oldDo(), []);
    await stampDoShippedFrom(db, 'do-1', 2);
    expect(line(db, 'l1').shipped_from).toMatchObject({
      pos: [{ po: '2990-PO-2610-044', qty: 1 }],
      racks: [{ rack_id: 'r-l82', label: 'Rack L8.2', qty: 1, via: 'grn', po: '2990-PO-2610-044', grn: 'GRN-0101' }],
    });
    expect(line(db, 'l2').shipped_from).toBeNull(); // its POs have no GRN rack: left open
  });

  test('a split GRN line reads grn_item_racks, not the single rack_id', async () => {
    const t = oldDo();
    t.delivery_order_items[0].qty = 2;
    t.inventory_lot_consumptions[0].qty_consumed = 2;
    t.grn_items[0].rack_id = null;
    t.grn_item_racks = [
      { grn_item_id: 'gi-44', rack_id: 'r-l82', qty: 1, company_id: 2 },
      { grn_item_id: 'gi-44', rack_id: 'r-l83', qty: 1, company_id: 2 },
    ];
    const db = makeFakePostgrest(t, []);
    await stampDoShippedFrom(db, 'do-1', 2);
    const racks = (line(db, 'l1').shipped_from!.racks as Array<{ label: string; qty: number; via: string }>);
    expect(racks.map((r) => [r.label, r.qty, r.via])).toEqual([['Rack L8.2', 1, 'grn'], ['Rack L8.3', 1, 'grn']]);
  });

  test("another company's GRN never reaches the stamp (no rack: left open)", async () => {
    const db = makeFakePostgrest(oldDo(1), []);
    await stampDoShippedFrom(db, 'do-1', 2);
    expect(line(db, 'l1').shipped_from).toBeNull();
  });

  test('a DRAFT GRN placed nothing, so it names no rack and the line stays open', async () => {
    const t = oldDo();
    t.grns[t.grns.length - 1].status = 'DRAFT';
    const db = makeFakePostgrest(t, []);
    await stampDoShippedFrom(db, 'do-1', 2);
    expect(line(db, 'l1').shipped_from).toBeNull();
  });

  /* Owner decision 2026-11-10: an incomplete line is left open and retried every
     night; it locks once its GRN gets a rack. */
  const NOW = new Date('2026-11-10T16:05:00.000Z');
  const REL = [{ child: 'delivery_order_items', childCol: 'delivery_order_id', parent: 'delivery_orders', parentCol: 'id' }];
  function nightly(): Record<string, Row[]> {
    const t = oldDo();
    Object.assign(t.delivery_orders[0], { status: 'LOADED', created_at: '2026-11-02T03:00:00.000Z', migrated_no_stock: false });
    t.grn_items[0].rack_id = null; // GRN posted before anyone put it on a rack
    const locked = { v: 1, at: 't0', src: 'ship', item_code: 'AKKA', qty: 1, pos: [{ po: 'PO-OLD', qty: 1 }], adj_qty: 0, racks: [{ rack_id: 'r-x', label: 'Rack X', qty: 1, via: 'dispatch' }] };
    t.delivery_order_items.push({ id: 'l4', delivery_order_id: 'do-1', company_id: 2, line_no: 4, item_code: 'AKKA', item_group: 'bedframe', variants: null, qty: 1, rack_id: null, so_item_id: null, committed_po_batch_no: null, shipped_from: locked });
    const other = (id: string, extra: Row, companyId = 2) => {
      t.delivery_orders.push({ id, do_number: id, company_id: companyId, status: 'LOADED', created_at: '2026-11-01T00:00:00.000Z', migrated_no_stock: false, ...extra });
      t.delivery_order_items.push({ id: `${id}-l1`, delivery_order_id: id, company_id: companyId, line_no: 1, item_code: 'CODY-(K)', item_group: 'bedframe', variants: null, qty: 1, rack_id: null, so_item_id: null, shipped_from: null });
    };
    other('do-old', { created_at: '2026-04-01T00:00:00.000Z' });
    other('do-draft', { status: 'DRAFT' });
    other('do-cancelled', { status: 'CANCELLED' });
    other('do-migrated', { migrated_no_stock: true });
    other('do-c1', {}, 1);
    return t;
  }

  test('the GRN fallback adds a fixed set of reads, still one per table per DO', async () => {
    const db = makeFakePostgrest(oldDo(), []);
    await stampDoShippedFrom(db, 'do-1', 2);
    expect(db.totalReads()).toBe(21);
  });

  test('the nightly pass picks only confirmed, live, recent DOs of the company with an open goods line', async () => {
    const db = makeFakePostgrest(nightly(), REL);
    expect(await listDosWithOpenLines(db, 2, '2026-05-14T16:05:00.000Z')).toEqual(['do-1']);
    expect(await listDosWithOpenLines(db, 1, '2026-05-14T16:05:00.000Z')).toEqual(['do-c1']);
  });

  test('the nightly pass locks a line once its GRN rack appears, and never touches a stamped line', async () => {
    const db = makeFakePostgrest(nightly(), REL);
    const before = JSON.stringify(line(db, 'l4').shipped_from);

    expect(await retryOpenDoStamps(db, [2], NOW)).toEqual([{ companyId: 2, open_dos: 1, tried: 1, written: 0, error: null }]);
    expect(line(db, 'l1').shipped_from).toBeNull(); // PO known, no rack yet: still open

    db.tables.grn_items[0].rack_id = 'r-l82'; // the GRN line gets its rack
    expect(await retryOpenDoStamps(db, [2], NOW)).toEqual([{ companyId: 2, open_dos: 1, tried: 1, written: 1, error: null }]);
    expect(line(db, 'l1').shipped_from).toMatchObject({
      pos: [{ po: '2990-PO-2610-044', qty: 1 }],
      racks: [{ rack_id: 'r-l82', label: 'Rack L8.2', qty: 1, via: 'grn', grn: 'GRN-0101' }],
    });
    expect(line(db, 'l2').shipped_from).toBeNull();
    expect(JSON.stringify(line(db, 'l4').shipped_from)).toBe(before);

    const locked = JSON.stringify(line(db, 'l1').shipped_from);
    db.tables.grn_items[0].rack_id = 'r-l83';
    await retryOpenDoStamps(db, [2], NOW); // idempotent: a locked line stays as it was
    expect(JSON.stringify(line(db, 'l1').shipped_from)).toBe(locked);
  });
});

describe('only a complete line is locked at the ship (owner decision 2026-11-10)', () => {
  test('a rack but no PO: the line stays open', async () => {
    const t = world();
    t.inventory_lot_consumptions = t.inventory_lot_consumptions.filter((c) => c.item_code !== 'CODY-(K)');
    const db = makeFakePostgrest(t, []);
    await stampDoShippedFrom(db, 'do-1', 2);
    expect(line(db, 'l1').shipped_from).toBeNull();
    expect(line(db, 'l2').shipped_from).not.toBeNull();
  });

  test('a rack for 2 of 3: the line stays open, nothing partial is written', async () => {
    const t = world();
    t.warehouse_rack_movements = t.warehouse_rack_movements.filter((r) => r.rack_id !== 'r-l51');
    const db = makeFakePostgrest(t, []);
    await stampDoShippedFrom(db, 'do-1', 2);
    expect(line(db, 'l2').shipped_from).toBeNull();
    expect(line(db, 'l1').shipped_from).not.toBeNull();
  });
});

describe('the request path never waits for the stamp', () => {
  test('inside a request the stamp is handed to waitUntil and the caller returns first', async () => {
    const db = makeFakePostgrest(world(), []);
    const deferred: Array<Promise<unknown>> = [];
    await withAfterResponse((p) => { deferred.push(p); }, () => queueDoShippedFromStamp(db, 'do-1', 2));
    expect(deferred).toHaveLength(1);
    expect(line(db, 'l1').shipped_from).toBeNull(); // not yet: the response went first
    await Promise.all(deferred);
    expect(line(db, 'l1').shipped_from).not.toBeNull();
  });

  test('outside a request (cron, scripts) it runs inline', async () => {
    const db = makeFakePostgrest(world(), []);
    await queueDoShippedFromStamp(db, 'do-1', 2);
    expect(line(db, 'l1').shipped_from).not.toBeNull();
  });

  test('reads are one query per table per DO, not per line', async () => {
    const reads = async (t: Record<string, Row[]>) => {
      const db = makeFakePostgrest(t, []);
      await stampDoShippedFrom(db, 'do-1', 2);
      return { total: db.totalReads(), perTable: Math.max(...db.reads.values()) };
    };
    const small = await reads(world());
    const big = world();
    for (let i = 4; i < 24; i += 1) big.delivery_order_items.push({ ...big.delivery_order_items[1], id: `x${i}`, line_no: i, shipped_from: null });
    expect((await reads(big)).total).toBe(small.total);
    expect(small.total).toBe(14);
  });
});

describe('rotateWindow', () => {
  test('a short list is tried whole; a long one moves on each night and wraps', () => {
    expect(rotateWindow([1, 2, 3], 5, 7)).toEqual([1, 2, 3]);
    expect(rotateWindow([1, 2, 3, 4, 5], 2, 0)).toEqual([1, 2]);
    expect(rotateWindow([1, 2, 3, 4, 5], 2, 1)).toEqual([3, 4]);
    expect(rotateWindow([1, 2, 3, 4, 5], 2, 2)).toEqual([5, 1]);
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
