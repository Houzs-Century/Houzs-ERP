/* A storekeeper must be able to FIND a rack on the phone.
 *
 * Before this screen, `frontend/src/mobile` touched `/warehouse` only to CREATE
 * a rack (MobileModuleList's FORM_RACK). There was no lookup at all, so
 * "which rack is that customer's sofa on" meant walking to a PC.
 *
 * FAILS ON THE PRE-FIX CODE — the screen did not exist.
 *
 * These drive the REAL screen with only `authedFetch` faked, so they cover the
 * read it issues, the search/filters, and the ordering. The ordering assertion
 * is the one that discriminates: rack labels must sort NATURALLY (A2 before
 * A10) through the shared `compareRackLabels`, not as strings — a plain
 * `localeCompare` puts A10 before A2 and the test goes red.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));

import { MobileRacks, visibleRackSlots, toMobileRackSlot } from "./MobileRacks";
import { EMPTY_FILTERS } from "../vendor/scm/lib/warehouse-floorplan";
import type { CrossCompanyRack } from "../vendor/scm/lib/warehouse-queries";

afterEach(cleanup);

const rackItem = (over: Record<string, unknown> = {}) => ({
  id: "ri-1",
  rack_id: "r-1",
  item_code: "AKEMI-QD",
  product_name: "Akemi Queen Divan",
  size_label: null,
  customer_name: "Tan Wei",
  source_doc_no: "SO-2609-001",
  qty: 2,
  stocked_in_date: "2026-09-01",
  notes: null,
  ...over,
});

const rack = (over: Partial<CrossCompanyRack> = {}): CrossCompanyRack =>
  ({
    id: "r-1",
    warehouse_id: "wh-1",
    rack: "A2",
    position: null,
    zone: null,
    status: "OCCUPIED",
    reserved: false,
    notes: null,
    items: [rackItem()],
    created_at: "2026-09-01",
    updated_at: "2026-09-01",
    company_id: 1,
    company_code: "HOUZS",
    warehouse_code: "WH-MAIN",
    warehouse_name: "Main",
    ...over,
  }) as CrossCompanyRack;

const FEED = {
  racks: [
    rack({ id: "r-10", rack: "A10", items: [rackItem({ id: "ri-10", item_code: "TRION-KD", product_name: "Trion King", customer_name: "Lim Ah Kau", source_doc_no: "SO-2609-044" })] }),
    rack({ id: "r-2", rack: "A2" }),
    rack({ id: "r-e", rack: "B1", status: "EMPTY", items: [], company_code: "HC", warehouse_code: "WH-HC" }),
  ],
  warehouses: [{ code: "WH-MAIN", name: "Main" }, { code: "WH-HC", name: "HC" }],
  companies: [{ id: 1, code: "HOUZS" }, { id: 2, code: "HC" }],
  summary: { total: 3, occupied: 2, empty: 1, reserved: 0, occupancyRate: 0.66 },
};

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileRacks onBack={vi.fn()} />
    </QueryClientProvider>,
  );
};

describe("the mobile shell reaches this screen", () => {
  it("opens Racks for the DESKTOP rack URL, not a stub", async () => {
    /* The row and the URL must land on the same screen. `destinationScreen` is
       what both the menu tap and a typed /scm/warehouses/racks resolve through
       (MobileApp), so a missing arm shows the "not built for phones" stub while
       the menu row sits right there. */
    const { destinationScreen, MOBILE_MENU_GROUPS } = await import("./MobileApp");
    expect(destinationScreen("/scm/warehouses/racks", "Racks")).toEqual({ t: "racks" });
    const warehouse = MOBILE_MENU_GROUPS.find((g) => g.group === "Warehouse");
    expect(warehouse?.items.some((i) => i.to === "/scm/warehouses/racks")).toBe(true);
  });
});

describe("visibleRackSlots", () => {
  const slots = FEED.racks.map(toMobileRackSlot);

  it("orders rack labels naturally, not as strings (A2 before A10)", () => {
    const ordered = visibleRackSlots(slots, { company: "HOUZS", warehouse: "", filters: EMPTY_FILTERS });
    expect(ordered.map((s) => s.rack.rack)).toEqual(["A2", "A10"]);
  });

  it("scopes to one company when a company is picked", () => {
    const only = visibleRackSlots(slots, { company: "HC", warehouse: "", filters: EMPTY_FILTERS });
    expect(only.map((s) => s.rack.rack)).toEqual(["B1"]);
  });

  it("matches an item's customer through the shared slot haystack", () => {
    const hit = visibleRackSlots(slots, { company: "", warehouse: "", filters: { ...EMPTY_FILTERS, q: "lim ah kau" } });
    expect(hit.map((s) => s.rack.rack)).toEqual(["A10"]);
  });

  it("filters by status", () => {
    const empties = visibleRackSlots(slots, { company: "", warehouse: "", filters: { ...EMPTY_FILTERS, status: "empty" } });
    expect(empties.map((s) => s.rack.rack)).toEqual(["B1"]);
  });
});

describe("MobileRacks screen", () => {
  beforeEach(() => {
    authedFetch.mockReset();
    authedFetch.mockResolvedValue(FEED);
  });

  it("reads the cross-company feed and lists every rack it may see", async () => {
    wrap();
    expect(await screen.findByText("A2")).toBeTruthy();
    expect(authedFetch).toHaveBeenCalledWith("/warehouse/cross-company");
    expect(screen.getByText("A10")).toBeTruthy();
    expect(screen.getByText("B1")).toBeTruthy();
  });

  it("shows what is ON a rack — item, customer and document", async () => {
    wrap();
    expect(await screen.findByText("Akemi Queen Divan")).toBeTruthy();
    expect(screen.getByText(/Tan Wei · SO-2609-001/)).toBeTruthy();
  });

  it("narrows to the racks holding the searched item", async () => {
    wrap();
    await screen.findByText("A2");
    await userEvent.type(screen.getByLabelText("Search racks"), "TRION");
    expect(screen.getByText("A10")).toBeTruthy();
    expect(screen.queryByText("A2")).toBeNull();
  });

  it("filters to empty racks from the status chips", async () => {
    wrap();
    await screen.findByText("A2");
    await userEvent.click(screen.getByRole("button", { name: "Empty" }));
    expect(screen.getByText("B1")).toBeTruthy();
    expect(screen.queryByText("A2")).toBeNull();
  });

  it("says the read FAILED rather than showing an empty warehouse", async () => {
    /* The real shape: vendor `authedFetch` throws an Error carrying `.status`.
       403 is the case that matters — a position the endpoint refuses must be
       told the read failed, never shown a warehouse with no racks in it. */
    const refused = Object.assign(new Error("Forbidden"), { status: 403 });
    authedFetch.mockRejectedValue(refused);
    wrap();
    expect(await screen.findByText(/Could not load the racks/)).toBeTruthy();
    expect(screen.queryByText(/No racks in any warehouse/)).toBeNull();
  });

  it("pins the search box and chip row to their own height (no flex grow/shrink)", async () => {
    /* jsdom has no layout, so this pins the MECHANISM, not the pixels. In a
       real 375px render both collapsed or ballooned inside the vertical scroll
       column: `.chips` scrolls sideways (flex min-height drops to 0, shrank to a
       sliver) and `.searchbar` carries `flex: 1` (grew ~200px tall whenever a
       search left few results). Measured after the fix: 36px and 32px. */
    const { container } = wrap();
    await screen.findByText("A2");
    expect((container.querySelector(".searchbar") as HTMLElement).style.flex).toMatch(/^(none|0 0 auto)$/);
    expect((container.querySelector(".chips") as HTMLElement).style.flex).toMatch(/^(none|0 0 auto)$/);
  });

  it("counts only what is currently matched", async () => {
    wrap();
    await screen.findByText("A2");
    const matched = screen.getByText("Matched").parentElement as HTMLElement;
    expect(within(matched).getByText("3")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Empty" }));
    expect(within(screen.getByText("Matched").parentElement as HTMLElement).getByText("1")).toBeTruthy();
  });
});
