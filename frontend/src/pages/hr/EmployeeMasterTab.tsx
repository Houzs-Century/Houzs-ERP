/* Employees & Attendance > Employee Master (HC-0125, from Hookka's
 * EmployeeMasterTab): one row per employee with the pay basis payroll reads.
 * The ERP account column is Century's own: punch in / out happens on the phone
 * with that account (Nico, option B), so an unlinked row cannot punch. */
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { DataTable, type Column } from "../../components/DataTable";
import { formatDate } from "../../lib/utils";
import { PAYMENT_METHODS } from "../../vendor/shared/hr-employee";
import { Pill, primaryBtn } from "../pos-admin/posAdminUi";
import { EmployeeDrawer } from "./EmployeeDrawer";
import { fmtRm, useEmployees, type Employee } from "./hrApi";

const statusPill = (e: Employee) =>
  e.status === "ACTIVE" ? (
    <Pill tone="ok">Active</Pill>
  ) : e.status === "RESIGNED" ? (
    <span className="inline-flex items-center gap-1">
      <Pill tone="muted">Resigned</Pill>
      <span className="text-[10.5px] text-ink-muted">left {formatDate(e.resignedOn)}</span>
    </span>
  ) : (
    <Pill tone="muted">Inactive</Pill>
  );

const statutoryText = (e: Employee): string => {
  const on = [e.epfEnabled && "EPF", e.socsoEnabled && "SOCSO", e.eisEnabled && "EIS", e.pcbEnabled && "PCB"].filter(Boolean);
  return on.length ? on.join(" · ") : "None";
};

const COLUMNS: Column<Employee>[] = [
  { key: "empNo", label: "Emp No", getValue: (e) => e.empNo, render: (e) => <span className="font-mono text-[11px] font-semibold text-accent">{e.empNo}</span> },
  { key: "name", label: "Name", getValue: (e) => e.name, render: (e) => e.name },
  {
    key: "account",
    label: "ERP Account",
    description: "The account this person punches in / out with on the phone. Not linked = cannot punch.",
    getValue: (e) => e.userName ?? e.userEmail ?? "",
    render: (e) =>
      e.userId ? (
        <span className="text-[11px]">{e.userName ?? e.userEmail}</span>
      ) : (
        <Pill tone="warn">Not linked</Pill>
      ),
  },
  { key: "department", label: "Department", getValue: (e) => e.departmentName ?? "", render: (e) => e.departmentName ?? <span className="text-ink-muted">--</span> },
  { key: "position", label: "Position", getValue: (e) => e.position, render: (e) => e.position || <span className="text-ink-muted">--</span> },
  { key: "phone", label: "Phone", defaultHidden: true, getValue: (e) => e.phone, render: (e) => <span className="font-mono text-[10.5px]">{e.phone || "--"}</span> },
  {
    key: "pay",
    label: "Basic Salary",
    align: "right",
    description: "Monthly: the basic salary in force today. Daily: the rate per day.",
    getValue: (e) => (e.payMode === "DAILY" ? e.dailyRateSen : e.basicSalarySen),
    render: (e) => (
      <span className="font-mono">
        {e.payMode === "DAILY" ? `${fmtRm(e.dailyRateSen)} / day` : fmtRm(e.basicSalarySen)}
      </span>
    ),
  },
  { key: "hoursPerDay", label: "Hrs/Day", align: "right", defaultHidden: true, getValue: (e) => e.workingHoursPerDay, render: (e) => e.workingHoursPerDay },
  { key: "daysPerMonth", label: "Days/Mo", align: "right", defaultHidden: true, getValue: (e) => e.workingDaysPerMonth, render: (e) => e.workingDaysPerMonth },
  { key: "ot", label: "OT x", align: "right", defaultHidden: true, getValue: (e) => e.otMultiplier, render: (e) => `${e.otMultiplier}x` },
  {
    key: "payBy",
    label: "Pay By",
    defaultHidden: true,
    getValue: (e) => PAYMENT_METHODS.find((m) => m.value === e.paymentMethod)?.label ?? e.paymentMethod,
    render: (e) => PAYMENT_METHODS.find((m) => m.value === e.paymentMethod)?.label ?? e.paymentMethod,
  },
  { key: "bank", label: "Bank", defaultHidden: true, getValue: (e) => e.bankName, render: (e) => e.bankName || <span className="text-ink-muted">--</span> },
  { key: "statutory", label: "Statutory", defaultHidden: true, getValue: statutoryText, render: statutoryText },
  { key: "outsource", label: "Outsourced", defaultHidden: true, getValue: (e) => (e.isOutsource ? "Yes" : "No"), render: (e) => (e.isOutsource ? "Yes" : "No") },
  { key: "joinDate", label: "Join Date", defaultHidden: true, filterType: "date", dateValue: (e) => e.joinDate || null, getValue: (e) => e.joinDate, render: (e) => formatDate(e.joinDate) },
  { key: "nationality", label: "Nationality", defaultHidden: true, getValue: (e) => e.nationality, render: (e) => e.nationality || <span className="text-ink-muted">--</span> },
  { key: "status", label: "Status", getValue: (e) => e.status, render: statusPill },
];

export function EmployeeMasterTab() {
  const employees = useEmployees();
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [showAll, setShowAll] = useState(false);
  const all = useMemo(() => employees.data?.employees ?? [], [employees.data]);
  const rows = useMemo(() => all.filter((e) => showAll || e.status === "ACTIVE"), [all, showAll]);
  const canManage = employees.data?.canManage ?? false;
  const unlinked = all.filter((e) => e.status === "ACTIVE" && !e.userId).length;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1 text-[11px] text-ink-secondary">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show inactive and resigned
        </label>
        {unlinked > 0 && (
          <span className="text-[11px] text-amber-800">
            {unlinked} active {unlinked === 1 ? "employee has" : "employees have"} no ERP account yet and cannot punch in.
          </span>
        )}
        {canManage && (
          <span className="ml-auto">
            <button type="button" className={primaryBtn} onClick={() => setEditing("new")}>
              <Plus size={11} /> Add employee
            </button>
          </span>
        )}
      </div>
      <DataTable<Employee>
        tableId="hr-employee-master"
        columns={COLUMNS}
        rows={employees.data ? rows : null}
        loading={employees.loading}
        error={employees.error}
        emptyLabel={showAll ? "No employees yet." : "No active employees. Add the drivers, helpers and warehouse crew who will punch in."}
        getRowKey={(e) => e.id}
        onRowClick={(e) => setEditing(e)}
        exportName="employees"
      />
      {editing && (
        <EmployeeDrawer
          employee={editing === "new" ? null : editing}
          canManage={canManage}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            employees.reload();
          }}
        />
      )}
    </div>
  );
}
