import { describe, expect, test } from 'vitest';
import {
  applyCommittedSupply,
  commitmentKey,
  outstandingCommitments,
  planShipCommitments,
  type CommittedShipmentRow,
  type PoSupplyEntry,
  type ShipLineFact,
} from './ship-commitment';

/* The decision table the owner described, made executable. Every row here is a
   sentence he said or a hole the 2026-07-30/31 prod measurement found. */

const line = (over: Partial<ShipLineFact> = {}): ShipLineFact => ({
  lineRef: 'L1',
  soItemId: 'so-1',
  itemCode: 'BOOQIT-2A',
  variantKey: 'BF-01|24|6',
  warehouseId: 'wh-kl',
  isSofa: false,
  allocatedBatchNo: null,
  expectedBatchNo: null,
  availableQty: 0,
  shipQty: 1,
  ...over,
});

const only = (l: ShipLineFact) => planShipCommitments([l])[0]!;

describe('planShipCommitments — binding follows the fact, not the dialog', () => {
  test('line with a bound PO and nothing on hand -> BOUND to that PO batch', () => {
    const d = only(line({ expectedBatchNo: '2990-PO-2607-009' }));
    expect(d.bind).toBe(true);
    expect(d.batchNo).toBe('2990-PO-2607-009');
    expect(d.reason).toBe('short_before_arrival');
  });

  test('line without a PO -> plain oversell, NO binding', () => {
    // The 3 stranded prod OUTs (2990-DO-2607-009 / -017) are exactly this shape.
    const d = only(line({ expectedBatchNo: null }));
    expect(d.bind).toBe(false);
    expect(d.batchNo).toBeNull();
    expect(d.reason).toBe('no_po');
  });

  test('sofa with no received batch but one bound PO -> BOUND (the drop-ship case)', () => {
    const d = only(line({ isSofa: true, expectedBatchNo: 'PO-1', availableQty: 5 }));
    // availableQty is irrelevant for a sofa: its OUT is batch-scoped, so pooled
    // stock of another dye lot must never be consumed for it.
    expect(d).toMatchObject({ bind: true, batchNo: 'PO-1', reason: 'sofa_before_arrival' });
  });

  test('the allocator already locked a RECEIVED batch -> normal ship, no commitment', () => {
    const d = only(line({ allocatedBatchNo: 'PO-0', expectedBatchNo: 'PO-1', isSofa: true }));
    expect(d).toMatchObject({ bind: false, reason: 'allocated_batch' });
  });

  test('non-sofa with SOME stock on hand -> not bound (a batch stamp would un-cost the on-hand units)', () => {
    const d = only(line({ expectedBatchNo: 'PO-1', availableQty: 2, shipQty: 3 }));
    expect(d).toMatchObject({ bind: false, reason: 'stock_on_hand' });
  });

  test('ad-hoc line with no SO link -> nothing to resolve a PO from', () => {
    const d = only(line({ soItemId: null, expectedBatchNo: 'PO-1' }));
    expect(d).toMatchObject({ bind: false, reason: 'no_so_link' });
  });

  test('zero-qty line binds nothing', () => {
    expect(only(line({ expectedBatchNo: 'PO-1', shipQty: 0 }))).toMatchObject({
      bind: false, reason: 'no_qty',
    });
  });

  test('ambiguous PO (resolver returned null for >1 live PO) binds nothing', () => {
    // resolveExpectedBatchBySoItem in 'block' mode yields poNumber null on multi-PO
    // (audit H3) — a guessed dye lot is worse than no binding.
    expect(only(line({ isSofa: true, expectedBatchNo: null }))).toMatchObject({
      bind: false, reason: 'no_po',
    });
  });

  test('MIXED DO — the resolvable lines bind, the others do not, and neither blocks the other', () => {
    const out = planShipCommitments([
      line({ lineRef: 'a', soItemId: 'so-a', itemCode: 'TRION-(K)', expectedBatchNo: 'PO-A' }),
      line({ lineRef: 'b', soItemId: 'so-b', itemCode: 'KETTA-(K)', expectedBatchNo: null }),
      line({ lineRef: 'c', soItemId: 'so-c', itemCode: 'BOOQIT-2A', isSofa: true, expectedBatchNo: 'PO-C' }),
    ]);
    expect(out.map((d) => [d.lineRef, d.bind, d.batchNo])).toEqual([
      ['a', true, 'PO-A'],
      ['b', false, null],
      ['c', true, 'PO-C'],
    ]);
  });
});

/* ── the MRP half ─────────────────────────────────────────────────────────── */

const K = 'wh-kl|TRION-(K)|';

const mov = (over: Partial<CommittedShipmentRow> = {}): CommittedShipmentRow => ({
  bucketKey: K,
  batchNo: 'PO-A',
  outQty: 1,
  consumedQty: 0,
  cancelled: false,
  headerDropship: false,
  lineCommitted: true,
  ...over,
});

describe('outstandingCommitments — the same "still short" test the SQL reconcile uses', () => {
  test('a line-committed, unconsumed OUT is a commitment', () => {
    expect(outstandingCommitments([mov()])).toEqual(new Map([[commitmentKey(K, 'PO-A'), 1]]));
  });

  test('the legacy is_dropship header flag still counts', () => {
    expect(outstandingCommitments([mov({ lineCommitted: false, headerDropship: true })]).size).toBe(1);
  });

  test('an OUT the reconcile can never claim is NOT a commitment', () => {
    // Neither signal: an accidental short-ship (the concurrent-DO race 0088
    // hardened against). Nothing will hand these units over, so deducting them
    // from MRP would take away supply that stays free.
    expect(outstandingCommitments([mov({ lineCommitted: false, headerDropship: false })]).size).toBe(0);
  });

  test('a CANCELLED DO holds no commitment', () => {
    expect(outstandingCommitments([mov({ cancelled: true })]).size).toBe(0);
  });

  test('once the reconcile consumes it, the commitment disappears by itself', () => {
    expect(outstandingCommitments([mov({ outQty: 2, consumedQty: 2 })]).size).toBe(0);
    expect(outstandingCommitments([mov({ outQty: 2, consumedQty: 1 })]))
      .toEqual(new Map([[commitmentKey(K, 'PO-A'), 1]]));
  });

  test('two shipments against one batch add up', () => {
    expect(outstandingCommitments([mov(), mov({ outQty: 3 })]))
      .toEqual(new Map([[commitmentKey(K, 'PO-A'), 4]]));
  });
});

const po = (over: Partial<PoSupplyEntry> = {}): PoSupplyEntry => ({
  bucketKey: K, poNumber: 'PO-A', eta: '2026-08-10', qtyLeft: 3, supplierId: 's1', ...over,
});

describe('applyCommittedSupply — deducted exactly once, and never double-counted', () => {
  test('committed units leave the PO pool AND return to on-hand stock', () => {
    const r = applyCommittedSupply([po()], new Map([[commitmentKey(K, 'PO-A'), 1]]));
    expect(r.entries).toEqual([{ ...po(), qtyLeft: 2 }]);
    // THE INVARIANT: the ship's OUT already took this unit off inventory_balances,
    // so deducting from PO supply without adding it back would count it twice.
    expect(r.stockAddBack).toEqual(new Map([[K, 1]]));
    expect(r.unmatched.size).toBe(0);
  });

  test('deduction and add-back are always the same number in the same bucket', () => {
    const committed = new Map([[commitmentKey(K, 'PO-A'), 2], [commitmentKey(K, 'PO-B'), 5]]);
    const before = 3 + 4;
    const r = applyCommittedSupply([po({ qtyLeft: 3 }), po({ poNumber: 'PO-B', qtyLeft: 4 })], committed);
    const after = r.entries.reduce((n, e) => n + e.qtyLeft, 0);
    const added = [...r.stockAddBack.values()].reduce((n, v) => n + v, 0);
    expect(before - after).toBe(added);
  });

  test('a fully committed PO line drops out of the pool entirely', () => {
    const r = applyCommittedSupply([po({ qtyLeft: 2 })], new Map([[commitmentKey(K, 'PO-A'), 2]]));
    expect(r.entries).toEqual([]);
    expect(r.stockAddBack).toEqual(new Map([[K, 2]]));
  });

  test('committed more than the PO has left -> deduct what exists, report the rest', () => {
    const r = applyCommittedSupply([po({ qtyLeft: 1 })], new Map([[commitmentKey(K, 'PO-A'), 4]]));
    expect(r.entries).toEqual([]);
    expect(r.stockAddBack).toEqual(new Map([[K, 1]]));
    expect(r.unmatched).toEqual(new Map([[commitmentKey(K, 'PO-A'), 3]]));
  });

  test('a commitment against a DIFFERENT PO never touches this one', () => {
    const r = applyCommittedSupply([po()], new Map([[commitmentKey(K, 'PO-Z'), 3]]));
    expect(r.entries).toEqual([po()]);
    expect(r.stockAddBack.size).toBe(0);
    expect(r.unmatched).toEqual(new Map([[commitmentKey(K, 'PO-Z'), 3]]));
  });

  test('a commitment in a DIFFERENT bucket (other warehouse) never touches this one', () => {
    const r = applyCommittedSupply([po()], new Map([[commitmentKey('wh-pg|TRION-(K)|', 'PO-A'), 3]]));
    expect(r.entries).toEqual([po()]);
    expect(r.stockAddBack.size).toBe(0);
  });

  test('one commitment spread across two PO lines of the same PO is taken once', () => {
    const r = applyCommittedSupply(
      [po({ qtyLeft: 1 }), po({ qtyLeft: 5 })],
      new Map([[commitmentKey(K, 'PO-A'), 3]]),
    );
    expect(r.entries.map((e) => e.qtyLeft)).toEqual([3]);
    expect(r.stockAddBack).toEqual(new Map([[K, 3]]));
  });

  test('no commitments at all -> the pool is returned untouched (todays behaviour)', () => {
    const entries = [po(), po({ poNumber: 'PO-B' })];
    const r = applyCommittedSupply(entries, new Map());
    expect(r.entries).toEqual(entries);
    expect(r.stockAddBack.size).toBe(0);
  });

  test('after the receipt nets it, the deduction is gone — no second bite', () => {
    // Receipt of 3: received_qty moves the PO line to 0 left, and the reconcile
    // books the consumption so the commitment recomputes to 0. Both sides fall
    // away from the SAME ledger fact.
    const committed = outstandingCommitments([mov({ outQty: 1, consumedQty: 1 })]);
    const r = applyCommittedSupply([po({ qtyLeft: 0 })], committed);
    expect(r.entries).toEqual([]);
    expect(r.stockAddBack.size).toBe(0);
    expect(r.unmatched.size).toBe(0);
  });
});
