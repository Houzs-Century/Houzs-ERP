/* HR shift groups — DB side (HC-0125). Loads the groups, the employee->group
 * map and, for a date window, the delivery days (from the trip rows), and
 * returns an employee-aware shift resolver: the global rules with the
 * employee's group shift, or its delivery-day shift on a day a trip row shows
 * them on a delivery. Pure maths is in hr-shift.ts. */
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { getDb } from "../../db/client";
import { hr_employees, hr_shift_groups, hr_trip_rows } from "../../db/schema";
import type { AttendanceRules } from "../../scm/shared/hr-attendance";
import { rulesResolver } from "./hr-attendance-store";
import { deliveryKey, shiftRulesFor, type ShiftGroupShift } from "./hr-shift";

type Db = ReturnType<typeof getDb>;

export type ShiftGroupRow = { id: number; name: string; startMin: number; endMin: number; deliveryStartMin: number | null; deliveryEndMin: number | null; sortOrder: number; active: boolean };

const groupOut = (g: typeof hr_shift_groups.$inferSelect): ShiftGroupRow => ({
  id: g.id,
  name: g.name,
  startMin: g.start_min,
  endMin: g.end_min,
  deliveryStartMin: g.delivery_start_min,
  deliveryEndMin: g.delivery_end_min,
  sortOrder: g.sort_order,
  active: g.active,
});

export async function loadShiftGroups(db: Db, companyId: number): Promise<ShiftGroupRow[]> {
  const rows = await db.select().from(hr_shift_groups).where(eq(hr_shift_groups.company_id, companyId)).orderBy(asc(hr_shift_groups.sort_order), asc(hr_shift_groups.id));
  return rows.map(groupOut);
}

export type ShiftResolver = {
  /** The day rules for an employee: the global rules with the employee's group
   *  shift (base, or its delivery-day shift) in place. No group = global shift.
   *  A grouped shift's standardWorkMin is the shift's own (end-start-lunch). */
  rulesFor: (workDate: string, employeeId: number) => AttendanceRules;
  /** Whether the employee is in a shift group. When false, a caller that
   *  overrides the standard day from the employee's working_hours_per_day keeps
   *  doing so; when true, the group shift's hours are authoritative. */
  hasGroup: (employeeId: number) => boolean;
};

/** An employee-aware shift resolver over [fromYmd, toYmd]. Preloads groups, the
 *  employee->group map and the window's delivery days, so each lookup is O(1).
 *  An employee with no group keeps the global pay-rules shift. */
export async function shiftRulesResolver(db: Db, companyId: number, fromYmd: string, toYmd: string): Promise<ShiftResolver> {
  const [baseFor, groups, emps, deliveries] = await Promise.all([
    rulesResolver(db, companyId),
    db.select().from(hr_shift_groups).where(eq(hr_shift_groups.company_id, companyId)),
    db.select({ id: hr_employees.id, shift_group_id: hr_employees.shift_group_id }).from(hr_employees).where(eq(hr_employees.company_id, companyId)),
    db
      .select({ trip_date: hr_trip_rows.trip_date, d1: hr_trip_rows.driver_1_employee_id, d2: hr_trip_rows.driver_2_employee_id, h1: hr_trip_rows.helper_1_employee_id, h2: hr_trip_rows.helper_2_employee_id })
      .from(hr_trip_rows)
      .where(and(eq(hr_trip_rows.company_id, companyId), isNull(hr_trip_rows.removed_at), gte(hr_trip_rows.trip_date, fromYmd), lte(hr_trip_rows.trip_date, toYmd))),
  ]);
  const groupById = new Map<number, ShiftGroupShift>(groups.map((g) => [g.id, { startMin: g.start_min, endMin: g.end_min, deliveryStartMin: g.delivery_start_min, deliveryEndMin: g.delivery_end_min }]));
  const groupOfEmp = new Map<number, number | null>(emps.map((e) => [e.id, e.shift_group_id]));
  const deliverySet = new Set<string>();
  for (const r of deliveries) {
    for (const id of [r.d1, r.d2, r.h1, r.h2]) if (id != null) deliverySet.add(deliveryKey(id, r.trip_date));
  }
  return {
    rulesFor: (workDate, employeeId) => {
      const base = baseFor(workDate);
      const gid = groupOfEmp.get(employeeId) ?? null;
      const group = gid != null ? (groupById.get(gid) ?? null) : null;
      return shiftRulesFor(base, group, deliverySet.has(deliveryKey(employeeId, workDate)));
    },
    hasGroup: (employeeId) => (groupOfEmp.get(employeeId) ?? null) != null,
  };
}
