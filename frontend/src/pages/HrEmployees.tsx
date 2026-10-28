/* HR > Employees & Attendance (HC-0125), ported from Hookka's /employees.
 * Phase 1 carries the master data (Employee Master, Public Holidays, Pay
 * Rules), phase 2 the punch clock (Attendance, Punch Sites; the phone half is
 * mobile/MobilePunch.tsx). Working Hours, Labor Cost and Payroll join in the
 * later phases. The URL carries the tab. */
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { EmployeeMasterTab } from "./hr/EmployeeMasterTab";
import { PublicHolidaysTab } from "./hr/PublicHolidaysTab";
import { PayRulesTab } from "./hr/PayRulesTab";
import { AttendanceTab } from "./hr/AttendanceTab";
import { PunchSitesTab } from "./hr/PunchSitesTab";

type Tab = "employees" | "attendance" | "sites" | "holidays" | "pay-rules";
const TABS: TabOption<Tab>[] = [
  { value: "employees", label: "Employee Master" },
  { value: "attendance", label: "Attendance" },
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
      {active === "sites" && <PunchSitesTab />}
      {active === "holidays" && <PublicHolidaysTab />}
      {active === "pay-rules" && <PayRulesTab />}
    </div>
  );
}
