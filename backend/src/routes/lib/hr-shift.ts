/* HR shift groups (HC-0125): a per-employee shift that overrides the single
 * global pay-rules shift for lateness and OT. A group has a base shift
 * (start/end, minutes from midnight) and, for warehouse crew, a delivery-day
 * shift used on a day DP sent them on a delivery (they come in earlier).
 *
 * Pure; the DB side (loading groups, the employee->group map and the delivery
 * days from the trip rows) is in hr-shift-store.ts. Backend-only, not a shared
 * mirror: the frontend never recomputes lateness, it only edits the groups. */
import type { AttendanceRules } from "../../scm/shared/hr-attendance";

export type ShiftGroupShift = {
  startMin: number;
  endMin: number;
  deliveryStartMin: number | null;
  deliveryEndMin: number | null;
};

/** Valid shift window: within the day, end after start, lunch not the whole shift. */
export function shiftWindowProblem(startMin: number, endMin: number): string | null {
  if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) return "Shift times must be whole minutes.";
  if (startMin < 0 || endMin > 24 * 60) return "Shift times must be within the day (00:00 to 24:00).";
  if (endMin <= startMin) return "Shift end must be after shift start.";
  return null;
}

/** The day rules for an employee: the global rules with the group's shift
 *  start/end (or its delivery-day shift) in place and the standard day
 *  recomputed. No group keeps the global shift. Grace, blocks and lunch length
 *  stay from the global rules. */
export function shiftRulesFor(base: AttendanceRules, group: ShiftGroupShift | null, onDelivery: boolean): AttendanceRules {
  if (!group) return base;
  const useDelivery = onDelivery && group.deliveryStartMin !== null && group.deliveryEndMin !== null;
  const startMin = useDelivery ? (group.deliveryStartMin as number) : group.startMin;
  const endMin = useDelivery ? (group.deliveryEndMin as number) : group.endMin;
  return { ...base, startMin, endMin, standardWorkMin: Math.max(0, endMin - startMin - base.lunchMin) };
}

/** The delivery-day set key: one employee on one calendar date. */
export const deliveryKey = (employeeId: number, workDate: string): string => `${employeeId}:${workDate}`;
