/* HR · Overview dashboard. The month on-time chart and "most late" read from
 * the working-hours month read; the attention list surfaces only the items the
 * data actually backs (not punched in, unlinked accounts, OT, penalties, a draft
 * payroll). The working-hours days are dated in the CURRENT month so the chart
 * is never empty regardless of the run date. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { todayMY } from "../../vendor/shared/format";
import type { AttendanceResponse, PayrollResponse, WorkDay, WorkingHoursResponse } from "./hrApi";

const PERIOD = todayMY().slice(0, 7);
const TODAY = todayMY().slice(0, 10);
const q = <T,>(data: T) => ({ data, loading: false, fetching: false, placeholder: false, error: null, reload: vi.fn() });

const EMP = [
  { id: 1, name: "Faslie Anak", status: "ACTIVE", isOutsource: false, userId: 11, position: "Lorry Driver" },
  { id: 2, name: "Mohd Zaimir", status: "ACTIVE", isOutsource: false, userId: null, position: "Warehouse Crew" }, // not linked
  { id: 3, name: "Abd Khalid", status: "ACTIVE", isOutsource: true, userId: 13, position: "Warehouse Crew" },
];

const wday = (employeeId: number, status: string, lateMin: number): WorkDay => ({
  attendanceId: employeeId,
  employeeId,
  workDate: `${PERIOD}-01`,
  status: status as WorkDay["status"],
  clockIn: null,
  clockOut: null,
  outSource: "PHONE",
  punchHours: null,
  lateMin,
});

const WH = {
  from: `${PERIOD}-01`,
  to: `${PERIOD}-01`,
  employees: EMP.map((e) => ({ id: e.id, empNo: `HC${e.id}`, name: e.name, departmentId: null, status: "ACTIVE", hoursPerDay: 8 })),
  departments: [],
  days: [wday(1, "PRESENT", 0), wday(2, "PRESENT", 30), wday(3, "ABSENT", 0)],
  entries: [],
  canManage: true,
} as unknown as WorkingHoursResponse;

const ATT = {
  date: TODAY,
  today: TODAY,
  shift: { startMin: 0, endMin: 1080, lateGraceMin: 0 },
  rows: EMP.map((e) => ({ employee: { id: e.id, empNo: `HC${e.id}`, name: e.name, position: e.position, department: null, linked: !!e.userId, status: "ACTIVE" }, day: null })),
  sitesConfigured: 1,
  canManage: true,
} as unknown as AttendanceResponse;

const PAY = {
  period: PERIOD,
  stored: true,
  projected: false,
  locked: false,
  status: "DRAFT",
  monthFinished: false,
  slips: [{ grossSen: 100000, netSen: 90000 }],
  canManage: true,
  canApprove: true,
} as unknown as PayrollResponse;

vi.mock("./hrApi", () => ({
  HR: "/api/hr",
  useEmployees: () => q({ employees: EMP, canManage: true }),
  useAttendance: () => q(ATT),
  usePayroll: () => q(PAY),
  useHolidays: () => q({ holidays: [{ date: "2099-12-25", name: "Christmas Day" }] }),
  useWorkingHours: () => q(WH),
}));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock("../../hooks/useQuery", () => ({
  useQuery: (key: unknown) => {
    const k = String(Array.isArray(key) ? key[0] : key);
    if (k.includes("ot")) return q({ claims: [{ status: "PENDING" }, { status: "CONFIRMED" }] });
    if (k.includes("penalt")) return q({ penalties: [{ status: "PENDING_APPROVAL" }, { status: "APPROVED" }] });
    return q(undefined);
  },
}));

import { OverviewPage } from "./OverviewPage";

afterEach(() => cleanup());
const show = () => render(<OverviewPage onNavigate={vi.fn()} onPickEmployee={vi.fn()} />);

describe("HR Overview dashboard", () => {
  it("renders the month attendance chart with its on-time summary", () => {
    show();
    expect(screen.getByText(/^Attendance ·/)).toBeTruthy();
    expect(screen.getByText("on-time")).toBeTruthy();
  });

  it("ranks the month's late employees", () => {
    show();
    expect(screen.getByText("Most late this month")).toBeTruthy();
    // Mohd Zaimir had the only late day, so he appears in the ranking.
    expect(screen.getAllByText("Mohd Zaimir").length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces the data-backed attention items", () => {
    show();
    expect(screen.getByText(/without an ERP account/)).toBeTruthy();
    expect(screen.getByText(/overtime to confirm/)).toBeTruthy();
    expect(screen.getByText(/to approve/)).toBeTruthy();
    expect(screen.getByText(/Payroll is still in draft/)).toBeTruthy();
  });

  it("lists an upcoming public holiday instead of the empty state", () => {
    show();
    expect(screen.getByText("Christmas Day")).toBeTruthy();
    expect(screen.queryByText("No public holidays ahead.")).toBeNull();
  });
});
