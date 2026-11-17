/* The job drawer's DP section (owner 2026-11-17): it shows the job's postcode
   and state — including one the server found only in the address — and offers
   Edit on a scheduled job, which used to be read-only. A cancelled job is not
   offered it, and a failed read is shown, not hidden. */
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../vendor/scm/lib/authed-fetch", () => ({ authedFetch: fetchMock }));
vi.mock("../../vendor/scm/components/EditDpOrderDrawer", () => ({
  EditDpOrderDrawer: ({ row }: { row: { id: string } }) => <div>Editing {row.id}</div>,
}));

const { DpJobDetails } = await import("./DpJobDetails");

const renderIt = (showFacts = true) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DpJobDetails dpId="dp-9" showFacts={showFacts} />
  </QueryClientProvider>,
);

const ROW = { id: "dp-9", status: "SCHEDULED", job_type: "SUPPLIER_PICKUP", postcode: "47000", state: "Selangor", city: "Sungai Buloh" };

describe("DpJobDetails", () => {
  test("shows the postcode and state and opens the editor on a scheduled job", async () => {
    fetchMock.mockResolvedValueOnce({ dpOrder: ROW });
    renderIt();
    expect(await screen.findByText("47000")).toBeTruthy();
    expect(screen.getByText("Selangor")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/dp-orders/dp-9");
    fireEvent.click(screen.getByText("Edit job details"));
    expect(screen.getByText("Editing dp-9")).toBeTruthy();
  });

  test("a cancelled job is not offered Edit", async () => {
    fetchMock.mockResolvedValueOnce({ dpOrder: { ...ROW, status: "CANCELLED" } });
    renderIt();
    expect(await screen.findByText("47000")).toBeTruthy();
    expect(screen.queryByText("Edit job details")).toBeNull();
  });

  test("inside the Last Mile stop drawer only Edit is added: the drawer shows the postcode and state", async () => {
    fetchMock.mockResolvedValueOnce({ dpOrder: ROW });
    renderIt(false);
    expect(await screen.findByText("Edit job details")).toBeTruthy();
    expect(screen.queryByText("47000")).toBeNull();
    expect(screen.queryByText("Selangor")).toBeNull();
  });

  test("a failed read is shown", async () => {
    fetchMock.mockRejectedValueOnce(new Error("load_failed"));
    renderIt();
    expect(await screen.findByText("load_failed")).toBeTruthy();
  });
});
