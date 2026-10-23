/* HR > Employees & Attendance (HC-0125), ported from Hookka's /employees.
 * Phase 1 carries the master data (Employee Master, Public Holidays, Pay
 * Rules), phase 2 the punch clock (Attendance, Punch Sites; the phone half is
 * mobile/MobilePunch.tsx), phase 3 the hours pay reads (Working Hours, Labor
 * Cost with the short-hour docks), phase 4 the pay (Payroll, Advances,
 * Penalty; the phone half is My pay in mobile/MobilePunch.tsx), phase 5 the
 * driver commission and trip allowances (Trip Pay) and the monthly
 * Allowances. The URL carries the tab. */
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { EmployeeMasterTab } from "./hr/EmployeeMasterTab";
import { PublicHolidaysTab } from "./hr/PublicHolidaysTab";
import { PayRulesTab } from "./hr/PayRulesTab";
import { AttendanceTab } from "./hr/AttendanceTab";
import { PunchSitesTab } from "./hr/PunchSitesTab";
import { WorkingHoursTab } from "./hr/WorkingHoursTab";
import { LaborCostTab } from "./hr/LaborCostTab";
import { PayrollTab } from "./hr/PayrollTab";
import { AdvancesTab } from "./hr/AdvancesTab";
import { PenaltiesTab } from "./hr/PenaltiesTab";
import { TripPayTab } from "./hr/TripPayTab";
import { AllowancesTab } from "./hr/AllowancesTab";

type Tab = "employees" | "attendance" | "hours" | "labor" | "payroll" | "trip-pay" | "allowances" | "advances" | "penalties" | "sites" | "holidays" | "pay-rules";
const TABS: TabOption<Tab>[] = [
  { value: "employees", label: "Employee Master" },
  { value: "attendance", label: "Attendance" },
  { value: "hours", label: "Working Hours" },
  { value: "labor", label: "Labor Cost" },
  { value: "payroll", label: "Payroll" },
  { value: "trip-pay", label: "Trip Pay" },
  { value: "allowances", label: "Allowances" },
  { value: "advances", label: "Advances" },
  { value: "penalties", label: "Penalty" },
  { value: "sites", label: "Punch Sites" },
  { value: "holidays", label: "Public Holidays" },
  { value: "pay-rules", label: "Pay Rules" },
];

const HEADER: Record<Tab, { title: string; description: string }> = {
  employees: {
    title: "Employee Master",
    description: "Drivers, helpers and warehouse crew: the ERP account they punch in with, pay basis, how they are paid, statutory. Click a row to edit.",
  },
  attendance: {
    title: "Attendance",
    description: "Phone punches for one day: when, where (site and distance), the selfie. Everyone active is listed, so a missing punch shows. Click a row to key or correct the day.",
  },
  hours: {
    title: "Working Hours",
    description: "The hours pay reads, one line per person per day. A clock-out logs them in the person's department; HR edits, splits or adds hours, and a punch never writes over HR's.",
  },
  labor: {
    title: "Labor Cost",
    description: "A month's logged hours priced the way payroll prices them, by department and by person, and the short-hour docks with Settle month.",
  },
  payroll: {
    title: "Payroll",
    description: "The month's payslips from the logged hours and docks: absences, late and short hours, OT by day type, EPF / SOCSO / EIS / PCB, advances and penalties. Generate, approve (locks the month), mark paid.",
  },
  "trip-pay": {
    title: "Trip Pay",
    description: "Driver commission and trip allowances for a trip month (23rd to 22nd): paste the Trip Report or read Delivery Planning, fix a job type or a name, and each person's pay lands on that month's payslip.",
  },
  allowances: {
    title: "Allowances",
    description: "Leadership, transport and KPI allowances for one month or every month, and Backpay (company advance), which is deducted. Overnight is paid on Trip Pay from the punches; add one here only for a night the punches missed.",
  },
  advances: { title: "Advances", description: "Cash given ahead of payday, taken back in full from the payslip of the month it was given." },
  penalties: { title: "Penalty", description: "A penalty for an incident, approved by someone other than who raised it, then deducted in the payroll month it lands in." },
  sites: {
    title: "Punch Sites",
    description: "Where a phone punch counts as on site: each warehouse or showroom as a point and a radius. An off-site punch still records; HR sees how far away it was.",
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
      {active === "attendance" && <AttendanceTab />}
      {active === "hours" && <WorkingHoursTab />}
      {active === "labor" && <LaborCostTab />}
      {active === "payroll" && <PayrollTab />}
      {active === "trip-pay" && <TripPayTab />}
      {active === "allowances" && <AllowancesTab />}
      {active === "advances" && <AdvancesTab />}
      {active === "penalties" && <PenaltiesTab />}
      {active === "sites" && <PunchSitesTab />}
      {active === "holidays" && <PublicHolidaysTab />}
      {active === "pay-rules" && <PayRulesTab />}
    </div>
  );
}
