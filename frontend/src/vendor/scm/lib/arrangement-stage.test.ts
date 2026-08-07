import { describe, expect, test } from 'vitest';
import {
  dateArrangementOf,
  timeArrangementOf,
  arrangementStageLabel,
  ARRANGEMENT_STAGE_LABEL,
  DATE_ARRANGEMENT_LABEL,
} from './delivery-planning-queries';

/* The FRONTEND half of the arrangement pipeline (owner spec 2026-08-07).
 *
 * The stage itself is derived SERVER-side (backend lib/arrangement-stage.ts,
 * pinned by backend/tests/arrangementStage.test.ts) and stamped on every board
 * row — these helpers only FOLD the stamped field into the two page views and
 * must never re-derive it from dates/trips (one shared logic layer). What is
 * worth pinning here is exactly that folding, plus the DEGRADATION rule: a
 * cached pre-upgrade payload has NO arrangement_stage field at all, and both
 * pages must fall back to their old show-everything behaviour rather than
 * blanking a queue. */

describe('dateArrangementOf — the Delivery Date Arrangement split', () => {
  test('PENDING_DATE stays pending; both later stages read as Date arranged', () => {
    expect(dateArrangementOf({ arrangement_stage: 'PENDING_DATE' })).toBe('PENDING_DATE');
    expect(dateArrangementOf({ arrangement_stage: 'PENDING_TIME' })).toBe('DATE_ARRANGED');
    expect(dateArrangementOf({ arrangement_stage: 'TIME_ARRANGED' })).toBe('DATE_ARRANGED');
  });

  test('out of pipeline (null) is nobody\'s queue', () => {
    expect(dateArrangementOf({ arrangement_stage: null })).toBeNull();
  });

  test('a pre-upgrade row (field absent) lands in the PENDING queue, never vanishes', () => {
    expect(dateArrangementOf({})).toBe('PENDING_DATE');
    expect(dateArrangementOf({ arrangement_stage: undefined })).toBe('PENDING_DATE');
  });
});

describe('timeArrangementOf — the Delivery Time Arrangement split', () => {
  test('only date-confirmed orders exist for the Time page', () => {
    expect(timeArrangementOf({ arrangement_stage: 'PENDING_TIME' })).toBe('PENDING_TIME');
    expect(timeArrangementOf({ arrangement_stage: 'TIME_ARRANGED' })).toBe('TIME_ARRANGED');
    /* An order still awaiting its date belongs to Date Arrangement — the Trips
       inbox shows it only as an "awaiting date" count. */
    expect(timeArrangementOf({ arrangement_stage: 'PENDING_DATE' })).toBeNull();
    expect(timeArrangementOf({ arrangement_stage: null })).toBeNull();
  });

  test('a pre-upgrade row (field absent) degrades to the old show-everything inbox', () => {
    expect(timeArrangementOf({})).toBe('PENDING_TIME');
  });
});

describe('labels — the owner\'s naming, one map each side', () => {
  test('stage labels', () => {
    expect(ARRANGEMENT_STAGE_LABEL.PENDING_DATE).toBe('Pending Date Arrangement');
    expect(ARRANGEMENT_STAGE_LABEL.PENDING_TIME).toBe('Pending Time Arrangement');
    expect(ARRANGEMENT_STAGE_LABEL.TIME_ARRANGED).toBe('Time arranged');
    expect(DATE_ARRANGEMENT_LABEL.DATE_ARRANGED).toBe('Date arranged');
  });

  test('the board column reads the stage label, blank outside the pipeline', () => {
    expect(arrangementStageLabel({ arrangement_stage: 'PENDING_TIME' })).toBe('Pending Time Arrangement');
    expect(arrangementStageLabel({ arrangement_stage: null })).toBe('');
    expect(arrangementStageLabel({})).toBe('');
  });
});
