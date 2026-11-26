
import type { PlanningOrder } from './delivery-planning-queries';

/** Same rule as the backend: digits only, '+' prefix, >= 8 digits or unusable. */
export const phoneKey = (raw: string | null | undefined): string | null => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? `+${digits}` : null;
};

export type DriverInfoPayload = {
  driverName: string;
  driverContact: string;
  driverIc: string;
  carPlate: string;
  deliveryTime: string;
};

/** Why a customer group cannot send a Driver Info message yet, or null = ready. */
export type DriverGroupBlock = 'no_driver' | 'not_linked' | 'no_contact' | 'no_time' | null;

export type DriverGroupPlan = {
  driver: Omit<DriverInfoPayload, 'deliveryTime'> | null;
  mixedDrivers: boolean;
  block: DriverGroupBlock;
  payload: DriverInfoPayload | null;
};

const trimmed = (v: string | null | undefined): string => String(v ?? '').trim();

/** The group's Time Slot (board column `time_range`) as the default delivery
 *  time: each distinct slot once, in order, so two orders on different slots
 *  both reach the customer. '' when no order has one. */
export const groupTimeSlot = (rows: PlanningOrder[]): string =>
  [...new Set(rows.map((r) => trimmed(r.time_range)).filter(Boolean))].join(' / ');

/** Build the Driver Info send plan for one customer phone group: the driver
 *  pulled from the orders' crew (the first order that names one) + the operator's
 *  typed time for this customer. IC is optional — a driver with no IC on file
 *  still sends, the message just omits it (same as the board shows "—"). */
export function planDriverInfoGroup(rows: PlanningOrder[], deliveryTime: string): DriverGroupPlan {
  const named = rows.filter((r) => trimmed(r.crew?.driver_1_name));
  const distinct = new Set(named.map((r) => trimmed(r.crew?.driver_1_name)));
  const src = named[0]?.crew ?? null;

  if (!src) return { driver: null, mixedDrivers: false, block: 'no_driver', payload: null };

  const driver = {
    driverName: trimmed(src.driver_1_name),
    driverContact: trimmed(src.driver_1_contact),
    driverIc: trimmed(src.driver_1_ic),
    carPlate: trimmed(src.lorry_plate),
  };
  const mixedDrivers = distinct.size > 1;

  if (src.driver_1_typed) return { driver, mixedDrivers, block: 'not_linked', payload: null };

  if (!driver.driverContact) return { driver, mixedDrivers, block: 'no_contact', payload: null };

  const time = trimmed(deliveryTime);
  if (!time) return { driver, mixedDrivers, block: 'no_time', payload: null };

  return { driver, mixedDrivers, block: null, payload: { ...driver, deliveryTime: time } };
}
