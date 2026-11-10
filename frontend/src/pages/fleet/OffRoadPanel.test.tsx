/* Off the road from the lorry (backlog #5459). Renders the real panel against a
   mocked api client. Pinned: today's windows show with their owner, only a
   hand-entered window offers "Back on the road", taking a lorry off sends today
   (Malaysia) with no expected return, ending asks first, and a refusal is shown
   inline (the record page has no dialog provider). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("../../api/client", () => ({ api }));

const { OffRoadPanel, offRoadProblem } = await import("./OffRoadPanel");
const { todayMyt } = await import("../../vendor/scm/lib/dates");

const WINDOWS = [
  { id: "w1", from: "2026-11-05", to: null, reason: "Gearbox", source: "manual" },
  { id: "w2", from: "2026-11-03", to: "2026-11-12", reason: "DP lorry service — DP-0042", source: "dp_job" },
  { id: "w3", from: "2026-10-01", to: "2026-10-02", reason: "Tyres", source: "manual" },
];

function wrap(onChanged: (() => void) | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><OffRoadPanel lorryId="l1" plate="VBA1234" onChanged={onChanged} /></QueryClientProvider>);
}

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ today: "2026-11-10", windows: WINDOWS });
  api.post.mockReset().mockResolvedValue({ ok: true });
  api.patch.mockReset().mockResolvedValue({ ok: true, outcome: "ended" });
});

describe("OffRoadPanel", () => {
  test("lists the windows; only the hand-entered one running today can be ended", async () => {
    wrap();
    expect(await screen.findByText("Gearbox")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/fleet-maintenance/vehicles/l1/off-road");
    expect(screen.getByText(/to further notice/)).toBeTruthy();
    expect(screen.getByText(/Set by a lorry service job/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Back on the road" })).toHaveLength(1);
  });

  test("taking it off the road sends today and no expected return, then refreshes the caller", async () => {
    const onChanged = vi.fn();
    wrap(onChanged);
    await screen.findByText("Gearbox");
    fireEvent.click(screen.getByRole("button", { name: "Take off the road" }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Accident/), { target: { value: " Accident at Klang " } });
    fireEvent.click(save);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/fleet-maintenance/vehicles/l1/off-road", { from: todayMyt(), expectedReturn: null, reason: "Accident at Klang" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test("back on the road asks first, then ends that window", async () => {
    wrap();
    await screen.findByText("Gearbox");
    fireEvent.click(screen.getByRole("button", { name: "Back on the road" }));
    expect(api.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, back on the road" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/fleet-maintenance/off-road/w1/end", {}));
  });

  test("a refusal is shown on the panel, not swallowed", async () => {
    api.patch.mockRejectedValueOnce(new Error("You do not have permission."));
    wrap();
    await screen.findByText("Gearbox");
    fireEvent.click(screen.getByRole("button", { name: "Back on the road" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, back on the road" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The lorry was not put back on the road. You do not have permission.");
  });

  test("a failed load says so instead of showing an empty list", async () => {
    api.get.mockRejectedValueOnce(new Error("boom"));
    wrap();
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
  });
});

describe("offRoadProblem", () => {
  test("needs a start day and a reason; the expected return cannot come first", () => {
    expect(offRoadProblem({ from: "", back: "", reason: "x" })).toMatch(/day it goes off/);
    expect(offRoadProblem({ from: "2026-11-10", back: "2026-11-09", reason: "x" })).toMatch(/cannot be before/);
    expect(offRoadProblem({ from: "2026-11-10", back: "", reason: " " })).toMatch(/why/);
    expect(offRoadProblem({ from: "2026-11-10", back: "", reason: "Gearbox" })).toBeNull();
  });
});
