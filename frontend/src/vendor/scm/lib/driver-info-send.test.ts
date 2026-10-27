import { describe, it, expect } from 'vitest';
import { phoneKey, planDriverInfoGroup } from './driver-info-send';
import type { PlanningOrder } from './delivery-planning-queries';

/** A PlanningOrder stub carrying only the crew the plan reads. */
const row = (crew: Partial<NonNullable<PlanningOrder['crew']>> | null): PlanningOrder =>
  ({
    crew: crew === null ? null : {
      driver: null, helper: null, lorry: null,
      driver_1_name: null, driver_1_ic: null, driver_1_contact: null,
      driver_2_name: null, helper_1_name: null, helper_2_name: null, lorry_plate: null,
      ...crew,
    },
  } as unknown as PlanningOrder);

describe('phoneKey', () => {
  it('normalises to +digits when >= 8 digits', () => {
    expect(phoneKey('+60 11-3192 8090')).toBe('+601131928090');
  });
  it('rejects too-short / blank', () => {
    expect(phoneKey('123')).toBeNull();
    expect(phoneKey('')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });
});

describe('planDriverInfoGroup', () => {
  it('reads the driver + IC + contact + plate off the order crew', () => {
    const plan = planDriverInfoGroup(
      [row({ driver_1_name: 'Ali', driver_1_ic: '900101-14-5555', driver_1_contact: '+60123456789', lorry_plate: 'VRH9058' })],
      '10am – 1pm',
    );
    expect(plan.block).toBeNull();
    expect(plan.payload).toEqual({
      driverName: 'Ali', driverContact: '+60123456789', driverIc: '900101-14-5555',
      carPlate: 'VRH9058', deliveryTime: '10am – 1pm',
    });
  });

  it('sends with a blank IC (IC is optional, like the board shows "—")', () => {
    const plan = planDriverInfoGroup(
      [row({ driver_1_name: 'Shamsul', driver_1_contact: '+60111111111' })],
      '2pm – 5pm',
    );
    expect(plan.block).toBeNull();
    expect(plan.payload?.driverIc).toBe('');
  });

  it('blocks when no order in the group has a driver', () => {
    const plan = planDriverInfoGroup([row(null), row({})], '10am');
    expect(plan.block).toBe('no_driver');
    expect(plan.payload).toBeNull();
  });

  it('blocks when the driver has no contact on file', () => {
    const plan = planDriverInfoGroup([row({ driver_1_name: 'Ali' })], '10am');
    expect(plan.block).toBe('no_contact');
    expect(plan.payload).toBeNull();
  });

  it('blocks until a delivery time is typed (whitespace is not a time)', () => {
    const plan = planDriverInfoGroup([row({ driver_1_name: 'Ali', driver_1_contact: '+60123456789' })], '   ');
    expect(plan.block).toBe('no_time');
    expect(plan.payload).toBeNull();
  });

  it('flags a group that mixes more than one driver, and uses the first named one', () => {
    const plan = planDriverInfoGroup(
      [
        row({ driver_1_name: 'Ali', driver_1_contact: '+60123456789' }),
        row({ driver_1_name: 'Bob', driver_1_contact: '+60129999999' }),
      ],
      '10am',
    );
    expect(plan.mixedDrivers).toBe(true);
    expect(plan.driver?.driverName).toBe('Ali');
  });
});
