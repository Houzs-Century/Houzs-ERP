/* HR > Employees & Attendance (HC-0125) — redesign (handoff
 * design_handoff_hr_employees_attendance). The 14-tab strip is replaced by a
 * resizable/collapsible grouped secondary sidebar (HrSubnav); the content fills
 * the viewport (no max-width). Every page is rebuilt on the shared design
 * system with sample data (API wiring is a later phase). The URL carries the
 * page in ?tab. */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { HrSubnav, HR_NAV } from "./hr/HrSubnav";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./hr/HrPageHeader";
import { OverviewPage } from "./hr/OverviewPage";
import { EmployeeMasterPage } from "./hr/EmployeeMasterPage";
import { AttendancePage } from "./hr/AttendancePage";
import { OtRequestsPage } from "./hr/OtRequestsPage";
import { PayrollPage } from "./hr/PayrollPage";
import { ShiftsPage, PunchSitesPage, WorkingHoursPage, PublicHolidaysPage, PayRulesPage, TripPayPage, AllowancesPage, AdvancesPage, PenaltyPage, LaborCostPage, KpiPage } from "./hr/HrSubPages";
import { EmployeeEditModal } from "./hr/EmployeeEditModal";
import type { Emp } from "./hr/hrSampleData";

const NAV_KEYS = new Set(HR_NAV.map((n) => n.key));

export function HrEmployees() {
  const [params, setParams] = useSearchParams();
  const [modalEmp, setModalEmp] = useState<Emp | null>(null);
  const raw = params.get("tab");
  const active = raw && NAV_KEYS.has(raw) ? raw : "overview";
  const setTab = (next: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("tab", next);
        return n;
      },
      { replace: true },
    );

  const page = (() => {
    switch (active) {
      case "overview":
        return (
          <>
            <HrPageHeader
              title="Overview"
              subtitle="Friday, 20 Nov 2026 · Operation Department"
              actions={<><button type="button" className={hrSecondaryBtn}>Export report</button><button type="button" className={hrPrimaryBtn}>+ Add employee</button></>}
            />
            <OverviewPage onNavigate={setTab} onPickEmployee={setModalEmp} />
          </>
        );
      case "employees": return <EmployeeMasterPage onPickEmployee={setModalEmp} />;
      case "shifts": return <ShiftsPage />;
      case "sites": return <PunchSitesPage />;
      case "attendance": return <AttendancePage onPickEmployee={setModalEmp} />;
      case "ot-requests":
        return (
          <>
            <HrPageHeader
              title="OT Requests"
              subtitle="Overtime submitted by employees or supervisors, approved before it reaches payroll"
              actions={<><button type="button" className={hrSecondaryBtn}>Export</button><button type="button" className={hrPrimaryBtn}>+ New OT request</button></>}
            />
            <OtRequestsPage />
          </>
        );
      case "hours": return <WorkingHoursPage />;
      case "holidays": return <PublicHolidaysPage />;
      case "payroll": return <PayrollPage />;
      case "pay-rules": return <PayRulesPage />;
      case "trip-pay": return <TripPayPage />;
      case "allowances": return <AllowancesPage />;
      case "advances": return <AdvancesPage />;
      case "penalties": return <PenaltyPage />;
      case "labor": return <LaborCostPage />;
      case "kpi": return <KpiPage />;
      default: return null;
    }
  })();

  return (
    // Full-bleed: break out of Layout's content padding so the sidebar sits
    // flush against the app sidebar and the area fills the viewport height.
    <div className="-mx-3 -mt-6 -mb-[calc(10rem+env(safe-area-inset-bottom))] flex h-[calc(100dvh-52px)] overflow-hidden bg-bg sm:-mx-4 lg:-mx-4 lg:-mt-2 lg:-mb-10 lg:h-[calc(100dvh-52px)]">
      <HrSubnav active={active} onSelect={setTab} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto thin-scroll">{page}</div>
      {modalEmp && <EmployeeEditModal emp={modalEmp} onClose={() => setModalEmp(null)} />}
    </div>
  );
}
