/* THE RULE HAS TO REFUSE, OR IT IS NOT A RULE.
 *
 * Setting a Processing Date on a CONFIRMED order IS the proceed, so the board
 * must show it in production. The dangerous half is everything this must NOT
 * do — a rule that fires too widely drags a delivered order back into
 * production, and that is worse than the gap it closes.
 */
import { describe, expect, it } from 'vitest';
import { statusAfterProcessingDateSet } from './so-proceeded-status';

const call = (currentStatus: string | null, stored: string | null, next: string | null) =>
  statusAfterProcessingDateSet({ currentStatus, storedProcessingDate: stored, effectiveProcessingDate: next });

describe('statusAfterProcessingDateSet', () => {
  it('moves a CONFIRMED order the moment it gains a Processing Date', () => {
    expect(call('CONFIRMED', null, '2026-09-05')).toBe('IN_PRODUCTION');
  });

  it('does NOTHING when the date was already there — editing an order is not a proceed', () => {
    expect(call('CONFIRMED', '2026-08-01', '2026-09-05')).toBeNull();
    expect(call('CONFIRMED', '2026-08-01', '2026-08-01')).toBeNull();
  });

  it('does NOTHING when the save leaves no date', () => {
    expect(call('CONFIRMED', null, null)).toBeNull();
    expect(call('CONFIRMED', null, '   ')).toBeNull();
  });

  it('never drags a further-along order BACKWARDS', () => {
    for (const st of ['READY_TO_SHIP', 'DELIVERED', 'INVOICED', 'CLOSED', 'IN_PRODUCTION']) {
      expect(call(st, null, '2026-09-05'), `${st} must not move`).toBeNull();
    }
  });

  it('never touches DRAFT — it has not been confirmed', () => {
    expect(call('DRAFT', null, '2026-09-05')).toBeNull();
  });

  it('never touches a CANCELLED order', () => {
    expect(call('CANCELLED', null, '2026-09-05')).toBeNull();
  });

  it('does not move backwards when a date is CLEARED', () => {
    /* Clearing is super-admin-only and what the status becomes is the owner's
       decision, not an inference this function may make. */
    expect(call('IN_PRODUCTION', '2026-08-01', null)).toBeNull();
  });

  it('reads the status case- and space-insensitively, and survives a missing one', () => {
    expect(call(' confirmed ', null, '2026-09-05')).toBe('IN_PRODUCTION');
    expect(call(null, null, '2026-09-05')).toBeNull();
  });
});
