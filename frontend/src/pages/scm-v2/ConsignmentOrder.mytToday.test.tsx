/* New Consignment Order refuses a Processing / Delivery date in the past, and
   the date pickers start at today. "Today" is the Malaysian day: at 01:30 on
   10 Nov (Malaysia), on a machine whose clock zone is UTC, the 9th was still
   offered and accepted. Run with TZ=UTC. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../vendor/scm/lib/authed-fetch", () => ({ authedFetch: vi.fn(async () => []) }));
vi.mock("../../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null }),
}));
vi.mock("../../auth/AuthContext", async (orig) => ({
  ...(await orig<typeof import("../../auth/AuthContext")>()),
  useAuth: () => ({ user: { id: 1, name: "Test" }, can: () => true, pageAccess: () => "full" }),
}));
vi.mock("../../vendor/scm/components/DateField", () => ({
  DateField: (p: { min?: string; title?: string; value?: string }) => (
    <input data-testid="date-field" data-min={p.min ?? ""} data-value={p.value ?? ""} title={p.title} readOnly />
  ),
}));
const HEADER = {
  doc_no: "HC-CO-2611-001", status: "OPEN", debtor_code: "C001", debtor_name: "Customer", salesperson_id: null,
  processing_date: "2026-11-09", customer_delivery_date: "2026-11-20", so_date: "2026-11-01", note: "",
  sales_location: null, phone: null, email: null, address1: null, address2: null, city: null, postcode: null,
  customer_state: null, branding: null, venue_id: null, venue: null, customer_so_no: null, ref: null,
};
const DETAIL = { data: { salesOrder: HEADER, items: [] }, isLoading: false, isError: false, error: null };
const NO_DETAIL = { data: undefined, isLoading: false, isError: false, error: null };
vi.mock("../../vendor/scm/lib/consignment-order-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/consignment-order-queries")>()),
  useConsignmentOrderDetail: (docNo: string | null) => (docNo ? DETAIL : NO_DETAIL),
}));

import { ConsignmentOrderNew } from "./ConsignmentOrderNew";
import { ConsignmentOrderDetail } from "./ConsignmentOrderDetail";
import { ConfirmProvider } from "../../vendor/scm/components/ConfirmDialog";
import { Route, Routes } from "react-router-dom";
import { NotifyProvider } from "../../vendor/scm/components/NotifyDialog";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T17:30:00Z")); // 01:30 on 10 Nov in Malaysia
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("New Consignment Order: today is the Malaysian day", () => {
  it("Processing and Delivery pickers start at the 10th", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><NotifyProvider><ConsignmentOrderNew /></NotifyProvider></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId("date-field").length).toBeGreaterThanOrEqual(2));
    const mins = screen.getAllByTestId("date-field").map((el) => el.getAttribute("data-min"));
    expect(mins.filter((m) => m === "2026-11-10").length).toBeGreaterThanOrEqual(2);
    expect(mins).not.toContain("2026-11-09");
  });
});

describe("Consignment Order detail: today is the Malaysian day", () => {
  it("a Processing date of the 9th is locked as past at 01:30 on the 10th, and Delivery starts at the 10th", { timeout: 20_000 }, async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/scm/consignment-orders/HC-CO-2611-001"]}>
          <NotifyProvider><ConfirmProvider>
            <Routes><Route path="/scm/consignment-orders/:docNo" element={<ConsignmentOrderDetail />} /></Routes>
          </ConfirmProvider></NotifyProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId("date-field").length).toBeGreaterThanOrEqual(2));
    const fields = screen.getAllByTestId("date-field");
    const processing = fields.find((el) => el.getAttribute("data-value") === "2026-11-09");
    const delivery = fields.find((el) => el.getAttribute("data-value") === "2026-11-20");
    expect(processing?.getAttribute("title")).toBe("Processing date has passed — locked.");
    expect(delivery?.getAttribute("data-min")).toBe("2026-11-10");
  });
});
