/* The phone Sales Orders "Filter" sheet (owner-approved mockup, 2026-09-14):
 * the status list stays the FIRST filter with its counts, zero-count statuses
 * fold into one compact line, "MORE FILTERS" rows are added from a grouped field
 * picker, and the footer's Apply button previews how many orders the draft
 * would show before anything is applied.
 *
 * Drives the REAL sheet, the real shared rows editor / picker / value editor and
 * the real shared state layer. Faked: `authedFetch` — the count-preview request
 * and its answer are the assertions. */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch,
}));

import { MobileSoFilterSheet } from "./MobileSoFilterSheet";

afterEach(cleanup);

const STATUS_OPTIONS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "confirmed", label: "Submitted" },
  { key: "in_production", label: "In Production" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
];
const COUNTS = { all: 2949, draft: 0, confirmed: 2341, in_production: 132, shipped: 0, delivered: 189 };

const urls = () => authedFetch.mock.calls.map(([u]) => String(u));

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/staff")) return { staff: [] };
    if (url.startsWith("/inventory/warehouses")) return { warehouses: [
      { id: "e309c399-697c-4174-967f-ae2c888ad999", code: "KL", name: "KL WAREHOUSE", location: null, is_active: true },
      { id: "a1b2c3d4-0000-4000-8000-000000000002", code: "JB", name: "JB WAREHOUSE", location: null, is_active: false },
    ] };
    const p = new URLSearchParams(url.split("?")[1] ?? "");
    if (p.getAll("f").includes("createdBy:me")) return { salesOrders: [], total: 57 };
    return { salesOrders: [], total: 2949 };
  });
});

function renderSheet(over: Partial<Parameters<typeof MobileSoFilterSheet>[0]> = {}) {
  const props = {
    appliedStatus: "all",
    appliedFilters: [],
    statusOptions: STATUS_OPTIONS,
    statusCounts: COUNTS,
    q: "",
    onApply: vi.fn(),
    onClear: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div className="hz-m"><MobileSoFilterSheet {...props} /></div>
    </QueryClientProvider>,
  );
  return props;
}

describe("MobileSoFilterSheet", () => {
  it("keeps the status list first, with counts, and folds zero-count statuses into one line", () => {
    renderSheet();
    const submitted = screen.getByRole("button", { name: /Submitted\s*2341/ });
    expect(submitted).toBeTruthy();
    const compact = screen.getByTestId("so-status-zero-line");
    expect(compact.textContent).toContain("Draft 0");
    expect(compact.textContent).toContain("Shipped 0");
    expect(screen.queryByRole("button", { name: /^Draft\s*0$/ })).toBeTruthy();
  });

  it("the field picker's labels use the same text class as the status rows (owner: the fonts were all different, too big)", async () => {
    const user = userEvent.setup();
    renderSheet();
    const statusLabel = screen.getByRole("button", { name: /Submitted\s*2341/ }).querySelector("span");
    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    const fieldLabel = screen.getByRole("button", { name: /^Created by/ }).querySelector("span");
    expect(fieldLabel?.className).toBe(statusLabel?.className);
    expect(fieldLabel?.className).toBe("ml");
  });

  it("adds a Created by row from the grouped picker, previews its count, and applies it", async () => {
    const user = userEvent.setup();
    const props = renderSheet();

    expect(screen.getByText(/More filters · 0/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    expect(screen.getByText("Who")).toBeTruthy();
    expect(screen.getByText("Order and money")).toBeTruthy();
    expect(screen.queryByText(/coming next/)).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Created by/ }));
    const row = screen.getByTestId("so-filter-row");
    expect(within(row).getByRole("button", { name: /Edit Created by value/ }).textContent).toContain("is me");
    expect(screen.getByText(/More filters · 1/i)).toBeTruthy();

    await waitFor(() => expect(screen.getByRole("button", { name: /Apply · 57 orders/ })).toBeTruthy());
    expect(urls().some((u) => u.includes("pageSize=1") && u.includes("f=createdBy%3Ame"))).toBe(true);

    await user.click(screen.getByRole("button", { name: /Apply · 57 orders/ }));
    expect(props.onApply).toHaveBeenCalledWith({ status: "all", filters: [{ field: "createdBy", op: "me", value: "" }] });
  });

  it("a status tap changes the draft and Apply carries it; Clear resets everything", async () => {
    const user = userEvent.setup();
    const props = renderSheet({ appliedFilters: [{ field: "balance", op: "positive", value: "" }] });
    expect(screen.getByText(/More filters · 1/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Submitted\s*2341/ }));
    await user.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(props.onApply).toHaveBeenCalledWith({ status: "confirmed", filters: [{ field: "balance", op: "positive", value: "" }] });

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(props.onClear).toHaveBeenCalled();
  });

  it("an incomplete row is shown as unfinished and is not sent to the preview", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    await user.click(screen.getByRole("button", { name: /^Name/ }));
    expect(screen.getByRole("button", { name: /Edit Name value/ }).textContent).toContain("Choose");
    await user.type(screen.getByLabelText("Name value"), "tan");
    expect(screen.getByRole("button", { name: /Edit Name value/ }).textContent).toContain('contains "tan"');
    await waitFor(() => expect(urls().some((u) => u.includes("f=name%3Acontains%3Atan"))).toBe(true));
  });

  it("a Delivery date row takes a preset, then a picked range from the calendar", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    await user.click(screen.getByRole("button", { name: /^Delivery date/ }));
    expect(screen.getByRole("button", { name: /Edit Delivery date value/ }).textContent).toContain("This week");
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("button", { name: /Edit Delivery date value/ }).textContent).toContain("Next month");
    await user.click(screen.getByRole("button", { name: "Pick range" }));
    const cal = screen.getByTestId("so-date-range-calendar");
    const days = within(cal).getAllByRole("button").filter((b) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(b.getAttribute("aria-label") ?? ""));
    await user.click(days[2]);
    await user.click(days[9]);
    const from = days[2].getAttribute("aria-label")!;
    const to = days[9].getAttribute("aria-label")!;
    const dmy = (d: string) => d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4);
    expect(screen.getByRole("button", { name: /Edit Delivery date value/ }).textContent).toContain(dmy(from) + " – " + dmy(to));
    await user.click(within(cal).getByRole("button", { name: "Show next month" }));
  });

  it("a Warehouse row picks from the company's warehouses and previews with it", async () => {
    const user = userEvent.setup();
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    await user.click(screen.getByRole("button", { name: /^Warehouse/ }));
    await user.click(await screen.findByRole("button", { name: /JB WAREHOUSE/ }));
    expect(screen.getByRole("button", { name: /Edit Warehouse value/ }).textContent).toContain("is JB WAREHOUSE");
    await waitFor(() => expect(urls().some((u) => u.includes("f=warehouse%3Ais%3Aa1b2c3d4-0000-4000-8000-000000000002"))).toBe(true));
    await user.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(props.onApply).toHaveBeenCalledWith({ status: "all", filters: [{ field: "warehouse", op: "is", value: "a1b2c3d4-0000-4000-8000-000000000002" }] });
  });

  it("Item category and Pending amendment are choices", async () => {
    const user = userEvent.setup();
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    await user.click(screen.getByRole("button", { name: /^Item category/ }));
    await user.click(screen.getByRole("button", { name: "Sofa" }));
    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    await user.click(screen.getByRole("button", { name: /^Pending amendment/ }));
    await user.click(screen.getByRole("button", { name: "Has a pending amendment" }));
    await user.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(props.onApply).toHaveBeenCalledWith({ status: "all", filters: [
      { field: "itemCategory", op: "is", value: "sofa" },
      { field: "pendingAmendment", op: "is", value: "yes" },
    ] });
  });
});
