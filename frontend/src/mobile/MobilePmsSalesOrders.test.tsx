/* The phone half of the project's Sales Orders block (owner 2026-10-13): same
   read, same arithmetic as the desktop block, in the mobile panel's own shape.
   Pinned: the sum and the gap sentence, each order's line, the scoped note,
   and an empty read that reports rather than concludes. */
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import type { ProjectSalesOrdersResponse } from "../pages/projects/projectSalesOrders";

const get = vi.fn<(path: string) => Promise<ProjectSalesOrdersResponse>>();
vi.mock("../api/client", () => ({ api: { get: (path: string) => get(path) } }));

const { MobilePmsSalesOrders } = await import("./MobilePmsSalesOrders");

const mount = (finalTotalRm: number | null) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <MobilePmsSalesOrders projectId={348} finalTotalRm={finalTotalRm} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const FULL: ProjectSalesOrdersResponse = {
  data: [
    { doc_no: "HC-SO-013462", so_date: "2026-09-18", ref: "HC13503", customer_name: "Lim Ah Kow", customer_phone: null,
      salesperson_name: "Anthony", status: "CONFIRMED", amount_sen: 5_000_000, paid_sen: 2_500_000, balance_sen: 2_500_000,
      fair_match: "PICKED", linked_ac_docno: null, created_at: null },
    { doc_no: "HC-SO-2609-175", so_date: "2026-09-19", ref: null, customer_name: "Tan Mei", customer_phone: null,
      salesperson_name: "Adrian", status: "DRAFT", amount_sen: 3_000_000, paid_sen: 3_000_000, balance_sen: 0,
      fair_match: null, linked_ac_docno: null, created_at: null },
  ],
  totals: { count: 2, draft_count: 1, amount_sen: 8_000_000, paid_sen: 5_500_000, balance_sen: 2_500_000 },
  scoped: false,
};

describe("MobilePmsSalesOrders", () => {
  test("reads the fair's orders from the one endpoint and sets them against the final total", async () => {
    get.mockResolvedValueOnce(FULL);
    mount(113_990);
    await waitFor(() => expect(screen.getByText("HC-SO-013462")).toBeTruthy());
    expect(get).toHaveBeenCalledWith("/api/project-sales-orders/348");

    expect(screen.getByText("2 · RM 80,000.00")).toBeTruthy();
    expect(screen.getByText(/Final total RM 113,990.00/)).toBeTruthy();
    expect(screen.getByText(/Not yet opened RM 33,990.00 \(29.8%\)/)).toBeTruthy();
    expect(screen.getByText("1 still draft")).toBeTruthy();
    expect(screen.queryByText("your orders only")).toBeNull();

    expect((screen.getByText("HC-SO-013462").closest("a"))?.getAttribute("href")).toBe("/scm/sales-orders/HC-SO-013462");
    expect((screen.getByText(/HC13503 · Anthony · Submitted/)).textContent).toContain("balance RM 25,000.00");
    expect((screen.getByText(/no ref · Adrian · Draft/)).textContent).not.toContain("balance");
  });

  test("a scoped rep is told the totals are theirs only; an empty read reports what it looked for", async () => {
    get.mockResolvedValueOnce({ ...FULL, scoped: true });
    const { unmount } = mount(null);
    await waitFor(() => expect(screen.getByText("your orders only")).toBeTruthy());
    expect(screen.queryByText(/Final total/)).toBeNull();
    unmount();

    get.mockResolvedValueOnce({ data: [], totals: { count: 0, draft_count: 0, amount_sen: 0, paid_sen: 0, balance_sen: 0 }, scoped: false });
    mount(5_000);
    await waitFor(() =>
      expect(screen.getByText("No sales orders linked to this event were found in the SO module.")).toBeTruthy(),
    );
    expect(screen.getByText(/Not yet opened RM 5,000.00 \(100%\)/)).toBeTruthy();
  });

  test("a failed read shows its message instead of an empty list", async () => {
    get.mockRejectedValueOnce(new Error("403: You don't have permission to view this page."));
    mount(113_990);
    await waitFor(() =>
      expect(screen.getByText("403: You don't have permission to view this page.")).toBeTruthy(),
    );
    expect(screen.queryByText(/were found/)).toBeNull();
  });
});
