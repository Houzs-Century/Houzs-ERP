// Symptom: a DO reverted to Draft and shipped again left its goods on the rack
//   (no second STOCK_OUT), and a second revert put nothing back.
// Cause: the rack stock-out guarded on "any dispatch STOCK_OUT for this DO number"
//   and the return on "any 'DO cancelled' STOCK_IN", so the first cycle's rows
//   blocked every later one.
// Fix: once every unit has come back the pair is retired (lib/do-rack-cycle.ts),
//   the same cycle rule the stock ledger follows.
import { describe, expect, test } from 'vitest';
import { makeFakePostgrest, type Row } from './fakePostgrest';
import { stockOutDoLinesFromRacks, returnDoRacksOnCancel } from '../src/scm/routes/delivery-orders-mfg';
import { DO_RACK_OUT_REASON } from '../src/scm/lib/do-shipped-from-stamp';
import { DO_RACK_IN_REASON, DO_RACK_REVERTED_REASON, rackShipState, retireDoRackCycle } from '../src/scm/lib/do-rack-cycle';

const CO = 2;
const DO_NO = '2990-DO-2611-030';
const ITEMS = [{ id: 'l1', item_code: 'CODY-(K)', item_group: 'bedframe', qty: 2, rack_id: null, description: 'Cody' }];
const LINE_WH = new Map<string, string | null>([['l1', 'wh-1']]);

function world(): Record<string, Row[]> {
  return {
    delivery_order_items: [],
    warehouse_racks: [{ id: 'r-1', rack: 'Rack A1', warehouse_id: 'wh-1', company_id: CO, reserved: false, status: 'OCCUPIED' }],
    warehouse_rack_items: [{ id: 'p-1', rack_id: 'r-1', item_code: 'CODY-(K)', qty: 5, stocked_in_date: '2026-11-01', company_id: CO }],
    warehouse_rack_movements: [],
  };
}

const onRack = (db: { tables: Record<string, Row[]> }) =>
  db.tables.warehouse_rack_items.filter((r) => r.rack_id === 'r-1' && r.item_code === 'CODY-(K)').reduce((s, r) => s + Number(r.qty), 0);
const live = (db: { tables: Record<string, Row[]> }, type: string) =>
  db.tables.warehouse_rack_movements.filter((m) => m.movement_type === type && m.reason !== DO_RACK_REVERTED_REASON);

const ship = (db: ReturnType<typeof makeFakePostgrest>) => stockOutDoLinesFromRacks(db, 'do-1', DO_NO, 'u-1', LINE_WH, ITEMS, CO);
const revert = (db: ReturnType<typeof makeFakePostgrest>) => returnDoRacksOnCancel(db, 'do-1', DO_NO, 'u-1', CO, 'revert');

describe('rack ledger across revert and re-ship', () => {
  test('ship, revert, ship, revert: each ship takes the goods off and each revert puts them back', async () => {
    const db = makeFakePostgrest(world(), []);
    await ship(db);
    expect(onRack(db)).toBe(3);
    await revert(db);
    expect(onRack(db)).toBe(5);
    await ship(db);
    expect(onRack(db)).toBe(3);
    expect(live(db, 'STOCK_OUT')).toHaveLength(1);
    await revert(db);
    expect(onRack(db)).toBe(5);
    expect(live(db, 'STOCK_OUT')).toHaveLength(0);
    expect(live(db, 'STOCK_IN')).toHaveLength(0);
    // Every row stays on the ledger under the DO's number.
    expect(db.tables.warehouse_rack_movements.filter((m) => m.source_doc_no === DO_NO)).toHaveLength(4);
  });

  test('a second ship call without a revert is still a no-op', async () => {
    const db = makeFakePostgrest(world(), []);
    await ship(db);
    await ship(db);
    expect(onRack(db)).toBe(3);
  });

  test('a second revert call without a ship is still a no-op', async () => {
    const db = makeFakePostgrest(world(), []);
    await ship(db);
    await revert(db);
    await revert(db);
    expect(onRack(db)).toBe(5);
  });

  test('a DO reverted before this fix (pair not retired) is retired by its re-ship', async () => {
    const t = world();
    t.warehouse_rack_movements.push(
      { company_id: CO, movement_type: 'STOCK_OUT', source_doc_no: DO_NO, reason: DO_RACK_OUT_REASON, item_code: 'CODY-(K)', rack_id: 'r-1', quantity: 2 },
      { company_id: CO, movement_type: 'STOCK_IN', source_doc_no: DO_NO, reason: DO_RACK_IN_REASON, item_code: 'CODY-(K)', rack_id: 'r-1', quantity: 2 },
    );
    const db = makeFakePostgrest(t, []);
    await ship(db);
    expect(onRack(db)).toBe(3);
  });

  test('a cycle with goods still off the rack is not retired', async () => {
    const t = world();
    t.warehouse_rack_movements.push(
      { company_id: CO, movement_type: 'STOCK_OUT', source_doc_no: DO_NO, reason: DO_RACK_OUT_REASON, item_code: 'CODY-(K)', rack_id: 'r-1', quantity: 2 },
      { company_id: CO, movement_type: 'STOCK_IN', source_doc_no: DO_NO, reason: DO_RACK_IN_REASON, item_code: 'CODY-(K)', rack_id: 'r-1', quantity: 1 },
    );
    const db = makeFakePostgrest(t, []);
    expect(await retireDoRackCycle(db, DO_NO, CO)).toMatch(/still off the racks/);
    expect(await rackShipState(db, DO_NO, CO)).toMatch(/still off the racks/);
    await ship(db);
    expect(onRack(db)).toBe(5);
  });

  test("another company's rack rows with the same number are neither read nor re-tagged", async () => {
    const t = world();
    t.warehouse_rack_movements.push(
      { company_id: 1, movement_type: 'STOCK_OUT', source_doc_no: DO_NO, reason: DO_RACK_OUT_REASON, item_code: 'X', rack_id: 'r-9', quantity: 1 },
      { company_id: 1, movement_type: 'STOCK_IN', source_doc_no: DO_NO, reason: DO_RACK_IN_REASON, item_code: 'X', rack_id: 'r-9', quantity: 1 },
    );
    const db = makeFakePostgrest(t, []);
    expect(await rackShipState(db, DO_NO, CO)).toBe('stock_out');
    expect(db.tables.warehouse_rack_movements.filter((m) => m.reason === DO_RACK_REVERTED_REASON)).toHaveLength(0);
  });
});
