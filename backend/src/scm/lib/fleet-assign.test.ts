import { describe, it, expect } from 'vitest';
import {
  assignFleet,
  type AssignGroup,
  type AssignLorry,
  type AssignDriver,
  type AssignHelper,
  type AssignConfig,
} from './fleet-assign';

const CFG: AssignConfig = { defaultMaxSets: 10, defaultMaxRevenueCenti: 3_000_000 };

function group(key: string, over: Partial<AssignGroup> = {}): AssignGroup {
  return {
    key,
    date: '2026-08-01',
    group: 'KLANG_VALLEY',
    orders: [key],
    sets: 4,
    revenueCenti: 100_000,
    preferredLorryId: null,
    ...over,
  };
}

function lorry(id: string, over: Partial<AssignLorry> = {}): AssignLorry {
  return {
    id,
    plate: id.toUpperCase(),
    dispatchable: true,
    status: 'AVAILABLE',
    maxSets: null,
    maxRevenueCenti: null,
    layer: 'SETS',
    driverId: null,
    driverName: null,
    ...over,
  };
}

const driver = (id: string, vehiclePlate: string | null = null): AssignDriver => ({ id, name: id.toUpperCase(), vehiclePlate });
const helper = (id: string): AssignHelper => ({ id, name: id.toUpperCase() });

describe('assignFleet — Module B availability', () => {
  it('EXCLUDES non-dispatchable lorries and reports why', () => {
    const r = assignFleet({
      groups: [group('SO1')],
      lorries: [
        lorry('l1', { dispatchable: false, status: 'BREAKDOWN' }),
        lorry('l2', { dispatchable: true, status: 'AVAILABLE' }),
      ],
      drivers: [],
      helpers: [],
      config: CFG,
    });
    expect(r.excludedLorries).toEqual([{ id: 'l1', plate: 'L1', status: 'BREAKDOWN' }]);
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].lorryId).toBe('l2');
  });

  it('never assigns a group when EVERY lorry is unavailable', () => {
    const r = assignFleet({
      groups: [group('SO1'), group('SO2')],
      lorries: [
        lorry('l1', { dispatchable: false, status: 'COMPLIANCE_BLOCKED' }),
        lorry('l2', { dispatchable: false, status: 'OUT_OF_SERVICE' }),
      ],
      drivers: [driver('d1')],
      helpers: [helper('h1')],
      config: CFG,
    });
    expect(r.assignments).toHaveLength(0);
    expect(r.unassigned).toHaveLength(2);
    expect(r.unassigned[0].reason).toMatch(/no dispatchable lorry/i);
    expect(r.excludedLorries).toHaveLength(2);
  });

  it('a preferred lorry that is now unavailable is NOT chosen — it reroutes', () => {
    const r = assignFleet({
      groups: [group('SO1', { preferredLorryId: 'l1' })],
      lorries: [
        lorry('l1', { dispatchable: false, status: 'OUT_OF_SERVICE' }),
        lorry('l2'),
      ],
      drivers: [],
      helpers: [],
      config: CFG,
    });
    expect(r.assignments[0].lorryId).toBe('l2');
  });
});

describe('assignFleet — capacity fit', () => {
  it('flags overCeiling when a group exceeds the chosen lorry ceiling but still assigns it', () => {
    const r = assignFleet({
      groups: [group('BIG', { sets: 15 })],
      lorries: [lorry('l1', { maxSets: 10, layer: 'SETS' })],
      drivers: [],
      helpers: [],
      config: CFG,
    });
    expect(r.assignments[0].overCeiling).toBe(true);
    expect(r.assignments[0].lorryId).toBe('l1');
    expect(r.assignments[0].ceilingSets).toBe(10);
  });

  it('does not flag overCeiling when the group fits', () => {
    const r = assignFleet({
      groups: [group('OK', { sets: 8 })],
      lorries: [lorry('l1', { maxSets: 10, layer: 'SETS' })],
      drivers: [], helpers: [], config: CFG,
    });
    expect(r.assignments[0].overCeiling).toBe(false);
  });

  it('REVENUE layer measures the revenue ceiling, not sets', () => {
    const r = assignFleet({
      groups: [group('R', { sets: 999, revenueCenti: 2_000_000 })],
      lorries: [lorry('l1', { maxRevenueCenti: 3_000_000, layer: 'REVENUE' })],
      drivers: [], helpers: [], config: CFG,
    });
    expect(r.assignments[0].overCeiling).toBe(false);
    expect(r.assignments[0].ceilingSets).toBeNull();
    expect(r.assignments[0].ceilingRevenueCenti).toBe(3_000_000);
  });
});

describe('assignFleet — load balancing', () => {
  it('spreads a day\'s groups across distinct lorries rather than stacking one', () => {
    const r = assignFleet({
      groups: [group('A'), group('B'), group('C')],
      lorries: [lorry('l1'), lorry('l2'), lorry('l3')],
      drivers: [], helpers: [], config: CFG,
    });
    const used = new Set(r.assignments.map((a) => a.lorryId));
    expect(used.size).toBe(3);
  });

  it('honours the preferred lorry when it is still the least-loaded free choice', () => {
    const r = assignFleet({
      groups: [group('A', { preferredLorryId: 'l2' })],
      lorries: [lorry('l1'), lorry('l2')],
      drivers: [], helpers: [], config: CFG,
    });
    expect(r.assignments[0].lorryId).toBe('l2');
  });

  it('balances per-day: the same lorry is free again on a different date', () => {
    const r = assignFleet({
      groups: [
        group('A', { date: '2026-08-01' }),
        group('B', { date: '2026-08-02' }),
      ],
      lorries: [lorry('l1')],
      drivers: [], helpers: [], config: CFG,
    });
    // One lorry, two days -> both assigned to l1 (each day it is free).
    expect(r.assignments.map((a) => a.lorryId)).toEqual(['l1', 'l1']);
  });
});

describe('assignFleet — crew pairing', () => {
  it('pairs the lorry\'s regular driver by plate', () => {
    const r = assignFleet({
      groups: [group('A')],
      lorries: [lorry('l1', { plate: 'WXY1234' })],
      drivers: [driver('d1', 'ZZZ0000'), driver('d2', 'WXY 1234')],
      helpers: [helper('h1')],
      config: CFG,
    });
    expect(r.assignments[0].driverId).toBe('d2');   // plate matched (space-insensitive)
    expect(r.assignments[0].helperId).toBe('h1');
  });

  it('a driver/helper is used at most once per day', () => {
    const r = assignFleet({
      groups: [group('A'), group('B')],
      lorries: [lorry('l1'), lorry('l2')],
      drivers: [driver('d1'), driver('d2')],
      helpers: [helper('h1')],
      config: CFG,
    });
    const drivers = r.assignments.map((a) => a.driverId);
    expect(new Set(drivers).size).toBe(2);          // two distinct drivers
    const helpers = r.assignments.map((a) => a.helperId);
    expect(helpers[0]).toBe('h1');
    expect(helpers[1]).toBeNull();                  // only one helper -> second trip gets none
  });

  it('falls back to any free driver when no plate match exists', () => {
    const r = assignFleet({
      groups: [group('A')],
      lorries: [lorry('l1', { plate: 'AAA1' })],
      drivers: [driver('d1', 'BBB2')],
      helpers: [],
      config: CFG,
    });
    expect(r.assignments[0].driverId).toBe('d1');
  });
});
