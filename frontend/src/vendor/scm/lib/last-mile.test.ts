import { describe, expect, test } from 'vitest';
import { isLastMileRow, lastMileSideOf, isToArrangeRow, lastMileListSideOf, isAssignedNoTripRow, isLastMileJobRow, proposeCrewDocNos, matchCrewSuggestions, LAST_MILE_SIDE_LABEL, isEastMalaysiaOrSingaporeStop } from './last-mile';
import type { PlanningOrder } from './delivery-planning-queries';

/* The Last Mile page's row derivation (owner pipeline 2026-08-07/08). The rows
 * are the SO rows whose server-stamped live trip sits on the picked day — the
 * page derives NOTHING itself. Worth pinning: the day filter, the SO-only rule,
 * and the two-sided split (to-run vs delivered) including the fold rule for a
 * day-row whose stage stamp is absent. */

const DAY = '2026-08-10';

const row = (
  over: Partial<Parameters<typeof isLastMileRow>[0] & Parameters<typeof isToArrangeRow>[0]> = {},
) => ({
  row_type: 'so' as const,
  trip_date: DAY as string | null,
  delivery_state: 'PENDING_SCHEDULE' as const,
  arrangement_stage: 'TIME_ARRANGED' as const,
  effective_delivery_date: null as string | null,
  customer_delivery_date: null as string | null,
  processing_date: null as string | null,
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

describe('isToArrangeRow — the day\'s orders not yet on a lorry', () => {
  const due = (over: Parameters<typeof row>[0] = {}) =>
    row({ trip_date: null, arrangement_stage: 'PENDING_TIME', delivery_state: 'PENDING_SCHEDULE', effective_delivery_date: DAY, ...over });

  test('an SO due this day with no live trip is to-arrange', () => {
    expect(isToArrangeRow(due(), DAY)).toBe(true);
  });

  test('due date falls back effective -> customer -> processing', () => {
    expect(isToArrangeRow(due({ effective_delivery_date: null, customer_delivery_date: DAY }), DAY)).toBe(true);
    expect(isToArrangeRow(due({ effective_delivery_date: null, customer_delivery_date: null, processing_date: DAY }), DAY)).toBe(true);
  });

  test('excluded once on a live trip (its trip\'s day owns it) or when delivered', () => {
    expect(isToArrangeRow(due({ trip_date: DAY }), DAY)).toBe(false);
    expect(isToArrangeRow(due({ delivery_state: 'DELIVERED' }), DAY)).toBe(false);
  });

  test('another day, no date, or a non-SO row is out', () => {
    expect(isToArrangeRow(due({ effective_delivery_date: '2026-08-11' }), DAY)).toBe(false);
    expect(isToArrangeRow(due({ effective_delivery_date: null, customer_delivery_date: null, processing_date: null }), DAY)).toBe(false);
    expect(isToArrangeRow(due({ row_type: 'assr' }), DAY)).toBe(false);
  });

  test('a stray timestamp still matches its calendar day', () => {
    expect(isToArrangeRow(due({ effective_delivery_date: `${DAY}T09:00:00Z` }), DAY)).toBe(true);
  });
});

describe('lastMileListSideOf — the list merges trip rows with to-arrange', () => {
  test('a live-trip row keeps its trip side', () => {
    expect(lastMileListSideOf(row(), DAY)).toBe('TIME_ARRANGED');
    expect(lastMileListSideOf(row({ delivery_state: 'DELIVERED', arrangement_stage: null }), DAY)).toBe('DELIVERED');
  });

  test('a due-this-day SO with no trip is TO_ARRANGE', () => {
    expect(lastMileListSideOf(row({ trip_date: null, effective_delivery_date: DAY }), DAY)).toBe('TO_ARRANGE');
  });

  test('off this day entirely is null (no trip, another due date)', () => {
    expect(lastMileListSideOf(row({ trip_date: null, effective_delivery_date: '2026-08-11' }), DAY)).toBeNull();
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

describe('isAssignedNoTripRow — a lorry assigned before a run is opened', () => {
  const crewPlate = (plate: string | null) => ({ lorry_plate: plate } as PlanningOrder['crew']);
  const due = (over: Record<string, unknown> = {}) => ({
    row_type: 'so' as const,
    trip_date: null as string | null,
    delivery_state: 'PENDING_SCHEDULE' as const,
    effective_delivery_date: DAY as string | null,
    customer_delivery_date: null as string | null,
    processing_date: null as string | null,
    crew: null as PlanningOrder['crew'],
    ...over,
  });

  test('due this day with a lorry on its crew = yes (belongs under that lorry)', () => {
    expect(isAssignedNoTripRow(due({ crew: crewPlate('VQE9058') }), DAY)).toBe(true);
  });

  test('no lorry = no (stays in To arrange)', () => {
    expect(isAssignedNoTripRow(due({ crew: null }), DAY)).toBe(false);
    expect(isAssignedNoTripRow(due({ crew: crewPlate(null) }), DAY)).toBe(false);
  });

  test('already on a live trip = no (the trip owns it)', () => {
    expect(isAssignedNoTripRow(due({ trip_date: DAY, crew: crewPlate('VQE9058') }), DAY)).toBe(false);
  });

  test('not due this day = no', () => {
    expect(isAssignedNoTripRow(due({ effective_delivery_date: '2026-08-11', crew: crewPlate('VQE9058') }), DAY)).toBe(false);
  });

  test('a DELIVERED one STAYS — the feed flips an SO to DELIVERED off a LOADED DO, and a lorry\'s loaded drops must not vanish mid-run', () => {
    expect(isAssignedNoTripRow(due({ delivery_state: 'DELIVERED', crew: crewPlate('VRH9058') }), DAY)).toBe(true);
    // still bounded to the picked day — a past-day delivered drop does not pile up
    expect(isAssignedNoTripRow(due({ delivery_state: 'DELIVERED', effective_delivery_date: '2026-08-09', crew: crewPlate('VRH9058') }), DAY)).toBe(false);
  });
});

describe('isLastMileJobRow — a lorry\'s non-SO work of the day (owner 2026-11-02)', () => {
  const crewPlate = (plate: string | null) => ({ lorry_plate: plate } as PlanningOrder['crew']);
  const job = (over: Record<string, unknown> = {}) => ({
    row_type: 'dp' as PlanningOrder['row_type'],
    trip_date: null as string | null,
    delivery_state: 'PENDING_DELIVERY' as PlanningOrder['delivery_state'],
    effective_delivery_date: DAY as string | null,
    customer_delivery_date: null as string | null,
    processing_date: null as string | null,
    crew: crewPlate('VRH9058') as PlanningOrder['crew'],
    ...over,
  });

  test('a DP job on a live trip that day is in (the crew echo stamps its trip_date)', () => {
    expect(isLastMileJobRow(job({ trip_date: DAY, crew: null }), DAY)).toBe(true);
  });

  test('a non-SO job due this day with a lorry on its crew is in — dp, assr and project alike', () => {
    expect(isLastMileJobRow(job(), DAY)).toBe(true);
    expect(isLastMileJobRow(job({ row_type: 'assr' }), DAY)).toBe(true);
    expect(isLastMileJobRow(job({ row_type: 'project' }), DAY)).toBe(true);
  });

  test('an SO row is never a job row — it rides its own two SO paths', () => {
    expect(isLastMileJobRow(job({ row_type: 'so' }), DAY)).toBe(false);
  });

  test('due this day but no lorry = out (nothing to place it under)', () => {
    expect(isLastMileJobRow(job({ crew: null }), DAY)).toBe(false);
    expect(isLastMileJobRow(job({ crew: crewPlate(null) }), DAY)).toBe(false);
  });

  test('another day = out; a stray timestamp still matches its calendar day', () => {
    expect(isLastMileJobRow(job({ effective_delivery_date: '2026-08-11' }), DAY)).toBe(false);
    expect(isLastMileJobRow(job({ effective_delivery_date: `${DAY}T09:00:00Z` }), DAY)).toBe(true);
  });

  test('delivered with no trip = out (historical); delivered on a day trip stays (a completed drop)', () => {
    expect(isLastMileJobRow(job({ delivery_state: 'DELIVERED', trip_date: null }), DAY)).toBe(false);
    expect(isLastMileJobRow(job({ delivery_state: 'DELIVERED', trip_date: DAY }), DAY)).toBe(true);
  });

  test('due date falls back effective -> customer -> processing', () => {
    expect(isLastMileJobRow(job({ effective_delivery_date: null, customer_delivery_date: DAY }), DAY)).toBe(true);
    expect(isLastMileJobRow(job({ effective_delivery_date: null, customer_delivery_date: null, processing_date: DAY }), DAY)).toBe(true);
  });
});

describe('isEastMalaysiaOrSingaporeStop — kept off Last Mile (owner 2026-10-25)', () => {
  test('Singapore is caught by country, even though it folds into the Southern region', () => {
    expect(isEastMalaysiaOrSingaporeStop({ region: 'Southern', state: 'Central', country: 'Singapore' })).toBe(true);
    expect(isEastMalaysiaOrSingaporeStop({ region: 'Southern', state: 'West', country: ' singapore ' })).toBe(true);
  });

  test('East Malaysia is caught by the EM region bucket', () => {
    expect(isEastMalaysiaOrSingaporeStop({ region: 'EM', state: 'Sabah', country: 'Malaysia' })).toBe(true);
  });

  test('East Malaysia states are a fallback when the region was not classified EM', () => {
    expect(isEastMalaysiaOrSingaporeStop({ region: '', state: 'Sarawak', country: null })).toBe(true);
    expect(isEastMalaysiaOrSingaporeStop({ state: 'labuan' })).toBe(true);
  });

  test('peninsular Malaysia and Southern-Malaysia stops stay ON the board', () => {
    expect(isEastMalaysiaOrSingaporeStop({ region: 'KL', state: 'Selangor', country: 'Malaysia' })).toBe(false);
    // Johor is Southern too, but it is NOT Singapore — must not be dropped.
    expect(isEastMalaysiaOrSingaporeStop({ region: 'Southern', state: 'Johor', country: 'Malaysia' })).toBe(false);
  });

  test('empty / missing geography does not drop a stop', () => {
    expect(isEastMalaysiaOrSingaporeStop({})).toBe(false);
    expect(isEastMalaysiaOrSingaporeStop({ region: null, state: null, country: null })).toBe(false);
  });
});
