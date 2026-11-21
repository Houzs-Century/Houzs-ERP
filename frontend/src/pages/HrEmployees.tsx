/* HR > Employees & Attendance (HC-0125) — redesign shell wired to the real API
 * (phase: API wiring, step 1). The resizable grouped sidebar (HrSubnav) and the
 * full-bleed layout stay; the pages that HR uses every day are the new design on
 * real data — Overview, Employee Master, Attendance, OT Requests — and the
 * twelve calc/settings pages keep their existing, fully working screens inside
 * the new shell until each is re-skinned (step 2). The URL carries the page in
 * ?tab.
 *
 * OT Requests is gated on hr.ot.confirm: the nav item is hidden and the page is
 * not mounted without it (the server re-checks every review). Employee add/edit
 * reuses the working EmployeeDrawer and the two bulk modals; a save invalidates
 * the shared /api/hr/employees cache so every page refreshes. */
import type { ReactNode } from "react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { buildQueryKey } from "../hooks/useQuery";
import { HrSubnav, HR_NAV } from "./hr/HrSubnav";
import { HrPageHeader } from "./hr/HrPageHeader";
import { OverviewPage } from "./hr/OverviewPage";
import { EmployeeMasterPage } from "./hr/EmployeeMasterPage";
import { OtRequestsPage } from "./hr/OtRequestsPage";
import { PublicHolidaysPage } from "./hr/PublicHolidaysPage";
import { AdvancesPage } from "./hr/AdvancesPage";
import { AllowancesPage } from "./hr/AllowancesPage";
import { EmployeeDrawer } from "./hr/EmployeeDrawer";
import { AddFromAccountsModal } from "./hr/AddFromAccountsModal";
import { ImportEmployeesModal } from "./hr/ImportEmployeesModal";
import type { Employee } from "./hr/hrApi";
// Existing, fully working calc/settings screens — mounted in the new shell
// until each is re-skinned to the new design (step 2).
import { AttendanceTab } from "./hr/AttendanceTab";
import { ShiftsTab } from "./hr/ShiftsTab";
import { PunchSitesTab } from "./hr/PunchSitesTab";
import { WorkingHoursTab } from "./hr/WorkingHoursTab";
import { PayrollTab } from "./hr/PayrollTab";
import { PayRulesTab } from "./hr/PayRulesTab";
import { TripPayTab } from "./hr/TripPayTab";
import { PenaltiesTab } from "./hr/PenaltiesTab";
import { LaborCostTab } from "./hr/LaborCostTab";
import { KpiTab } from "./hr/KpiTab";

const NAV_KEYS = new Set(HR_NAV.map((n) => n.key));

/** A not-yet-re-skinned page: the new header over the existing working screen. */
function LegacyPage({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <>
      <HrPageHeader title={title} subtitle={subtitle} />
      <div className="px-6 py-4">{children}</div>
    </>
  );
}

const LEGACY: Record<string, { title: string; subtitle: string; el: ReactNode }> = {
  attendance: { title: "Attendance", subtitle: "Daily punches — view and correct", el: <AttendanceTab /> },
  shifts: { title: "Shifts", subtitle: "Per-employee shift groups for lateness and overtime", el: <ShiftsTab /> },
  hours: { title: "Working Hours", subtitle: "Hours worked per employee", el: <WorkingHoursTab /> },
  payroll: { title: "Payroll", subtitle: "The month's payslips", el: <PayrollTab /> },
  "pay-rules": { title: "Pay Rules", subtitle: "Shift, lateness, overtime and statutory rates", el: <PayRulesTab /> },
  "trip-pay": { title: "Trip Pay", subtitle: "Driver commission and trip allowances", el: <TripPayTab /> },
  labor: { title: "Labor Cost", subtitle: "A month's logged hours priced the way payroll prices them", el: <LaborCostTab /> },
  kpi: { title: "KPI", subtitle: "Monthly scorecard and allowance tier", el: <KpiTab /> },
};

export function HrEmployees() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const canOt = can("hr.ot.confirm");
  const canManage = can("hr.employees.manage");

  const [editEmp, setEditEmp] = useState<Employee | "new" | null>(null);
  const [bulk, setBulk] = useState<"accounts" | "import" | null>(null);

  const raw = params.get("tab");
  let active = raw && NAV_KEYS.has(raw) ? raw : "overview";
  if (active === "ot-requests" && !canOt) active = "overview";

  const setTab = (next: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("tab", next);
        return n;
      },
      { replace: true },
    );

  const reloadEmployees = () => void qc.invalidateQueries({ queryKey: buildQueryKey("/api/hr/employees") });
  const openEmployee = (e: Employee) => setEditEmp(e);

  const page = (() => {
    switch (active) {
      case "overview":
        return (
          <>
            <HrPageHeader title="Overview" subtitle="Today at a glance" />
            <OverviewPage onNavigate={setTab} onPickEmployee={openEmployee} />
          </>
        );
      case "employees":
        return <EmployeeMasterPage onPickEmployee={openEmployee} onNew={() => setEditEmp("new")} onBulk={setBulk} canManage={canManage} />;
      case "ot-requests":
        return (
          <>
            <HrPageHeader title="OT Requests" subtitle="Overtime reported by employees, confirmed before it reaches payroll" />
            <OtRequestsPage />
          </>
        );
      case "holidays":
        return <PublicHolidaysPage />;
      case "advances":
        return <AdvancesPage />;
      case "allowances":
        return <AllowancesPage />;
      case "penalties":
        return <PenaltiesTab />;
      case "sites":
        return <PunchSitesTab />;
      default: {
        const l = LEGACY[active] as { title: string; subtitle: string; el: ReactNode } | undefined;
        return l ? <LegacyPage title={l.title} subtitle={l.subtitle}>{l.el}</LegacyPage> : null;
      }
    }
  })();

  return (
    // Full-bleed: break out of Layout's content padding so the sidebar sits
    // flush against the app sidebar and the area fills the viewport height.
    <div className="-mx-3 -mt-6 -mb-[calc(10rem+env(safe-area-inset-bottom))] flex h-[calc(100dvh-52px)] overflow-hidden bg-bg sm:-mx-4 lg:-mx-4 lg:-mt-2 lg:-mb-10 lg:h-[calc(100dvh-52px)]">
      <HrSubnav active={active} onSelect={setTab} hiddenKeys={canOt ? undefined : OT_HIDDEN} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto thin-scroll">{page}</div>
      {editEmp && (
        <EmployeeDrawer
          employee={editEmp === "new" ? null : editEmp}
          canManage={canManage}
          onClose={() => setEditEmp(null)}
          onSaved={() => {
            setEditEmp(null);
            reloadEmployees();
          }}
        />
      )}
      <AddFromAccountsModal open={bulk === "accounts"} onClose={() => setBulk(null)} onDone={reloadEmployees} />
      <ImportEmployeesModal open={bulk === "import"} onClose={() => setBulk(null)} onDone={reloadEmployees} />
    </div>
  );
}

const OT_HIDDEN = new Set(["ot-requests"]);
