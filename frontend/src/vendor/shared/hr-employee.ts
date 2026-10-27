/* HR Employee Master — the fixed choices on an employee record and the one
 * validator the form and the API share. Ported from Hookka
 * (src/lib/payment-method.ts, src/components/employee-drawer.tsx,
 * src/api/routes/workers.ts) for HC-0125.
 *
 * ONE home. backend/src/scm/shared/hr-employee.ts is the original and
 * frontend/src/vendor/shared/hr-employee.ts its byte-identical copy
 * (check-shared-mirrors.mjs).
 */

export type EmployeeStatus = "ACTIVE" | "INACTIVE" | "RESIGNED";
export const EMPLOYEE_STATUSES: ReadonlyArray<{ value: EmployeeStatus; label: string }> = [
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "RESIGNED", label: "Resigned" },
];

export type PayMode = "MONTHLY" | "DAILY";
export type PaymentMethod = "TRANSFER" | "CASH";
export const PAYMENT_METHODS: ReadonlyArray<{ value: PaymentMethod; label: string }> = [
  { value: "TRANSFER", label: "Bank transfer" },
  { value: "CASH", label: "Cash" },
];

/** A fixed dropdown, not free text: a bank typed two ways is how a payment file gets rejected. */
export const MALAYSIAN_BANKS: readonly string[] = [
  "Maybank",
  "CIMB Bank",
  "Public Bank",
  "RHB Bank",
  "Hong Leong Bank",
  "AmBank",
  "Bank Islam",
  "OCBC Bank",
  "UOB Bank",
  "HSBC Bank",
  "Affin Bank",
  "Alliance Bank",
  "Bank Simpanan Nasional",
  "Bank Rakyat",
  "Agrobank",
  "MBSB Bank",
  "Standard Chartered",
  "Citibank",
];

export type TaxResidency = "RESIDENT" | "NON_RESIDENT";
export type TaxCategory = "SINGLE" | "MARRIED_SPOUSE_NOT_WORKING" | "MARRIED_SPOUSE_WORKING";
export const TAX_RESIDENCIES: ReadonlyArray<{ value: TaxResidency; label: string }> = [
  { value: "RESIDENT", label: "Resident" },
  { value: "NON_RESIDENT", label: "Non-resident" },
];
export const TAX_CATEGORIES: ReadonlyArray<{ value: TaxCategory; label: string }> = [
  { value: "SINGLE", label: "Single" },
  { value: "MARRIED_SPOUSE_NOT_WORKING", label: "Married, spouse not working" },
  { value: "MARRIED_SPOUSE_WORKING", label: "Married, spouse working" },
];

/** The editable fields of an employee, as the form and the API exchange them. Money in sen. */
export type EmployeeInput = {
  empNo: string;
  name: string;
  userId: number | null;
  departmentId: number | null;
  position: string;
  phone: string;
  status: EmployeeStatus;
  resignedOn: string;
  joinDate: string;
  nationality: string;
  icNumber: string;
  passportNumber: string;
  isOutsource: boolean;
  payMode: PayMode;
  basicSalarySen: number;
  dailyRateSen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  otMultiplier: number;
  paymentMethod: PaymentMethod;
  bankName: string;
  bankAccount: string;
  epfEnabled: boolean;
  socsoEnabled: boolean;
  eisEnabled: boolean;
  pcbEnabled: boolean;
  taxResidency: TaxResidency | null;
  taxCategory: TaxCategory | null;
  taxChildReliefSen: number | null;
  /** The names the person goes by on the trip sheet (AMIR), comma-separated. */
  tripNames: string;
};

/** New-employee defaults. Statutory starts OFF: HR ticks it for the people who are registered. */
export function emptyEmployeeInput(todayYmd: string): EmployeeInput {
  return {
    empNo: "",
    name: "",
    userId: null,
    departmentId: null,
    position: "",
    phone: "",
    status: "ACTIVE",
    resignedOn: "",
    joinDate: todayYmd,
    nationality: "",
    icNumber: "",
    passportNumber: "",
    isOutsource: false,
    payMode: "MONTHLY",
    basicSalarySen: 180000,
    dailyRateSen: 0,
    workingHoursPerDay: 9,
    workingDaysPerMonth: 26,
    otMultiplier: 1.5,
    paymentMethod: "TRANSFER",
    bankName: "",
    bankAccount: "",
    epfEnabled: false,
    socsoEnabled: false,
    eisEnabled: false,
    pcbEnabled: false,
    taxResidency: null,
    taxCategory: null,
    taxChildReliefSen: null,
    tripNames: "",
  };
}

/* Two independent number series: own staff EMP-###, outsourced OSC-###, so the
 * prefix alone tells payroll which rules apply. Next = highest existing + 1;
 * hand-typed codes outside the pattern are ignored. */
export function nextEmpNo(existing: ReadonlyArray<string | null>, isOutsource: boolean): string {
  const prefix = isOutsource ? "OSC" : "EMP";
  const re = new RegExp(`^${prefix}-(\\d+)$`, "i");
  let max = 0;
  for (const e of existing) {
    const m = re.exec((e ?? "").trim());
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const n = (v: unknown, dflt: number): number => {
  if (v === null || v === undefined || v === "") return dflt;
  const x = Number(v);
  return Number.isFinite(x) ? x : Number.NaN;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt);

/** Read a request body onto EmployeeInput. Unknown values fall to the default
 *  and are then caught by employeeInputProblem, never silently stored. */
export function parseEmployeeInput(raw: unknown, todayYmd: string): EmployeeInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = emptyEmployeeInput(todayYmd);
  const id = (v: unknown): number | null => (Number.isInteger(Number(v)) && Number(v) > 0 && v !== null && v !== "" ? Number(v) : null);
  const paymentMethod = oneOf<PaymentMethod>(r.paymentMethod, PAYMENT_METHODS.map((m) => m.value), "TRANSFER");
  const pcbEnabled = r.pcbEnabled === true;
  return {
    empNo: s(r.empNo).toUpperCase(),
    name: s(r.name),
    userId: id(r.userId),
    departmentId: id(r.departmentId),
    position: s(r.position),
    phone: s(r.phone),
    status: oneOf<EmployeeStatus>(r.status, EMPLOYEE_STATUSES.map((x) => x.value), "ACTIVE"),
    resignedOn: s(r.resignedOn),
    joinDate: s(r.joinDate),
    nationality: s(r.nationality),
    icNumber: s(r.icNumber),
    passportNumber: s(r.passportNumber),
    isOutsource: r.isOutsource === true,
    payMode: oneOf<PayMode>(r.payMode, ["MONTHLY", "DAILY"], "MONTHLY"),
    basicSalarySen: n(r.basicSalarySen, d.basicSalarySen),
    dailyRateSen: n(r.dailyRateSen, 0),
    workingHoursPerDay: n(r.workingHoursPerDay, d.workingHoursPerDay),
    workingDaysPerMonth: n(r.workingDaysPerMonth, d.workingDaysPerMonth),
    otMultiplier: n(r.otMultiplier, d.otMultiplier),
    paymentMethod,
    bankName: paymentMethod === "CASH" ? "" : s(r.bankName),
    bankAccount: paymentMethod === "CASH" ? "" : s(r.bankAccount),
    epfEnabled: r.epfEnabled === true,
    socsoEnabled: r.socsoEnabled === true,
    eisEnabled: r.eisEnabled === true,
    pcbEnabled,
    taxResidency: pcbEnabled ? (r.taxResidency === "RESIDENT" || r.taxResidency === "NON_RESIDENT" ? r.taxResidency : null) : null,
    taxCategory: pcbEnabled
      ? r.taxCategory === "SINGLE" || r.taxCategory === "MARRIED_SPOUSE_NOT_WORKING" || r.taxCategory === "MARRIED_SPOUSE_WORKING"
        ? r.taxCategory
        : null
      : null,
    taxChildReliefSen: pcbEnabled && r.taxChildReliefSen !== null && r.taxChildReliefSen !== undefined && r.taxChildReliefSen !== "" ? n(r.taxChildReliefSen, 0) : null,
    tripNames: s(r.tripNames)
      .split(",")
      .map((x) => x.replace(/\s+/g, " ").trim().toUpperCase())
      .filter(Boolean)
      .join(", "),
  };
}

/** Why an employee cannot be saved, or null when it can. The form disables
 *  Save on the same answer the API refuses with. */
export function employeeInputProblem(e: EmployeeInput): string | null {
  if (!e.empNo) return "Employee No is required.";
  if (!/^[A-Z0-9][A-Z0-9-]{0,19}$/.test(e.empNo)) return "Employee No: letters, digits and dashes only (max 20).";
  if (!e.name) return "Name is required.";
  if (e.joinDate && !YMD.test(e.joinDate)) return "Join date must be a date.";
  if (e.status === "RESIGNED" && !YMD.test(e.resignedOn)) return "Pick the date they resigned.";
  if (e.status !== "RESIGNED" && e.resignedOn) return "Only a resigned employee has a resigned date.";
  if (e.status === "RESIGNED" && e.joinDate && e.resignedOn < e.joinDate) return "Resigned date is before the join date.";
  const money = [e.basicSalarySen, e.dailyRateSen];
  if (money.some((v) => !Number.isInteger(v) || v < 0)) return "Salary and day rate must be RM 0.00 or more.";
  if (e.payMode === "DAILY" && e.dailyRateSen <= 0) return "A daily-paid employee needs a rate per day.";
  if (!Number.isFinite(e.workingHoursPerDay) || e.workingHoursPerDay <= 0 || e.workingHoursPerDay > 24) return "Hours / day must be between 0.5 and 24.";
  if (Math.round(e.workingHoursPerDay * 10) !== e.workingHoursPerDay * 10) return "Hours / day: at most one decimal (7.5).";
  if (!Number.isInteger(e.workingDaysPerMonth) || e.workingDaysPerMonth < 1 || e.workingDaysPerMonth > 31) return "Days / month must be a whole number from 1 to 31.";
  if (!Number.isFinite(e.otMultiplier) || e.otMultiplier < 0 || e.otMultiplier > 10) return "OT multiplier must be between 0 and 10.";
  if (e.taxChildReliefSen !== null && (!Number.isInteger(e.taxChildReliefSen) || e.taxChildReliefSen < 0)) return "Child relief must be RM 0.00 or more.";
  if (e.tripNames.length > 200) return "Trip sheet names: at most 200 characters.";
  return null;
}
