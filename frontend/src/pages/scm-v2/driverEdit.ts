// Which fields a Fleet "Edit Driver" save sends — only the ones that changed.
//
// inHouse stays OUT of the patch unless the admin actually moved the toggle, so
// renaming a 3PL-linked driver never trips the backend's linked-to-carrier 409
// (scm/routes/drivers.ts resolveCarrierLink refuses ownFlag=true while linked).
// PURE so the diff is testable and cannot silently start sending the toggle.

import type { DriverRow, NewDriver } from '../../vendor/scm/lib/drivers-queries';

export type DriverEditForm = {
  name: string;
  phone: string;
  icNumber: string;
  vehicle: string;
  inHouse: boolean;
};

export type DriverPatch = Partial<NewDriver> & { id: string };

/** A driver's saved in-house flag, reading the one half PostgREST actually sends. */
export const driverInHouse = (d: Pick<DriverRow, 'in_house' | 'inHouse'>): boolean =>
  (d.inHouse ?? d.in_house) !== false;

export function driverEditPatch(driver: DriverRow, next: DriverEditForm): DriverPatch {
  const patch: DriverPatch = { id: driver.id };
  const name = next.name.trim();
  const phone = next.phone.trim();
  if (name !== driver.name) patch.name = name;
  // driver.phone is the stored E.164, so an untouched field diffs clean.
  if (phone !== driver.phone) patch.phone = phone;
  if ((next.icNumber.trim() || null) !== (driver.ic_number ?? null)) patch.icNumber = next.icNumber.trim();
  if ((next.vehicle.trim() || null) !== (driver.vehicle ?? null)) patch.vehicle = next.vehicle.trim();
  if (next.inHouse !== driverInHouse(driver)) patch.inHouse = next.inHouse;
  return patch;
}

/** True when the patch carries only the id — nothing to save. */
export const driverEditUnchanged = (patch: DriverPatch): boolean =>
  Object.keys(patch).length === 1;
