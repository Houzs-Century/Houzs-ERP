/* The phone half of the project's sales report (owner 2026-10-14): the same
   read, each person's red number, each bill with its words and its order. */
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import type { ProjectSalesBillsResponse } from "../lib/projectSalesBills";

const get = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../api/client", () => ({ api: { get: (p: string) => get(p) } }));

const { MobilePmsSalesBills, useMobileProjectSalesBills } = await import("./MobilePmsSalesBills");

function Harness({ projectId }: { projectId: number }) {
  const q = useMobileProjectSalesBills(projectId, true);
  return <MobilePmsSalesBills query={q} />;
}

const mount = (projectId = 344) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Harness projectId={projectId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const RESPONSE: ProjectSalesBillsResponse = {
  bills: [
    { key: "5:2", ref_raw: "HC8993", ref_token: "HC8993", amount_sen: 650000, extra_sen: null, extra_tag: null, salesperson_name: "Jason", report_date: "2026-10-11", source_activity_id: 5, created_at: null, person_key: "rep:11", sales_rep_id: 11,
      other_event_name: "JOHOR [AKEMI] MLE @ MVEC SOUTHKEY",
      match: { status: "opened", so_doc_no: "HC-SO-2609-104", so_status: "CONFIRMED", so_project_id: 345, so_salesperson_id: "s", so_amount_sen: 650000, other_event: true, unlinked: false } },
    /* Opened under this event: already in the Sales Orders list, so not repeated. */
    { key: "5:4", ref_raw: "HC8999", ref_token: "HC8999", amount_sen: 100000, extra_sen: null, extra_tag: null, salesperson_name: "Jason", report_date: "2026-10-11", source_activity_id: 5, created_at: null, person_key: "rep:11", sales_rep_id: 11,
      other_event_name: null,
      match: { status: "opened", so_doc_no: "HC-SO-2609-199", so_status: "CONFIRMED", so_project_id: 344, so_salesperson_id: "s", so_amount_sen: 100000, other_event: false, unlinked: false } },
    { key: "5:3", ref_raw: "HC10785", ref_token: "HC10785", amount_sen: 499900, extra_sen: null, extra_tag: null, salesperson_name: "Melvin", report_date: "2026-10-11", source_activity_id: 5, created_at: null, person_key: "rep:12", sales_rep_id: 12,
      other_event_name: null,
      match: { status: "not_opened", so_doc_no: null, so_status: null, so_project_id: null, so_salesperson_id: null, so_amount_sen: null, other_event: false, unlinked: false } },
  ],
  persons: [
    { key: "rep:12", name: "Melvin Tan", sales_rep_id: 12, rep_user_id: 102, count: 1, amount_sen: 499900, opened_count: 0, opened_sen: 0, not_opened_count: 1, not_opened_sen: 499900, other_event_count: 0 },
    { key: "rep:11", name: "Jason Lee", sales_rep_id: 11, rep_user_id: 101, count: 1, amount_sen: 650000, opened_count: 1, opened_sen: 650000, not_opened_count: 0, not_opened_sen: 0, other_event_count: 0 },
  ],
  totals: { count: 2, amount_sen: 1149900, opened_count: 1, opened_sen: 650000, not_opened_count: 1, not_opened_sen: 499900, other_event_count: 0 },
  report_activity_ids: [5],
  summary: null,
  total_sales_rm: null,
  can_save: false,
};

describe("MobilePmsSalesBills", () => {
  test("reads the report from the one endpoint and lists only the bills still to act on, with their orders and events", async () => {
    get.mockResolvedValueOnce(RESPONSE);
    mount();
    await waitFor(() => expect(screen.getByText("HC8993")).toBeTruthy());
    expect(get).toHaveBeenCalledWith("/api/project-sales-bills/344");
    expect(screen.getByText("2 · RM 11,499.00")).toBeTruthy();
    expect(screen.getByText(/Not opened 1 · RM 4,999.00/)).toBeTruthy();
    /* No per-person row: the red sums sit under Sales attending. */
    expect(screen.queryByText("Melvin Tan")).toBeNull();
    expect(screen.queryByText("all opened")).toBeNull();
    expect(screen.getByText("HC-SO-2609-104").closest("a")?.getAttribute("href")).toBe("/scm/sales-orders/HC-SO-2609-104");
    expect(screen.getByText(/under JOHOR \[AKEMI\] MLE @ MVEC SOUTHKEY/)).toBeTruthy();
    expect(screen.getByText("Not opened")).toBeTruthy();
    expect(screen.queryByText("HC8999")).toBeNull();
  });

  test("when every bill is opened under this event, it says so instead of a list", async () => {
    get.mockResolvedValueOnce({ ...RESPONSE, bills: [RESPONSE.bills[1]] });
    mount();
    await waitFor(() => expect(screen.getByText(/are opened as Sales Orders under this event/)).toBeTruthy());
    expect(screen.queryByText("HC8999")).toBeNull();
  });

  test("an empty report reports what it looked for; a failed read shows its message", async () => {
    get.mockResolvedValueOnce({ ...RESPONSE, bills: [], persons: [], totals: { ...RESPONSE.totals, count: 0, amount_sen: 0 } });
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByText(/No bills found in this event's chat/)).toBeTruthy());
    unmount();
    get.mockRejectedValueOnce(new Error("403: You don't have permission to view this page."));
    mount(345);
    await waitFor(() => expect(screen.getByText("403: You don't have permission to view this page.")).toBeTruthy());
  });
});
