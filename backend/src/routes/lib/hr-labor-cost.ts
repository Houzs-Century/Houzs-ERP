/* The Labor Cost tab's arithmetic (HC-0125 phase 3), pure: logged hours ->
 * cost by department and by employee, with Hookka's day costing
 * (scm/shared/hr-labor.ts dayEntryCostsSen). Hookka's version also set the
 * cost against production revenue by SOFA / BEDFRAME line; Century has no
 * production revenue, so it is cost and hours only. */
import { countWorkingDays, dayEntryCostsSen, type CostEmployee } from "../../scm/shared/hr-labor";
import type { PayRulesConfig } from "../../scm/shared/hr-pay-rules";
import { salaryAsOf } from "./hr-rules";

export type CostEntry = { employeeId: number; workDate: string; departmentId: number | null; hours: number };
export type CostEmployeeIn = CostEmployee & { id: number; empNo: string; name: string; departmentId: number | null };

export type LaborLine = { hours: number; otHours: number; costSen: number; otCostSen: number };
export type DeptLine = LaborLine & { departmentId: number | null; name: string; headcount: number };
export type EmployeeLine = LaborLine & { employeeId: number; empNo: string; name: string; departmentName: string; days: number; payMode: "MONTHLY" | "DAILY"; salaryMissing: boolean };

const blank = (): LaborLine => ({ hours: 0, otHours: 0, costSen: 0, otCostSen: 0 });
const add = (a: LaborLine, b: LaborLine) => {
  a.hours += b.hours;
  a.otHours += b.otHours;
  a.costSen += b.costSen;
  a.otCostSen += b.otCostSen;
};

export function laborCost(args: {
  employees: ReadonlyArray<CostEmployeeIn>;
  salaryHistory: ReadonlyMap<number, ReadonlyArray<{ effective_from: string; basic_salary_sen: number }>>;
  entries: ReadonlyArray<CostEntry>;
  holidays: ReadonlySet<string>;
  cfgFor: (ymd: string) => PayRulesConfig;
  departmentNames: ReadonlyMap<number, string>;
}): { totals: LaborLine & { employees: number }; byDepartment: DeptLine[]; byEmployee: EmployeeLine[] } {
  const emps = new Map(args.employees.map((e) => [e.id, e]));
  const groups = new Map<string, CostEntry[]>();
  for (const e of args.entries) {
    const k = `${e.employeeId}|${e.workDate}`;
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  const monthDays = new Map<string, number>();
  const dept = new Map<number | null, LaborLine & { people: Set<number> }>();
  const person = new Map<number, LaborLine & { days: Set<string> }>();
  for (const [k, segs] of groups) {
    const [idRaw, ymd] = k.split("|");
    const emp = emps.get(Number(idRaw));
    if (!emp) continue;
    const ym = ymd.slice(0, 7);
    let wd = monthDays.get(ym);
    if (wd == null) {
      const [y, m] = ym.split("-").map(Number);
      wd = Math.max(1, countWorkingDays(y, m, 31, args.holidays));
      monthDays.set(ym, wd);
    }
    const lastOfMonth = `${ym}-${String(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
    const salary = salaryAsOf(args.salaryHistory.get(emp.id) ?? [], lastOfMonth) ?? 0;
    const r = dayEntryCostsSen({ employee: emp, salarySen: salary, ymd, entryHours: segs.map((s) => s.hours), monthWorkingDays: wd, holidays: args.holidays, cfg: args.cfgFor(ymd) });
    const dayHours = segs.reduce((s, x) => s + x.hours, 0);
    segs.forEach((s, i) => {
      const line: LaborLine = { hours: s.hours, otHours: dayHours > 0 ? (r.otHours * s.hours) / dayHours : 0, costSen: r.costs[i], otCostSen: r.otCosts[i] };
      const d = dept.get(s.departmentId) ?? { ...blank(), people: new Set<number>() };
      add(d, line);
      d.people.add(emp.id);
      dept.set(s.departmentId, d);
      const p = person.get(emp.id) ?? { ...blank(), days: new Set<string>() };
      add(p, line);
      p.days.add(ymd);
      person.set(emp.id, p);
    });
  }
  const round = (l: LaborLine): LaborLine => ({
    hours: Math.round(l.hours * 100) / 100,
    otHours: Math.round(l.otHours * 100) / 100,
    costSen: Math.round(l.costSen),
    otCostSen: Math.round(l.otCostSen),
  });
  const byDepartment: DeptLine[] = [...dept.entries()]
    .map(([id, d]) => ({ ...round(d), departmentId: id, name: id == null ? "No department" : args.departmentNames.get(id) ?? "Unknown", headcount: d.people.size }))
    .sort((a, b) => b.costSen - a.costSen);
  const byEmployee: EmployeeLine[] = [...person.entries()]
    .map(([id, p]) => {
      const e = emps.get(id)!;
      const monthly = e.payMode === "MONTHLY";
      return {
        ...round(p),
        employeeId: id,
        empNo: e.empNo,
        name: e.name,
        departmentName: e.departmentId == null ? "" : args.departmentNames.get(e.departmentId) ?? "",
        days: p.days.size,
        payMode: e.payMode,
        salaryMissing: monthly ? !(args.salaryHistory.get(id) ?? []).length : e.dailyRateSen <= 0,
      };
    })
    .sort((a, b) => a.empNo.localeCompare(b.empNo));
  const totals = blank();
  for (const d of byDepartment) add(totals, d);
  return { totals: { ...round(totals), employees: person.size }, byDepartment, byEmployee };
}
