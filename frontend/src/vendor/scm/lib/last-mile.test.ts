import { describe, expect, test } from 'vitest';
import { isLastMileRow, lastMileSideOf, proposeCrewDocNos, matchCrewSuggestions, LAST_MILE_SIDE_LABEL } from './last-mile';

/* The Last Mile page's row derivation (owner pipeline 2026-08-07/08). The rows
 * are the SO rows whose server-stamped live trip sits on the picked day — the
 * page derives NOTHING itself. Worth pinning: the day filter, the SO-only rule,
 * and the two-sided split (to-run vs delivered) including the fold rule for a
 * day-row whose stage stamp is absent. */

const DAY = '2026-08-10';

const row = (over: Partial<Parameters<typeof isLastMileRow>[0]> = {}) => ({
  row_type: 'so' as const,
  trip_date: DAY,
  delivery_state: 'PENDING_SCHEDULE' as const,
  arrangement_stage: 'TIME_ARRANGED' as const,
  ...over,
});

describe('isLastMileRow — the picked day owns the board', () => {
  test('an SO row on a live trip that day is in', () => {
    expect(isLastMileRow(row(), DAY)).toBe(true);
  });

  test('no trip, another day, or a timestamped same-day value', () => {
    expect(isLastMileRow(row({ trip_date: null }), DAY)).toBe(false);
    expect(isLastMileRow(row({ trip_date: '2026-08-11' }), DAY)).toBe(false);
    /* A stray timestamp still matches its calendar day. */
    expect(isLastMileRow(row({ trip_date: `${DAY}T00:00:00Z` }), DAY)).toBe(true);
  });

  test('non-SO rows never join — their scheduling lives on their own documents', () => {
    expect(isLastMileRow(row({ row_type: 'assr' }), DAY)).toBe(false);
    expect(isLastMileRow(row({ row_type: 'dp' }), DAY)).toBe(false);
    expect(isLastMileRow(row({ row_type: 'project' }), DAY)).toBe(false);
  });
});

describe('lastMileSideOf — to-run vs delivered', () => {
  test('a time-arranged order is the to-run side', () => {
    expect(lastMileSideOf(row(), DAY)).toBe('TIME_ARRANGED');
  });

  test('a DELIVERED order with a trip that day is the done side (stage stamp is null there)', () => {
    expect(lastMileSideOf(row({ delivery_state: 'DELIVERED', arrangement_stage: null }), DAY)).toBe('DELIVERED');
  });

  test('a day-row with no stage stamp still folds into to-run — never invisible on its own day', () => {
    expect(lastMileSideOf(row({ arrangement_stage: undefined, delivery_state: 'PENDING_DELIVERY' }), DAY)).toBe('TIME_ARRANGED');
  });

  test('off-day rows are nobody\'s side', () => {
    expect(lastMileSideOf(row({ trip_date: null }), DAY)).toBeNull();
    expect(lastMileSideOf(row({ trip_date: '2026-08-11' }), DAY)).toBeNull();
  });

  test('labels', () => {
    expect(LAST_MILE_SIDE_LABEL.TIME_ARRANGED).toBe('Time arranged');
    expect(LAST_MILE_SIDE_LABEL.DELIVERED).toBe('Delivered');
  });
});

describe('proposeCrewDocNos — crew is proposed only for the day\'s already-sequenced runs', () => {
  const withDoc = (docNo: string, over: Parameters<typeof row>[0] = {}) => ({ ...row(over), so_doc_no: docNo });

  test('THE pin: only TIME_ARRANGED rows of the picked day make the candidate list', () => {
    const docs = proposeCrewDocNos([
      withDoc('SO-RUN-1'),                                                      // on a run today -> in
      withDoc('SO-RUN-2'),                                                      // on a run today -> in
      withDoc('SO-DONE', { delivery_state: 'DELIVERED', arrangement_stage: null }), // delivered -> no crew needed
      withDoc('SO-TOMORROW', { trip_date: '2026-08-11' }),                      // another day's run -> not this day's
      withDoc('SO-NO-RUN', { trip_date: null, arrangement_stage: 'PENDING_TIME' }), // not sequenced yet -> Time page's business
      withDoc('SO-ASSR', { row_type: 'assr' }),                                 // non-SO -> never
    ], DAY);
    expect(docs).toEqual(['SO-RUN-1', 'SO-RUN-2']);
  });

  test('an empty day proposes nothing', () => {
    expect(proposeCrewDocNos([withDoc('SO-X', { trip_date: '2026-08-12' })], DAY)).toEqual([]);
  });
});

describe('matchCrewSuggestions — crew labels only the day\'s already-sequenced runs', () => {
  const engineRun = (refs: string[], over: Record<string, unknown> = {}) => ({
    lorryId: 'lorry-a', driverId: 'drv-1', driverName: 'Ali',
    helperId: 'hlp-1', helperName: 'Bob',
    stops: refs.map((ref) => ({ ref })),
    ...over,
  });

  test('THE pin: a suggestion attaches only to an EXISTING trip of the day; unknown orders attach to nothing', () => {
    const tripIdByDocNo = new Map([
      ['SO-1', 'trip-A'], ['SO-2', 'trip-A'], ['SO-3', 'trip-B'],
    ]);
    const out = matchCrewSuggestions([
      engineRun(['SO-1', 'SO-2']),                                     // -> trip-A
      engineRun(['SO-3'], { lorryId: 'lorry-b', driverId: 'drv-2', driverName: 'Chan' }), // -> trip-B
      engineRun(['SO-NOT-ON-A-RUN'], { driverId: 'drv-9' }),           // -> nowhere
    ], tripIdByDocNo);
    expect([...out.keys()].sort()).toEqual(['trip-A', 'trip-B']);
    expect(out.get('trip-A')).toMatchObject({ lorryId: 'lorry-a', driverId: 'drv-1' });
    expect(out.get('trip-B')).toMatchObject({ lorryId: 'lorry-b', driverId: 'drv-2' });
    /* No suggestion is ever minted for a run that does not exist. */
    expect(out.size).toBe(2);
  });

  test('an engine run spanning two trips votes for the one carrying MOST of its orders', () => {
    const tripIdByDocNo = new Map([
      ['SO-1', 'trip-A'], ['SO-2', 'trip-B'], ['SO-3', 'trip-B'],
    ]);
    const out = matchCrewSuggestions([engineRun(['SO-1', 'SO-2', 'SO-3'])], tripIdByDocNo);
    expect([...out.keys()]).toEqual(['trip-B']);
  });

  test('one suggestion per trip — a second engine run mapping to the same trip is ignored (first wins)', () => {
    const tripIdByDocNo = new Map([['SO-1', 'trip-A'], ['SO-2', 'trip-A']]);
    const out = matchCrewSuggestions([
      engineRun(['SO-1']),
      engineRun(['SO-2'], { driverId: 'drv-2' }),
    ], tripIdByDocNo);
    expect(out.size).toBe(1);
    expect(out.get('trip-A')?.driverId).toBe('drv-1');
  });
});
