// The pure half of backfill-hard-bound-cost.mjs: which already-shipped company-1
// hard-bound DO buckets get re-costed from their bound PO's lot, and which are
// left alone and why.
import { describe, expect, test } from 'vitest';
import {
  targetClass, selectBuckets, planGroup, nextSeqs, groupFingerprint, backfillNote, SKIPS,
} from '../scripts/lib/hard-bound-cost-backfill.mjs';
import { REPAIR_DOC_NO } from '../scripts/lib/cutover-nospec-revert.mjs';

const row = (over = {}) => ({
  id: 'm1', doId: 'do1', doNo: 'HC-DO-2610-001', warehouseId: 'wh1', wh: 'BALAKONG', itemCode: 'CODY-(K)', vk: 'v',
  hardBound: true, verdict: 'uncosted', same: null, boundPoNos: ['HC-PO-2609-187'], outBatch: null,
  outDate: '2026-10-03', costing: [], ...over,
});

describe('targetClass', () => {
  test('the three classes the owner asked for', () => {
    expect(targetClass(row())).toBe('uncosted');
    expect(targetClass(row({ verdict: 'lot-po-unknown' }))).toBe('lot-po-unknown');
    expect(targetClass(row({ verdict: 'mismatch', same: false }))).toBe('other-po');
  });
  test('a mismatch at the same cost, a match, a partial and a pooled line are left alone', () => {
    expect(targetClass(row({ verdict: 'mismatch', same: true }))).toBeNull();
    expect(targetClass(row({ verdict: 'match' }))).toBeNull();
    expect(targetClass(row({ verdict: 'partial', same: false }))).toBeNull();
    expect(targetClass(row({ hardBound: false }))).toBeNull();
  });
});

describe('selectBuckets', () => {
  test('a line still costed from the cutover repair waits for the revert, never counts as costed', () => {
    const [b] = selectBuckets([row({ verdict: 'lot-po-unknown', costing: [{ lotDocNo: `${REPAIR_DOC_NO}`, qty: 1 }] })], REPAIR_DOC_NO);
    expect(b.skip).toBe('awaiting-cutover-revert');
  });
  test('the revert lot of its own document is not a repair lot', () => {
    const [b] = selectBuckets([row({ verdict: 'lot-po-unknown', costing: [{ lotDocNo: 'AC-BAL-2026-08-09', qty: 1 }] })], REPAIR_DOC_NO);
    expect(b.skip).toBeNull();
    expect(b.boundPo).toBe('HC-PO-2609-187');
  });
  test('a batched OUT, no bound PO and two bound POs are left alone', () => {
    expect(selectBuckets([row({ outBatch: 'DYE-1' })], REPAIR_DOC_NO)[0].skip).toBe('out-is-batched');
    expect(selectBuckets([row({ boundPoNos: [] })], REPAIR_DOC_NO)[0].skip).toBe('no-bound-po');
    expect(selectBuckets([row({ boundPoNos: ['A', 'B'] })], REPAIR_DOC_NO)[0].skip).toBe('several-bound-pos');
  });
  test('the first-ship OUT and a later correction of one bucket are one candidate', () => {
    const out = selectBuckets([row(), row({ id: 'm2', verdict: 'lot-po-unknown', outDate: '2026-10-09' })], REPAIR_DOC_NO);
    expect(out).toHaveLength(1);
    expect(out[0].classes).toEqual(['lot-po-unknown', 'uncosted']);
    expect(out[0].outIds).toEqual(['m1', 'm2']);
    expect(out[0].outDate).toBe('2026-10-03');
  });
  test('every skip has a printed reason', () => {
    expect(SKIPS.map(([k]) => k)).toContain('own-po-lot-not-available');
    expect(SKIPS.map(([k]) => k)).toContain('nothing-out');
  });
});

describe('planGroup', () => {
  const c = (key, boundPo, netQty, releases = {}) => ({ key, boundPo, netQty, releases: new Map(Object.entries(releases)) });

  test('the own PO lot holds the units: re-cost', () => {
    expect(planGroup([c('a', 'P1', 1)], new Map([['P1', 1]])).get('a')).toBe('recost');
  });
  test('no own lot (the stock is an AutoCount layer that names no PO): left alone', () => {
    expect(planGroup([c('a', 'P1', 1)], new Map()).get('a')).toBe('own-po-lot-not-available');
  });
  test('two DOs that took each other\'s PO lot swap in one run', () => {
    const r = planGroup([c('x', 'PA', 1, { PB: 1 }), c('y', 'PB', 1, { PA: 1 })], new Map());
    expect([r.get('x'), r.get('y')]).toEqual(['recost', 'recost']);
  });
  test('a candidate that cannot be served gives nothing back, which may leave another short', () => {
    // x needs PA (none); y needs PB, which only x would have given back
    const r = planGroup([c('x', 'PA', 1, { PB: 1 }), c('y', 'PB', 1)], new Map());
    expect([r.get('x'), r.get('y')]).toEqual(['own-po-lot-not-available', 'own-po-lot-not-available']);
  });
  test('the older shipment is served first when the lot is short', () => {
    const r = planGroup([c('old', 'P1', 1), c('new', 'P1', 1)], new Map([['P1', 1]]));
    expect([r.get('old'), r.get('new')]).toEqual(['recost', 'own-po-lot-not-available']);
  });
});

describe('nextSeqs', () => {
  test('the return and the OUT take two fresh slots per DO + item + spec, across warehouses', () => {
    const m = new Map([['do1\u0001X\u0001v', 1]]);
    expect(nextSeqs(m, 'do1', 'X', 'v')).toEqual({ returnSeq: 2, outSeq: 3 });
    expect(nextSeqs(m, 'do1', 'X', 'v')).toEqual({ returnSeq: 4, outSeq: 5 });
    expect(nextSeqs(m, 'do2', 'X', 'v')).toEqual({ returnSeq: 1, outSeq: 2 });
  });
});

describe('groupFingerprint', () => {
  test('changes when a bucket, a consumption or an open lot moves', () => {
    const base = { buckets: [{ key: 'a', netQty: 1, consumed: ['l1:1'] }], openLots: [{ lotId: 'l2', qty: 1 }] };
    const fp = groupFingerprint(base);
    expect(groupFingerprint({ ...base, openLots: [{ lotId: 'l2', qty: 0 }] })).not.toBe(fp);
    expect(groupFingerprint({ ...base, buckets: [{ key: 'a', netQty: 2, consumed: ['l1:1'] }] })).not.toBe(fp);
    expect(groupFingerprint({ ...base, buckets: [{ key: 'a', netQty: 1, consumed: [] }] })).not.toBe(fp);
    expect(groupFingerprint(base)).toBe(fp);
  });
});

test('the movement note names the PO and the class, never money', () => {
  expect(backfillNote('HC-PO-2609-187', ['uncosted'])).toBe('Hard-bound cost backfill: re-costed from bound PO HC-PO-2609-187 (was uncosted).');
});
