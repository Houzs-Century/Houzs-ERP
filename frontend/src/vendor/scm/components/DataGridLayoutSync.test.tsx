import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DataGrid, type DataGridColumn } from "./DataGrid";
import {
  __resetTableLayoutsForTest,
  hydrateTableLayouts,
} from "../../../lib/tableLayouts";
import { api } from "../../../api/client";

/* ────────────────────────────────────────────────────────────────────────────
   Vendored SCM DataGrid × server-stored layouts.

   Thirty lists still run on this grid, and it persists columns in a completely
   different localStorage shape from DataTable — one JSON blob under
   `<storageKey>::c<company>` rather than five `dt:<part>:<key>` entries. The
   store keeps them apart by namespacing this grid's rows `dg:<storageKey>`;
   what these tests pin is that the two shapes never cross, that a company
   default reaches an untouched grid, and that an admin can publish one from
   the grid's own drawer (owner 2026-08-01: 覆盖到系统的所有列表).
   ──────────────────────────────────────────────────────────────────────────── */

vi.mock("../../../api/client", () => ({
  api: { get: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

type Row = { id: string; name: string; city: string };

const rows: Row[] = [{ id: "1", name: "Alpha", city: "KL" }];
const columns: DataGridColumn<Row>[] = [
  { key: "name", label: "Name", accessor: (r) => r.name },
  { key: "city", label: "City", accessor: (r) => r.city },
];

const STORAGE_KEY = "dg-suppliers";
const SERVER_KEY = "dg:dg-suppliers";

const emptyish = { order: [], hidden: [], shown: [], widths: {}, pinned: [], groupBy: [] };

function respond(over: Record<string, unknown> = {}) {
  mockApi.get.mockResolvedValue({
    companies: [
      { id: 1, code: "HOUZS", name: "Houzs Century Sdn Bhd" },
      { id: 2, code: "2990", name: "2990's Home" },
    ],
    activeCompanyId: 2,
    canManageDefaults: false,
    defaults: {},
    mine: {},
    ...over,
  });
}

const headers = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("thead th"))
    .map((th) => th.textContent?.trim())
    .filter((t): t is string => Boolean(t));

const renderGrid = () =>
  render(
    <DataGrid rows={rows} columns={columns} storageKey={STORAGE_KEY} rowKey={(r) => r.id} />,
  );

beforeEach(() => {
  localStorage.clear();
  mockApi.get.mockReset();
  mockApi.put.mockReset().mockResolvedValue({ ok: true });
  mockApi.del.mockReset().mockResolvedValue({ ok: true });
  __resetTableLayoutsForTest();
});

afterEach(() => {
  cleanup();
  __resetTableLayoutsForTest();
  vi.restoreAllMocks();
});

describe("DataGrid with server layouts", () => {
  it("hydrates into the GRID's storage shape, never the table's", async () => {
    respond({
      mine: {
        [SERVER_KEY]: {
          layout: { ...emptyish, order: ["city", "name"], hidden: ["name"] },
          updatedAt: null,
        },
      },
    });

    await hydrateTableLayouts();

    // The grid reads one versioned blob under its own key…
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toMatchObject({
      version: 1,
      layout: { order: ["city", "name"], hidden: ["name"] },
    });
    // …and nothing was written in the DataTable shape under a dg key.
    expect(localStorage.getItem(`dt:order:${SERVER_KEY}`)).toBeNull();
  });

  it("starts an untouched grid on the company default", async () => {
    respond({
      defaults: { "2": { [SERVER_KEY]: { ...emptyish, order: ["city", "name"], hidden: ["name"] } } },
    });
    await hydrateTableLayouts();

    const { container } = renderGrid();
    expect(headers(container)).toEqual(["City"]);
  });

  it("leaves a grid alone once the user has arranged it", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, layout: { order: [], hidden: ["city"], widths: {}, groupBy: [], pinned: [], sort: null } }),
    );
    respond({
      defaults: { "2": { [SERVER_KEY]: { ...emptyish, order: ["city"], hidden: ["name"] } } },
    });
    await hydrateTableLayouts();

    const { container } = renderGrid();
    // Their own choice (City hidden) stands; the default is not imposed.
    expect(headers(container)).toEqual(["Name"]);
  });

  it("publishes the arrangement on screen as this company's default", async () => {
    respond({ canManageDefaults: true });
    await hydrateTableLayouts();

    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /Columns/i }));
    /* Same drawer the DataTable lists use now (owner 2026-08-02: 需要应用到全
       系统 column panel), so the control is the footer's, not a card's. */
    fireEvent.click(screen.getByRole("button", { name: "Save as default" }));

    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(
        // The key is URL-encoded on the wire; Hono decodes it back.
        `/api/table-layouts/${encodeURIComponent(SERVER_KEY)}/default`,
        expect.objectContaining({
          // What is on screen, materialised — not the empty stored value.
          layout: expect.objectContaining({ order: ["name", "city"] }),
        }),
      ),
    );
  });

  it("says nothing about layouts when the store never came up", async () => {
    // Offline / pre-deploy: the grid must look exactly as it always did.
    mockApi.get.mockRejectedValue(new Error("offline"));
    await hydrateTableLayouts();

    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /Columns/i }));
    expect(screen.queryByRole("button", { name: "Save as default" })).toBeNull();
    expect(screen.queryByText("Layout")).toBeNull();
  });
});

/* The vendored grid now mounts the SAME drawer as every DataTable list (owner
   2026-08-02: 需要应用到全系统 column panel). What that buys these 30 pages is
   worth pinning: the drawer's own affordances, on this grid's layout state. */
describe("DataGrid on the shared columns drawer", () => {
  it("searches, groups and edits width — the grid's own drawer had none of it", async () => {
    respond();
    await hydrateTableLayouts();
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /Columns/i }));

    // Scoped to the drawer: the grid's own header sort buttons carry the same
    // column names.
    const drawer = within(screen.getByRole("dialog", { name: "Columns" }));
    fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "cit" } });
    expect(drawer.getByRole("button", { name: "City" })).toBeTruthy();
    expect(drawer.queryByRole("button", { name: "Name" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "" } });

    // A toggle still lands on the grid immediately.
    fireEvent.click(drawer.getByRole("button", { name: "City" }));
    expect(headers(document.body as HTMLElement)).toEqual(["Name"]);
  });

  it("keeps the drawer free of management for a non-admin", async () => {
    respond({ canManageLayouts: false, myLayouts: { [SERVER_KEY]: [{ id: 2, name: "Ops", layout: { ...emptyish } }] } });
    await hydrateTableLayouts();
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /Columns/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Layout/ }));

    expect(screen.getByRole("option", { name: /Ops/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New layout from current columns/ })).toBeNull();
  });
});
