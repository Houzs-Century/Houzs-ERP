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
  api: { get: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
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

    // 2990 has no saved default yet, so its SEED fills the slot — but the row
    // is still that company's, labelled and marked as this window's default.
    const houzs = screen.getByRole("button", { name: /Houzs Century Layout/ });
    const home = screen.getByRole("button", { name: /2990's Home Layout/ });
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
    fireEvent.click(screen.getByTitle("Reset order and visibility"));
    await vi.runAllTimersAsync();
    expect(mockApi.del).toHaveBeenCalledWith("/api/table-layouts/push");
    vi.useRealTimers();
  });

  it("shows the publish control only to an admin, and saves what is on screen", async () => {
    respond({ canManageDefaults: false });
    await hydrateTableLayouts();
    renderTable("publish");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    expect(screen.queryByText(/Save current columns as default/)).toBeNull();

    cleanup();
    __resetTableLayoutsForTest();
    mockApi.get.mockReset();
    respond({ canManageDefaults: true });
    await hydrateTableLayouts();

    renderTable("publish");
    fireEvent.click(screen.getByTitle(/^Columns —/));
    // Named after the company it publishes to — the admin sets 2990's default
    // from a 2990 window and Houzs's from a Houzs one.
    expect(screen.getByText("2990's Home default")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Save current columns as default/ }));

    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(
        "/api/table-layouts/publish/default",
        expect.anything(),
      ),
    );
    expect(await screen.findByText(/New users of this company start here/)).toBeTruthy();
  });
});
