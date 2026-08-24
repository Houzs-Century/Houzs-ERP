// Owner 2026-08-20: a Purchase-Consignment receive is legitimately 0-priced (the
// supplier still owns the goods), so — unlike GRN — it is NEVER blocked for a
// zero cost; instead the IN cost is resolved so a known-cost SKU never opens a
// 0-cost lot. The "match GRN's zero-cost guard" review item was refuted: GRN's
// block-and-ack would fight the normal consignment case. The real fix is this
// tiered cost resolver, whose tiers this pins.
import { describe, it, expect } from 'vitest';
import { resolvePcReceiveUnitCostSen } from './purchase-consignment-receives';

describe('resolvePcReceiveUnitCostSen — tiered consignment IN cost', () => {
  it('uses the line price when it is set', () => {
    expect(resolvePcReceiveUnitCostSen(12345, 999, 777)).toBe(12345);
  });

  it('falls back to the on-hand weighted-avg cost when the line is 0-priced', () => {
    expect(resolvePcReceiveUnitCostSen(0, 8600, 5000)).toBe(8600);
  });

  it('falls back to the last KNOWN historical cost when nothing is on hand (the sold-out SKU the old on-hand-only fallback missed)', () => {
    expect(resolvePcReceiveUnitCostSen(0, undefined, 5000)).toBe(5000);
  });

  it('books 0 only for a genuinely never-priced SKU (no on-hand, no history)', () => {
    expect(resolvePcReceiveUnitCostSen(0, undefined, undefined)).toBe(0);
  });

  it('lets a present-but-0 on-hand cost win over history (preserves the prior ?? semantics)', () => {
    // An open lot really is carried at 0 — do not silently re-cost it from history.
    expect(resolvePcReceiveUnitCostSen(0, 0, 5000)).toBe(0);
  });
});
