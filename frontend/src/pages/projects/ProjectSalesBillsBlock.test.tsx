/* The sales report a project's chat carries, inside its Sales section (owner
   2026-10-14). Pinned: the header counts bills, opened and not opened (red),
   lists no per-person row (the red sum is under Sales Attending), links an opened
   bill to its order, shows a "+ (T)" extra apart from the amount, offers the
   latest summary's Total for Total Sales only to someone who may and only when
   the figures differ (with its days when they do not add up), and reports —
   never concludes — when nothing is counted. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import type { QueryState } from "../../hooks/useQuery";
import type { ProjectSalesBill, ProjectSalesBillsResponse } from "../../lib/projectSalesBills";
import { ProjectSalesBillsBlock } from "./ProjectSalesBillsBlock";

const bill = (over: Partial<ProjectSalesBill> & { key: string }): ProjectSalesBill => ({
  ref_raw: "HC8993", ref_token: "HC8993", amount_sen: 650000, extra_sen: null, extra_tag: null, salesperson_name: "Jason",
  report_date: "2026-10-11", source_activity_id: 5, created_at: null, person_key: "rep:11", sales_rep_id: 11, other_event_name: null,
  match: { status: "opened", so_doc_no: "HC-SO-2609-104", so_status: "CONFIRMED", so_project_id: 344, so_salesperson_id: "s", so_amount_sen: 650000, other_event: false, unlinked: false },
  ...over,
});

const RESPONSE: ProjectSalesBillsResponse = {
  bills: [
    bill({ key: "5:2" }),
    bill({ key: "5:3", ref_raw: "HC10785", ref_token: "HC10785", amount_sen: 499900, extra_sen: 71000, extra_tag: "T", salesperson_name: "Melvin", person_key: "rep:12", sales_rep_id: 12,
      match: { status: "not_opened", so_doc_no: null, so_status: null, so_project_id: null, so_salesperson_id: null, so_amount_sen: null, other_event: false, unlinked: false } }),
    bill({ key: "6:2", ref_raw: "ZNT6042", ref_token: "ZNT6042", amount_sen: 200000, salesperson_name: "Jason", other_event_name: "JOHOR [ZANOTTI] MLE @ MVEC SOUTHKEY",
      match: { status: "opened", so_doc_no: "HC-SO-2609-324", so_status: "CONFIRMED", so_project_id: 345, so_salesperson_id: "s", so_amount_sen: 200000, other_event: true, unlinked: false } }),
  ],
  persons: [
    { key: "rep:12", name: "Melvin Tan", sales_rep_id: 12, rep_user_id: 102, count: 1, amount_sen: 499900, opened_count: 0, opened_sen: 0, not_opened_count: 1, not_opened_sen: 499900, other_event_count: 0 },
    { key: "rep:11", name: "Jason Lee", sales_rep_id: 11, rep_user_id: 101, count: 2, amount_sen: 850000, opened_count: 2, opened_sen: 850000, not_opened_count: 0, not_opened_sen: 0, other_event_count: 1 },
  ],
  totals: { count: 3, amount_sen: 1349900, opened_count: 2, opened_sen: 850000, not_opened_count: 1, not_opened_sen: 499900, other_event_count: 1 },
  report_activity_ids: [5, 6],
  summary: { activity_id: 7, total_sen: 4818500, days_sen: 4836500, created_at: "2026-10-14 11:27:25" },
  total_sales_rm: null,
  can_save: true,
};

const query = (over: Partial<QueryState<ProjectSalesBillsResponse>>): QueryState<ProjectSalesBillsResponse> => ({
  data: null, loading: false, fetching: false, placeholder: false, error: null, reload: () => {}, ...over,
});

const mount = (q: QueryState<ProjectSalesBillsResponse>, finalTotalRm: number | null, canSetTotalSales = true, onSet = vi.fn(async (_rm: number) => {})) =>
  render(
    <MemoryRouter>
      <ProjectSalesBillsBlock query={q} finalTotalRm={finalTotalRm} canSetTotalSales={canSetTotalSales} onSetTotalSales={onSet} />
    </MemoryRouter>,
  );

describe("ProjectSalesBillsBlock", () => {
  test("counts the report, names each person with their red number, and links opened bills to their orders", () => {
    mount(query({ data: RESPONSE }), 48_185);
    /* The header strip carries the labels; the table below repeats the words
       as status pills, so the tiles are read inside the strip. */
    const strip = within(screen.getByText("Sales report (chat)").parentElement!);
    expect(strip.getByText("Bills").nextSibling?.textContent).toBe("3 · RM 13,499.00");
    expect(strip.getByText("Opened").nextSibling?.textContent).toBe("2 · RM 8,500.00");
    const notOpened = strip.getByText("Not opened").nextSibling as HTMLElement;
    expect(notOpened.textContent).toBe("1 · RM 4,999.00");
    expect(notOpened.className).toContain("text-err");
    expect(strip.getByText("1 under another event")).toBeTruthy();

    /* No per-person row: the red sums live beside the names under Sales
       Attending; repeating them here was a duplicate (owner 2026-10-14). */
    expect(screen.queryByText("Melvin Tan")).toBeNull();
    expect(screen.queryByText("all opened")).toBeNull();

    /* Only the bills still to act on: HC8993 is opened under this event and is
       in the Sales Orders list, so the report does not repeat it. */
    const table = screen.getByRole("table");
    expect(within(table).queryByText("HC8993")).toBeNull();
    expect(within(table).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/scm/sales-orders/HC-SO-2609-324"]);
    expect(within(table).getByText("Opened under another event")).toBeTruthy();
    expect(within(table).getByText("under JOHOR [ZANOTTI] MLE @ MVEC SOUTHKEY")).toBeTruthy();
    expect(within(table).getByText("+ RM 710.00 (T)")).toBeTruthy();
    /* Nothing to edit here: the report is the chat. */
    expect(screen.queryByTitle(/Remove this bill/)).toBeNull();
  });

  test("offers the latest summary's Total only when allowed and different, and shows its days when they do not add up", async () => {
    const onSet = vi.fn(async (_rm: number) => {});
    const { unmount } = mount(query({ data: RESPONSE }), 40_000, true, onSet);
    expect(screen.getByText("its days add up to RM 48,365.00")).toBeTruthy();
    fireEvent.click(screen.getByText("Set Total Sales = RM 48,185.00"));
    await vi.waitFor(() => expect(onSet).toHaveBeenCalledWith(48185));
    unmount();

    const { unmount: u2 } = mount(query({ data: RESPONSE }), 48_185, true);
    expect(screen.queryByText(/Set Total Sales/)).toBeNull();
    u2();

    const { unmount: u3 } = mount(query({ data: RESPONSE }), 40_000, false);
    expect(screen.queryByText(/Set Total Sales/)).toBeNull();
    u3();

    mount(query({ data: { ...RESPONSE, summary: null } }), 40_000, true);
    expect(screen.queryByText(/Set Total Sales/)).toBeNull();
  });

  test("an empty Total Sales (none or 0) is filled from the latest summary on opening; a set figure is never overwritten", async () => {
    const onSet = vi.fn(async (_rm: number) => {});
    const { unmount } = mount(query({ data: RESPONSE }), null, true, onSet);
    await vi.waitFor(() => expect(onSet).toHaveBeenCalledWith(48185));
    unmount();

    const onSet0 = vi.fn(async (_rm: number) => {});
    const { unmount: u0 } = mount(query({ data: RESPONSE }), 0, true, onSet0);
    await vi.waitFor(() => expect(onSet0).toHaveBeenCalledWith(48185));
    u0();

    const onSetKept = vi.fn(async (_rm: number) => {});
    const { unmount: u1 } = mount(query({ data: RESPONSE }), 48_365, true, onSetKept);
    await new Promise((r) => setTimeout(r, 20));
    expect(onSetKept).not.toHaveBeenCalled();
    expect(screen.getByText("Set Total Sales = RM 48,185.00")).toBeTruthy();
    u1();

    const onSetNo = vi.fn(async (_rm: number) => {});
    mount(query({ data: RESPONSE }), null, false, onSetNo);
    await new Promise((r) => setTimeout(r, 20));
    expect(onSetNo).not.toHaveBeenCalled();
  });

  test("when every bill is opened under this event, it says so instead of a list", () => {
    mount(query({ data: { ...RESPONSE, bills: [RESPONSE.bills[0]!] } }), 48_185);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/All 3 bills in the report are opened as Sales Orders under this event/)).toBeTruthy();
  });

  test("nothing counted says how a report counts; loading and errors show as such", () => {
    const empty: ProjectSalesBillsResponse = {
      bills: [], persons: [], report_activity_ids: [], summary: null, total_sales_rm: null, can_save: true,
      totals: { count: 0, amount_sen: 0, opened_count: 0, opened_sen: 0, not_opened_count: 0, not_opened_sen: 0, other_event_count: 0 },
    };
    const { unmount } = mount(query({ data: empty }), 113_990);
    expect(screen.getByText(/No bills found in this event's chat/)).toBeTruthy();
    unmount();
    const { unmount: u2 } = mount(query({ loading: true }), null);
    expect(screen.getByText("Loading sales report…")).toBeTruthy();
    u2();
    mount(query({ error: "403: You don't have permission to view this page." }), null);
    expect(screen.getByText("403: You don't have permission to view this page.")).toBeTruthy();
  });
});
