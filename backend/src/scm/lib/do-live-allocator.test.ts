import { describe, it, expect } from 'vitest';
import {
  allocateExpectedBatches,
  pickIncomingForBucket,
  pickIncomingForSofaSet,
  subtractOutstanding,
  type AllocatorDemandLine,
  type IncomingLine,
} from './do-live-allocator';
import { outstandingCommitments, planShipCommitments, type OutstandingCommitment } from './ship-commitment';

const line = (po: string, code: string, key: string, qty: number, eta: string | null): IncomingLine =>
  ({ poNumber: po, itemCode: code, variantKey: key, warehouseId: 'wh-1', qtyLeft: qty, eta });

describe('pickIncomingForBucket — the owner\'s supply-side order', () => {
  it('earliest effective ETA wins', () => {
    const pick = pickIncomingForBucket([
      line('PO-2', 'X', 'k', 1, '2026-08-20'),
      line('PO-1', 'X', 'k', 1, '2026-08-25'),
    ], 'X', 'k', 1);
    expect(pick?.poNumber).toBe('PO-2');
  });

  it('equal ETA -> the smaller PO number ("SO1 比 SO2 优先", supply mirror)', () => {
    const pick = pickIncomingForBucket([
      line('PO-9', 'X', 'k', 1, '2026-08-20'),
      line('PO-2', 'X', 'k', 1, '2026-08-20'),
    ], 'X', 'k', 1);
    expect(pick?.poNumber).toBe('PO-2');
  });

  it('an undated promise never outranks a dated one', () => {
    const pick = pickIncomingForBucket([
      line('PO-1', 'X', 'k', 5, null),
      line('PO-2', 'X', 'k', 5, '2026-09-01'),
    ], 'X', 'k', 1);
    expect(pick?.poNumber).toBe('PO-2');
  });

  it('prefers the first PO that COVERS the need over an earlier partial', () => {
    const pick = pickIncomingForBucket([
      line('PO-1', 'X', 'k', 1, '2026-08-10'),
      line('PO-2', 'X', 'k', 3, '2026-08-15'),
    ], 'X', 'k', 2);
    expect(pick?.poNumber).toBe('PO-2');
  });

  it('falls back to the earliest partial when nothing covers alone', () => {
    const pick = pickIncomingForBucket([
      line('PO-1', 'X', 'k', 1, '2026-08-10'),
      line('PO-2', 'X', 'k', 1, '2026-08-15'),
    ], 'X', 'k', 3);
    expect(pick?.poNumber).toBe('PO-1');
  });

  it('aggregates several lines of the same PO before judging cover', () => {
    const pick = pickIncomingForBucket([
      line('PO-1', 'X', 'k', 1, '2026-08-10'),
      line('PO-1', 'X', 'k', 1, '2026-08-12'),
    ], 'X', 'k', 2);
    expect(pick?.poNumber).toBe('PO-1');
    expect(pick?.qtyLeft).toBe(2);
  });

  it('ignores other buckets and empty lines; null when the pool is empty', () => {
    expect(pickIncomingForBucket([line('PO-1', 'X', 'other', 5, null)], 'X', 'k', 1)).toBeNull();
    expect(pickIncomingForBucket([line('PO-1', 'X', 'k', 0, null)], 'X', 'k', 1)).toBeNull();
  });
});

describe('pickIncomingForSofaSet — one dye lot per set, sofa only', () => {
  const needs = new Map([['A::k1', 1], ['B::k2', 1]]);

  it('picks the single PO that covers the whole set', () => {
    const pick = pickIncomingForSofaSet([
      line('PO-1', 'A', 'k1', 1, '2026-08-10'), // covers only half
      line('PO-2', 'A', 'k1', 1, '2026-08-20'),
      line('PO-2', 'B', 'k2', 1, '2026-08-20'),
    ], needs);
    expect(pick?.poNumber).toBe('PO-2');
  });

  it('among full covers: earliest ETA, then smaller PO number', () => {
    const both = (po: string, eta: string) => [line(po, 'A', 'k1', 1, eta), line(po, 'B', 'k2', 1, eta)];
    expect(pickIncomingForSofaSet([...both('PO-5', '2026-08-20'), ...both('PO-3', '2026-08-15')], needs)?.poNumber).toBe('PO-3');
    expect(pickIncomingForSofaSet([...both('PO-5', '2026-08-20'), ...both('PO-3', '2026-08-20')], needs)?.poNumber).toBe('PO-3');
  });

  it('null when no single PO covers the set — the conflict path takes over', () => {
    const pick = pickIncomingForSofaSet([
      line('PO-1', 'A', 'k1', 1, '2026-08-10'),
      line('PO-2', 'B', 'k2', 1, '2026-08-10'),
    ], needs);
    expect(pick).toBeNull();
  });

  it('set membership needs no READY state — needs come straight from the lines (closes the empty-full-set gap)', () => {
    // A set whose SO lines are nowhere READY still forms a complete needs map here.
    const pick = pickIncomingForSofaSet([
      line('PO-7', 'A', 'k1', 2, '2026-09-01'),
      line('PO-7', 'B', 'k2', 2, '2026-09-01'),
    ], new Map([['A::k1', 2], ['B::k2', 2]]));
    expect(pick?.poNumber).toBe('PO-7');
  });

  it('a preferred PO (the set\'s received anchor batch) beats an earlier-ETA cover — one PO IS one batch', () => {
    const both = (po: string, eta: string) => [line(po, 'A', 'k1', 1, eta), line(po, 'B', 'k2', 1, eta)];
    const pick = pickIncomingForSofaSet(
      [...both('PO-3', '2026-08-10'), ...both('PO-9', '2026-08-25')],
      needs,
      'PO-9',
    );
    expect(pick?.poNumber).toBe('PO-9');
  });

  it('a preferred PO that does NOT cover falls back to the normal order (the conflict gate is the backstop)', () => {
    const pick = pickIncomingForSofaSet([
      line('PO-9', 'A', 'k1', 1, '2026-08-10'), // preferred, but covers only half
      line('PO-3', 'A', 'k1', 1, '2026-08-20'),
      line('PO-3', 'B', 'k2', 1, '2026-08-20'),
    ], needs, 'PO-9');
    expect(pick?.poNumber).toBe('PO-3');
  });
});

/* ── PR-4: the fold — units earlier shipments already own are not supply ──── */

const owedRow = (over: Partial<OutstandingCommitment> = {}): OutstandingCommitment => ({
  bucketKey: 'wh-1|X|k',
  warehouseId: 'wh-1',
  itemCode: 'X',
  variantKey: 'k',
  batchNo: 'PO-1',
  qty: 1,
  ...over,
});

describe('subtractOutstanding — the outstanding-commitment fold (double-commitment impossible)', () => {
  it('subtracts a commitment from its (warehouse, code, variant, batch) pool lines only', () => {
    const pool = subtractOutstanding([
      line('PO-1', 'X', 'k', 3, '2026-08-10'),
      line('PO-2', 'X', 'k', 3, '2026-08-12'),
      line('PO-1', 'X', 'other', 3, '2026-08-10'),
    ], [owedRow({ qty: 2 })]);
    expect(pool.map((l) => [l.poNumber, l.variantKey, l.qtyLeft])).toEqual([
      ['PO-1', 'k', 1],
      ['PO-2', 'k', 3],
      ['PO-1', 'other', 3],
    ]);
  });

  it('a commitment in ANOTHER warehouse never touches this pool', () => {
    const pool = subtractOutstanding([line('PO-1', 'X', 'k', 3, null)], [owedRow({ warehouseId: 'wh-2', bucketKey: 'wh-2|X|k' })]);
    expect(pool[0]!.qtyLeft).toBe(3);
  });

  it('committed more than the pool holds -> the pool floors at zero (the excess is MRP\'s unmatched shape)', () => {
    const pool = subtractOutstanding([line('PO-1', 'X', 'k', 2, null)], [owedRow({ qty: 5 })]);
    expect(pool[0]!.qtyLeft).toBe(0);
  });

  it('END TO END: a bound unconsumed OUT moves the next pick to the next PO — the same units are never committed twice', () => {
    // DO-1 shipped 2 short, bound to PO-1 (outstanding = 2 of PO-1's 3).
    const committed = outstandingCommitments([{
      bucketKey: 'wh-1|X|k', warehouseId: 'wh-1', itemCode: 'X', variantKey: 'k',
      batchNo: 'PO-1', outQty: 2, consumedQty: 0,
      cancelled: false, headerDropship: false, lineCommitted: true,
    }]);
    const pool = subtractOutstanding([
      line('PO-1', 'X', 'k', 3, '2026-08-10'),
      line('PO-2', 'X', 'k', 3, '2026-08-20'),
    ], committed.values());
    // DO-2 needs 2: PO-1 has only 1 genuinely free unit left, so PO-2 covers.
    expect(pickIncomingForBucket(pool, 'X', 'k', 2)?.poNumber).toBe('PO-2');
    // Once the receipt nets DO-1 (consumed = out), PO-1 is free again.
    const netted = outstandingCommitments([{
      bucketKey: 'wh-1|X|k', warehouseId: 'wh-1', itemCode: 'X', variantKey: 'k',
      batchNo: 'PO-1', outQty: 2, consumedQty: 2,
      cancelled: false, headerDropship: false, lineCommitted: true,
    }]);
    const freed = subtractOutstanding([
      line('PO-1', 'X', 'k', 3, '2026-08-10'),
      line('PO-2', 'X', 'k', 3, '2026-08-20'),
    ], netted.values());
    expect(pickIncomingForBucket(freed, 'X', 'k', 2)?.poNumber).toBe('PO-1');
  });
});

/* ── PR-4: the flip — one walk decides every line's expected batch ────────── */

const dLine = (over: Partial<AllocatorDemandLine> = {}): AllocatorDemandLine => ({
  lineRef: 'L1',
  itemCode: 'X',
  variantKey: 'k',
  shipQty: 1,
  isSofa: false,
  soDocNo: 'SO-1',
  allocatedBatchNo: null,
  deliveryDate: '2026-08-15',
  ...over,
});

describe('allocateExpectedBatches — the DO-time live pick (Decision 2026-08-06)', () => {
  it('a stored-vs-allocator divergence resolves to the ALLOCATOR: the pick feeds planShipCommitments and binds', () => {
    // The stored raise-link says PO-STORED; the pool's earliest cover is
    // PO-LIVE. Post-flip the stored link is provenance only — the fact fed to
    // the decision table is the allocator's pick, and that is what binds.
    const picks = allocateExpectedBatches(
      [line('PO-LIVE', 'X', 'k', 5, '2026-08-10'), line('PO-STORED', 'X', 'k', 5, '2026-08-20')],
      [dLine()],
    );
    expect(picks.get('L1')?.poNumber).toBe('PO-LIVE');
    const [d] = planShipCommitments([{
      lineRef: 'L1', soItemId: 'so-1', itemCode: 'X', variantKey: 'k',
      warehouseId: 'wh-1', isSofa: false, allocatedBatchNo: null,
      expectedBatchNo: picks.get('L1')?.poNumber ?? null,
      availableQty: 0, shipQty: 1,
    }]);
    expect(d).toMatchObject({ bind: true, batchNo: 'PO-LIVE', reason: 'short_before_arrival' });
  });

  it('demand order is the owner\'s: earlier delivery date takes the covering PO; the later line falls to the partial', () => {
    const pool = [line('PO-1', 'X', 'k', 2, '2026-08-10'), line('PO-2', 'X', 'k', 1, '2026-08-20')];
    const picks = allocateExpectedBatches(pool, [
      dLine({ lineRef: 'late', soDocNo: 'SO-2', deliveryDate: '2026-09-01', shipQty: 2 }),
      dLine({ lineRef: 'early', soDocNo: 'SO-1', deliveryDate: '2026-08-12', shipQty: 2 }),
    ]);
    expect(picks.get('early')?.poNumber).toBe('PO-1'); // first in demand order, gets the cover
    expect(picks.get('late')?.poNumber).toBe('PO-2');  // PO-1 is spent; earliest remaining
  });

  it('equal dates -> smaller doc number first ("SO1 比 SO2 优先")', () => {
    const pool = [line('PO-1', 'X', 'k', 1, '2026-08-10'), line('PO-2', 'X', 'k', 1, '2026-08-20')];
    const picks = allocateExpectedBatches(pool, [
      dLine({ lineRef: 'b', soDocNo: 'SO-2' }),
      dLine({ lineRef: 'a', soDocNo: 'SO-1' }),
    ]);
    expect(picks.get('a')?.poNumber).toBe('PO-1');
    expect(picks.get('b')?.poNumber).toBe('PO-2');
  });

  it('an undated line never outranks a dated one', () => {
    const pool = [line('PO-1', 'X', 'k', 1, '2026-08-10')];
    const picks = allocateExpectedBatches(pool, [
      dLine({ lineRef: 'undated', soDocNo: 'SO-1', deliveryDate: null }),
      dLine({ lineRef: 'dated', soDocNo: 'SO-2', deliveryDate: '2026-12-01' }),
    ]);
    expect(picks.get('dated')?.poNumber).toBe('PO-1');
    expect(picks.get('undated')).toBeUndefined();
  });

  it('two lines of ONE write draw down the pool — the intra-write twin of the fold', () => {
    const pool = [line('PO-1', 'X', 'k', 3, '2026-08-10'), line('PO-2', 'X', 'k', 3, '2026-08-20')];
    const picks = allocateExpectedBatches(pool, [
      dLine({ lineRef: 'a', shipQty: 3 }),
      dLine({ lineRef: 'b', shipQty: 3, soDocNo: 'SO-2', deliveryDate: '2026-08-16' }),
    ]);
    expect(picks.get('a')?.poNumber).toBe('PO-1');
    expect(picks.get('b')?.poNumber).toBe('PO-2'); // PO-1 is spent by line a
  });

  it('a line with no incoming supply gets NO pick (planShipCommitments reads that as no_po)', () => {
    expect(allocateExpectedBatches([], [dLine()]).size).toBe(0);
  });

  it('SOFA: the whole set gets ONE pick, needs pooled across modules', () => {
    const pool = [
      line('PO-1', 'A', 'k1', 1, '2026-08-10'), // covers only module A
      line('PO-2', 'A', 'k1', 1, '2026-08-20'),
      line('PO-2', 'B', 'k2', 1, '2026-08-20'),
    ];
    const picks = allocateExpectedBatches(pool, [
      dLine({ lineRef: 'mA', itemCode: 'A', variantKey: 'k1', isSofa: true }),
      dLine({ lineRef: 'mB', itemCode: 'B', variantKey: 'k2', isSofa: true }),
    ]);
    expect(picks.get('mA')?.poNumber).toBe('PO-2');
    expect(picks.get('mB')?.poNumber).toBe('PO-2');
  });

  it('SOFA: a module already holding a RECEIVED batch anchors the set\'s preference and takes no pick itself', () => {
    const both = (po: string, eta: string) => [line(po, 'B', 'k2', 1, eta)];
    const pool = [...both('PO-3', '2026-08-10'), ...both('PO-9', '2026-08-25')];
    const picks = allocateExpectedBatches(pool, [
      dLine({ lineRef: 'recv', itemCode: 'A', variantKey: 'k1', isSofa: true, allocatedBatchNo: 'PO-9' }),
      dLine({ lineRef: 'open', itemCode: 'B', variantKey: 'k2', isSofa: true }),
    ]);
    expect(picks.get('recv')).toBeUndefined();           // ships from received stock
    expect(picks.get('open')?.poNumber).toBe('PO-9');    // follows the anchor, not the earlier ETA
  });

  it('SOFA: no single PO covers the set -> NO pick (the sofa guards take over; never a per-module split)', () => {
    const pool = [
      line('PO-1', 'A', 'k1', 1, '2026-08-10'),
      line('PO-2', 'B', 'k2', 1, '2026-08-10'),
    ];
    const picks = allocateExpectedBatches(pool, [
      dLine({ lineRef: 'mA', itemCode: 'A', variantKey: 'k1', isSofa: true }),
      dLine({ lineRef: 'mB', itemCode: 'B', variantKey: 'k2', isSofa: true }),
    ]);
    expect(picks.size).toBe(0);
  });

  it('the fold feeds the walk: an outstanding commitment shifts the whole-write allocation', () => {
    const committed = outstandingCommitments([{
      bucketKey: 'wh-1|X|k', warehouseId: 'wh-1', itemCode: 'X', variantKey: 'k',
      batchNo: 'PO-1', outQty: 3, consumedQty: 0,
      cancelled: false, headerDropship: false, lineCommitted: true,
    }]);
    const pool = subtractOutstanding([
      line('PO-1', 'X', 'k', 3, '2026-08-10'),
      line('PO-2', 'X', 'k', 3, '2026-08-20'),
    ], committed.values());
    const picks = allocateExpectedBatches(pool, [dLine({ shipQty: 2 })]);
    expect(picks.get('L1')?.poNumber).toBe('PO-2'); // PO-1's units are already owed away
  });
});
