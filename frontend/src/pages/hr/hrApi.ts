/* Employees & Attendance (HC-0125) reads and writes over /api/hr/*, typed once
 * for every tab. Money is integer sen on the wire; the tabs show RM. */
import { api } from "../../api/client";
import { useQuery, type QueryState } from "../../hooks/useQuery";
import type { EmployeeInput } from "../../vendor/shared/hr-employee";
import type { PayRuleVersion, PayRulesConfig } from "../../vendor/shared/hr-pay-rules";

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
