/* The desktop Overtime tab (HC-0125): HR sees a month of reported OT and
 * confirms or rejects the waiting ones. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, reload } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), reload: vi.fn() }));

const SEED = {
  month: "2026-11",
  claims: [
    { id: 1, workDate: "2026-11-20", startMin: 1230, endMin: 1290, note: "rushed an order", status: "PENDING", rejectReason: null, employeeName: "Sagor", empNo: "HCFW0006", reviewedAt: null },
    { id: 2, workDate: "2026-11-19", startMin: 480, endMin: 540, note: "early unload", status: "CONFIRMED", rejectReason: null, employeeName: "Rahim", empNo: "HCFW0011", reviewedAt: "2026-11-19T10:00:00Z" },
  ],
};

vi.mock("../../api/client", () => ({ api: { get: apiGet, post: apiPost } }));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../hooks/useDialog", () => ({ useDialog: () => ({ confirm: vi.fn(async () => true) }) }));
vi.mock("../../hooks/useQuery", () => ({ useQuery: () => ({ data: SEED, loading: false, fetching: false, placeholder: false, error: null, reload }) }));

import { OvertimeTab } from "./OvertimeTab";

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset().mockResolvedValue({ ok: true });
  reload.mockReset();
});
afterEach(() => cleanup());

const show = () => render(<MemoryRouter initialEntries={["/?period=2026-11"]}><OvertimeTab /></MemoryRouter>);

describe("Overtime desktop tab", () => {
  it("lists the month's reported overtime with its status", () => {
    show();
    expect(screen.getByText("rushed an order")).toBeTruthy();
    expect(screen.getByText("Rahim")).toBeTruthy();
    expect(screen.getByText("20:30-21:30")).toBeTruthy();
    expect(screen.getByText(/1 waiting/)).toBeTruthy();
  });

  it("confirms a waiting claim", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/attendance/ot/1/review", { decision: "confirm", reason: "" }));
  });
});
