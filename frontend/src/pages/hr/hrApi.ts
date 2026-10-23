/* Employees & Attendance (HC-0125) reads and writes over /api/hr/*, typed once
 * for every tab. Money is integer sen on the wire; the tabs show RM. */
import { api } from "../../api/client";
import { useQuery, type QueryState } from "../../hooks/useQuery";
import type { EmployeeInput } from "../../vendor/shared/hr-employee";
import type { PayRuleVersion, PayRulesConfig } from "../../vendor/shared/hr-pay-rules";
import type { AttendanceStatus } from "../../vendor/shared/hr-attendance";
import type { TripCommission, TripKind, TripPay, TripPayLine, TripRates } from "../../vendor/shared/hr-trip-pay";

export const HR = "/api/hr";

export type Employee = EmployeeInput & {
  id: number;
  userName: string | null;
  userEmail: string | null;
  departmentName: string | null;
  updatedAt: string;
};

export type ErpAccount = {
  id: number;
  name: string | null;
  email: string;
  phone: string | null;
  department_id: number | null;
  position: string | null;
  linkedEmpNo: string | null;
};

export type EmployeeOptions = {
  accounts: ErpAccount[];
  departments: { id: number; name: string }[];
  nextEmpNo: { staff: string; outsource: string };
};

export type SalaryRow = { id: number; effectiveFrom: string; basicSalarySen: number; note: string | null; createdAt: string };
export type PublicHoliday = { date: string; name: string | null };
export type PayRulesResponse = { versions: PayRuleVersion[]; defaults: PayRulesConfig; effectiveToday: PayRulesConfig; today: string };

export const useEmployees = (): QueryState<{ employees: Employee[]; canManage: boolean }> =>
  useQuery(`${HR}/employees`, () => api.get<{ employees: Employee[]; canManage: boolean }>(`${HR}/employees`));

export const useEmployeeOptions = (enabled: boolean): QueryState<EmployeeOptions> =>
  useQuery(`${HR}/employees/options`, () => api.get<EmployeeOptions>(`${HR}/employees/options`), [], { enabled });

export const useSalaryHistory = (employeeId: number | null): QueryState<{ history: SalaryRow[] }> =>
  useQuery(`${HR}/employees/salary-history`, () => api.get<{ history: SalaryRow[] }>(`${HR}/employees/${employeeId}/salary-history`), [employeeId], {
    enabled: employeeId != null,
  });

export const useHolidays = (): QueryState<{ holidays: PublicHoliday[] }> =>
  useQuery(`${HR}/holidays`, () => api.get<{ holidays: PublicHoliday[] }>(`${HR}/holidays`));

export const usePayRules = (): QueryState<PayRulesResponse> => useQuery(`${HR}/pay-rules`, () => api.get<PayRulesResponse>(`${HR}/pay-rules`));

export const rmFromSen = (sen: number): string => (sen / 100).toFixed(2);
export { fmtSen as fmtRm } from "../../vendor/shared/format";
/** "1,800.50" / "1800.5" -> 180050 sen; NaN when not a number. */
export const senFromRm = (rm: string): number => {
  const v = Number(rm.replace(/,/g, "").trim());
  return rm.trim() === "" ? 0 : Number.isFinite(v) ? Math.round(v * 100) : Number.NaN;
};

export type PunchSide = {
  at: string;
  clock: string;
  source: "PHONE" | "MANUAL" | "AUTO" | null;
  geo: "IN" | "OUT" | "NONE" | null;
  siteName: string | null;
  distanceM: number | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  hasPhoto: boolean;
};
export type AttendanceDay = {
  id: number;
  employeeId: number;
  workDate: string;
  status: AttendanceStatus;
  in: PunchSide | null;
  out: PunchSide | null;
  open: boolean;
  lateMin: number;
  regularMin: number;
  otMin: number;
  shortfallMin: number;
  spanMin: number | null;
  notes: string | null;
};
export type AttendanceRowOut = {
  employee: { id: number; empNo: string; name: string; position: string; department: string | null; linked: boolean; status: string };
  day: AttendanceDay | null;
};
export type AttendanceResponse = {
  date: string;
  today: string;
  shift: { startMin: number; endMin: number; lateGraceMin: number };
  rows: AttendanceRowOut[];
  sitesConfigured: number;
  canManage: boolean;
};
export type PunchSiteOut = { id: number; name: string; lat: number; lng: number; radiusM: number; active: boolean };

export const useAttendance = (date: string): QueryState<AttendanceResponse> =>
  useQuery(`${HR}/attendance`, () => api.get<AttendanceResponse>(`${HR}/attendance?date=${encodeURIComponent(date)}`), [date]);

export const usePunchSites = (): QueryState<{ sites: PunchSiteOut[]; canManage: boolean }> =>
  useQuery(`${HR}/punch-sites`, () => api.get<{ sites: PunchSiteOut[]; canManage: boolean }>(`${HR}/punch-sites`));

export type WorkDay = {
  attendanceId: number;
  employeeId: number;
  workDate: string;
  status: AttendanceStatus;
  clockIn: string | null;
  clockOut: string | null;
  outSource: "PHONE" | "MANUAL" | "AUTO" | null;
  punchHours: number | null;
};
export type HoursEntry = { id: number; attendanceId: number; employeeId: number; workDate: string; departmentId: number | null; hours: number; source: "AUTO" | "MANUAL"; notes: string | null };
export type WorkingHoursResponse = {
  from: string;
  to: string;
  employees: { id: number; empNo: string; name: string; departmentId: number | null; status: string; hoursPerDay: number }[];
  departments: { id: number; name: string }[];
  days: WorkDay[];
  entries: HoursEntry[];
  canManage: boolean;
};
export type LaborLine = { hours: number; otHours: number; costSen: number; otCostSen: number };
export type LaborCostResponse = {
  from: string;
  to: string;
  totals: LaborLine & { employees: number };
  byDepartment: (LaborLine & { departmentId: number | null; name: string; headcount: number })[];
  byEmployee: (LaborLine & { employeeId: number; empNo: string; name: string; departmentName: string; days: number; payMode: "MONTHLY" | "DAILY"; salaryMissing: boolean })[];
  canManage: boolean;
};
export type HourDeduction = { id: number; employeeId: number; empNo: string; name: string; workDate: string; hours: number; source: "AUTO" | "MANUAL"; note: string | null };

export const useWorkingHours = (from: string, to: string): QueryState<WorkingHoursResponse> =>
  useQuery(`${HR}/working-hours`, () => api.get<WorkingHoursResponse>(`${HR}/working-hours?from=${from}&to=${to}`), [from, to]);

export const useLaborCost = (from: string, to: string): QueryState<LaborCostResponse> =>
  useQuery(`${HR}/labor-cost`, () => api.get<LaborCostResponse>(`${HR}/labor-cost?from=${from}&to=${to}`), [from, to]);

export const useHourDeductions = (period: string): QueryState<{ period: string; deductions: HourDeduction[]; totalHours: number; canManage: boolean }> =>
  useQuery(`${HR}/hour-deductions`, () => api.get<{ period: string; deductions: HourDeduction[]; totalHours: number; canManage: boolean }>(`${HR}/hour-deductions?period=${period}`), [period]);

export type Payslip = {
  id: number | null;
  employeeId: number;
  period: string;
  status: "DRAFT" | "APPROVED" | "PAID";
  empNo: string;
  employeeName: string;
  departmentName: string | null;
  payMode: "MONTHLY" | "DAILY";
  fullSalarySen: number;
  dayRateSen: number;
  hourRateSen: number;
  daysWorked: number;
  absentDays: number;
  absenceDeductionSen: number;
  shortHours: number;
  shortHourDeductionSen: number;
  basicEarnedSen: number;
  otWeekdayHours: number;
  otSundayHours: number;
  otHolidayHours: number;
  otWeekdayPaySen: number;
  otSundayPaySen: number;
  otHolidayPaySen: number;
  otPaySen: number;
  allowancesSen: number;
  commissionSen: number;
  tripAllowanceSen: number;
  backpaySen: number;
  grossSen: number;
  epfEmployeeSen: number;
  epfEmployerSen: number;
  socsoEmployeeSen: number;
  socsoEmployerSen: number;
  eisEmployeeSen: number;
  eisEmployerSen: number;
  pcbSen: number;
  pcbStatus: "DISABLED" | "COMPUTED" | "ZERO_PROVEN" | "UNKNOWN";
  statutoryEmployeeSen: number;
  advanceSen: number;
  penaltySen: number;
  netSen: number;
  paymentMethod: "TRANSFER" | "CASH";
  bankName: string | null;
  bankAccount: string | null;
  detail: {
    absentDates: string[];
    paidLeaveDates?: string[];
    otDays: { date: string; hours: number; kind: string }[];
    advanceDates: string[];
    pcbNote: string;
    allowances?: { kind: AllowanceKind; label: string; amountSen: number; note: string | null }[];
    trip?: { commission: TripCommission; lines: TripPayLine[] } | null;
  };
  approvedAt: string | null;
  paidAt: string | null;
};
export type PayrollResponse = {
  period: string;
  stored: boolean;
  projected: boolean;
  locked: boolean;
  status: "DRAFT" | "APPROVED" | "PAID" | "MIXED" | null;
  monthFinished: boolean;
  slips: Payslip[];
  canManage: boolean;
  canApprove: boolean;
};
export type Advance = { id: number; employeeId: number; empNo: string; name: string; date: string; amountSen: number; note: string | null; status: "UNSETTLED" | "SETTLED" };
export type Penalty = {
  id: number;
  penaltyNo: string;
  date: string;
  reference: string | null;
  reason: string;
  remarks: string | null;
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "POSTED";
  createdBy: number | null;
  createdByName: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  lines: { id: number; employeeId: number; empNo: string; name: string; amountSen: number; payrollPeriod: string | null; posted: boolean }[];
};

export const usePayroll = (period: string): QueryState<PayrollResponse> => useQuery(`${HR}/payroll`, () => api.get<PayrollResponse>(`${HR}/payroll?period=${period}`), [period]);
export const useAdvances = (period: string): QueryState<{ period: string; advances: Advance[]; totalSen: number; canManage: boolean }> =>
  useQuery(`${HR}/advances`, () => api.get<{ period: string; advances: Advance[]; totalSen: number; canManage: boolean }>(`${HR}/advances?period=${period}`), [period]);
export const usePenalties = (): QueryState<{ penalties: Penalty[]; me: number; canManage: boolean; canApprove: boolean }> =>
  useQuery(`${HR}/penalties`, () => api.get<{ penalties: Penalty[]; me: number; canManage: boolean; canApprove: boolean }>(`${HR}/penalties`));

export const ALLOWANCE_KINDS = [
  { value: "LEADERSHIP", label: "Leadership allowance" },
  { value: "TRANSPORT", label: "Transport allowance" },
  { value: "OVERNIGHT", label: "Overnight allowance" },
  { value: "KPI", label: "KPI allowance" },
  { value: "OTHER", label: "Allowance" },
  { value: "BACKPAY", label: "Backpay (company advance)" },
] as const;
export type AllowanceKind = (typeof ALLOWANCE_KINDS)[number]["value"];
export type Allowance = {
  id: number;
  employeeId: number;
  empNo: string;
  name: string;
  kind: AllowanceKind;
  label: string;
  amountSen: number;
  fromPeriod: string;
  untilPeriod: string | null;
  note: string | null;
};
export type AllowancesResponse = { period: string; allowances: Allowance[]; paidSen: number; deductedSen: number; locked: boolean; canManage: boolean };
export const useAllowances = (period: string): QueryState<AllowancesResponse> =>
  useQuery(`${HR}/allowances`, () => api.get<AllowancesResponse>(`${HR}/allowances?period=${period}`), [period]);

export type TripPerson = { name: string; employeeId: number | null };
export type TripRowOut = {
  id: number;
  source: "SHEET" | "PLANNING" | "MANUAL";
  tripDate: string;
  docNo: string;
  transferTo: string;
  refNo: string;
  kind: TripKind;
  localTotalSen: number;
  state: string;
  lorryPlate: string;
  driver1: TripPerson;
  driver2: TripPerson;
  helper1: TripPerson;
  helper2: TripPerson;
  /** Who each named person resolved to; null = nobody, absent = no one in that seat. */
  matched: { driver1?: number | null; driver2?: number | null; helper1?: number | null; helper2?: number | null };
};
export type TripPersonPay = TripPay & {
  empNo: string;
  name: string;
  missed: { days: number; dates: string[]; override: number | null; note: string | null; noAttendance: boolean } | null;
};
export type TripPayResponse = {
  month: string;
  first: string;
  last: string;
  locked: boolean;
  rates: TripRates;
  rows: TripRowOut[];
  people: TripPersonPay[];
  unmatched: { name: string; rows: number }[];
  totals: { commissionSen: number; allowanceSen: number };
  sources: string[];
  canManage: boolean;
};
export const useTripPay = (month: string): QueryState<TripPayResponse> =>
  useQuery(`${HR}/trip-pay`, () => api.get<TripPayResponse>(`${HR}/trip-pay?month=${month}`), [month]);

export type TripRateVersion = { id: number; effectiveFrom: string; rates: TripRates; note: string | null; createdAt: string };
export type TripRatesResponse = { versions: TripRateVersion[]; defaults: TripRates; effectiveToday: TripRates; today: string; canManage: boolean };
export const useTripRates = (): QueryState<TripRatesResponse> => useQuery(`${HR}/trip-rates`, () => api.get<TripRatesResponse>(`${HR}/trip-rates`));
