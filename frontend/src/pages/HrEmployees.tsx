/* HR > Employees & Attendance (HC-0125). Redesign (handoff
 * design_handoff_hr_employees_attendance): the 14-tab strip is replaced by a
 * resizable/collapsible grouped secondary sidebar (HrSubnav), the content
 * fills the full viewport (no max-width), and two new pages — Overview
 * (default) and OT Requests — join the existing tab bodies. Sidebar first;
 * Overview / OT Requests / per-page restyle land in later stages. The URL
 * carries the page in ?tab. */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { HrSubnav, HR_NAV } from "./hr/HrSubnav";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./hr/HrPageHeader";
import { OverviewPage } from "./hr/OverviewPage";
import { EmployeeMasterPage } from "./hr/EmployeeMasterPage";
import { AttendancePage } from "./hr/AttendancePage";
import { OtRequestsPage } from "./hr/OtRequestsPage";
import { PayrollPage } from "./hr/PayrollPage";
import { EmployeeEditModal } from "./hr/EmployeeEditModal";
import type { Emp } from "./hr/hrSampleData";
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
import { KpiTab } from "./hr/KpiTab";
import { ShiftsTab } from "./hr/ShiftsTab";

type Tab =
  | "overview" | "employees" | "shifts" | "sites"
  | "attendance" | "ot-requests" | "hours" | "holidays"
  | "payroll" | "pay-rules" | "trip-pay" | "allowances" | "advances" | "penalties" | "labor"
  | "kpi";

const NAV_KEYS = new Set(HR_NAV.map((n) => n.key));

const HEADER: Record<Tab, { title: string; description: string }> = {
  overview: { title: "Overview", description: "Today at a glance across Employees & Attendance." },
  employees: {
    title: "Employee Master",
    description: "Drivers, helpers and warehouse crew: the ERP account they punch in with, pay basis, how they are paid, statutory. Click a row to edit.",
  },
  attendance: {
    title: "Attendance",
    description: "Phone punches for one day: when, where (site and distance), the selfie. Everyone active is listed, so a missing punch shows. Click a row to key or correct the day.",
  },
  "ot-requests": { title: "OT Requests", description: "Overtime workers reported on the phone: approve or reject before payroll closes. Confirmed overtime is what payroll pays." },
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
  kpi: {
    title: "KPI",
    description: "The monthly KPI appraisal: rate each weighted KPI 1-5 per week; the final score lands in a payout tier and that RM (by role) is booked as the month's KPI allowance when you confirm. Edit the KPIs and amounts under Settings.",
  },
  advances: { title: "Advances", description: "Cash given ahead of payday, taken back in full from the payslip of the month it was given." },
  penalties: { title: "Penalty", description: "A penalty for an incident, approved by someone other than who raised it, then deducted in the payroll month it lands in." },
  sites: {
    title: "Punch Sites",
    description: "Where a phone punch counts as on site: each warehouse or showroom as a point and a radius. An off-site punch still records; HR sees how far away it was.",
  },
  holidays: { title: "Public Holidays", description: "Dates nobody is docked for not working. Hours worked on them count as public-holiday overtime." },
  "pay-rules": { title: "Pay Rules", description: "Shift, lateness, overtime and statutory rates. A change is scheduled from a date, so earlier months keep the rules they were paid under." },
  shifts: {
    title: "Shifts",
    description: "Shift groups give each employee their own shift for lateness and overtime, with a delivery-day shift used when DP sent a warehouse member on a delivery. Assign each employee a group; no group uses the global Pay Rules shift.",
  },
};

export function HrEmployees() {
  const [params, setParams] = useSearchParams();
  const [modalEmp, setModalEmp] = useState<Emp | null>(null);
  const raw = params.get("tab");
  const active: Tab = (raw && NAV_KEYS.has(raw) ? raw : "overview") as Tab;
  const setTab = (next: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("tab", next);
        return n;
      },
      { replace: true },
    );

  const body = (() => {
    switch (active) {
      case "employees": return <EmployeeMasterTab />;
      case "attendance": return <AttendanceTab />;
      case "hours": return <WorkingHoursTab />;
      case "labor": return <LaborCostTab />;
      case "payroll": return <PayrollTab />;
      case "trip-pay": return <TripPayTab />;
      case "allowances": return <AllowancesTab />;
      case "kpi": return <KpiTab />;
      case "advances": return <AdvancesTab />;
      case "penalties": return <PenaltiesTab />;
      case "sites": return <PunchSitesTab />;
      case "holidays": return <PublicHolidaysTab />;
      case "pay-rules": return <PayRulesTab />;
      case "shifts": return <ShiftsTab />;
      default: return null;
    }
  })();
  const head = HEADER[active];

  return (
    // Full-bleed: break out of Layout's content padding so the sidebar sits
    // flush against the app sidebar and the area fills the viewport height.
    <div className="-mx-3 -mt-6 -mb-[calc(10rem+env(safe-area-inset-bottom))] flex h-[calc(100dvh-52px)] overflow-hidden bg-bg sm:-mx-4 lg:-mx-4 lg:-mt-2 lg:-mb-10 lg:h-[calc(100dvh-52px)]">
      <HrSubnav active={active} onSelect={setTab} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto thin-scroll">
        {active === "overview" ? (
          <>
            <HrPageHeader
              title="Overview"
              subtitle="Friday, 20 Nov 2026 · Operation Department"
              actions={
                <>
                  <button type="button" className={hrSecondaryBtn}>Export report</button>
                  <button type="button" className={hrPrimaryBtn}>+ Add employee</button>
                </>
              }
            />
            <OverviewPage onNavigate={setTab} onPickEmployee={setModalEmp} />
          </>
        ) : active === "employees" ? (
          <EmployeeMasterPage onPickEmployee={setModalEmp} />
        ) : active === "attendance" ? (
          <AttendancePage onPickEmployee={setModalEmp} />
        ) : active === "ot-requests" ? (
          <>
            <HrPageHeader
              title="OT Requests"
              subtitle="Overtime submitted by employees or supervisors, approved before it reaches payroll"
              actions={<><button type="button" className={hrSecondaryBtn}>Export</button><button type="button" className={hrPrimaryBtn}>+ New OT request</button></>}
            />
            <OtRequestsPage />
          </>
        ) : active === "payroll" ? (
          <PayrollPage />
        ) : (
          <div className="px-6 py-4">
            <PageHeader eyebrow="HR · Employees & Attendance" title={head.title} description={head.description} />
            {body}
          </div>
        )}
      </div>
      {modalEmp && <EmployeeEditModal emp={modalEmp} onClose={() => setModalEmp(null)} />}
    </div>
  );
}
