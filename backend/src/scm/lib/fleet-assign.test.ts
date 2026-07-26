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

  it('spills EVERY group to 3PL overflow when no lorry is dispatchable (A3)', () => {
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
    expect(r.overflow).toHaveLength(2);
    expect(r.overflow[0].reason).toMatch(/3pl/i);
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

describe('assignFleet — A3 driver-leave exclusion', () => {
  it('does NOT auto-crew a driver on leave that day — it picks a free driver', () => {
    const r = assignFleet({
      groups: [group('A', { date: '2026-08-01' })],
      lorries: [lorry('l1', { plate: 'WXY1234' })],
      // d2 is the plate-paired driver but is on leave 08-01 -> d1 takes it.
      drivers: [driver('d1', 'ZZZ0000'), driver('d2', 'WXY 1234')],
      helpers: [helper('h1')],
      config: CFG,
      driverLeave: [{ driverId: 'd2', from: '2026-08-01', to: '2026-08-03', reason: 'MC' }],
    });
    expect(r.assignments[0].driverId).toBe('d1');
  });

  it('the SAME driver is eligible again on a date OUTSIDE the leave range', () => {
    const r = assignFleet({
      groups: [group('A', { date: '2026-08-05' })],
      lorries: [lorry('l1', { plate: 'WXY1234' })],
      drivers: [driver('d2', 'WXY 1234')],
      helpers: [],
      config: CFG,
      driverLeave: [{ driverId: 'd2', from: '2026-08-01', to: '2026-08-03', reason: 'MC' }],
    });
    // 08-05 is after the leave -> the paired driver is back.
    expect(r.assignments[0].driverId).toBe('d2');
  });

  it('leaves the driver empty when the only driver is on leave', () => {
    const r = assignFleet({
      groups: [group('A', { date: '2026-08-02' })],
      lorries: [lorry('l1')],
      drivers: [driver('d1')],
      helpers: [],
      config: CFG,
      driverLeave: [{ driverId: 'd1', from: '2026-08-02', to: '2026-08-02', reason: 'annual' }],
    });
    // The trip still ships on the lorry; only the auto driver-pick is withheld.
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].driverId).toBeNull();
  });
});

describe('assignFleet — WS2 helper-leave exclusion', () => {
  it('does NOT auto-crew a helper on leave that day — it picks a free helper', () => {
    const r = assignFleet({
      groups: [group('A', { date: '2026-08-01' })],
      lorries: [lorry('l1')],
      drivers: [driver('d1')],
      // h1 is first but on leave 08-01 -> h2 takes it.
      helpers: [helper('h1'), helper('h2')],
      config: CFG,
      helperLeave: [{ helperId: 'h1', from: '2026-08-01', to: '2026-08-03', reason: 'MC' }],
    });
    expect(r.assignments[0].helperId).toBe('h2');
  });

  it('leaves the helper empty when the only helper is on leave', () => {
    const r = assignFleet({
      groups: [group('A', { date: '2026-08-02' })],
      lorries: [lorry('l1')],
      drivers: [driver('d1')],
      helpers: [helper('h1')],
      config: CFG,
      helperLeave: [{ helperId: 'h1', from: '2026-08-02', to: '2026-08-02', reason: 'annual' }],
    });
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].helperId).toBeNull();
  });

  it('the SAME helper is eligible again on a date OUTSIDE the leave range', () => {
    const r = assignFleet({
      groups: [group('A', { date: '2026-08-05' })],
      lorries: [lorry('l1')],
      drivers: [driver('d1')],
      helpers: [helper('h1')],
      config: CFG,
      helperLeave: [{ helperId: 'h1', from: '2026-08-01', to: '2026-08-03', reason: 'MC' }],
    });
    expect(r.assignments[0].helperId).toBe('h1');
  });
});

describe('assignFleet — A3 3PL overflow (own-fleet slots)', () => {
  it('spills the group beyond the fleet slots to overflow (default 1 trip/lorry/day)', () => {
    const r = assignFleet({
      groups: [group('A'), group('B'), group('C')],
      lorries: [lorry('l1'), lorry('l2')],   // 2 lorries, 1 slot each -> 1 overflow
      drivers: [driver('d1'), driver('d2')],
      helpers: [],
      config: CFG,
    });
    expect(r.assignments).toHaveLength(2);
    expect(r.overflow).toHaveLength(1);
    expect(r.overflow[0].key).toBe('C');
    expect(r.overflow[0].reason).toMatch(/own fleet is full/i);
  });

  it('honours a higher maxTripsPerLorryPerDay before spilling', () => {
    const r = assignFleet({
      groups: [group('A'), group('B'), group('C')],
      lorries: [lorry('l1'), lorry('l2')],
      drivers: [driver('d1'), driver('d2')],
      helpers: [],
      config: { ...CFG, maxTripsPerLorryPerDay: 2 },   // 2 lorries x 2 trips -> all 3 fit
    });
    expect(r.assignments).toHaveLength(3);
    expect(r.overflow).toHaveLength(0);
  });

  it('overflow is per-day: a second date gets its own fresh slots', () => {
    const r = assignFleet({
      groups: [
        group('A', { date: '2026-08-01' }),
        group('B', { date: '2026-08-01' }),   // overflow on 08-01 (1 lorry, 1 slot)
        group('C', { date: '2026-08-02' }),   // fits on 08-02
      ],
      lorries: [lorry('l1')],
      drivers: [driver('d1')],
      helpers: [],
      config: CFG,
    });
    expect(r.overflow).toHaveLength(1);
    expect(r.overflow[0].date).toBe('2026-08-01');
    expect(r.assignments.map((a) => a.date).sort()).toEqual(['2026-08-01', '2026-08-02']);
  });
});
