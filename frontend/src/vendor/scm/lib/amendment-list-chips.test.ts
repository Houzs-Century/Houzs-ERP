/* The status chips above every amendment list (SO + PO, desktop + phone) come
   from ONE list. Owner 2026-09-17: a refused or withdrawn amendment could only
   be found by scanning "All" — 7 of 77 rows on the day — so Rejected gets its
   own chip. Pinned: the chip exists, and every chip but "all" is a real bucket,
   so a chip can never filter to a status the rows do not carry. */

import { describe, expect, test } from 'vitest';
import { AMENDMENT_LIST_CHIPS, amendmentBucketOf, amendmentBucketLabel } from './status-pill';

describe('AMENDMENT_LIST_CHIPS', () => {
  test('offers Rejected beside Requested and Approved', () => {
    expect([...AMENDMENT_LIST_CHIPS]).toEqual(['all', 'REQUESTED', 'APPROVED', 'REJECTED']);
    expect(amendmentBucketLabel('REJECTED')).toBe('Rejected');
  });

  test('each chip is a bucket some status actually lands in', () => {
    const statuses = ['REQUESTED', 'SUPPLIER_PENDING', 'SO_APPROVED', 'PO_APPROVED', 'SENT', 'APPROVED', 'REJECTED'];
    const reachable = new Set(statuses.map((s) => amendmentBucketOf(s)));
    for (const chip of AMENDMENT_LIST_CHIPS) {
      if (chip !== 'all') expect(reachable.has(chip)).toBe(true);
    }
  });

  test('a withdrawn request sits on status REJECTED, so the Rejected chip finds it too', () => {
    expect(amendmentBucketOf('REJECTED')).toBe('REJECTED');
    expect(amendmentBucketOf('rejected')).toBe('REJECTED');
  });
});
