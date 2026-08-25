// MRP must not offer another order's batch-locked sofa unit as free stock.
//
// The prod case this pins (2026-08-24, 2990): SO-2608-006's set L(LHF) +
// 2A(RHF) was whole-set allocated from batch 2990-PO-2608-006
// (allocated_batch_no stamped, stock_status READY). SO-2607-019 needs
// 1A(LHF) + 2A(RHF) and delivers EARLIER. The batch-blind pooled walk gave
// -006's received RHF unit to -019 by date rank, so:
//   · -019's RHF chip read "stock" — units the DO ship-gate would never
//     release to it (whole-set-from-one-batch rule);
//   · -006's RHF chip read SHORT — its unit was never in danger;
//   · the From-SO picker (same coverage) reported -019's RHF shortage 0, so
//     the line that actually needed ordering could not be picked, and the
//     suggested LHF-only PO could never complete -019's set: no single batch
//     would ever hold both modules. A silent deadlock.
//
// These tests drive the exact functions mrp.ts sections 7/8 now call
// (lib/batch-claimed-stock.ts) through the same walk order the engine uses:
// lines sorted by delivery date, one drawBucketStock per line, PO queue after.
import { describe, expect, it } from 'vitest';
import {
  collectBatchClaims,
  drawBucketStock,
  openBucketStock,
} from '../src/scm/lib/batch-claimed-stock';

/* Bucket keys are opaque to the module (composite() output in prod). */
const RHF = 'GZ|XAMMAR EZ-2A(RHF)|fabriccode=xm-01';
const LHF_006 = 'GZ|XAMMAR EZ-L(LHF)|fabriccode=xm-01';
const LHF_019 = 'GZ|XAMMAR EZ-1A(LHF)|fabriccode=xm-01';
const BATCH = '2990-PO-2608-006';

describe('the two-SO prod scenario (2607-019 vs 2608-006)', () => {
  /* -006's two module lines carry the batch lock; -019's carry none. */
  const claims = collectBatchClaims([
    { soItemId: 'line-019-1A-LHF', bucketKey: LHF_019, allocatedBatchNo: null, remainingQty: 1 },
    { soItemId: 'line-019-2A-RHF', bucketKey: RHF, allocatedBatchNo: null, remainingQty: 1 },
    { soItemId: 'line-006-L-LHF', bucketKey: LHF_006, allocatedBatchNo: BATCH, remainingQty: 1 },
    { soItemId: 'line-006-2A-RHF', bucketKey: RHF, allocatedBatchNo: BATCH, remainingQty: 1 },
  ]);

  it('the earlier-delivery SO can no longer take the claimed RHF unit', () => {
    // On hand in the RHF bucket: exactly the one unit batch -006 received.
    const rhf = openBucketStock(1, claims.qtyByBucket.get(RHF) ?? 0);
    expect(rhf).toEqual({ reserve: 1, free: 0 });

    // Walk in delivery-date order: -019 first (earlier), then -006.
    const early = drawBucketStock(rhf, claims.qtyByLine.get('line-019-2A-RHF') ?? 0, 1);
    const claiming = drawBucketStock(rhf, claims.qtyByLine.get('line-006-2A-RHF') ?? 0, 1);

    expect(early).toBe(0);    // -019 stays uncovered → PO queue / SHORT
    expect(claiming).toBe(1); // -006 keeps the unit its batch lock owns
  });

  it("-006's LHF module is likewise served from its own claim", () => {
    const lhf = openBucketStock(1, claims.qtyByBucket.get(LHF_006) ?? 0);
    expect(drawBucketStock(lhf, claims.qtyByLine.get('line-006-L-LHF') ?? 0, 1)).toBe(1);
  });

  it("-019 now reads SHORT on BOTH modules, so the From-SO picker offers the whole set", () => {
    // The picker shows a line iff computeMrp's shortageQty > 0. Before the fix
    // -019's RHF was "covered" and unpickable; the LHF-only order it steered
    // the operator toward could never satisfy the whole-set batch rule.
    const rhf = openBucketStock(1, claims.qtyByBucket.get(RHF) ?? 0);
    const lhf019 = openBucketStock(0, claims.qtyByBucket.get(LHF_019) ?? 0);
    const shortRhf = 1 - drawBucketStock(rhf, 0, 1);
    const shortLhf = 1 - drawBucketStock(lhf019, 0, 1);
    expect(shortRhf).toBe(1);
    expect(shortLhf).toBe(1);
  });
});

describe('collectBatchClaims', () => {
  it('ignores unlocked lines and lines with nothing left to fulfil', () => {
    const claims = collectBatchClaims([
      { soItemId: 'a', bucketKey: RHF, allocatedBatchNo: null, remainingQty: 3 },
      { soItemId: 'b', bucketKey: RHF, allocatedBatchNo: BATCH, remainingQty: 0 },
      { soItemId: 'c', bucketKey: RHF, allocatedBatchNo: BATCH, remainingQty: -2 },
    ]);
    expect(claims.qtyByLine.size).toBe(0);
    expect(claims.qtyByBucket.size).toBe(0);
  });

  it('sums two claimed sets sharing one bucket', () => {
    const claims = collectBatchClaims([
      { soItemId: 'a', bucketKey: RHF, allocatedBatchNo: BATCH, remainingQty: 1 },
      { soItemId: 'b', bucketKey: RHF, allocatedBatchNo: '2990-PO-2608-009', remainingQty: 2 },
    ]);
    expect(claims.qtyByBucket.get(RHF)).toBe(3);
    expect(claims.qtyByLine.get('a')).toBe(1);
    expect(claims.qtyByLine.get('b')).toBe(2);
  });
});

describe('openBucketStock / drawBucketStock edges', () => {
  it('a stale claim reserves only what is actually on hand', () => {
    // The batch's units were transferred/oversold since the allocator last
    // recomputed: claim 3 against 1 on hand reserves 1, and the claiming line
    // falls through to the PO queue for the rest like any other line.
    const stock = openBucketStock(1, 3);
    expect(stock).toEqual({ reserve: 1, free: 0 });
    expect(drawBucketStock(stock, 3, 3)).toBe(1);
  });

  it('an unclaimed bucket behaves exactly as the old walk did', () => {
    const stock = openBucketStock(5, 0);
    expect(drawBucketStock(stock, 0, 2)).toBe(2);
    expect(drawBucketStock(stock, 0, 4)).toBe(3);
    expect(drawBucketStock(stock, 0, 1)).toBe(0);
  });

  it('a claim larger than the line needs leaves the rest of the reserve for its sibling claim', () => {
    const stock = openBucketStock(2, 2);
    expect(drawBucketStock(stock, 1, 1)).toBe(1);
    expect(drawBucketStock(stock, 1, 1)).toBe(1);
  });

  it('a negative balance carves no reserve and still taxes the first line to walk', () => {
    // Pre-existing pooled-walk behaviour, deliberately unchanged (mrp.ts 4b:
    // "a nameless negative that silently taxes whichever Sales Order happens
    // to sort first in the bucket") — the carve must not move that tax onto
    // the claim, and a claimed line in a negative bucket has no reserve.
    const stock = openBucketStock(-2, 1);
    expect(stock).toEqual({ reserve: 0, free: -2 });
    expect(drawBucketStock(stock, 1, 1)).toBe(-2);
    expect(stock.free).toBe(0);
  });
});
