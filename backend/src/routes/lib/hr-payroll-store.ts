/* Loads a month and builds every payslip of it (HC-0125 phase 4): Hookka's
 * POST /api/payslips pipeline over Century's tables. Used by Generate (which
 * stores the result), by the projected view of a month with no slips, and
 * by the phone's My pay estimate. */
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  departments,
  hr_advances,
  hr_allowances,
  hr_employee_salary_history,
  hr_employees,
  hr_attendance,
  hr_hour_deductions,
  hr_payslips,
  hr_penalties,
  hr_penalty_lines,
  hr_public_holidays,
  hr_working_hours,
} from "../../db/schema";
import { absenceCutoffDay } from "../../scm/shared/hr-payroll";
import { PAID_LEAVE_STATUSES } from "../../scm/shared/hr-attendance";
import type { PcbCategory } from "../../scm/shared/hr-pcb";
import { payRulesResolver } from "./hr-attendance-store";
import { buildPayslip, onPayroll, type AllowanceKind, type PayslipFigures } from "./hr-payslip";
import { loadTripMonth } from "./hr-trip-store";

type Db = ReturnType<typeof getDb>;

export function periodBounds(period: string): { first: string; last: string; year: number; month: number } {
  const [year, month] = period.split("-").map(Number);
  return { first: `${period}-01`, last: `${period}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`, year, month };
}

/** Months of a company that are approved or paid: their payroll is locked. */
export async function lockedPeriods(db: Db, companyId: number): Promise<Set<string>> {
  const rows = await db.selectDistinct({ period: hr_payslips.period }).from(hr_payslips).where(and(eq(hr_payslips.company_id, companyId), ne(hr_payslips.status, "DRAFT")));
  return new Set(rows.map((r) => r.period));
}

export async function computePeriod(db: Db, companyId: number, period: string, today: string, onlyEmployeeId: number | null = null): Promise<PayslipFigures[]> {
  const { first, last, year, month } = periodBounds(period);
  const empWhere = onlyEmployeeId != null ? and(eq(hr_employees.company_id, companyId), eq(hr_employees.id, onlyEmployeeId)) : eq(hr_employees.company_id, companyId);
  const [employees, holidays, hours, docks, advances, penalties, ytd, rulesOn, allowances, paidLeave, trip] = await Promise.all([
    db
      .select({ e: hr_employees, department: departments.name })
      .from(hr_employees)
      .leftJoin(departments, eq(departments.id, hr_employees.department_id))
      .where(empWhere)
      .orderBy(asc(hr_employees.emp_no)),
    /* The grace walk-back can cross into the previous year's December. */
    db
      .select({ d: hr_public_holidays.holiday_date })
      .from(hr_public_holidays)
      .where(and(eq(hr_public_holidays.company_id, companyId), gte(hr_public_holidays.holiday_date, `${year - 1}-12-01`), lte(hr_public_holidays.holiday_date, `${year}-12-31`))),
    db
      .select({ employee_id: hr_working_hours.employee_id, date: hr_working_hours.work_date, hours: hr_working_hours.hours })
      .from(hr_working_hours)
      .where(and(eq(hr_working_hours.company_id, companyId), gte(hr_working_hours.work_date, first), lte(hr_working_hours.work_date, last))),
    db
      .select({ employee_id: hr_hour_deductions.employee_id, hours: sql<string>`SUM(${hr_hour_deductions.hours})` })
      .from(hr_hour_deductions)
      .where(and(eq(hr_hour_deductions.company_id, companyId), gte(hr_hour_deductions.work_date, first), lte(hr_hour_deductions.work_date, last)))
      .groupBy(hr_hour_deductions.employee_id),
    db
      .select({ employee_id: hr_advances.employee_id, date: hr_advances.advance_date, amount: hr_advances.amount_sen })
      .from(hr_advances)
      .where(and(eq(hr_advances.company_id, companyId), gte(hr_advances.advance_date, first), lte(hr_advances.advance_date, last))),
    db
      .select({ employee_id: hr_penalty_lines.employee_id, amount: sql<string>`SUM(${hr_penalty_lines.amount_sen})` })
      .from(hr_penalty_lines)
      .innerJoin(hr_penalties, eq(hr_penalties.id, hr_penalty_lines.penalty_id))
      .where(and(eq(hr_penalty_lines.company_id, companyId), eq(hr_penalty_lines.payroll_period, period), inArray(hr_penalties.status, ["APPROVED", "POSTED"])))
      .groupBy(hr_penalty_lines.employee_id),
    /* PCB year-to-date: earlier months of the same year, drafts included (as Hookka). */
    db
      .select({
        employee_id: hr_payslips.employee_id,
        rem: sql<string>`SUM(${hr_payslips.gross_sen} - ${hr_payslips.allowances_sen} - ${hr_payslips.trip_allowance_sen})`,
        epf: sql<string>`SUM(${hr_payslips.epf_employee_sen})`,
        pcb: sql<string>`SUM(${hr_payslips.pcb_sen})`,
      })
      .from(hr_payslips)
      .where(and(eq(hr_payslips.company_id, companyId), gte(hr_payslips.period, `${year}-01`), lt(hr_payslips.period, period)))
      .groupBy(hr_payslips.employee_id),
    payRulesResolver(db, companyId),
    db
      .select({ employee_id: hr_allowances.employee_id, kind: hr_allowances.kind, amount: hr_allowances.amount_sen, note: hr_allowances.note })
      .from(hr_allowances)
      .where(
        and(
          eq(hr_allowances.company_id, companyId),
          lte(hr_allowances.from_period, period),
          or(isNull(hr_allowances.until_period), gte(hr_allowances.until_period, period)),
        ),
      )
      .orderBy(asc(hr_allowances.id)),
    /* Annual / medical leave and rest days keyed on the Attendance tab are paid: not absences. */
    db
      .select({ employee_id: hr_attendance.employee_id, date: hr_attendance.work_date })
      .from(hr_attendance)
      .where(
        and(
          eq(hr_attendance.company_id, companyId),
          inArray(hr_attendance.status, [...PAID_LEAVE_STATUSES]),
          gte(hr_attendance.work_date, first),
          lte(hr_attendance.work_date, last),
        ),
      ),
    loadTripMonth(db, companyId, period, today),
  ]);
  const ids = employees.map((r) => r.e.id);
  const history = ids.length
    ? await db
        .select({ employee_id: hr_employee_salary_history.employee_id, effective_from: hr_employee_salary_history.effective_from, salary: hr_employee_salary_history.basic_salary_sen })
        .from(hr_employee_salary_history)
        .where(and(eq(hr_employee_salary_history.company_id, companyId), inArray(hr_employee_salary_history.employee_id, ids)))
    : [];
  const holidaySet = new Set(holidays.map((h) => h.d));
  const through = absenceCutoffDay(year, month, today, rulesOn(today).absenceGraceWorkingDays, holidaySet);
  const by = <T extends { employee_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) m.set(r.employee_id, [...(m.get(r.employee_id) ?? []), r]);
    return m;
  };
  const hoursBy = by(hours);
  const advBy = by(advances);
  const allowBy = by(allowances);
  const leaveBy = by(paidLeave);
  const histBy = by(history);
  const dockBy = new Map(docks.map((d) => [d.employee_id, Number(d.hours)]));
  const penBy = new Map(penalties.map((p) => [p.employee_id, Number(p.amount)]));
  const ytdBy = new Map(ytd.map((y) => [y.employee_id, { remunerationSen: Number(y.rem), epfSen: Number(y.epf), pcbSen: Number(y.pcb) }]));

  return employees
    .filter(({ e }) => onPayroll({ joinDate: e.join_date ?? "", resignedOn: e.resigned_on ?? "" }, e.status, period))
    .map(({ e, department }) =>
      buildPayslip({
        employee: {
          id: e.id,
          empNo: e.emp_no,
          name: e.name,
          departmentName: department,
          payMode: e.pay_mode as "MONTHLY" | "DAILY",
          basicSalarySen: Number(e.basic_salary_sen),
          dailyRateSen: Number(e.daily_rate_sen),
          workingDaysPerMonth: e.working_days_per_month,
          workingHoursPerDay: Number(e.working_hours_per_day),
          otMultiplier: Number(e.ot_multiplier),
          resignedOn: e.resigned_on ?? "",
          joinDate: e.join_date ?? "",
          paymentMethod: e.payment_method as "TRANSFER" | "CASH",
          bankName: e.bank_name ?? "",
          bankAccount: e.bank_account ?? "",
          epf: e.epf_enabled,
          socso: e.socso_enabled,
          eis: e.eis_enabled,
          pcb: e.pcb_enabled,
          taxResidency: e.tax_residency as "RESIDENT" | "NON_RESIDENT" | null,
          taxCategory: e.tax_category as PcbCategory | null,
          taxChildReliefSen: e.tax_child_relief_sen == null ? null : Number(e.tax_child_relief_sen),
        },
        period,
        salaryHistory: (histBy.get(e.id) ?? []).map((h) => ({ effectiveFrom: h.effective_from, basicSalarySen: Number(h.salary) })),
        days: (hoursBy.get(e.id) ?? []).map((h) => ({ date: h.date, hours: Number(h.hours) })),
        holidays: holidaySet,
        absenceThroughDay: through,
        shortHours: dockBy.get(e.id) ?? 0,
        rulesOn,
        advances: (advBy.get(e.id) ?? []).map((a) => ({ date: a.date, amountSen: Number(a.amount) })),
        penaltySen: penBy.get(e.id) ?? 0,
        paidLeave: new Set((leaveBy.get(e.id) ?? []).map((l) => l.date)),
        trip: trip.pay.get(e.id) ?? null,
        allowances: (allowBy.get(e.id) ?? []).map((a) => ({ kind: a.kind as AllowanceKind, amountSen: Number(a.amount), note: a.note })),
        ytd: ytdBy.get(e.id) ?? { remunerationSen: 0, epfSen: 0, pcbSen: 0 },
      }),
    );
}

/** The stored row for a computed slip. */
export function payslipRow(companyId: number, period: string, s: PayslipFigures, by: number | null) {
  const p = s.pay;
  return {
    company_id: companyId,
    employee_id: s.employeeId,
    period,
    status: "DRAFT",
    emp_no: s.empNo,
    employee_name: s.employeeName,
    department_name: s.departmentName,
    pay_mode: s.payMode,
    full_salary_sen: p.fullSalarySen,
    day_rate_sen: p.dayRateSen,
    hour_rate_sen: p.hourRateSen,
    days_worked: p.daysWorked,
    absent_days: p.absentDays,
    absence_deduction_sen: p.absenceDeductionSen,
    short_hours: String(p.shortHours),
    short_hour_deduction_sen: p.shortHourDeductionSen,
    basic_earned_sen: p.basicEarnedSen,
    ot_weekday_hours: String(p.otWeekdayHours),
    ot_sunday_hours: String(p.otSundayHours),
    ot_holiday_hours: String(p.otHolidayHours),
    ot_weekday_pay_sen: p.otWeekdayPaySen,
    ot_sunday_pay_sen: p.otSundayPaySen,
    ot_holiday_pay_sen: p.otHolidayPaySen,
    ot_pay_sen: p.otPaySen,
    allowances_sen: s.allowancesSen,
    commission_sen: s.commissionSen,
    trip_allowance_sen: s.tripAllowanceSen,
    backpay_sen: s.backpaySen,
    gross_sen: s.grossSen,
    epf_employee_sen: s.statutory.epfEmployeeSen,
    epf_employer_sen: s.statutory.epfEmployerSen,
    socso_employee_sen: s.statutory.socsoEmployeeSen,
    socso_employer_sen: s.statutory.socsoEmployerSen,
    eis_employee_sen: s.statutory.eisEmployeeSen,
    eis_employer_sen: s.statutory.eisEmployerSen,
    pcb_sen: s.pcbSen,
    pcb_status: s.pcbStatus,
    statutory_employee_sen: s.statutoryEmployeeSen,
    advance_sen: s.advanceSen,
    penalty_sen: s.penaltySen,
    net_sen: s.netSen,
    payment_method: s.paymentMethod,
    bank_name: s.bankName,
    bank_account: s.bankAccount,
    detail: {
      absentDates: p.absentDates,
      paidLeaveDates: p.paidLeaveDates,
      otDays: p.otDays,
      advanceDates: s.advanceDates,
      pcbNote: s.pcbNote,
      allowances: s.allowanceLines,
      trip: s.trip ? { commission: s.trip.commission, lines: s.trip.lines } : null,
    },
    created_by: by,
  };
}
