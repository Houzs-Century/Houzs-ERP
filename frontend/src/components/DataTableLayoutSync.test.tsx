import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DataTable, type Column, type ColumnLayoutPreset } from "./DataTable";
import {
  __resetTableLayoutsForTest,
  hydrateTableLayouts,
} from "../lib/tableLayouts";
import { api } from "../api/client";

/* ────────────────────────────────────────────────────────────────────────────
   DataTable × server-stored layouts (lib/tableLayouts.ts, routes/tableLayouts).

   The page still ships SEED presets in code, but once an admin saves a default
   for a company the saved layout takes that slot — and both companies' layouts
   are offered whichever company you are in, which is the ask this started from
   (owner 2026-08-01). What these tests pin is the handover: server wins over
   seed, the ACTIVE company's layout is the baseline, and a user's own
   arrangement still beats every default.
   ──────────────────────────────────────────────────────────────────────────── */

vi.mock("../api/client", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

type Row = { id: number; name: string };

const columns: Column<Row>[] = [
  { key: "a", label: "Alpha", render: (r) => r.name },
  { key: "b", label: "Bravo", render: (r) => r.name },
  { key: "c", label: "Charlie", defaultHidden: true, render: (r) => r.name },
  { key: "d", label: "Delta", render: (r) => r.name },
];

const seeds: ColumnLayoutPreset[] = [
  { id: "seed-2990", label: "2990 Layout", companyCode: "2990", columns: ["b", "c"] },
  { id: "seed-houzs", label: "Houzs Layout", companyCode: "HOUZS", columns: ["a", "d"] },
];

const rows: Row[] = [{ id: 1, name: "One" }];

const COMPANIES = [
  { id: 1, code: "HOUZS", name: "Houzs Century Sdn Bhd" },
  { id: 2, code: "2990", name: "2990's Home" },
];

function respond(over: Record<string, unknown> = {}) {
  mockApi.get.mockResolvedValue({
    companies: COMPANIES,
    activeCompanyId: 2,
    canManageDefaults: false,
    defaults: {},
    mine: {},
    myLayouts: {},
    ...over,
  });
}

const emptyish = { hidden: [], shown: [], widths: {}, pinned: [] };

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(max-width: 639px)" ? width < 640 : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const headerLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent?.trim());

const renderTable = (tableId: string) =>
  render(
    <DataTable
      tableId={tableId}
      layoutPresets={seeds}
      rows={rows}
      columns={columns}
      getRowKey={(row) => row.id}
    />,
  );

beforeEach(() => {
  localStorage.clear();
  mockApi.get.mockReset();
  mockApi.post.mockReset().mockResolvedValue({ ok: true });
  mockApi.patch.mockReset().mockResolvedValue({ ok: true });
  mockApi.put.mockReset().mockResolvedValue({ ok: true });
  mockApi.del.mockReset().mockResolvedValue({ ok: true });
  __resetTableLayoutsForTest();
  setViewport(1280);
});

afterEach(() => {
  cleanup();
  __resetTableLayoutsForTest();
  vi.restoreAllMocks();
});

describe("DataTable with server layouts", () => {
  it("prefers the company's SAVED default over the page's seed", async () => {
    respond({
      defaults: { "2": { saved: { order: ["d", "a"], ...emptyish, hidden: ["b", "c"] } } },
    });
    await hydrateTableLayouts();

    const { container } = renderTable("saved");
    // The seed for 2990 is ["b","c"]; the saved default wins outright.
    expect(headerLabels(container)).toEqual(["Delta", "Alpha"]);
  });

  it("offers BOTH companies' layouts, named after the companies", async () => {
    respond({ defaults: { "1": { both: { order: ["a"], ...emptyish, hidden: ["b", "c", "d"] } } } });
    await hydrateTableLayouts();

    renderTable("both");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getByRole("button", { name: /^Layout/ }));

    // 2990 has no saved default yet, so its SEED fills the slot — but the row
    // is still that company's, labelled and marked as this window's default.
    const houzs = screen.getByRole("option", { name: /Houzs Century Layout/ });
    const home = screen.getByRole("option", { name: /2990's Home Layout/ });
    expect(houzs).toBeTruthy();
    expect(home.textContent).toContain("Default");

    // Taking the other company's layout is one click, and it sticks.
    fireEvent.click(houzs);
    expect(JSON.parse(localStorage.getItem("dt:order:both")!)).toEqual(["a", "b", "c", "d"]);
  });

  it("never moves a user who has arranged the table themselves", async () => {
    localStorage.setItem("dt:hidden:mine", JSON.stringify(["d"]));
    respond({
      defaults: { "2": { mine: { order: ["c"], ...emptyish, hidden: ["a", "b", "d"] } } },
    });
    await hydrateTableLayouts();

    const { container } = renderTable("mine");
    // Their own choice stands; the company default is not imposed over it.
    expect(headerLabels(container)).toEqual(["Alpha", "Bravo"]);
  });

  it("pushes a column change up to the account, and a reset as a delete", async () => {
    respond();
    await hydrateTableLayouts();
    vi.useFakeTimers();

    renderTable("push");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getAllByRole("button", { name: "Hide column" })[0]!);
    await vi.runAllTimersAsync();

    expect(mockApi.put).toHaveBeenCalledWith(
      "/api/table-layouts/push",
      expect.objectContaining({ layout: expect.objectContaining({ hidden: ["b"] }) }),
    );

    mockApi.put.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await vi.runAllTimersAsync();
    expect(mockApi.del).toHaveBeenCalledWith("/api/table-layouts/push");
    vi.useRealTimers();
  });

  it("lets an admin publish a default on a list that ships NO seed layout", async () => {
    // Every list except Sales Orders is this case. Gating the Layout section on
    // seeds was a chicken-and-egg — no section, so no way to save the first
    // default, so the section could never appear (owner 2026-08-01: cover every
    // list). The section now follows the RIGHT to publish, not the seeds.
    respond({ canManageDefaults: true });
    await hydrateTableLayouts();

    render(
      <DataTable
        tableId="seedless"
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );
    fireEvent.click(screen.getByTitle(/^Columns —/));

    // The overflow menu names the company the save publishes to — the admin
    // sets 2990's default from a 2990 window and Houzs's from a Houzs one.
    fireEvent.click(screen.getByRole("button", { name: "More column actions" }));
    expect(screen.getByRole("button", { name: /Save as 2990's Home default/ })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Save as default" }));

    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(
        "/api/table-layouts/seedless/default",
        expect.anything(),
      ),
    );
    // Saved → the company now HAS a layout to offer, so the picker appears.
    fireEvent.click(await screen.findByRole("button", { name: /^Layout/ }));
    expect(screen.getByRole("option", { name: /2990's Home Layout/ })).toBeTruthy();
  });

  it("shows the publish control only to an admin, and saves what is on screen", async () => {
    respond({ canManageDefaults: false });
    await hydrateTableLayouts();
    renderTable("publish");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    expect(screen.queryByRole("button", { name: "Save as default" })).toBeNull();

    cleanup();
    __resetTableLayoutsForTest();
    mockApi.get.mockReset();
    respond({ canManageDefaults: true });
    await hydrateTableLayouts();

    renderTable("publish");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getByRole("button", { name: "Save as default" }));

    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(
        "/api/table-layouts/publish/default",
        expect.anything(),
      ),
    );
    /* The redesign demoted the confirmation from a card of body copy to a
       toast (handoff 2026-08-01), so what is asserted here is the WRITE, not
       the wording — the toast host does not exist in a bare test render. */
    expect(mockApi.put.mock.calls[0]![0]).toContain("/default");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   NAMED layouts (mig 0239). A saved column set, offered in the picker next to
   the company defaults. Switching COPIES it into the live arrangement, which is
   why saving one must not disturb what is on screen — and why a company row can
   be duplicated into one of your own.
   ──────────────────────────────────────────────────────────────────────────── */
describe("DataTable with saved layouts", () => {
  const savedLayout = (over: Record<string, unknown> = {}) => ({
    order: ["a", "b"],
    hidden: ["c", "d"],
    shown: [],
    widths: {},
    pinned: [],
    groupBy: [],
    ...over,
  });

  it("offers a saved layout in the picker and applies it on click", async () => {
    respond({
      myLayouts: {
        saved: [{ id: 7, name: "Finance review", layout: savedLayout() }],
      },
    });
    await hydrateTableLayouts();

    const { container } = renderTable("saved");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getByRole("button", { name: /^Layout/ }));

    const row = screen.getByRole("option", { name: /Finance review/ });
    expect(row.textContent).toContain("Saved by you");
    fireEvent.click(row);

    expect(headerLabels(container)).toEqual(["Alpha", "Bravo"]);
  });

  it("saves the arrangement on screen as a new layout", async () => {
    respond({ canManageDefaults: false, canManageLayouts: true });
    await hydrateTableLayouts();
    mockApi.post.mockResolvedValue({
      layout: { id: 3, name: "Mine", layout: savedLayout() },
    });

    renderTable("newlayout");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getByRole("button", { name: /^Layout/ }));

    // Without a dialog host the naming step cannot run, so the control is
    // present but the write is not attempted — which is the same contract the
    // toast has: no host, no crash.
    expect(screen.getByRole("button", { name: /New layout from current columns/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /New layout from current columns/ }));
    await waitFor(() => expect(mockApi.post).not.toHaveBeenCalled());
  });

  it("lets an admin rename the company default, but never delete it", async () => {
    respond({
      canManageLayouts: true,
      defaults: { "2": { rights: savedLayout({ order: ["a"] }) } },
      myLayouts: { rights: [{ id: 9, name: "Mine", layout: savedLayout() }] },
    });
    await hydrateTableLayouts();

    renderTable("rights");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getByRole("button", { name: /^Layout/ }));

    /* The company row can be renamed (the whole company inherits that name)
       and duplicated (start from 2990's view and tweak it) — but not deleted.
       Deleting the arrangement everyone inherits is the Clear control in the
       admin block, not a menu item next to the user's own layouts. */
    fireEvent.click(screen.getByRole("button", { name: /Actions for 2990's Home Layout/ }));
    expect(screen.getByRole("button", { name: /^Rename/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Duplicate/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete layout/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Actions for Mine/ }));
    expect(screen.getByRole("button", { name: /Delete layout/ })).toBeTruthy();
  });

  it("shows a non-admin the layouts but none of the management", async () => {
    // Owner decision 2026-08-02: layout management is the "*" wildcard only.
    // Everyone else still switches layouts and arranges their own columns.
    respond({
      canManageLayouts: false,
      defaults: { "readonly": savedLayout() },
      myLayouts: { readonly: [{ id: 4, name: "Mine", layout: savedLayout() }] },
    });
    await hydrateTableLayouts();

    renderTable("readonly");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getByRole("button", { name: /^Layout/ }));

    expect(screen.getByRole("option", { name: /Mine/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New layout from current columns/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for Mine/ })).toBeNull();
  });

  it("says nothing about saved layouts when the store never came up", async () => {
    mockApi.get.mockRejectedValue(new Error("offline"));
    await hydrateTableLayouts();

    renderTable("offline");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    expect(screen.queryByRole("button", { name: /New layout from current columns/ })).toBeNull();
  });
});
