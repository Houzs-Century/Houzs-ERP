// The rules resync-so-status-to-rules.mjs applies, stated one at a time. The
// script reads the facts; this is the judgement, and the part that must not
// drift from what the app's own writers do (so-delivery-sync, so-proceeded-status,
// so-stock-allocation).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resyncTarget } from '../scripts/lib/so-status-resync.mjs';

const base = {
  status: 'CONFIRMED',
  processingDate: null,
  fullyCovered: false,
  lateUncoveredLines: 0,
  emptyLiveDeliveries: 0,
  hasDownstream: false,
};

test('a Submitted order carrying a Processing Date is In Production', () => {
  assert.deepEqual(resyncTarget({ ...base, processingDate: '2026-09-20' }),
    { to: 'IN_PRODUCTION', rule: 'date-means-in-production' });
  assert.equal(resyncTarget({ ...base, processingDate: '   ' }), null);
  assert.equal(resyncTarget(base), null);
});

test('an In Production order with no date goes back to Submitted — unless something shipped', () => {
  assert.deepEqual(resyncTarget({ ...base, status: 'IN_PRODUCTION' }),
    { to: 'CONFIRMED', rule: 'no-date-means-submitted' });
  assert.equal(resyncTarget({ ...base, status: 'IN_PRODUCTION', processingDate: '2026-09-20' }), null);
  const kept = resyncTarget({ ...base, status: 'IN_PRODUCTION', hasDownstream: true });
  assert.ok(kept && 'refused' in kept, 'a downstream document means it is further along, not less');
});

test('full delivery coverage wins over every date rule and lands on DELIVERED', () => {
  for (const status of ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED']) {
    assert.deepEqual(resyncTarget({ ...base, status, processingDate: '2026-09-20', fullyCovered: true }),
      { to: 'DELIVERED', rule: 'delivered-by-do' }, status);
  }
  /* Already there, or past it: nothing to say. */
  assert.equal(resyncTarget({ ...base, status: 'DELIVERED', fullyCovered: true }), null);
  assert.equal(resyncTarget({ ...base, status: 'INVOICED', fullyCovered: true }), null);
});

test('a line added after delivery re-opens the order, on positive evidence only', () => {
  assert.deepEqual(resyncTarget({ ...base, status: 'DELIVERED', lateUncoveredLines: 1 }),
    { to: 'READY_TO_SHIP', rule: 'reopened-by-late-line' });
  const refused = resyncTarget({ ...base, status: 'DELIVERED', lateUncoveredLines: 1, emptyLiveDeliveries: 1 });
  assert.ok(refused && 'refused' in refused, 'a shipped DO with no line rows is corruption, not goods to ship');
  /* An uncovered line that predates the delivery is a migrated order's MISC /
     STORAGE row, not new demand — left exactly alone. */
  assert.equal(resyncTarget({ ...base, status: 'DELIVERED', lateUncoveredLines: 0 }), null);
});

test('READY_TO_SHIP is the stock sweep\'s to move, never the date rules\'', () => {
  assert.equal(resyncTarget({ ...base, status: 'READY_TO_SHIP' }), null);
  assert.equal(resyncTarget({ ...base, status: 'READY_TO_SHIP', processingDate: '2026-09-20' }), null);
});

test('terminal and side states are never touched', () => {
  for (const status of ['DRAFT', 'CANCELLED', 'CLOSED', 'ON_HOLD', 'INVOICED']) {
    assert.equal(resyncTarget({ ...base, status, processingDate: '2026-09-20' }), null, status);
  }
});
