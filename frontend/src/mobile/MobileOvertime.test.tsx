// The phone Overtime screen (HC-0125): a worker reports OT windows and sees
// their status; a supervisor (canConfirm) also sees a "To confirm" list.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn(), del: vi.fn() } }));
vi.mock("../api/client", () => ({ api }));

import { OvertimeBody } from "./MobileOvertime";

const MINE = [
  { id: 1, workDate: "2026-11-20", startMin: 1230, endMin: 1290, note: "rushed an order", status: "PENDING", rejectReason: null },
  { id: 2, workDate: "2026-11-19", startMin: 480, endMin: 540, note: "early unload", status: "CONFIRMED", rejectReason: null },
];
const PENDING = [{ id: 3, workDate: "2026-11-20", startMin: 1410, endMin: 1470, note: "late delivery", status: "PENDING", rejectReason: null, employeeName: "Sagor", empNo: "HCFW0006" }];

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset().mockResolvedValue({ id: 9 });
  api.del.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

const show = () => render(<QueryClientProvider client={new QueryClient()}><OvertimeBody /></QueryClientProvider>);

describe("Overtime on the phone", () => {
  it("a worker sees the report form and their claims, not the confirm list", async () => {
    api.get.mockResolvedValue({ canConfirm: false, mine: MINE, pending: [] });
    show();
    await waitFor(() => expect(screen.getByText(/rushed an order/)).toBeTruthy());
    expect(screen.getByText("Report overtime")).toBeTruthy();
    expect(screen.getByText(/Waiting for your supervisor/)).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();
    expect(screen.queryByText("To confirm")).toBeNull();
  });

  it("a supervisor also sees pending claims with confirm / reject", async () => {
    api.get.mockResolvedValue({ canConfirm: true, mine: [], pending: PENDING });
    show();
    await waitFor(() => expect(screen.getByText("To confirm")).toBeTruthy());
    expect(screen.getByText(/HCFW0006 . Sagor/)).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/attendance/ot/3/review", { decision: "confirm", reason: "" }));
  });

  it("a punch-derived claim is tagged and cannot be deleted by the worker", async () => {
    api.get.mockResolvedValue({
      canConfirm: false,
      mine: [{ id: 5, workDate: "2026-11-20", startMin: 1140, endMin: 1230, note: "Auto from punch (1.5h past the shift)", status: "PENDING", source: "AUTO", rejectReason: null }],
      pending: [],
    });
    show();
    await waitFor(() => expect(screen.getByText("From your punch")).toBeTruthy());
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("adding a window posts the times", async () => {
    api.get.mockResolvedValue({ canConfirm: false, mine: [], pending: [] });
    const { container } = show();
    await waitFor(() => expect(screen.getByText("Add overtime")).toBeTruthy());
    const times = container.querySelectorAll('input[type="time"]');
    fireEvent.change(times[0], { target: { value: "20:30" } });
    fireEvent.change(times[1], { target: { value: "21:30" } });
    fireEvent.click(screen.getByText("Add overtime"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/attendance/ot", expect.objectContaining({ startHHMM: "20:30", endHHMM: "21:30" })));
  });
});
