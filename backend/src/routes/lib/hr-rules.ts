/* Pure pieces of routes/hr.ts (HC-0125), kept apart so they are tested
 * without a database: the wire shape of an employee, the salary in force on a
 * date, and the field diff the audit log records. */
import type { EmployeeInput, EmployeeStatus, PayMode, PaymentMethod, TaxCategory, TaxResidency } from "../../scm/shared/hr-employee";

export type EmployeeRow = {
  id: number;
  emp_no: string;
  name: string;
  user_id: number | null;
  department_id: number | null;
  position: string | null;
  phone: string | null;
  status: string;
  resigned_on: string | null;
  join_date: string | null;
  nationality: string | null;
  ic_number: string | null;
  passport_number: string | null;
  is_outsource: boolean;
  pay_mode: string;
  basic_salary_sen: number;
  daily_rate_sen: number;
  working_hours_per_day: string | number;
  working_days_per_month: number;
  ot_multiplier: string | number;
  payment_method: string;
  bank_name: string | null;
  bank_account: string | null;
  epf_enabled: boolean;
  socso_enabled: boolean;
  eis_enabled: boolean;
  pcb_enabled: boolean;
  tax_residency: string | null;
  tax_category: string | null;
  tax_child_relief_sen: number | null;
  updated_at: string;
};

export type EmployeeOut = EmployeeInput & {
  id: number;
  userName: string | null;
  userEmail: string | null;
  departmentName: string | null;
  updatedAt: string;
};

export function rowToEmployee(
  r: EmployeeRow,
  user: { name: string | null; email: string } | null,
  departmentName: string | null,
): EmployeeOut {
  return {
    id: r.id,
    empNo: r.emp_no,
    name: r.name,
    userId: r.user_id,
    userName: user?.name ?? null,
    userEmail: user?.email ?? null,
    departmentId: r.department_id,
    departmentName,
    position: r.position ?? "",
    phone: r.phone ?? "",
    status: r.status as EmployeeStatus,
    resignedOn: r.resigned_on ?? "",
    joinDate: r.join_date ?? "",
    nationality: r.nationality ?? "",
    icNumber: r.ic_number ?? "",
    passportNumber: r.passport_number ?? "",
    isOutsource: r.is_outsource,
    payMode: r.pay_mode as PayMode,
    basicSalarySen: Number(r.basic_salary_sen),
    dailyRateSen: Number(r.daily_rate_sen),
    workingHoursPerDay: Number(r.working_hours_per_day),
    workingDaysPerMonth: r.working_days_per_month,
    otMultiplier: Number(r.ot_multiplier),
    paymentMethod: r.payment_method as PaymentMethod,
    bankName: r.bank_name ?? "",
    bankAccount: r.bank_account ?? "",
    epfEnabled: r.epf_enabled,
    socsoEnabled: r.socso_enabled,
    eisEnabled: r.eis_enabled,
    pcbEnabled: r.pcb_enabled,
    taxResidency: r.tax_residency as TaxResidency | null,
    taxCategory: r.tax_category as TaxCategory | null,
    taxChildReliefSen: r.tax_child_relief_sen == null ? null : Number(r.tax_child_relief_sen),
    updatedAt: r.updated_at,
  };
}

/** Columns to write for an EmployeeInput. basic_salary_sen is left out: it
 *  only moves through the salary history (see salaryAsOf). */
export function employeeColumns(e: EmployeeInput) {
  const blank = (v: string): string | null => (v ? v : null);
  return {
    emp_no: e.empNo,
    name: e.name,
    user_id: e.userId,
    department_id: e.departmentId,
    position: blank(e.position),
    phone: blank(e.phone),
    status: e.status,
    resigned_on: e.status === "RESIGNED" ? e.resignedOn : null,
    join_date: blank(e.joinDate),
    nationality: blank(e.nationality),
    ic_number: blank(e.icNumber),
    passport_number: blank(e.passportNumber),
    is_outsource: e.isOutsource,
    pay_mode: e.payMode,
    daily_rate_sen: e.dailyRateSen,
    working_hours_per_day: String(e.workingHoursPerDay),
    working_days_per_month: e.workingDaysPerMonth,
    ot_multiplier: String(e.otMultiplier),
    payment_method: e.paymentMethod,
    bank_name: blank(e.bankName),
    bank_account: blank(e.bankAccount),
    epf_enabled: e.epfEnabled,
    socso_enabled: e.socsoEnabled,
    eis_enabled: e.eisEnabled,
    pcb_enabled: e.pcbEnabled,
    tax_residency: e.taxResidency,
    tax_category: e.taxCategory,
    tax_child_relief_sen: e.taxChildReliefSen,
  };
}

/** The basic salary in force on dateYmd: the newest history row on or before
 *  it. Before the first row, the earliest row (an employee is never RM 0 just
 *  because their first salary was dated after their join day). Null = no rows. */
export function salaryAsOf(history: ReadonlyArray<{ effective_from: string; basic_salary_sen: number }>, dateYmd: string): number | null {
  if (history.length === 0) return null;
  const sorted = [...history].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  let pick = sorted[0];
  for (const h of sorted) if (h.effective_from <= dateYmd) pick = h;
  return Number(pick.basic_salary_sen);
}

/** Field-by-field before / after for the audit log. Bank account and IC are
 *  recorded as changed, never with their values. */
export function employeeDiff(before: EmployeeInput, after: EmployeeInput): Record<string, { from: unknown; to: unknown }> {
  const secret = new Set<keyof EmployeeInput>(["bankAccount", "icNumber", "passportNumber"]);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after) as Array<keyof EmployeeInput>) {
    if (k === "basicSalarySen") continue;
    if (before[k] === after[k]) continue;
    out[k] = secret.has(k) ? { from: "(hidden)", to: "(hidden)" } : { from: before[k], to: after[k] };
  }
  return out;
}
