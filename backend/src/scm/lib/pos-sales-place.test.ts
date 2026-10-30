import { describe, expect, test } from 'vitest';
import type { FairProjectRow } from './fair-options';
import {
  NO_VENUE,
  applySalesPlace,
  readSalesPlace,
  salesPlaceFacet,
  salesPlaceSql,
  type SalesPlaceFilterable,
} from './pos-sales-place';

/** Records every builder call, in order, so a test can read the filter it built. */
class FakeBuilder implements SalesPlaceFilterable<FakeBuilder> {
  calls: string[] = [];
  eq(column: string, value: number) { this.calls.push(`eq ${column} ${value}`); return this; }
  is(column: string, value: null) { this.calls.push(`is ${column} ${String(value)}`); return this; }
  ilike(column: string, pattern: string) { this.calls.push(`ilike ${column} ${pattern}`); return this; }
  or(filters: string) { this.calls.push(`or ${filters}`); return this; }
}

const fair = (over: Partial<FairProjectRow> & { projectId: number }): FairProjectRow => ({
  venue: 'SUNWAY PYRAMID', organizer: 'MEGAHOME', brand: '2990', startDate: '2026-10-03',
  endDate: '2026-10-12', status: 'active', eventType: 'exhibition', ...over,
});

describe('readSalesPlace', () => {
  test('nothing picked is no filter', () => {
    expect(readSalesPlace(undefined, undefined)).toBeNull();
    expect(readSalesPlace('', '  ')).toBeNull();
  });

  test('an event id wins over a venue', () => {
    expect(readSalesPlace('41', '2990s PJ')).toEqual({ kind: 'event', projectId: 41 });
  });

  test('a venue is trimmed; the no-venue value passes through', () => {
    expect(readSalesPlace(undefined, '  2990s PJ ')).toEqual({ kind: 'venue', venue: '2990s PJ' });
    expect(readSalesPlace(undefined, NO_VENUE)).toEqual({ kind: 'venue', venue: NO_VENUE });
  });

  test('a malformed or out-of-range id never reaches the integer column', () => {
    for (const bad of ['abc', '0', '-3', '4.5', '1e3', '2147483648', '99999999999']) {
      expect(readSalesPlace(bad, undefined)).toBeNull();
    }
    expect(readSalesPlace('2147483647', undefined)).toEqual({ kind: 'event', projectId: 2147483647 });
    expect(readSalesPlace('abc', 'Mid Valley')).toEqual({ kind: 'venue', venue: 'Mid Valley' });
  });
});

describe('the tiles and the board narrow the same way', () => {
  test('an event: its linked orders', () => {
    expect(salesPlaceSql({ kind: 'event', projectId: 41 })).toEqual({ sql: 'project_id = ?', binds: [41] });
    const b = applySalesPlace(new FakeBuilder(), { kind: 'event', projectId: 41 });
    expect(b.calls).toEqual(['eq project_id 41']);
  });

  test('a venue: its orders linked to no event, case and outer spaces ignored', () => {
    expect(salesPlaceSql({ kind: 'venue', venue: '2990s PJ' })).toEqual({
      sql: 'project_id IS NULL AND lower(btrim(venue)) = lower(?)',
      binds: ['2990s PJ'],
    });
    const b = applySalesPlace(new FakeBuilder(), { kind: 'venue', venue: '2990s PJ' });
    expect(b.calls).toEqual(['is project_id null', 'ilike venue 2990s PJ']);
  });

  test('a venue is matched literally, never as a LIKE pattern', () => {
    const b = applySalesPlace(new FakeBuilder(), { kind: 'venue', venue: 'HALL_A 50%' });
    expect(b.calls).toEqual(['is project_id null', 'ilike venue HALL\\_A 50\\%']);
  });

  test('no venue recorded: unlinked orders whose venue is empty, null or spaces', () => {
    expect(salesPlaceSql({ kind: 'venue', venue: NO_VENUE })).toEqual({
      sql: "project_id IS NULL AND NULLIF(btrim(venue), '') IS NULL",
      binds: [],
    });
    const b = applySalesPlace(new FakeBuilder(), { kind: 'venue', venue: NO_VENUE });
    expect(b.calls).toEqual(['is project_id null', 'or venue.is.null,venue.match.^\\s*$']);
  });

  test('no pick leaves both untouched', () => {
    expect(salesPlaceSql(null)).toBeNull();
    expect(applySalesPlace(new FakeBuilder(), null).calls).toEqual([]);
  });
});

describe('salesPlaceFacet', () => {
  test('venues by name with none-recorded last, then events by start date', () => {
    const rows = [
      { projectid: 42, venuename: 'IOI CITY MALL', cnt: 1 },
      { projectid: null, venuename: '', cnt: 2 },
      { projectid: null, venuename: 'Kelana Jaya', cnt: 3 },
      { projectid: 41, venuename: 'SUNWAY PYRAMID', cnt: 2 },
      { projectid: null, venuename: '2990s PJ', cnt: 5 },
    ];
    const events = new Map([
      [41, fair({ projectId: 41 })],
      [42, fair({ projectId: 42, venue: 'IOI CITY MALL', organizer: 'ROADSHOW CO', eventType: 'solo', startDate: '2026-10-17', endDate: '2026-10-26' })],
    ]);
    expect(salesPlaceFacet(rows, events)).toEqual([
      { kind: 'venue', venue: '2990s PJ', count: 5 },
      { kind: 'venue', venue: 'Kelana Jaya', count: 3 },
      { kind: 'venue', venue: null, count: 2 },
      {
        kind: 'event', projectId: 41, venue: 'SUNWAY PYRAMID', organizer: 'MEGAHOME', solo: false,
        brand: '2990', startDate: '2026-10-03', endDate: '2026-10-12', count: 2,
      },
      {
        kind: 'event', projectId: 42, venue: 'IOI CITY MALL', organizer: 'ROADSHOW CO', solo: true,
        brand: '2990', startDate: '2026-10-17', endDate: '2026-10-26', count: 1,
      },
    ]);
  });

  test('every order lands in exactly one entry, so the entries add up to the tile', () => {
    const rows = [
      { projectid: null, venuename: '2990s PJ', cnt: 5 },
      { projectid: 41, venuename: 'SUNWAY PYRAMID', cnt: 2 },
      { projectid: null, venuename: '', cnt: 1 },
    ];
    const total = salesPlaceFacet(rows, new Map()).reduce((s, e) => s + e.count, 0);
    expect(total).toBe(8);
  });

  test('an event whose project could not be read keeps its orders, with no facts', () => {
    expect(salesPlaceFacet([{ projectid: '77', venuename: 'Somewhere', cnt: 4 }], new Map())).toEqual([
      {
        kind: 'event', projectId: 77, venue: null, organizer: null, solo: false,
        brand: null, startDate: null, endDate: null, count: 4,
      },
    ]);
  });

  test('blank facts read as null, never as an empty name', () => {
    const [entry] = salesPlaceFacet(
      [{ projectid: 41, venuename: 'x', cnt: 1 }],
      new Map([[41, fair({ projectId: 41, organizer: '  ', brand: '', endDate: null })]]),
    );
    expect(entry).toMatchObject({ organizer: null, brand: null, endDate: null });
  });

  test('an empty or zero row is skipped', () => {
    expect(salesPlaceFacet([{ projectid: null, venuename: 'A', cnt: 0 }], new Map())).toEqual([]);
  });
});
