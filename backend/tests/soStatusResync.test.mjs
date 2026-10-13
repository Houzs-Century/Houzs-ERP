// The rules resync-so-status-to-rules.mjs applies, stated one at a time. The
// script reads the facts; this is the judgement, and the part that must not
// drift from what the app's own writers do (so-delivery-sync, so-proceeded-status,
// so-stock-allocation).
import { describe, expect, it } from 'vitest';

import { resyncTarget } from '../scripts/lib/so-status-resync.mjs';

const base = {
  status: 'CONFIRMED',
  processingDate: null,
  fullyCovered: false,
  lateUncoveredLines: 0,
  emptyLiveDeliveries: 0,
  hasDownstream: false,
};

describe('resyncTarget', () => {
  it('a Submitted order carrying a Processing Date is In Production', () => {
    expect(resyncTarget({ ...base, processingDate: '2026-09-20' }))
      .toEqual({ to: 'IN_PRODUCTION', rule: 'date-means-in-production' });
    expect(resyncTarget({ ...base, processingDate: '   ' })).toBeNull();
    expect(resyncTarget(base)).toBeNull();
  });

  it('an In Production order with no date goes back to Submitted — unless something shipped', () => {
    expect(resyncTarget({ ...base, status: 'IN_PRODUCTION' }))
      .toEqual({ to: 'CONFIRMED', rule: 'no-date-means-submitted' });
    expect(resyncTarget({ ...base, status: 'IN_PRODUCTION', processingDate: '2026-09-20' })).toBeNull();
    const kept = resyncTarget({ ...base, status: 'IN_PRODUCTION', hasDownstream: true });
    /* A downstream document means it is further along, not less. */
    expect(kept).toHaveProperty('refused');
  });

  it('full delivery coverage wins over every date rule and lands on DELIVERED', () => {
    for (const status of ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED']) {
      expect(resyncTarget({ ...base, status, processingDate: '2026-09-20', fullyCovered: true }), status)
        .toEqual({ to: 'DELIVERED', rule: 'delivered-by-do' });
    }
    /* Already there, or past it: nothing to say. */
    expect(resyncTarget({ ...base, status: 'DELIVERED', fullyCovered: true })).toBeNull();
    expect(resyncTarget({ ...base, status: 'INVOICED', fullyCovered: true })).toBeNull();
  });

  it('a line added after delivery re-opens the order, on positive evidence only', () => {
    expect(resyncTarget({ ...base, status: 'DELIVERED', lateUncoveredLines: 1 }))
      .toEqual({ to: 'READY_TO_SHIP', rule: 'reopened-by-late-line' });
    /* A shipped DO with no line rows is corruption, not goods to ship. */
    expect(resyncTarget({ ...base, status: 'DELIVERED', lateUncoveredLines: 1, emptyLiveDeliveries: 1 }))
      .toHaveProperty('refused');
    /* An uncovered line that predates the delivery is a migrated order's MISC /
       STORAGE row, not new demand — left exactly alone. */
    expect(resyncTarget({ ...base, status: 'DELIVERED', lateUncoveredLines: 0 })).toBeNull();
  });

  it("READY_TO_SHIP is the stock sweep's to move, never the date rules'", () => {
    expect(resyncTarget({ ...base, status: 'READY_TO_SHIP' })).toBeNull();
    expect(resyncTarget({ ...base, status: 'READY_TO_SHIP', processingDate: '2026-09-20' })).toBeNull();
  });

  it('terminal and side states are never touched', () => {
    for (const status of ['DRAFT', 'CANCELLED', 'CLOSED', 'ON_HOLD', 'INVOICED']) {
      expect(resyncTarget({ ...base, status, processingDate: '2026-09-20' }), status).toBeNull();
    }
  });
});
