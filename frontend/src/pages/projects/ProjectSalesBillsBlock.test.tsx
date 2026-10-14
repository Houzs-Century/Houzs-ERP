/* The pasted sales report inside a project's Sales section (owner 2026-10-14).
   Pinned: the header counts bills, opened and not opened (red), names each
   person with their red number or "all opened", links an opened bill to its
   order, offers Set Total Sales only to someone who may and only when the
   figures differ, shows the delete control only to someone who may save, and
   reports — never concludes — when nothing is saved. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import type { QueryState } from "../../hooks/useQuery";
import type { ProjectSalesBill, ProjectSalesBillsResponse } from "../../lib/projectSalesBills";

vi.mock("../../hooks/useProjectSalesBills", () => ({ useInvalidateProjectSalesBills: () => () => {} }));
vi.mock("../../hooks/useDialog", () => ({ useDialog: () => ({ confirm: async () => true, prompt: async () => null, alert: async () => {} }) }));
const del = vi.fn(async (_path: string) => ({ ok: true }));
vi.mock("../../api/client", () => ({ api: { del: (p: string) => del(p) } }));

const { ProjectSalesBillsBlock } = await import("./ProjectSalesBillsBlock");

const bill = (over: Partial<ProjectSalesBill> & { id: number }): ProjectSalesBill => ({
  ref_raw: "HC8993", ref_token: "HC8993", amount_sen: 650000, salesperson_name: "Jason", report_date: "2026-10-11",
  source_activity_id: 5, created_at: null, person_key: "rep:11", sales_rep_id: 11,
  match: { status: "opened", so_doc_no: "HC-SO-2609-104", so_status: "CONFIRMED", so_project_id: 344, so_salesperson_id: "s", so_amount_sen: 650000, other_event: false, unlinked: false },
  ...over,
});

const RESPONSE: ProjectSalesBillsResponse = {
  bills: [
    bill({ id: 1 }),
    bill({ id: 2, ref_raw: "HC10785", ref_token: "HC10785", amount_sen: 499900, salesperson_name: "Melvin", person_key: "rep:12", sales_rep_id: 12,
      match: { status: "not_opened", so_doc_no: null, so_status: null, so_project_id: null, so_salesperson_id: null, so_amount_sen: null, other_event: false, unlinked: false } }),
    bill({ id: 3, ref_raw: "ZNT6042", ref_token: "ZNT6042", amount_sen: 200000, salesperson_name: "Jason",
      match: { status: "opened", so_doc_no: "HC-SO-2609-324", so_status: "CONFIRMED", so_project_id: 345, so_salesperson_id: "s", so_amount_sen: 200000, other_event: true, unlinked: false } }),
  ],
  persons: [
    { key: "rep:12", name: "Melvin Tan", sales_rep_id: 12, rep_user_id: 102, count: 1, amount_sen: 499900, opened_count: 0, opened_sen: 0, not_opened_count: 1, not_opened_sen: 499900, other_event_count: 0 },
    { key: "rep:11", name: "Jason Lee", sales_rep_id: 11, rep_user_id: 101, count: 2, amount_sen: 850000, opened_count: 2, opened_sen: 850000, not_opened_count: 0, not_opened_sen: 0, other_event_count: 1 },
  ],
  totals: { count: 3, amount_sen: 1349900, opened_count: 2, opened_sen: 850000, not_opened_count: 1, not_opened_sen: 499900, other_event_count: 1 },
  saved_activity_ids: [5],
  can_save: true,
};

const query = (over: Partial<QueryState<ProjectSalesBillsResponse>>): QueryState<ProjectSalesBillsResponse> => ({
  data: null, loading: false, fetching: false, placeholder: false, error: null, reload: () => {}, ...over,
});

const mount = (q: QueryState<ProjectSalesBillsResponse>, finalTotalRm: number | null, canSetTotalSales = true, onSet = vi.fn(async () => {})) =>
  render(
    <MemoryRouter>
      <ProjectSalesBillsBlock projectId={344} query={q} finalTotalRm={finalTotalRm} canSetTotalSales={canSetTotalSales} onSetTotalSales={onSet} />
    </MemoryRouter>,
  );

describe("ProjectSalesBillsBlock", () => {
  test("counts the report, names each person with their red number, and links opened bills to their orders", () => {
    mount(query({ data: RESPONSE }), 113_990);
    /* The header strip carries the labels; the table below repeats the words
       as status pills, so the tiles are read inside the strip. */
    const strip = within(screen.getByText("Sales report (pasted)").parentElement!);
    expect(strip.getByText("Bills").nextSibling?.textContent).toBe("3 · RM 13,499.00");
    expect(strip.getByText("Opened").nextSibling?.textContent).toBe("2 · RM 8,500.00");
    const notOpened = strip.getByText("Not opened").nextSibling as HTMLElement;
    expect(notOpened.textContent).toBe("1 · RM 4,999.00");
    expect(notOpened.className).toContain("text-err");
    expect(screen.getByText("1 under another event")).toBeTruthy();

    const melvin = screen.getByText("Melvin Tan").parentElement!;
    expect(melvin.textContent).toContain("RM 4,999.00");
    const jason = screen.getByText("Jason Lee").parentElement!;
    expect(jason.textContent).toContain("all opened");

    const table = screen.getByRole("table");
    const links = within(table).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/scm/sales-orders/HC-SO-2609-104", "/scm/sales-orders/HC-SO-2609-324"]);
    expect(within(table).getByText("Opened under another event")).toBeTruthy();
    expect(within(table).getByText("Not opened")).toBeTruthy();
  });

  test("offers to set Total Sales only when allowed and only when the figures differ", async () => {
    const onSet = vi.fn(async () => {});
    const { unmount } = mount(query({ data: RESPONSE }), 113_990, true, onSet);
    fireEvent.click(screen.getByText("Set Total Sales = RM 13,499.00"));
    await vi.waitFor(() => expect(onSet).toHaveBeenCalledWith(13499));
    unmount();

    const { unmount: u2 } = mount(query({ data: RESPONSE }), 13_499, true);
    expect(screen.queryByText(/Set Total Sales/)).toBeNull();
    u2();

    mount(query({ data: RESPONSE }), 113_990, false);
    expect(screen.queryByText(/Set Total Sales/)).toBeNull();
  });

  test("the delete control is for someone who may save, and calls the bill's route", async () => {
    const { unmount } = mount(query({ data: RESPONSE }), null);
    const buttons = screen.getAllByTitle("Remove this bill from the report");
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[1]!);
    await vi.waitFor(() => expect(del).toHaveBeenCalledWith("/api/project-sales-bills/344/2"));
    unmount();

    mount(query({ data: { ...RESPONSE, can_save: false } }), null);
    expect(screen.queryByTitle("Remove this bill from the report")).toBeNull();
  });

  test("an empty report says what to do, loading and errors show as such", () => {
    const empty: ProjectSalesBillsResponse = { bills: [], persons: [], totals: { count: 0, amount_sen: 0, opened_count: 0, opened_sen: 0, not_opened_count: 0, not_opened_sen: 0, other_event_count: 0 }, saved_activity_ids: [], can_save: true };
    const { unmount } = mount(query({ data: empty }), 113_990);
    expect(screen.getByText(/No sales report has been saved for this event/)).toBeTruthy();
    expect(screen.queryByText(/Set Total Sales/)).toBeNull();
    unmount();
    const { unmount: u2 } = mount(query({ loading: true }), null);
    expect(screen.getByText("Loading sales report…")).toBeTruthy();
    u2();
    mount(query({ error: "403: You don't have permission to view this page." }), null);
    expect(screen.getByText("403: You don't have permission to view this page.")).toBeTruthy();
  });
});
