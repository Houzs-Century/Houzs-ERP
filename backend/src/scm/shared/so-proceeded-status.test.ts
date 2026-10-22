/* THE RULE HAS TO REFUSE, OR IT IS NOT A RULE.
 *
 * Setting a Processing Date on a CONFIRMED order IS the proceed, so the board
 * must show it in production. The dangerous half is everything this must NOT
 * do — a rule that fires too widely drags a delivered order back into
 * production, and that is worse than the gap it closes.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_DELIVERY_PAST_PROBLEM,
  liveStatusForProcessingDate,
  processingDateOnConfirm,
  statusAfterProcessingDateSet,
} from './so-proceeded-status';

describe('liveStatusForProcessingDate — where a live order lands', () => {
  it('lands IN_PRODUCTION when the order already carries a Processing Date', () => {
    expect(liveStatusForProcessingDate('2026-10-20')).toBe('IN_PRODUCTION');
  });

  it('lands CONFIRMED when there is no date — blank and whitespace are no date', () => {
    expect(liveStatusForProcessingDate(null)).toBe('CONFIRMED');
    expect(liveStatusForProcessingDate(undefined)).toBe('CONFIRMED');
    expect(liveStatusForProcessingDate('')).toBe('CONFIRMED');
    expect(liveStatusForProcessingDate('   ')).toBe('CONFIRMED');
  });
});

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

describe('processingDateOnConfirm — HC-0113, a late confirm proceeds on the confirm day', () => {
  const today = '2026-10-13';
  const on = (processingDate: string | null, deliveryDate: string | null) =>
    processingDateOnConfirm({ processingDate, deliveryDate, todayMY: today });

  it('moves a past Processing Date to the confirm day (HC-SO-2609-077: 18/9 confirmed 13/10)', () => {
    expect(on('2026-09-18', '2026-10-26')).toEqual({ ok: true, write: '2026-10-13' });
    expect(on('2026-09-18T00:00:00+00:00', '2026-10-26')).toEqual({ ok: true, write: '2026-10-13' });
  });

  it('keeps today and future dates', () => {
    expect(on('2026-10-13', '2026-10-26')).toEqual({ ok: true, write: null });
    expect(on('2026-10-20', '2026-10-26')).toEqual({ ok: true, write: null });
  });

  it('does nothing for a draft with no Processing Date', () => {
    expect(on(null, null)).toEqual({ ok: true, write: null });
    expect(on('  ', '2026-09-01')).toEqual({ ok: true, write: null });
  });

  it('refuses when the Delivery Date has also passed, rather than leave Processing after Delivery', () => {
    expect(on('2026-09-18', '2026-10-01')).toEqual({ ok: false, problem: CONFIRM_DELIVERY_PAST_PROBLEM });
  });

  it('allows a Delivery Date of today', () => {
    expect(on('2026-09-18', '2026-10-13')).toEqual({ ok: true, write: '2026-10-13' });
  });
});
