import { describe, expect, test } from 'vitest';
import {
  applyCommittedSupply,
  commitmentKey,
  outstandingCommitments,
  planShipCommitments,
  planSofaSetPoConflicts,
  type CommittedShipmentRow,
  type OutstandingCommitment,
  type PoSupplyEntry,
  type ShipLineFact,
  type SofaSetModule,
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

describe('strictBatch — binding a non-sofa must NOT cost it the fallback repair', () => {
  /* THE REGRESSION THIS GUARDS. Migration 0230 first excluded EVERY committed
     OUT from fn_reconcile_uncosted_out, justified as "costing them from an
     arbitrary dye lot is exactly the colour-mixing batch binding exists to
     prevent". That argument is about SOFA. A mattress has no dye lot, and the
     exclusion turned a repairable RM0 into a permanent one: bind MAT-X to
     PO-500, cancel PO-500 (or let the supplier re-ship under a new number, or
     receive the goods by transfer / stock take), and fn_reconcile_dropship_batch
     never fires for PO-500 while the batch-agnostic repair steps over the OUT
     forever. On main, ANY later stock-IN fixed that OUT.

     strictBatch is what the SQL keys the exclusion off, so these two rows are
     the whole difference. */
  test('a SOFA binding is strict — its batch is a dye lot, never substitutable', () => {
    const d = only(line({ isSofa: true, expectedBatchNo: 'PO-500' }));
    expect(d).toMatchObject({ bind: true, strictBatch: true });
  });

  test('a MATTRESS binding is NOT strict — any later stock-IN may still repair it', () => {
    const d = only(line({ isSofa: false, expectedBatchNo: 'PO-500', availableQty: 0 }));
    expect(d).toMatchObject({ bind: true, batchNo: 'PO-500', strictBatch: false });
  });

  test('a line that binds nothing is never strict', () => {
    expect(only(line({ expectedBatchNo: null })).strictBatch).toBe(false);
    expect(only(line({ isSofa: true, allocatedBatchNo: 'PO-0' })).strictBatch).toBe(false);
  });
});

describe('a qty-increase on a line that ALREADY shipped elsewhere', () => {
  /* resyncInventoryForDo keys its delta on (warehouse, code, variant, BATCH).
     Stamping a batch onto a line whose earlier units went out un-batched would
     make the resync reverse a costed OUT and re-issue the whole line against
     goods that have not arrived — the temporal form of the partial short the
     table already refuses. */
  test('earlier units went out UN-BATCHED -> the delta does not bind', () => {
    const d = only(line({
      expectedBatchNo: 'PO-1', priorShippedQty: 5, priorBatchNo: null,
    }));
    expect(d).toMatchObject({ bind: false, reason: 'prior_ship_other_batch' });
  });

  test('earlier units went out under a DIFFERENT batch -> the delta does not bind', () => {
    const d = only(line({
      isSofa: true, expectedBatchNo: 'PO-2', priorShippedQty: 1, priorBatchNo: 'PO-1',
    }));
    expect(d).toMatchObject({ bind: false, reason: 'prior_ship_other_batch' });
  });

  test('earlier units went out under the SAME batch -> the delta binds to it', () => {
    const d = only(line({
      expectedBatchNo: 'PO-1', priorShippedQty: 2, priorBatchNo: 'PO-1',
    }));
    expect(d).toMatchObject({ bind: true, batchNo: 'PO-1', reason: 'short_before_arrival' });
  });

  test('nothing shipped yet -> the create paths are unaffected', () => {
    expect(only(line({ expectedBatchNo: 'PO-1', priorShippedQty: 0 })).bind).toBe(true);
  });
});

/* ── one PO IS one batch number (owner, 2026-07-31) ───────────────────────── */

const mod = (over: Partial<SofaSetModule> = {}): SofaSetModule => ({
  lineRef: 'L1',
  soDocNo: '2990-SO-2607-001',
  itemCode: 'BOOQIT-2A',
  isSofa: true,
  allocatedBatchNo: null,
  boundBatchNo: null,
  ...over,
});

describe('planSofaSetPoConflicts — a sofa SET binds ONE PO, not one per module', () => {
  test('two modules resolving DIFFERENT POs is refused, and both are named', () => {
    const cf = planSofaSetPoConflicts([
      mod({ lineRef: 'a', itemCode: 'BOOQIT-2A', boundBatchNo: 'PO-A' }),
      mod({ lineRef: 'b', itemCode: 'BOOQIT-LL', boundBatchNo: 'PO-B' }),
    ]);
    expect(cf).toHaveLength(1);
    expect(cf[0]!.soDocNo).toBe('2990-SO-2607-001');
    expect(cf[0]!.batchNos).toEqual(['PO-A', 'PO-B']);
    expect(cf[0]!.modules.map((m) => [m.itemCode, m.batchNo])).toEqual([
      ['BOOQIT-2A', 'PO-A'], ['BOOQIT-LL', 'PO-B'],
    ]);
  });

  test('every module on the SAME PO is fine — that is the whole point', () => {
    expect(planSofaSetPoConflicts([
      mod({ lineRef: 'a', boundBatchNo: 'PO-A' }),
      mod({ lineRef: 'b', itemCode: 'BOOQIT-LL', boundBatchNo: 'PO-A' }),
    ])).toEqual([]);
  });

  test('a module that would ship UN-batched alongside a bound one is a split too', () => {
    // Un-batched means plain FIFO picks its lot — a different dye lot by
    // another name, which is what the set rule exists to stop.
    const cf = planSofaSetPoConflicts([
      mod({ lineRef: 'a', boundBatchNo: 'PO-A' }),
      mod({ lineRef: 'b', itemCode: 'BOOQIT-LL', boundBatchNo: null }),
    ]);
    expect(cf).toHaveLength(1);
    expect(cf[0]!.modules.map((m) => m.batchNo)).toEqual(['PO-A', null]);
  });

  test('a module the ALLOCATOR already locked to the same batch is not a split', () => {
    expect(planSofaSetPoConflicts([
      mod({ lineRef: 'a', boundBatchNo: 'PO-A' }),
      mod({ lineRef: 'b', itemCode: 'BOOQIT-LL', allocatedBatchNo: 'PO-A' }),
    ])).toEqual([]);
  });

  test('NOTHING being bound -> not examined at all (a normal ship cannot be broken by this)', () => {
    expect(planSofaSetPoConflicts([
      mod({ lineRef: 'a', allocatedBatchNo: 'PO-A' }),
      mod({ lineRef: 'b', itemCode: 'BOOQIT-LL', allocatedBatchNo: 'PO-B' }),
    ])).toEqual([]);
  });

  test('non-sofa lines are not a set and never conflict', () => {
    expect(planSofaSetPoConflicts([
      mod({ lineRef: 'a', isSofa: false, itemCode: 'MAT-X', boundBatchNo: 'PO-A' }),
      mod({ lineRef: 'b', isSofa: false, itemCode: 'MAT-Y', boundBatchNo: 'PO-B' }),
    ])).toEqual([]);
  });

  test('two different Sales Orders are two different sets', () => {
    expect(planSofaSetPoConflicts([
      mod({ lineRef: 'a', soDocNo: 'SO-1', boundBatchNo: 'PO-A' }),
      mod({ lineRef: 'b', soDocNo: 'SO-2', itemCode: 'BOOQIT-LL', boundBatchNo: 'PO-B' }),
    ])).toEqual([]);
  });
});

/* ── the MRP half ─────────────────────────────────────────────────────────── */

const K = 'wh-kl|TRION-(K)|';

const mov = (over: Partial<CommittedShipmentRow> = {}): CommittedShipmentRow => ({
  bucketKey: K,
  warehouseId: 'wh-kl',
  itemCode: 'TRION-(K)',
  variantKey: '',
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
    expect(qtyMap(outstandingCommitments([mov()]))).toEqual(new Map([[commitmentKey(K, 'PO-A'), 1]]));
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
    expect(qtyMap(outstandingCommitments([mov({ outQty: 2, consumedQty: 1 })])))
      .toEqual(new Map([[commitmentKey(K, 'PO-A'), 1]]));
  });

  test('two shipments against one batch add up', () => {
    expect(qtyMap(outstandingCommitments([mov(), mov({ outQty: 3 })])))
      .toEqual(new Map([[commitmentKey(K, 'PO-A'), 4]]));
  });
});

/** The qty-only view of a commitment map, for the assertions that only care
 *  about the number. The map's VALUE is structured now so `unmatched` can be
 *  reported without ever splitting the key (a variant key contains '|'). */
const qtyMap = (m: Map<string, OutstandingCommitment>): Map<string, number> =>
  new Map([...m].map(([k, v]) => [k, v.qty]));

/** A commitment map keyed exactly as outstandingCommitments builds it. */
const owed = (
  pairs: Array<[bucketKey: string, batchNo: string, qty: number]>,
): Map<string, OutstandingCommitment> => new Map(pairs.map(([bucketKey, batchNo, qty]) => {
  const [warehouseId = null, itemCode = '', ...rest] = bucketKey.split('|');
  return [commitmentKey(bucketKey, batchNo), {
    bucketKey, warehouseId, itemCode, variantKey: rest.join('|'), batchNo, qty,
  }];
}));

const po = (over: Partial<PoSupplyEntry> = {}): PoSupplyEntry => ({
  bucketKey: K, poNumber: 'PO-A', eta: '2026-08-10', qtyLeft: 3, supplierId: 's1', ...over,
});

describe('applyCommittedSupply — deducted exactly once, and never double-counted', () => {
  test('committed units leave the PO pool AND return to on-hand stock', () => {
    const r = applyCommittedSupply([po()], owed([[K, 'PO-A', 1]]));
    expect(r.entries).toEqual([{ ...po(), qtyLeft: 2 }]);
    // THE INVARIANT: the ship's OUT already took this unit off inventory_balances,
    // so deducting from PO supply without adding it back would count it twice.
    expect(r.stockAddBack).toEqual(new Map([[K, 1]]));
    expect(r.unmatched).toEqual([]);
  });

  test('deduction and add-back are always the same number in the same bucket', () => {
    const committed = owed([[K, 'PO-A', 2], [K, 'PO-B', 5]]);
    const before = 3 + 4;
    const r = applyCommittedSupply([po({ qtyLeft: 3 }), po({ poNumber: 'PO-B', qtyLeft: 4 })], committed);
    const after = r.entries.reduce((n, e) => n + e.qtyLeft, 0);
    const added = [...r.stockAddBack.values()].reduce((n, v) => n + v, 0);
    expect(before - after).toBe(added);
  });

  test('a fully committed PO line drops out of the pool entirely', () => {
    const r = applyCommittedSupply([po({ qtyLeft: 2 })], owed([[K, 'PO-A', 2]]));
    expect(r.entries).toEqual([]);
    expect(r.stockAddBack).toEqual(new Map([[K, 2]]));
  });

  test('committed more than the PO has left -> deduct what exists, report the rest', () => {
    const r = applyCommittedSupply([po({ qtyLeft: 1 })], owed([[K, 'PO-A', 4]]));
    expect(r.entries).toEqual([]);
    expect(r.stockAddBack).toEqual(new Map([[K, 1]]));
    // FIX 4 — reported AS DATA, with the bucket spelled out so a caller can
    // print it. These rows are the ones most worth seeing: the units left the
    // shelf and no receipt is ever going to net them.
    expect(r.unmatched).toEqual([{
      bucketKey: K, warehouseId: 'wh-kl', itemCode: 'TRION-(K)', variantKey: '',
      batchNo: 'PO-A', qty: 3,
    }]);
  });

  test('a commitment against a DIFFERENT PO never touches this one', () => {
    const r = applyCommittedSupply([po()], owed([[K, 'PO-Z', 3]]));
    expect(r.entries).toEqual([po()]);
    expect(r.stockAddBack.size).toBe(0);
    expect(r.unmatched.map((u) => [u.batchNo, u.qty])).toEqual([['PO-Z', 3]]);
  });

  test('a commitment in a DIFFERENT bucket (other warehouse) never touches this one', () => {
    const r = applyCommittedSupply([po()], owed([['wh-pg|TRION-(K)|', 'PO-A', 3]]));
    expect(r.entries).toEqual([po()]);
    expect(r.stockAddBack.size).toBe(0);
  });

  test('one commitment spread across two PO lines of the same PO is taken once', () => {
    const r = applyCommittedSupply(
      [po({ qtyLeft: 1 }), po({ qtyLeft: 5 })],
      owed([[K, 'PO-A', 3]]),
    );
    expect(r.entries.map((e) => e.qtyLeft)).toEqual([3]);
    expect(r.stockAddBack).toEqual(new Map([[K, 3]]));
  });

  test('no commitments at all -> the pool is returned untouched (todays behaviour)', () => {
    const entries = [po(), po({ poNumber: 'PO-B' })];
    const r = applyCommittedSupply(entries, owed([]));
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
    expect(r.unmatched).toEqual([]);
  });
});
