/* The driver run-sheet header names the Malaysian route day, and a today stop
   turns "Late" by the Malaysian clock. On a phone whose clock zone is UTC,
   at 01:30 on Monday 16 Nov (Malaysia) the header said Sunday, and a stop due
   by 1:00PM never went late until 21:00 Malaysia time. Run with TZ=UTC. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { todayMyt } from "../vendor/scm/lib/dates";

let orders: Record<string, unknown>[] = [];
const stop = (n: string, timeRange: string | null) => ({
  so_doc_no: n, row_type: "dp", delivery_state: "PENDING_DELIVERY", debtor_name: `Cust ${n}`,
  effective_delivery_date: todayMyt(), time_range: timeRange,
  crew: { driver: "Khalid", helper: null, lorry: null }, delivery_orders: [],
});

vi.mock("../vendor/scm/lib/authed-fetch", () => ({
  authedFetch: vi.fn((url: string) =>
    String(url).includes("/delivery-planning")
      ? Promise.resolve({ orders, counts: {}, regions: [] })
      : Promise.resolve([]),
  ),
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, name: "Test", position_capabilities: [] }, can: () => true, pageAccess: { areas: {}, level: null } }),
}));

import { MobileDeliveryPlanning } from "./MobileDeliveryPlanning";
import { ConfirmProvider } from "../vendor/scm/components/ConfirmDialog";
import { ToastProvider } from "../hooks/useToast";

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider><MemoryRouter><ConfirmProvider>
      <MobileDeliveryPlanning onBack={() => {}} completedDoNumber={null} />
    </ConfirmProvider></MemoryRouter></ToastProvider>
  </QueryClientProvider>,
);

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("run-sheet judges the day and the clock by Malaysia time", () => {
  it("at 01:30 on Monday 16 Nov (Malaysia) the header says Monday 16/11", async () => {
    vi.setSystemTime(new Date("2026-11-15T17:30:00Z"));
    orders = [stop("A1", null)];
    mount();
    await screen.findByText(/Cust A1/);
    expect(screen.getByText(/Monday · 2026\/11\/16/)).toBeTruthy();
    expect(screen.queryByText(/Sunday/)).toBeNull();
  });

  it("at 15:30 Malaysia time a stop due by 1:00PM is Late", async () => {
    vi.setSystemTime(new Date("2026-11-16T07:30:00Z"));
    orders = [stop("B1", "TIME AROUND 12:00PM TO 1:00PM")];
    mount();
    await screen.findByText(/Cust B1/);
    await waitFor(() => expect(screen.getAllByText("Late").length).toBeGreaterThan(0));
  });

  it("at 11:30 Malaysia time the same stop is not Late yet", async () => {
    vi.setSystemTime(new Date("2026-11-16T03:30:00Z"));
    orders = [stop("C1", "TIME AROUND 12:00PM TO 1:00PM")];
    mount();
    await screen.findByText(/Cust C1/);
    expect(screen.queryByText("Late")).toBeNull();
  });
});
