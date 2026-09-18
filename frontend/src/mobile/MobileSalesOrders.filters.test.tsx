/* The phone Sales Orders list reads its filters from the URL through the SHARED
 * state layer and sends them on every list request — so the order count, the
 * revenue / outstanding line and the status counts the sheet shows all come
 * back from a server that applied them. Applying in the sheet rewrites the URL
 * and re-queries.
 *
 * Drives the REAL screen and sheet. Faked: `authedFetch` (the requests are the
 * assertions) and `useAuth`. */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch,
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, email: "o@x.test", name: "O", permissions: [] }, can: () => false, pageAccess: () => "full" }),
}));

import { MobileSalesOrders } from "./MobileSalesOrders";
import { NotifyProvider } from "../vendor/scm/components/NotifyDialog";

afterEach(cleanup);

let search = "";
function Probe() {
  search = useLocation().search;
  return null;
}

const listCalls = () =>
  authedFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/mfg-sales-orders?") && !u.includes("pageSize=1&"));

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/mfg-sales-orders?")) {
      return { salesOrders: [], total: 7, page: 0, pageSize: 30, statusCounts: { all: 7, confirmed: 7 }, aggregates: { revenueSen: 100000, outstandingSen: 25000, paidSen: 75000 } };
    }
    if (url.startsWith("/staff")) return { staff: [] };
    return { jobs: [] };
  });
});

function renderList(initial: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>
        <NotifyProvider>
          <MobileSalesOrders onScan={() => {}} onOpen={() => {}} onNew={() => {}} />
        </NotifyProvider>
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MobileSalesOrders second-level filters", () => {
  it("sends the URL's rows and status on the list request and shows the filtered totals", async () => {
    renderList("/?status=confirmed&f=createdBy:me&f=balance:positive");
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    const p = new URLSearchParams(listCalls()[0].split("?")[1]);
    expect(p.getAll("f")).toEqual(["createdBy:me", "balance:positive"]);
    expect(p.get("status")).toBe("CONFIRMED");
    await waitFor(() => expect(screen.getByText("7")).toBeTruthy());
  });

  it("applying a row in the sheet writes it to the URL and re-queries with it", async () => {
    const user = userEvent.setup();
    renderList("/");
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    await user.click(screen.getByRole("button", { name: /^Created by/ }));
    await user.click(await screen.findByRole("button", { name: /^Apply/ }));
    expect(new URLSearchParams(search).getAll("f")).toEqual(["createdBy:me"]);
    await waitFor(() => expect(listCalls().some((u) => new URLSearchParams(u.split("?")[1]).getAll("f").includes("createdBy:me"))).toBe(true));
  });
});
