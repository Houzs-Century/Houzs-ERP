/* Overtime / attendance confirmers pinned to specific employees.
 *
 * A user id NOT listed here is unrestricted — a full HR reader or a broad OT
 * confirmer (Super Admin, HR & Operation Executive) sees every employee in the
 * company, unchanged. A user id listed here is RESTRICTED to the employee ids
 * mapped to it: the attendance day, the month grid and the OT review list show
 * only those employees, and a review of anyone else is refused.
 *
 * Internal ids only (no names — the repo is public). Owner-set and hardcoded
 * for now; a self-serve "supervisor" assignment can replace this map later
 * without touching the call sites, which only ask scopedEmployeeIds(userId).
 */
const SCOPED_CONFIRMERS: ReadonlyMap<number, ReadonlySet<number>> = new Map([
  // One warehouse confirmer, pinned to one warehouse crew member (owner 2026-11-23).
  [82, new Set([6])],
]);

/** The employee ids this user may see and confirm, or null when unrestricted. */
export function scopedEmployeeIds(userId: number): ReadonlySet<number> | null {
  return SCOPED_CONFIRMERS.get(userId) ?? null;
}
