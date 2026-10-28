/* The desktop SO list's second-level filter bar. Drives the REAL bar, rows
 * editor, grouped field picker and the shared URL state inside a MemoryRouter.
 * Faked: `authedFetch` — the count preview's request and answer are the
 * assertions, and the URL is the applied state. */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch,
}));

import { SoListFilterBar } from "./SoListFilterBar";

afterEach(cleanup);

let search = "";
function Probe() {
  search = useLocation().search;
  return null;
}

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/staff")) return { staff: [] };
    if (url.startsWith("/inventory/warehouses")) return { warehouses: [{ id: "e309c399-697c-4174-967f-ae2c888ad999", code: "KL", name: "KL WAREHOUSE", location: null, is_active: true }] };
    const p = new URLSearchParams(url.split("?")[1] ?? "");
    return { salesOrders: [], total: p.getAll("f").length > 0 ? 8 : 2949 };
  });
});

function renderBar(initial: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>
        <SoListFilterBar q="" />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SoListFilterBar", () => {
  it("adds a Balance > 0 row, previews the count, applies it to the URL keeping the status", async () => {
    const user = userEvent.setup();
    renderBar("/scm/sales-orders?status=confirmed&page=2");
    await user.click(screen.getByRole("button", { name: "More filters" }));
    const dialog = screen.getByRole("dialog", { name: "More filters" });
    expect(dialog).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    expect(screen.getByText("Where")).toBeTruthy();
    expect(screen.getByText("When")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Balance/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Apply · 8 orders/ })).toBeTruthy());
    const previewUrl = authedFetch.mock.calls.map(([u]) => String(u)).find((u) => u.includes("pageSize=1") && u.includes("f="));
    expect(previewUrl).toContain("status=CONFIRMED");
    await user.click(screen.getByRole("button", { name: /Apply · 8 orders/ }));
    const p = new URLSearchParams(search);
    expect(p.getAll("f")).toEqual(["balance:positive"]);
    expect(p.get("status")).toBe("confirmed");
    expect(p.get("page")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows applied rows as chips from the URL, and x removes one", async () => {
    const user = userEvent.setup();
    renderBar("/scm/sales-orders?f=venue:contains:IOI&f=deliveryDate:preset:this_week");
    expect(screen.getByText(/contains "IOI"/)).toBeTruthy();
    expect(screen.getByText("This week")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Filters · 2/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove Venue filter" }));
    expect(new URLSearchParams(search).getAll("f")).toEqual(["deliveryDate:preset:this_week"]);
  });

  it("Clear in the panel removes every row", async () => {
    const user = userEvent.setup();
    renderBar("/scm/sales-orders?f=createdBy:me");
    await user.click(screen.getByRole("button", { name: /Filters · 1/ }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(new URLSearchParams(search).getAll("f")).toEqual([]);
  });

  it("opens the popover with fixed positioning so it escapes the list's overflow clip", async () => {
    // Regression for the clipped/cut-off popover: the panel must be position:fixed
    // (not absolute) so it is not clipped by the ancestors' overflow-x hidden/clip,
    // and can be clamped into the viewport at any button position. See SoListFilterBar.tsx.
    const user = userEvent.setup();
    renderBar("/scm/sales-orders");
    await user.click(screen.getByRole("button", { name: "More filters" }));
    expect(screen.getByRole("dialog", { name: "More filters" }).style.position).toBe("fixed");
  });

  it("an applied Warehouse row reads as the warehouse's name", async () => {
    renderBar("/scm/sales-orders?f=warehouse:is:e309c399-697c-4174-967f-ae2c888ad999&f=branding:contains:AKEMI");
    expect(await screen.findByText(/is KL WAREHOUSE/)).toBeTruthy();
    expect(screen.getByText(/contains "AKEMI"/)).toBeTruthy();
  });
});
