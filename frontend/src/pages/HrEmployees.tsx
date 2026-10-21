/* HR > Employees & Attendance (HC-0125), ported from Hookka's /employees.
 * Phase 1 carries the master data: Employee Master, Public Holidays, Pay
 * Rules. Attendance, Working Hours, Labor Cost, Payroll and the phone punch
 * join in the later phases. The URL carries the tab. */
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { EmployeeMasterTab } from "./hr/EmployeeMasterTab";
import { PublicHolidaysTab } from "./hr/PublicHolidaysTab";
import { PayRulesTab } from "./hr/PayRulesTab";

type Tab = "employees" | "holidays" | "pay-rules";
const TABS: TabOption<Tab>[] = [
  { value: "employees", label: "Employee Master" },
  { value: "holidays", label: "Public Holidays" },
  { value: "pay-rules", label: "Pay Rules" },
];

const HEADER: Record<Tab, { title: string; description: string }> = {
  employees: {
    title: "Employee Master",
    description: "Drivers, helpers and warehouse crew: the ERP account they punch in with, pay basis, how they are paid, statutory. Click a row to edit.",
  },
  holidays: { title: "Public Holidays", description: "Dates nobody is docked for not working. Hours worked on them count as public-holiday overtime." },
  "pay-rules": { title: "Pay Rules", description: "Shift, lateness, overtime and statutory rates. A change is scheduled from a date, so earlier months keep the rules they were paid under." },
};

export function HrEmployees() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") as Tab | null;
  const active: Tab = raw && TABS.some((t) => t.value === raw) ? raw : "employees";
  const setTab = (next: Tab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("tab", next);
        return n;
      },
      { replace: true },
    );
  return (
    <div className="max-w-7xl">
      <TabStrip<Tab> value={active} onChange={setTab} options={TABS} />
      <PageHeader eyebrow="HR · Employees & Attendance" title={HEADER[active].title} description={HEADER[active].description} />
      {active === "employees" && <EmployeeMasterTab />}
      {active === "holidays" && <PublicHolidaysTab />}
      {active === "pay-rules" && <PayRulesTab />}
    </div>
  );
}
