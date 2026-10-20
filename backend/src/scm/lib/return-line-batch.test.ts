import { describe, expect, it } from 'vitest';
import { shippedBatchOf } from './return-line-batch';
import type { BucketTrace } from './source-po-trace';

const DO = 'eccec63c-0621-4018-8ead-e1040cf59a65';
const VK = 'fabriccode=ez-003|seatheight=28|legheight=6"';
const trace = (entries: Array<[string, string[]]>): Map<string, BucketTrace> =>
  new Map(entries.map(([k, pos]) => [k, { pos, adjQty: 0 }]));

describe('shippedBatchOf (2990-0011)', () => {
  it('returns the batch the DO shipped the module from', () => {
    const byBucket = trace([
      [`${DO}::XAMMAR-2A(LHF)::${VK}`, ['2990-PO-2606-010']],
      [`${DO}::XAMMAR-L(RHF)::${VK}`, ['2990-PO-2606-010']],
    ]);
    expect(shippedBatchOf(byBucket, DO, 'XAMMAR-2A(LHF)', VK)).toBe('2990-PO-2606-010');
    expect(shippedBatchOf(byBucket, DO, 'XAMMAR-L(RHF)', VK)).toBe('2990-PO-2606-010');
  });

  it('names no batch when the shipment drew from two', () => {
    const byBucket = trace([[`${DO}::XAMMAR-2A(LHF)::${VK}`, ['2990-PO-2606-010', '2990-PO-2607-018']]]);
    expect(shippedBatchOf(byBucket, DO, 'XAMMAR-2A(LHF)', VK)).toBeNull();
  });

  it('falls back to the code on that DO when the variant key was written differently', () => {
    const byBucket = trace([[`${DO}::XAMMAR-2A(LHF)::fabriccode=ez-003`, ['2990-PO-2606-010']]]);
    expect(shippedBatchOf(byBucket, DO, 'XAMMAR-2A(LHF)', VK)).toBe('2990-PO-2606-010');
  });

  it('never reads another DO or another code', () => {
    const byBucket = trace([
      [`other-do::XAMMAR-2A(LHF)::${VK}`, ['2990-PO-2606-010']],
      [`${DO}::XAMMAR-2A(LHF)X::${VK}`, ['2990-PO-2606-010']],
    ]);
    expect(shippedBatchOf(byBucket, DO, 'XAMMAR-2A(LHF)', VK)).toBeNull();
  });
});
