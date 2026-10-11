// Tests for atomic inter-warehouse stock transfer (audit finding R3).
//
// Two layers, matching how the fix is split:
//   1. buildTransferPayload — PRODUCTION code (the pure payload the route feeds
//      to the RPC). Tested directly.
//   2. The atomic OUT+IN transaction itself runs in PL/pgSQL
//      (scm.fn_stock_transfer_apply, migration 0192). This repo's vitest harness
//      rebuilds only the D1 side and cannot execute the scm Supabase-Postgres
//      layer (same limitation the oversell/dropship tests note), so the
//      transactional CONTRACT is locked here by a faithful in-memory FIFO model
//      the SQL is written against — driving the exact scenario the task calls
//      out: the IN failing after the OUT, asserting the source stock is restored.
import { describe, expect, test } from 'vitest';
import { buildTransferPayload, type TransferLinePayload } from './stock-transfer-atomic';

// ── 1. buildTransferPayload (production) ────────────────────────────────────
describe('buildTransferPayload', () => {
  const line = (o: Partial<{ product_code: string; product_name: string | null; variant_key: string | null; qty: number }> & { product_code: string; qty: number }) => ({
    product_name: null,
    variant_key: null,
    ...o,
  });

  test('drops qty <= 0 lines and floors fractional qty', () => {
    const out = buildTransferPayload(
      [line({ product_code: 'A', qty: 0 }), line({ product_code: 'B', qty: -3 }), line({ product_code: 'C', qty: 2.9 })],
      new Map(),
    );
    expect(out.map((l) => l.product_code)).toEqual(['C']);
    expect(out[0]!.qty).toBe(2);
  });

  test('normalises variant_key null -> "" (the FIFO bucket key)', () => {
    const [row] = buildTransferPayload([line({ product_code: 'A', qty: 1 })], new Map());
    expect(row!.variant_key).toBe('');
  });

  test('carries the resolved batch only for the matching code::variant bucket', () => {
    const batches = new Map<string, string | null>([
      ['A::red', 'PO-1001'], // single batch -> carried
      ['B::', null],         // ambiguous/plain -> not carried
    ]);
    const out = buildTransferPayload(
      [line({ product_code: 'A', variant_key: 'red', qty: 1 }), line({ product_code: 'B', qty: 1 })],
      batches,
    );
    expect(out.find((l) => l.product_code === 'A')!.batch_no).toBe('PO-1001');
    expect(out.find((l) => l.product_code === 'B')!.batch_no).toBeNull();
  });
});

// ── 2. Atomic OUT+IN contract (mirror of scm.fn_stock_transfer_apply) ────────
//
// A minimal FIFO store standing in for inventory_lots + the AFTER-INSERT trigger:
//   OUT  -> consume the source bucket's lots FIFO (oldest first), returning the
//           consumed total cost (what the trigger stamps on the OUT movement).
//   IN   -> open a dest lot at unit = round(consumedTotal / qty) (the carried
//           FIFO basis), exactly what the DB function reads back and applies.
// The DB function wraps every line in ONE transaction; the model mirrors that by
// snapshotting and restoring on any throw. This is the contract the SQL ports.
type Lot = { warehouse_id: string; product_code: string; variant_key: string; qty_remaining: number; unit_cost_sen: number; received_at: number };

function consumeFifo(lots: Lot[], wh: string, code: string, variant: string, qty: number): number {
  let remaining = qty;
  let total = 0;
  for (const lot of lots.filter((l) => l.warehouse_id === wh && l.product_code === code && l.variant_key === variant && l.qty_remaining > 0).sort((a, b) => a.received_at - b.received_at)) {
    if (remaining <= 0) break;
    const take = Math.min(lot.qty_remaining, remaining);
    lot.qty_remaining -= take;
    total += take * lot.unit_cost_sen;
    remaining -= take;
  }
  return total;
}

/** Faithful mirror of fn_stock_transfer_apply: all lines' OUT+IN, atomic. If
 *  `failInOnLineIndex` is set, the IN for that line throws AFTER its OUT has
 *  consumed the source — the exact non-atomic window the fix closes. */
function applyStockTransfer(
  lots: Lot[],
  fromWh: string,
  toWh: string,
  lines: TransferLinePayload[],
  opts: { failInOnLineIndex?: number } = {},
): { lots: Lot[]; moved: number } {
  const snapshot: Lot[] = lots.map((l) => ({ ...l }));
  const working: Lot[] = lots.map((l) => ({ ...l }));
  let moved = 0;
  try {
    lines.forEach((ln, i) => {
      if (ln.qty <= 0) return;
      const consumedTotal = consumeFifo(working, fromWh, ln.product_code, ln.variant_key, ln.qty);
      const inUnit = ln.qty > 0 ? Math.round(consumedTotal / ln.qty) : 0;
      if (opts.failInOnLineIndex === i) throw new Error('simulated IN failure after OUT committed');
      working.push({ warehouse_id: toWh, product_code: ln.product_code, variant_key: ln.variant_key, qty_remaining: ln.qty, unit_cost_sen: inUnit, received_at: 9_999 });
      moved += 1;
    });
    return { lots: working, moved };
  } catch (e) {
    // Postgres rolls the whole call back; the model restores the pre-call snapshot.
    return { lots: snapshot, moved: 0 };
  }
}

const onHand = (lots: Lot[], wh: string, code: string, variant = '') =>
  lots.filter((l) => l.warehouse_id === wh && l.product_code === code && l.variant_key === variant).reduce((s, l) => s + l.qty_remaining, 0);
const lotValue = (lots: Lot[], wh: string, code: string, variant = '') =>
  lots.filter((l) => l.warehouse_id === wh && l.product_code === code && l.variant_key === variant).reduce((s, l) => s + l.qty_remaining * l.unit_cost_sen, 0);

describe('atomic stock transfer — the fn_stock_transfer_apply contract', () => {
  const seed = (): Lot[] => [
    { warehouse_id: 'A', product_code: 'SKU1', variant_key: '', qty_remaining: 6, unit_cost_sen: 500, received_at: 1 },
    { warehouse_id: 'A', product_code: 'SKU1', variant_key: '', qty_remaining: 4, unit_cost_sen: 700, received_at: 2 },
  ];
  const pl = (o: Partial<TransferLinePayload> & { product_code: string; qty: number }): TransferLinePayload =>
    ({ product_name: null, variant_key: '', batch_no: null, ...o });

  test('happy path: source decremented, dest opened, FIFO cost carried over', () => {
    const { lots, moved } = applyStockTransfer(seed(), 'A', 'B', [pl({ product_code: 'SKU1', qty: 8 })]);
    expect(moved).toBe(1);
    // 8 units consumed FIFO: 6@500 + 2@700 = 4400 sen -> IN unit = round(4400/8) = 550.
    expect(onHand(lots, 'A', 'SKU1')).toBe(2);   // source: 10 - 8
    expect(onHand(lots, 'B', 'SKU1')).toBe(8);   // dest: +8
    expect(lotValue(lots, 'B', 'SKU1')).toBe(8 * 550); // cost carried, not invented/lost
  });

  test('IN fails after OUT: WHOLE transfer rolls back, source stock restored', () => {
    const before = seed();
    const { lots, moved } = applyStockTransfer(before, 'A', 'B', [pl({ product_code: 'SKU1', qty: 8 })], { failInOnLineIndex: 0 });
    expect(moved).toBe(0);
    expect(onHand(lots, 'A', 'SKU1')).toBe(10);  // source fully restored (not 2)
    expect(onHand(lots, 'B', 'SKU1')).toBe(0);   // nothing created at dest
    expect(lotValue(lots, 'A', 'SKU1')).toBe(6 * 500 + 4 * 700); // cost basis intact
  });

  test('multi-line: a later line failing leaves EARLIER lines un-moved too (all-or-nothing)', () => {
    const before: Lot[] = [
      { warehouse_id: 'A', product_code: 'SKU1', variant_key: '', qty_remaining: 5, unit_cost_sen: 500, received_at: 1 },
      { warehouse_id: 'A', product_code: 'SKU2', variant_key: '', qty_remaining: 5, unit_cost_sen: 900, received_at: 1 },
    ];
    const { lots, moved } = applyStockTransfer(
      before, 'A', 'B',
      [pl({ product_code: 'SKU1', qty: 3 }), pl({ product_code: 'SKU2', qty: 2 })],
      { failInOnLineIndex: 1 }, // second line's IN fails
    );
    expect(moved).toBe(0);
    expect(onHand(lots, 'A', 'SKU1')).toBe(5);   // first line NOT left half-moved
    expect(onHand(lots, 'B', 'SKU1')).toBe(0);
    expect(onHand(lots, 'A', 'SKU2')).toBe(5);
  });
});
