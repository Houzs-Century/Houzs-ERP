const SCOPED_CONFIRMERS: ReadonlyMap<number, ReadonlySet<number>> = new Map([
  // One warehouse confirmer, pinned to one warehouse crew member (owner 2026-11-23).
  [82, new Set([6])],
]);

/** The employee ids this user may see and confirm, or null when unrestricted. */
export function scopedEmployeeIds(userId: number): ReadonlySet<number> | null {
  return SCOPED_CONFIRMERS.get(userId) ?? null;
}
