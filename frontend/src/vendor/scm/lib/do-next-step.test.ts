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
  it('is available on exactly the statuses where the stock has already left', () => {
    for (const s of SI_TRANSFERABLE_DO_STATUSES) {
      expect([s, siTransferBlockReason(s)]).toEqual([s, null]);
    }
    /* THE REGRESSION THIS PINS. `canConvertToSi` was a hand-typed
       ["signed","delivered"] literal in two desktop files while the server
       picker and the mobile wizard used the wide predicate. Eight of 2990's
       delivery orders sat at DISPATCHED — goods gone, nothing billed — with no
       transfer button anywhere. Narrow this back and the first line fails. */
    expect(siTransferBlockReason('dispatched')).toBeNull();
    expect(siTransferBlockReason('in_transit')).toBeNull();
    expect(siTransferBlockReason('invoiced')).toBeNull();
    /* Pre-ship and terminal rungs stay blocked. LOADED is deliberately NOT
       billable: no inventory OUT movement exists yet. */
    for (const s of ['draft', 'loaded', 'cancelled']) {
      expect([s, siTransferBlockReason(s) === null]).toEqual([s, false]);
    }
  });

  it('tells a loaded order the goods have not left, not to go and sign itself', () => {
    const r = siTransferBlockReason('loaded');
    expect(r).toMatch(/have not left/i);
    expect(r).toMatch(/dispatch/i);
  });

  it('does not tell a cancelled order to go and dispatch itself', () => {
    const r = siTransferBlockReason('cancelled');
    expect(r).toMatch(/cancelled/i);
    expect(r).not.toMatch(/dispatch it/i);
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
      expect(r).not.toMatch(/have not left/i);
    }
  });
});
