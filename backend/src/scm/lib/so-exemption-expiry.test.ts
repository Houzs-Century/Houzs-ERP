import { describe, expect, it } from 'vitest';

import { exemptionExpirySeed } from './so-exemption-expiry';

describe('exemptionExpirySeed — the original delivery date, written once (BUG-51)', () => {
  it('seeds the first delivery date an order carries', () => {
    expect(exemptionExpirySeed(null, '2026-10-03')).toBe('2026-10-03');
    expect(exemptionExpirySeed(undefined, '2026-10-03')).toBe('2026-10-03');
  });

  it('never moves once set: HC11494 was rescheduled 03/10 -> 10/10 and must keep 03/10', () => {
    expect(exemptionExpirySeed('2026-10-03', '2026-10-10')).toBeNull();
  });

  it('nothing to seed when no delivery date arrives', () => {
    expect(exemptionExpirySeed(null, null)).toBeNull();
    expect(exemptionExpirySeed(null, '')).toBeNull();
  });
});
