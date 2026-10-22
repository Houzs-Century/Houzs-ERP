/* Employees & Attendance (HC-0125) reads and writes over /api/hr/*, typed once
 * for every tab. Money is integer sen on the wire; the tabs show RM. */
import { api } from "../../api/client";
import { useQuery, type QueryState } from "../../hooks/useQuery";
import type { EmployeeInput } from "../../vendor/shared/hr-employee";
import type { PayRuleVersion, PayRulesConfig } from "../../vendor/shared/hr-pay-rules";
import type { AttendanceStatus } from "../../vendor/shared/hr-attendance";

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
