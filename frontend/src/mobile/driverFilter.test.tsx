import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// HC-0192: office users get a driver filter on the run-sheet; one driver alone gets none.
const today = new Date().toISOString().slice(0, 10);
const stop = (n: string, driver: string) => ({
  so_doc_no: n, row_type: "dp", delivery_state: "PENDING_DELIVERY", debtor_name: `Cust ${n}`,
  effective_delivery_date: today, crew: { driver, helper: null, lorry: null }, delivery_orders: [],
});
let orders: ReturnType<typeof stop>[] = [];

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

describe("run-sheet driver filter", () => {
  it("filters the day's stops to one driver", async () => {
    orders = [stop("A1", "Khalid"), stop("B1", "Ali")];
    mount();
    const select = await screen.findByLabelText("Filter by driver");
    expect(await screen.findByText(/Cust A1/)).toBeTruthy();
    expect(screen.getByText(/Cust B1/)).toBeTruthy();
    fireEvent.change(select, { target: { value: "Khalid" } });
    expect(screen.queryByText(/Cust B1/)).toBeNull();
    expect(screen.getByText(/Cust A1/)).toBeTruthy();
  });

  it("shows no filter when only one driver is on the sheet", async () => {
    orders = [stop("A1", "Khalid")];
    mount();
    await screen.findByText(/Cust A1/);
    expect(screen.queryByLabelText("Filter by driver")).toBeNull();
  });
});
