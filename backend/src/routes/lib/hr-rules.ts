/* Pure pieces of routes/hr.ts (HC-0125), kept apart so they are tested
 * without a database: the wire shape of an employee, the salary in force on a
 * date, and the field diff the audit log records. */
import type { EmployeeInput, EmployeeStatus, PayMode, PaymentMethod, TaxCategory, TaxResidency } from "../../scm/shared/hr-employee";
import { emptyEmployeeInput, employeeInputProblem, nextEmpNo } from "../../scm/shared/hr-employee";

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
  work_permit_expiry: string | null;
  confirm_due_on: string | null;
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
  trip_names: string | null;
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
    workPermitExpiry: r.work_permit_expiry ?? "",
    confirmDueOn: r.confirm_due_on ?? "",
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
    tripNames: r.trip_names ?? "",
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
    work_permit_expiry: blank(e.workPermitExpiry),
    confirm_due_on: blank(e.confirmDueOn),
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
    trip_names: blank(e.tripNames),
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

/* ── bulk add ────────────────────────────────────────────────────────────────
 * Two ways to fill Employee Master without keying each row: pick the ERP
 * accounts that already exist, or import a spreadsheet. Both reduce to "make
 * many employee rows at once", so the Emp No assignment and the duplicate rules
 * live here, pure and tested; the route only does the database I/O. */

/** One ERP account offered for a bulk add. */
export type BulkAccount = {
  userId: number;
  name: string | null;
  email: string;
  phone: string | null;
  departmentId: number | null;
  position: string | null;
};

export type BulkLinkPlan = {
  create: Array<{ userId: number; input: EmployeeInput }>;
  skipped: Array<{ userId: number; name: string; reason: string }>;
};

/** Plan the rows to create from chosen ERP accounts. The Emp No runs on from
 *  the highest in the book, one per row, so a batch never collides; name,
 *  phone, department and position are copied from the account. Pay basis stays
 *  the monthly default — a bulk add cannot know a day rate, so HR sets that per
 *  person afterwards, and `isOutsource` only chooses the OSC number series. An
 *  account already linked, or with no name to show, is skipped with a reason
 *  rather than guessed. */
export function planBulkLink(
  accounts: readonly BulkAccount[],
  linkedUserIds: ReadonlySet<number>,
  existingEmpNos: readonly string[],
  isOutsource: boolean,
  todayYmd: string,
): BulkLinkPlan {
  const create: BulkLinkPlan["create"] = [];
  const skipped: BulkLinkPlan["skipped"] = [];
  const running: string[] = [...existingEmpNos];
  for (const a of accounts) {
    const name = (a.name ?? "").trim() || a.email.trim();
    if (linkedUserIds.has(a.userId)) {
      skipped.push({ userId: a.userId, name, reason: "already has an employee record" });
      continue;
    }
    if (!name) {
      skipped.push({ userId: a.userId, name: a.email, reason: "the ERP account has no name" });
      continue;
    }
    const empNo = nextEmpNo(running, isOutsource);
    running.push(empNo);
    create.push({
      userId: a.userId,
      input: {
        ...emptyEmployeeInput(todayYmd),
        empNo,
        name,
        userId: a.userId,
        phone: (a.phone ?? "").trim(),
        departmentId: a.departmentId,
        position: (a.position ?? "").trim(),
        isOutsource,
      },
    });
  }
  return { create, skipped };
}

/** One already-parsed import row: the employee fields, which of them the sheet
 *  actually gave (so a re-import patches only the cells that were filled, never
 *  blanking what it left empty), and the ERP account email to match or link by
 *  when the sheet named one and gave no user id. */
export type ImportRowIn = {
  input: EmployeeInput;
  provided: ReadonlySet<keyof EmployeeInput>;
  accountEmail: string | null;
};

/** An employee already in the book, for a re-import to match a row against. */
export type ExistingEmp = { id: number; empNo: string; userId: number | null };

export type BulkImportPlan = {
  create: Array<{ index: number; input: EmployeeInput }>;
  update: Array<{ index: number; employeeId: number; empNo: string; name: string; patch: Partial<EmployeeInput> }>;
  errors: Array<{ index: number; message: string }>;
};

/* The fields a spreadsheet re-import may change on someone already in the book.
 * Deliberately left out: emp_no and the ERP-account link (an import enriches a
 * record, it does not renumber or relink it), status, and anything to do with
 * pay — the salary and day rate stay with HR and the salary history, so a sheet
 * with a blank or default salary can never knock down what someone earns. */
const UPDATABLE_TEXT: ReadonlyArray<keyof EmployeeInput> = [
  "name", "phone", "position", "joinDate", "nationality", "icNumber", "passportNumber", "bankName", "bankAccount", "tripNames",
];
const UPDATABLE_BOOL: ReadonlyArray<keyof EmployeeInput> = ["epfEnabled", "socsoEnabled", "eisEnabled", "pcbEnabled"];

/** The patch for a matched employee: only the updatable fields the sheet gave,
 *  text left out when blank so an empty cell changes nothing. */
function buildUpdatePatch(input: EmployeeInput, provided: ReadonlySet<keyof EmployeeInput>): Partial<EmployeeInput> {
  const patch: Record<string, unknown> = {};
  for (const k of UPDATABLE_TEXT) if (provided.has(k) && String(input[k] ?? "").trim() !== "") patch[k] = input[k];
  for (const k of UPDATABLE_BOOL) if (provided.has(k)) patch[k] = input[k];
  if (provided.has("departmentId") && input.departmentId != null) patch.departmentId = input.departmentId;
  return patch as Partial<EmployeeInput>;
}

/** Translate an update patch to the hr_employees columns to SET. Only the keys
 *  the patch carries are written; blank text becomes NULL, as on an insert. */
export function employeeUpdateColumns(patch: Partial<EmployeeInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const blank = (v: string): string | null => (v ? v : null);
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.phone !== undefined) out.phone = blank(patch.phone);
  if (patch.departmentId !== undefined) out.department_id = patch.departmentId;
  if (patch.position !== undefined) out.position = blank(patch.position);
  if (patch.joinDate !== undefined) out.join_date = blank(patch.joinDate);
  if (patch.nationality !== undefined) out.nationality = blank(patch.nationality);
  if (patch.icNumber !== undefined) out.ic_number = blank(patch.icNumber);
  if (patch.passportNumber !== undefined) out.passport_number = blank(patch.passportNumber);
  if (patch.bankName !== undefined) out.bank_name = blank(patch.bankName);
  if (patch.bankAccount !== undefined) out.bank_account = blank(patch.bankAccount);
  if (patch.epfEnabled !== undefined) out.epf_enabled = patch.epfEnabled;
  if (patch.socsoEnabled !== undefined) out.socso_enabled = patch.socsoEnabled;
  if (patch.eisEnabled !== undefined) out.eis_enabled = patch.eisEnabled;
  if (patch.pcbEnabled !== undefined) out.pcb_enabled = patch.pcbEnabled;
  if (patch.tripNames !== undefined) out.trip_names = blank(patch.tripNames);
  return out;
}

/** Plan a spreadsheet import, update-or-create. One message per bad row, never
 *  a silent drop. A row is matched to someone already in the book by its ERP
 *  account (the resolved user id) first, else by an exactly-matching Emp No; a
 *  match is UPDATED in place (keeping its Emp No and link, enriching only the
 *  cells the sheet filled), everyone else is CREATED. On create a blank Emp No
 *  is auto-assigned in sequence and a within-file duplicate is refused; an
 *  account email that names no active account is refused, and one account
 *  cannot seed two new rows. A number is only consumed by an accepted create,
 *  so refused rows leave no gaps. `index` is the row's position in the input. */
export function planBulkImport(
  rows: readonly ImportRowIn[],
  opts: {
    existing: readonly ExistingEmp[];
    userIdByEmail: ReadonlyMap<string, number>;
  },
): BulkImportPlan {
  const create: BulkImportPlan["create"] = [];
  const update: BulkImportPlan["update"] = [];
  const errors: BulkImportPlan["errors"] = [];
  const byUser = new Map<number, ExistingEmp>();
  const byEmpNo = new Map<string, ExistingEmp>();
  for (const e of opts.existing) {
    if (e.userId != null) byUser.set(e.userId, e);
    byEmpNo.set(e.empNo.trim().toUpperCase(), e);
  }
  const running: string[] = opts.existing.map((e) => e.empNo);
  const usedEmpNo = new Set(running.map((e) => e.trim().toUpperCase()));
  const createdUserIds = new Set<number>();
  const touched = new Set<number>();
  rows.forEach((row, index) => {
    const input: EmployeeInput = { ...row.input };
    if (input.userId == null && row.accountEmail) {
      const uid = opts.userIdByEmail.get(row.accountEmail.trim().toLowerCase());
      if (uid == null) {
        errors.push({ index, message: `No active ERP account has the email ${row.accountEmail}.` });
        return;
      }
      input.userId = uid;
    }
    const empNoGiven = input.empNo.trim().toUpperCase();
    const matchUser = input.userId != null ? byUser.get(input.userId) : undefined;
    const matchEmpNo = empNoGiven ? byEmpNo.get(empNoGiven) : undefined;
    if (matchUser && matchEmpNo && matchUser.id !== matchEmpNo.id) {
      errors.push({ index, message: `Employee No ${empNoGiven} belongs to a different person than that ERP account.` });
      return;
    }
    const target = matchUser ?? matchEmpNo;
    if (target) {
      if (touched.has(target.id)) {
        errors.push({ index, message: `Two rows change the same employee (${target.empNo}).` });
        return;
      }
      touched.add(target.id);
      update.push({ index, employeeId: target.id, empNo: target.empNo, name: input.name || target.empNo, patch: buildUpdatePatch(input, row.provided) });
      return;
    }
    let empNo = empNoGiven;
    if (!empNo) {
      empNo = nextEmpNo(running, input.isOutsource);
    } else if (usedEmpNo.has(empNo)) {
      errors.push({ index, message: `Employee No ${empNo} is already in use.` });
      return;
    }
    input.empNo = empNo;
    const problem = employeeInputProblem(input);
    if (problem) {
      errors.push({ index, message: problem });
      return;
    }
    if (input.userId != null && createdUserIds.has(input.userId)) {
      errors.push({ index, message: "That ERP account is used by more than one new row." });
      return;
    }
    running.push(empNo);
    usedEmpNo.add(empNo);
    if (input.userId != null) createdUserIds.add(input.userId);
    create.push({ index, input });
  });
  return { create, update, errors };
}
