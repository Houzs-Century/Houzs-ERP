/* Database reads and the forgotten-punch close shared by the phone punch
 * (routes/attendance.ts), the Attendance tab (routes/hr-attendance.ts) and
 * the hr-auto-clockout cron. Drizzle throughout. */
import { and, asc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { Env } from "../../types";
import { getDb } from "../../db/client";
import { hr_attendance, hr_pay_rule_versions, hr_punch_sites } from "../../db/schema";
import { resolvePayRulesAsOf, normalizePayRules } from "../../scm/shared/hr-pay-rules";
import { AUTO_CLOSE_AFTER_HOURS, toAttendanceRules, type AttendanceRules, type PunchSite } from "../../scm/shared/hr-attendance";
import { asDate, autoCloseAt } from "./hr-attendance-view";

type Db = ReturnType<typeof getDb>;

export const FORGOT_OUT_NOTE = "Forgot to punch out: closed at the shift end";

/** The day rules in force on a work date, per company, from the dated pay rules. */
export async function rulesResolver(db: Db, companyId: number): Promise<(workDate: string) => AttendanceRules> {
  const rows = await db
    .select({ effective_from: hr_pay_rule_versions.effective_from, rules: hr_pay_rule_versions.rules })
    .from(hr_pay_rule_versions)
    .where(eq(hr_pay_rule_versions.company_id, companyId));
  const versions = rows.map((r) => ({ effectiveFrom: r.effective_from, rules: normalizePayRules(r.rules) }));
  const cache = new Map<string, AttendanceRules>();
  return (workDate) => {
    let r = cache.get(workDate);
    if (!r) {
      r = toAttendanceRules(resolvePayRulesAsOf(versions, workDate));
      cache.set(workDate, r);
    }
    return r;
  };
}

/** Active sites for the check, and every site's name (an inactive site still names old punches). */
export async function loadSites(db: Db, companyId: number): Promise<{ active: PunchSite[]; names: Map<number, string> }> {
  const rows = await db.select().from(hr_punch_sites).where(eq(hr_punch_sites.company_id, companyId)).orderBy(asc(hr_punch_sites.name));
  return {
    active: rows.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, radiusM: r.radius_m })),
    names: new Map(rows.map((r) => [r.id, r.name])),
  };
}

/* Close every open punch whose clock-in is AUTO_CLOSE_AFTER_HOURS old, at
 * the shift end of its work date (Hookka's autoCloseForgottenPunch). The
 * UPDATE re-checks clock_out_at IS NULL, so a clock-out racing the close
 * wins and a second run changes nothing. employeeId narrows it to one person
 * (their next punch); null sweeps the company. */
export async function closeForgottenPunches(db: Db, companyId: number, employeeId: number | null, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - AUTO_CLOSE_AFTER_HOURS * 3600_000).toISOString();
  const open = await db
    .select({ id: hr_attendance.id, work_date: hr_attendance.work_date, clock_in_at: hr_attendance.clock_in_at, notes: hr_attendance.notes })
    .from(hr_attendance)
    .where(
      and(
        eq(hr_attendance.company_id, companyId),
        employeeId != null ? eq(hr_attendance.employee_id, employeeId) : undefined,
        isNotNull(hr_attendance.clock_in_at),
        isNull(hr_attendance.clock_out_at),
        lt(hr_attendance.clock_in_at, cutoff),
      ),
    );
  if (open.length === 0) return 0;
  const rulesFor = await rulesResolver(db, companyId);
  let closed = 0;
  for (const r of open) {
    if (!r.clock_in_at) continue;
    const outAt = autoCloseAt(r.work_date, asDate(r.clock_in_at), rulesFor(r.work_date));
    const done = await db
      .update(hr_attendance)
      .set({
        clock_out_at: outAt.toISOString(),
        out_source: "AUTO",
        notes: r.notes ? `${r.notes}\n${FORGOT_OUT_NOTE}` : FORGOT_OUT_NOTE,
        updated_at: now.toISOString(),
      })
      .where(and(eq(hr_attendance.id, r.id), isNull(hr_attendance.clock_out_at)))
      .returning({ id: hr_attendance.id });
    closed += done.length;
  }
  return closed;
}

/** The cron sweep: every company with an open punch. */
export async function runAutoClockOut(env: Env): Promise<{ companies: number; closed: number }> {
  const db = getDb(env);
  const companies = await db
    .selectDistinct({ company_id: hr_attendance.company_id })
    .from(hr_attendance)
    .where(and(isNotNull(hr_attendance.clock_in_at), isNull(hr_attendance.clock_out_at)));
  let closed = 0;
  const now = new Date();
  for (const c of companies) closed += await closeForgottenPunches(db, c.company_id, null, now);
  return { companies: companies.length, closed };
}
