/* HR > Employees & Attendance (HC-0125) — the redesign, wired to the real API.
 * A resizable grouped sidebar (HrSubnav) and a full-bleed layout; every page is
 * the new design on real data. The URL carries the page in ?tab.
 *
 * OT Requests is gated on hr.ot.confirm: the nav item is hidden and the page is
 * not mounted without it (the server re-checks every review). Employee add/edit
 * reuses the working EmployeeDrawer and the two bulk modals; a save invalidates
 * the shared /api/hr/employees cache so every page refreshes. */
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
import { AttendancePage } from "./hr/AttendancePage";
import { LeavePage } from "./hr/LeavePage";
import { EmployeeDrawer } from "./hr/EmployeeDrawer";
import { AddFromAccountsModal } from "./hr/AddFromAccountsModal";
import { ImportEmployeesModal } from "./hr/ImportEmployeesModal";
import type { Employee } from "./hr/hrApi";
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

export function HrEmployees() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const canOt = can("hr.ot.confirm");
  const canManage = can("hr.employees.manage");
  const canFull = can("hr.employees.read") || can("hr.employees.manage");
  const canAttendance = canFull || can("hr.attendance.read");
  const canLeave = can("hr.leave.approve");

  const [editEmp, setEditEmp] = useState<Employee | "new" | null>(null);
  const [bulk, setBulk] = useState<"accounts" | "import" | null>(null);

  const hiddenKeys = (() => {
    if (canFull) return canOt ? undefined : OT_HIDDEN;
    const visible = new Set<string>();
    if (canAttendance) visible.add("attendance");
    if (canOt) visible.add("ot-requests");
    if (canLeave) visible.add("leave");
    return new Set(HR_NAV.filter((n) => !visible.has(n.key)).map((n) => n.key));
  })();

  const fallback = canFull ? "overview" : canAttendance ? "attendance" : canOt ? "ot-requests" : canLeave ? "leave" : "overview";
  const raw = params.get("tab");
  let active = raw && NAV_KEYS.has(raw) ? raw : fallback;
  if (active === "ot-requests" && !canOt) active = fallback;
  if (hiddenKeys?.has(active)) active = fallback;

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
      case "hours":
        return <WorkingHoursTab />;
      case "labor":
        return <LaborCostTab />;
      case "shifts":
        return <ShiftsTab />;
      case "kpi":
        return <KpiTab />;
      case "pay-rules":
        return <PayRulesTab />;
      case "payroll":
        return <PayrollTab />;
      case "trip-pay":
        return <TripPayTab />;
      case "attendance":
        return <AttendancePage />;
      case "leave":
        return <LeavePage />;
      default:
        return null;
    }
  })();

  return (
    <div className="-mx-3 -mt-6 -mb-[calc(10rem+env(safe-area-inset-bottom))] flex h-[calc(100dvh-52px)] overflow-hidden bg-bg sm:-mx-4 lg:-mx-4 lg:-mt-2 lg:-mb-10 lg:h-[calc(100dvh-52px)]">
      <HrSubnav active={active} onSelect={setTab} hiddenKeys={hiddenKeys} />
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
