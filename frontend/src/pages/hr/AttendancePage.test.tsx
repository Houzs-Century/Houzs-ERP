/* HR · Attendance month grid (v3 redesign). The grid must read calm: days with
 * no punch (every day before go-live) and rest days render BLANK, not a grey
 * "?" box, so only real exceptions — late (L), absent (A), leave (V) — and the
 * present dot draw the eye. A past month is used so the test never depends on
 * the run date (no day is "future"). */
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkingHoursResponse, AttendanceResponse, WorkDay } from "./hrApi";

const EMP = [
  { id: 1, empNo: "HC0006", name: "Faslie Anak" },
  { id: 2, empNo: "HC0014", name: "Mohd Zaimir" },
  { id: 3, empNo: "HC0009", name: "Abd Khalid" },
];

const day = (employeeId: number, workDate: string, status: string, lateMin: number): WorkDay => ({
  attendanceId: employeeId * 100 + Number(workDate.slice(-2)),
  employeeId,
  workDate,
  status: status as WorkDay["status"],
  clockIn: status === "PRESENT" ? "08:00" : null,
  clockOut: status === "PRESENT" ? "18:00" : null,
  outSource: "PHONE",
  punchHours: status === "PRESENT" ? 8 : null,
  lateMin,
});

const WH: WorkingHoursResponse = {
  from: "2020-01-01",
  to: "2020-01-31",
  employees: EMP.map((e) => ({ id: e.id, empNo: e.empNo, name: e.name, departmentId: null, status: "ACTIVE", hoursPerDay: 8 })),
  departments: [],
  days: [
    day(1, "2020-01-06", "PRESENT", 0),
    day(1, "2020-01-07", "PRESENT", 20), // late
    day(2, "2020-01-08", "ABSENT", 0),
    day(3, "2020-01-09", "ANNUAL_LEAVE", 0),
    day(1, "2020-01-04", "REST_DAY", 0), // weekend rest -> blank
  ],
  entries: [],
  canManage: true,
};

const ATT: AttendanceResponse = {
  date: "2020-01-09",
  today: "2020-01-09",
  shift: { startMin: 480, endMin: 1080, lateGraceMin: 10 },
  rows: EMP.map((e) => ({ employee: { id: e.id, empNo: e.empNo, name: e.name, position: "", department: null, linked: true, status: "ACTIVE" }, day: null })),
  sitesConfigured: 1,
  canManage: true,
};

vi.mock("./hrApi", () => ({
  HR: "/api/hr",
  useWorkingHours: () => ({ data: WH, loading: false, fetching: false, placeholder: false, error: null, reload: vi.fn() }),
  useAttendance: () => ({ data: ATT, loading: false, fetching: false, placeholder: false, error: null, reload: vi.fn() }),
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../hooks/useDialog", () => ({ useDialog: () => ({ confirm: () => Promise.resolve(true) }) }));

import { AttendancePage } from "./AttendancePage";
import { api } from "../../api/client";

afterEach(() => cleanup());

const show = () => render(<MemoryRouter initialEntries={["/?month=2020-01"]}><AttendancePage /></MemoryRouter>);

describe("Attendance month grid redesign", () => {
  it("renders no grey '?' cell for days with no punch", () => {
    const { container } = show();
    // The eye-strain was a grid full of "?". Not one may remain.
    expect(screen.queryByText("?")).toBeNull();
    expect(container.textContent).not.toContain("?");
  });

  it("marks only the real exceptions: late (L), absent (A), leave (V)", () => {
    show();
    expect(screen.getAllByText("L").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("V")).toBeTruthy();
  });

  it("shows a present day as a dot, not a letter", () => {
    const { container } = show();
    expect(container.querySelectorAll('[class*="bg-synced/70"]').length).toBeGreaterThanOrEqual(1);
  });

  it("drops the misleading 'No punch' legend", () => {
    show();
    expect(screen.queryByText("No punch")).toBeNull();
  });

  it("totals count present plus late into PRES, and split absent and leave", () => {
    show();
    const rowOf = (name: string) => screen.getByText(name).closest("tr")!;
    const totalsOf = (name: string) => [...rowOf(name).querySelectorAll("td")].slice(-4).map((td) => String(td.textContent).trim());
    expect(totalsOf("Faslie Anak")).toEqual(["2", "1", "0", "0"]); // 1 present + 1 late
    expect(totalsOf("Mohd Zaimir")).toEqual(["0", "0", "1", "0"]); // 1 absent
    expect(totalsOf("Abd Khalid")).toEqual(["0", "0", "0", "1"]); // 1 leave
  });

  it("removes a recorded day through the delete endpoint", async () => {
    const del = vi.spyOn(api, "del").mockResolvedValue(undefined);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Faslie Anak 2020-01-06" })); // a present day with a record
    fireEvent.click(await screen.findByRole("button", { name: "Remove day" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/hr/attendance/106"));
    del.mockRestore();
  });

  it("offers no Remove day on a day with no record", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Faslie Anak 2020-01-10" })); // no record that day
    expect(screen.getByRole("heading", { name: "Record attendance" })).toBeTruthy(); // editor is open
    expect(screen.queryByRole("button", { name: "Remove day" })).toBeNull();
  });
});
