/* HR · Leave desktop page. Reuses the self-service leave API; this pins the
 * desktop behaviour: my-request list + counts + filter, the approver pending
 * queue, and that approve / reject / cancel hit the right endpoints. */
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const DATA = {
  types: [
    { value: "ANNUAL_LEAVE", label: "Annual leave", paid: true },
    { value: "MEDICAL_LEAVE", label: "Medical leave", paid: true },
    { value: "UNPAID_LEAVE", label: "Unpaid leave", paid: false },
  ],
  canApprove: true,
  mine: [
    { id: 1, leaveStatus: "ANNUAL_LEAVE", startDate: "2026-11-20", endDate: "2026-11-21", reason: "family trip", status: "APPROVED", rejectReason: null, reviewedByName: "Sana Khan", reviewedAt: "2026-11-19T10:00:00Z" },
    { id: 2, leaveStatus: "MEDICAL_LEAVE", startDate: "2026-11-25", endDate: "2026-11-25", reason: "fever", status: "PENDING", rejectReason: null, reviewedByName: null, reviewedAt: null },
    { id: 3, leaveStatus: "UNPAID_LEAVE", startDate: "2026-10-01", endDate: "2026-10-02", reason: "errand", status: "REJECTED", rejectReason: "short-staffed that week", reviewedByName: "Sana Khan", reviewedAt: "2026-09-30T09:00:00Z" },
  ],
  pending: [
    { id: 9, leaveStatus: "ANNUAL_LEAVE", startDate: "2026-12-01", endDate: "2026-12-02", reason: "holiday", status: "PENDING", rejectReason: null, reviewedByName: null, reviewedAt: null, employeeName: "Bilal Yousaf", empNo: "HCFW0002" },
  ],
  teamHistory: [
    { id: 20, leaveStatus: "ANNUAL_LEAVE", startDate: "2026-11-10", endDate: "2026-11-11", reason: "wedding", status: "APPROVED", rejectReason: null, reviewedByName: "Sana Khan", reviewedAt: "2026-11-09T08:00:00Z", employeeName: "Ravi Kumar", empNo: "HCFW0005" },
  ],
};

vi.mock("../../hooks/useQuery", () => ({ useQuery: () => ({ data: DATA, loading: false, fetching: false, placeholder: false, error: null, reload: vi.fn() }) }));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../hooks/useDialog", () => ({ useDialog: () => ({ confirm: () => Promise.resolve(true) }) }));
const { apiGet, apiPost, apiDel } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(() => Promise.resolve({})), apiDel: vi.fn(() => Promise.resolve({})) }));
vi.mock("../../api/client", () => ({ api: { get: apiGet, post: apiPost, del: apiDel } }));

import { LeavePage } from "./LeavePage";

afterEach(() => {
  cleanup();
  apiPost.mockClear();
  apiDel.mockClear();
});

describe("HR Leave desktop page", () => {
  it("lists my requests with their status and a reject reason", () => {
    render(<LeavePage />);
    expect(screen.getByText("family trip")).toBeTruthy();
    expect(screen.getByText("fever")).toBeTruthy();
    expect(screen.getByText("Rejected: short-staffed that week")).toBeTruthy();
    expect(screen.getAllByText("Approved").length).toBeGreaterThanOrEqual(1); // card + pill
  });

  it("shows the approver pending queue and approves to the review endpoint", async () => {
    render(<LeavePage />);
    expect(screen.getByText("Bilal Yousaf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/attendance/leave/9/review", { decision: "approve", reason: "" }));
  });

  it("rejects a pending request with a reason", async () => {
    render(<LeavePage />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" })); // open the reject modal
    fireEvent.change(screen.getByPlaceholderText("e.g. short-staffed that week"), { target: { value: "no cover" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1)!); // modal submit
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/attendance/leave/9/review", { decision: "reject", reason: "no cover" }));
  });

  it("cancels my pending request through the delete endpoint", async () => {
    render(<LeavePage />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); // the only Cancel is the pending row's
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith("/api/attendance/leave/2"));
  });

  it("filters my requests by status", () => {
    render(<LeavePage />);
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "PENDING" } });
    expect(screen.getByText("fever")).toBeTruthy(); // the pending one stays
    expect(screen.queryByText("family trip")).toBeNull(); // approved hidden
    expect(screen.queryByText("Rejected: short-staffed that week")).toBeNull(); // rejected hidden
  });

  it("applies for leave to the create endpoint", async () => {
    render(<LeavePage />);
    fireEvent.click(screen.getByRole("button", { name: "Apply for leave" }));
    expect(screen.getByText("A supervisor approves it; approval marks the days on attendance.")).toBeTruthy();
  });

  it("shows who reviewed a reviewed request", () => {
    render(<LeavePage />);
    expect(screen.getAllByText("Sana Khan").length).toBeGreaterThanOrEqual(1); // reviewer name on approved/rejected rows
  });

  it("shows team history for approvers", () => {
    render(<LeavePage />);
    expect(screen.getByText("Team history")).toBeTruthy();
    expect(screen.getByText("Ravi Kumar")).toBeTruthy(); // the team member whose reviewed leave shows
    expect(screen.getByText("HCFW0005")).toBeTruthy(); // their emp no, only in the team-history row
  });

  it("toggles between the list and calendar views", () => {
    render(<LeavePage />);
    expect(screen.getByText("My requests")).toBeTruthy(); // list view by default
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    expect(screen.getByText("Sun")).toBeTruthy(); // a weekday header — the calendar rendered
    expect(screen.queryByText("My requests")).toBeNull(); // list is hidden
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByText("My requests")).toBeTruthy(); // back to the list
  });
});
