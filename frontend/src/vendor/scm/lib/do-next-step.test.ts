/* The next step is never hidden.
 *
 * Owner, 2026-08-18: two delivery orders, one per company, same green button
 * slot, two different verbs and no explanation — "我又不是两套系统". These pin the
 * two halves of the answer: the transfer is available on exactly the statuses
 * the backend accepts, and every other status produces a SENTENCE rather than
 * an absence.
 *
 * Delete the `cancelled` or the in-flight arm and the matching case fails on a
 * generic sentence where a specific one belongs.
 */
import { describe, expect, it } from 'vitest';
import { siTransferBlockReason, SI_TRANSFERABLE_DO_STATUSES } from './do-next-step';

describe('siTransferBlockReason', () => {
  it('is available on exactly the statuses a Sales Invoice can be raised from', () => {
    for (const s of SI_TRANSFERABLE_DO_STATUSES) {
      expect([s, siTransferBlockReason(s)]).toEqual([s, null]);
    }
    /* The ladder from routes/delivery-orders-mfg.ts. Every rung that is NOT
       transferable must be blocked — a new status added upstream lands here as
       the generic sentence, never as a silently-enabled transfer. */
    for (const s of ['draft', 'dispatched', 'loaded', 'in_transit', 'cancelled']) {
      expect([s, siTransferBlockReason(s) === null]).toEqual([s, false]);
    }
  });

  it('tells an in-flight order to get signed, naming the step', () => {
    for (const s of ['loaded', 'dispatched', 'in_transit']) {
      expect(siTransferBlockReason(s)).toMatch(/sign this delivery order first/i);
    }
  });

  it('does not tell a cancelled order to go and sign itself', () => {
    const r = siTransferBlockReason('cancelled');
    expect(r).toMatch(/cancelled/i);
    expect(r).not.toMatch(/sign this delivery order first/i);
  });

  it('does not tell a draft to sign before it has been dispatched', () => {
    expect(siTransferBlockReason('draft')).toMatch(/still a draft/i);
  });

  it('is case- and whitespace-insensitive, because status casing is not a contract', () => {
    expect(siTransferBlockReason('DELIVERED')).toBeNull();
    expect(siTransferBlockReason('  Signed  ')).toBeNull();
  });

  it('never guesses at an unknown status, and never returns an empty string', () => {
    for (const s of [null, undefined, '', 'wat', 'PENDING_UNICORN']) {
      const r = siTransferBlockReason(s);
      expect([s, typeof r === 'string' && r.length > 0]).toEqual([s, true]);
      expect(r).not.toMatch(/sign this delivery order first/i);
    }
  });
});
