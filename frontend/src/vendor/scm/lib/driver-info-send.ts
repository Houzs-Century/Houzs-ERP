// ----------------------------------------------------------------------------
// driver-info-send.ts — the per-customer plan for the Driver Info WhatsApp send.
//
// The Driver Info message prints the driver (name / IC / contact / plate) and a
// delivery-time window. The driver crew is already on each order — the board's
// Driver / Lorry columns snapshot it onto the DO — so the send READS it per
// order instead of asking the operator to pick again, exactly as Postpone reads
// the row's Amend Reason + Delivery Date. The one thing the ERP does not hold is
// the time window, and it differs from customer to customer, so each customer
// group carries its OWN typed time.
//
// This is the pure part (grouping key + per-group readiness), imported by both
// the modal and its test; the modal owns the state and the per-group sends.
// ----------------------------------------------------------------------------

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
export type DriverGroupBlock = 'no_driver' | 'no_contact' | 'no_time' | null;

export type DriverGroupPlan = {
  /** The driver read off the group's orders, or null when none is assigned. */
  driver: Omit<DriverInfoPayload, 'deliveryTime'> | null;
  /** True when the group's orders name more than one distinct driver. */
  mixedDrivers: boolean;
  /** What is missing, or null when the group is ready to send. */
  block: DriverGroupBlock;
  /** The send payload — set iff block === null. */
  payload: DriverInfoPayload | null;
};

const trimmed = (v: string | null | undefined): string => String(v ?? '').trim();

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

  // The template prints the contact, so a driver with no phone on file cannot send.
  if (!driver.driverContact) return { driver, mixedDrivers, block: 'no_contact', payload: null };

  const time = trimmed(deliveryTime);
  if (!time) return { driver, mixedDrivers, block: 'no_time', payload: null };

  return { driver, mixedDrivers, block: null, payload: { ...driver, deliveryTime: time } };
}
