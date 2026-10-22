/* The Sales Orders block inside a project's Sales section (owner 2026-10-13).
   Pinned: the header reads the opened count and sum, the final total and the
   gap between them in words a salesperson reads ("Not yet opened"); each order
   links to its SO; a scoped rep is told the totals are theirs only; nothing is
   claimed about the business when the read came back empty. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import type { QueryState } from "../../hooks/useQuery";
const transferMutate = vi.hoisted(() => vi.fn());
vi.mock("../../vendor/scm/lib/fair-options-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/fair-options-queries")>()),
  useFairTransfer: () => ({ mutate: transferMutate, isPending: false }),
  useFairOptions: () => ({ data: { date: "2026-10-12", running: [], venues: [], earlier: [
    { key: "ioigecc|homelove|2026-10-09|2026-10-11", venue: "IOIGECC", organizer: "HOMELOVE", startDate: "2026-10-09", endDate: "2026-10-11", projectIds: [307, 2267],
      booths: [{ projectId: 307, brand: "AKEMI" }, { projectId: 2267, brand: "ZANOTTI" }] },
  ] }, isLoading: false, isError: false }),
}));

import { ProjectSalesOrdersBlock } from "./ProjectSalesOrdersBlock";
import type { ProjectSalesOrderRow, ProjectSalesOrdersResponse } from "./projectSalesOrders";

const row = (over: Partial<ProjectSalesOrderRow>): ProjectSalesOrderRow => ({
  doc_no: "HC-SO-013462", so_date: "2026-09-18", ref: "HC13503", customer_name: "Lim Ah Kow",
  customer_phone: "0123456789", salesperson_name: "Anthony", status: "CONFIRMED",
  amount_sen: 5_000_000, paid_sen: 2_500_000, balance_sen: 2_500_000, fair_match: "PICKED",
  linked_ac_docno: null, created_at: "2026-09-18T02:00:00Z", ...over,
});

const response = (rows: ProjectSalesOrderRow[], scoped = false): ProjectSalesOrdersResponse => ({
  data: rows,
  totals: rows.reduce(
    (t, r) => ({
      count: t.count + 1, draft_count: t.draft_count + (r.status === "DRAFT" ? 1 : 0),
      amount_sen: t.amount_sen + r.amount_sen, paid_sen: t.paid_sen + r.paid_sen, balance_sen: t.balance_sen + r.balance_sen,
    }),
    { count: 0, draft_count: 0, amount_sen: 0, paid_sen: 0, balance_sen: 0 },
  ),
  scoped,
  can_transfer: false,
});

const query = (over: Partial<QueryState<ProjectSalesOrdersResponse>>): QueryState<ProjectSalesOrdersResponse> => ({
  data: null, loading: false, fetching: false, placeholder: false, error: null, reload: () => {}, ...over,
});

const mount = (q: QueryState<ProjectSalesOrdersResponse>, finalTotalRm: number | null) =>
  render(
    <MemoryRouter>
      <ProjectSalesOrdersBlock query={q} finalTotalRm={finalTotalRm} />
    </MemoryRouter>,
  );

describe("ProjectSalesOrdersBlock", () => {
  test("reads the opened orders against the final total and links each order to its SO", () => {
    const rows = [
      row({}),
      row({ doc_no: "HC-SO-2609-175", ref: "HC12892", customer_name: "Tan Mei", customer_phone: null, salesperson_name: "Adrian", status: "DRAFT", amount_sen: 3_000_000, paid_sen: 0, balance_sen: 3_000_000 }),
    ];
    mount(query({ data: response(rows) }), 113_990);

    expect((screen.getByText("Opened").nextSibling)?.textContent).toContain("2 · RM 80,000.00");
    expect((screen.getByText("Final total").nextSibling)?.textContent).toContain("RM 113,990.00");
    expect(screen.getByText("Not yet opened RM 33,990.00 (29.8%)")).toBeTruthy();
    expect(screen.getByText("1 draft")).toBeTruthy();
    expect(screen.queryByText("your orders only")).toBeNull();

    const table = screen.getByRole("table");
    const links = within(table).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/scm/sales-orders/HC-SO-013462",
      "/scm/sales-orders/HC-SO-2609-175",
    ]);
    const first = links[0]!.closest("tr")!;
    expect((first).textContent).toContain("HC13503");
    expect((first).textContent).toContain("Lim Ah Kow");
    expect((first).textContent).toContain("RM 50,000.00");
    expect((first).textContent).toContain("RM 25,000.00");
    expect((first).textContent).toContain("Anthony");
    expect((first).textContent).toContain("Submitted");
    expect((links[1]!.closest("tr")!).textContent).toContain("Draft");
  });

  test("says when the orders already exceed the typed total, and when they match it", () => {
    const { unmount } = mount(query({ data: response([row({ amount_sen: 12_000_000 })]) }), 113_990);
    expect(screen.getByText("Orders exceed final total by RM 6,010.00 (5.3%)")).toBeTruthy();
    unmount();
    mount(query({ data: response([row({ amount_sen: 11_399_000 })]) }), 113_990);
    expect(screen.getByText("Opened orders match the final total")).toBeTruthy();
  });

  test("without a final total there is no gap and no final-total tile", () => {
    mount(query({ data: response([row({})]) }), null);
    expect(screen.queryByText("Final total")).toBeNull();
    expect(screen.queryByText(/Not yet opened/)).toBeNull();
    expect((screen.getByText("Opened").nextSibling)?.textContent).toContain("1 · RM 50,000.00");
  });

  test("a scoped rep is told the totals are theirs only", () => {
    mount(query({ data: response([row({})], true) }), 113_990);
    expect(screen.getByText("your orders only")).toBeTruthy();
  });

  test("an empty read reports what it looked for, loading and errors show as such", () => {
    const { unmount } = mount(query({ data: response([]) }), 113_990);
    expect(screen.getByText("No sales orders linked to this event were found in the SO module.")).toBeTruthy();
    expect(screen.getByText("Not yet opened RM 113,990.00 (100%)")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    unmount();

    const { unmount: unmount2 } = mount(query({ loading: true }), 113_990);
    expect(screen.getByText("Loading sales orders…")).toBeTruthy();
    unmount2();

    mount(query({ error: "403: You don't have permission to view this page." }), 113_990);
    expect(screen.getByText("403: You don't have permission to view this page.")).toBeTruthy();
    expect(screen.queryByText(/were found/)).toBeNull();
  });

  test('marks an order placed here from another place — "Venue differs" (owner 2026-10-19)', () => {
    mount(query({ data: response([row({}), row({ doc_no: "HC-SO-2610-167", venue_differs: "IOIGECC" })]) }), null);
    const pills = screen.getAllByText("Venue differs");
    expect(pills).toHaveLength(1);
    expect(pills[0]!.getAttribute("title")).toBe("Venue on the order: IOIGECC");
    expect(pills[0]!.closest("tr")?.textContent).toContain("HC-SO-2610-167");
  });
});

describe("ProjectSalesOrdersBlock — moving an order out (owner 2026-10-20)", () => {
  const reported = row({ doc_no: "HC-SO-2610-167", venue: "IOI MALL PUTRAJAYA", branding: "AKEMI",
    report_elsewhere: { project_id: 307, label: "AKEMI — IOIGECC — HOMELOVE (10/09 - 10/11)", report_date: "2026-10-10" } });
  const differs = row({ doc_no: "HC-SO-2610-166", so_date: "2026-10-12", venue: "IOIGECC", branding: "AKEMI", venue_differs: "IOIGECC" });
  const plain = row({ doc_no: "HC-SO-2610-100" });

  test("another event's report names where it belongs: moved ticked, or all at one click", () => {
    transferMutate.mockReset();
    mount(query({ data: { ...response([reported, plain]), can_transfer: true } }), null);
    expect(screen.getByText("AKEMI — IOIGECC — HOMELOVE (10/09 - 10/11)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Transfer all to their reported event (1)" }));
    expect(transferMutate.mock.calls[0]![0]).toEqual([{ docNo: "HC-SO-2610-167", projectId: 307 }]);
    fireEvent.click(screen.getByLabelText("Tick HC-SO-2610-167 to transfer"));
    fireEvent.click(screen.getByRole("button", { name: "Transfer ticked (1)" }));
    expect(transferMutate.mock.calls[1]![0]).toEqual([{ docNo: "HC-SO-2610-167", projectId: 307 }]);
  });

  test("a Venue differs order no report places: pick a booth at its own venue, one at a time", () => {
    transferMutate.mockReset();
    mount(query({ data: { ...response([differs, plain]), can_transfer: true } }), null);
    const pick = screen.getByLabelText("Fair to move HC-SO-2610-166 to") as HTMLSelectElement;
    /* Its own brand's booth, filled in; the person still presses Transfer. */
    expect(pick.value).toBe("307");
    expect([...pick.options].map((o) => o.text)).toEqual(["— pick a fair —", "AKEMI — IOIGECC — HOMELOVE (10/09 - 10/11)", "ZANOTTI — IOIGECC — HOMELOVE (10/09 - 10/11)"]);
    expect(transferMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
    expect(transferMutate.mock.calls[0]![0]).toEqual([{ docNo: "HC-SO-2610-166", projectId: 307 }]);
    expect(screen.queryByRole("button", { name: /Transfer all/ })).toBeNull();
  });

  test("without the right, no Move column", () => {
    mount(query({ data: response([reported, differs]) }), null);
    expect(screen.queryByText("Move to")).toBeNull();
    expect(screen.queryByRole("button", { name: /Transfer/ })).toBeNull();
  });
});
