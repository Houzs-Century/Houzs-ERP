import { describe, expect, test } from 'vitest';
import { resolveCrewSeats } from '../src/scm/lib/crew-seats';

/* The crew row is one UPSERT, so a seat the caller does not mention must be
   written back from what was there — otherwise a board edit that touches one
   seat would wipe the other four. */

const before = {
  driver_1_id: 'd1', driver_2_id: 'd2',
  helper_1_id: 'h1', helper_2_id: 'h2', lorry_id: 'L1',
};

describe('resolveCrewSeats', () => {
  test('a single-seat board edit keeps the other four seats', () => {
    // The board changes only the driver; it sends only driver1Id.
    expect(resolveCrewSeats({ driver1Id: 'd9' }, before)).toEqual({
      driver1Id: 'd9', driver2Id: 'd2', helper1Id: 'h1', helper2Id: 'h2', lorryId: 'L1',
    });
  });

  test('an explicit null clears just that seat, leaving the rest', () => {
    expect(resolveCrewSeats({ helper2Id: null }, before)).toEqual({
      driver1Id: 'd1', driver2Id: 'd2', helper1Id: 'h1', helper2Id: null, lorryId: 'L1',
    });
    // '' clears too (a picker's "— none —").
    expect(resolveCrewSeats({ lorryId: '' }, before).lorryId).toBeNull();
  });

  test('FleetDay sends all five, so its full re-assign is unchanged', () => {
    expect(resolveCrewSeats(
      { driver1Id: 'x', driver2Id: null, helper1Id: 'y', helper2Id: null, lorryId: 'z' },
      before,
    )).toEqual({ driver1Id: 'x', driver2Id: null, helper1Id: 'y', helper2Id: null, lorryId: 'z' });
  });

  test('the first assignment (no crew row yet) starts from empty seats', () => {
    expect(resolveCrewSeats({ driver1Id: 'd1' }, {})).toEqual({
      driver1Id: 'd1', driver2Id: null, helper1Id: null, helper2Id: null, lorryId: null,
    });
  });

  test('a whitespace-only id is treated as cleared, not a real master id', () => {
    expect(resolveCrewSeats({ driver1Id: '   ' }, before).driver1Id).toBeNull();
  });
});
