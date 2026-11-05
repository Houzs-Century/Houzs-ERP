import { describe, expect, it } from 'vitest';
import { crewToCopy, seatsForTarget } from './crew-paste';
import type { PlanningOrder } from './delivery-planning-queries';

const order = (crew: Partial<NonNullable<PlanningOrder['crew']>>) => ({
  row_type: 'so',
  crew: { driver: null, helper: null, lorry: null, driver_1_name: null, driver_1_ic: null, driver_1_contact: null, driver_2_name: null, helper_1_name: null, helper_2_name: null, lorry_plate: null, ...crew },
}) as unknown as PlanningOrder;

const drivers = [{ id: 'd1', name: 'Khalid' }, { id: 'd2', name: 'Ali' }, { id: 'd3', name: 'Twin' }, { id: 'd4', name: 'Twin' }];
const lorries = [{ id: 'l1', plate: 'VAB 1234' }];
const helpers = [{ id: 'h1', name: 'Sam' }];

// HC-0191: copy a row's crew once, paste it onto the other bills.
describe('crewToCopy', () => {
  it('resolves names to ids and keeps only the filled seats', () => {
    const r = crewToCopy(order({ driver_1_name: 'Khalid', lorry_plate: 'VAB 1234', helper_1_name: 'Sam' }), drivers, lorries, helpers);
    expect(r.seats).toEqual({ lorryId: 'l1', driver1Id: 'd1', helper1Id: 'h1' });
    expect(r.unresolved).toEqual([]);
  });
  it('reports a name that is unknown or shared instead of guessing', () => {
    const r = crewToCopy(order({ driver_1_name: 'Twin', helper_2_name: 'Nobody' }), drivers, lorries, helpers);
    expect(r.seats).toEqual({});
    expect(r.unresolved).toEqual(['Driver', 'Helper 2']);
  });
});

describe('seatsForTarget', () => {
  it('drops driver 2 for DP and service-case rows only', () => {
    const seats = { driver1Id: 'd1', driver2Id: 'd2' };
    expect(seatsForTarget(seats, { row_type: 'so' })).toEqual(seats);
    expect(seatsForTarget(seats, { row_type: 'dp' })).toEqual({ driver1Id: 'd1' });
    expect(seatsForTarget(seats, { row_type: 'assr' })).toEqual({ driver1Id: 'd1' });
  });
});
