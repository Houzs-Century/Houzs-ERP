import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";
import {
  __resetTableLayoutsForTest,
  hydrateTableLayouts,
  type LayoutSeed,
  type StoredLayout,
} from "../lib/tableLayouts";
import { api } from "../api/client";

/* Full-layout page seeds on DataTable (the Delivery Planning board's four views,
   carried from the SCM DataGrid 2026-09-26): a manager's team-wide override
   wins over the code seed, one written while the board was a DataGrid is read
   through DataGrid's rules, and the board's key is NOT split per company. */

vi.mock("../api/client", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
const mockApi = api as unknown as Record<"get" | "post" | "patch" | "put" | "del", ReturnType<typeof vi.fn>>;

type Row = { id: number; name: string };
const columns: Column<Row>[] = [
  { key: "a", label: "Alpha", render: (r) => r.name },
  { key: "b", label: "Bravo", render: (r) => r.name },
  { key: "c", label: "Charlie", defaultHidden: true, render: (r) => r.name },
  { key: "d", label: "Delta", render: (r) => r.name },
];
const rows: Row[] = [{ id: 1, name: "One" }];
const L = (over: Partial<StoredLayout>): StoredLayout => ({
  order: [], hidden: [], shown: [], widths: {}, pinned: [], pinnedRight: [], groupBy: [], ...over,
});
const seeds: LayoutSeed[] = [{ id: "narrow", label: "Narrow View", layout: L({ order: ["a", "b", "d"], hidden: ["b", "d"] }) }];
const BOARD = "dg-delivery-planning-v2";

function respond(over: Record<string, unknown>) {
  mockApi.get.mockResolvedValue({
    companies: [{ id: 1, code: "HOUZS", name: "Houzs Century Sdn Bhd" }],
    activeCompanyId: 1,
    canManageDefaults: true,
    canManageLayouts: true,
    defaults: {},
    mine: {},
    myLayouts: {},
    sharedLayouts: {},
    ...over,
  });
}

const headers = () => screen.getAllByRole("columnheader").map((h) => String(h.textContent).trim());

async function pick(label: string) {
  fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /Layout/ }));
  fireEvent.click(await screen.findByText(label));
}

beforeEach(() => {
  localStorage.clear();
  __resetTableLayoutsForTest();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DataTable layout seeds", () => {
  it("applies the code seed when no one has overridden it", async () => {
    respond({});
    await hydrateTableLayouts();
    render(<DataTable tableId="seeded" columns={columns} rows={rows} getRowKey={(r) => r.id} layoutSeeds={seeds} />);
    await pick("Narrow View");
    await waitFor(() => expect(headers()).toEqual(["Alpha"]));
  });

  it("a manager's team-wide override wins over the code seed", async () => {
    respond({ sharedLayouts: { seeded: [{ id: 5, name: "narrow", layout: L({ order: ["d", "a"], hidden: ["b"] }) }] } });
    await hydrateTableLayouts();
    render(<DataTable tableId="seeded" columns={columns} rows={rows} getRowKey={(r) => r.id} layoutSeeds={seeds} />);
    await pick("Narrow View");
    await waitFor(() => expect(headers()).toEqual(["Delta", "Alpha"]));
  });

  it("reads an override saved while the board was a DataGrid through DataGrid's rules", async () => {
    // DataGrid: a non-empty hidden list means every other column shows,
    // defaultHidden Charlie included.
    respond({ sharedLayouts: { "dg:old-board": [{ id: 6, name: "narrow", layout: L({ order: ["a", "b", "c", "d"], hidden: ["d"] }) }] } });
    await hydrateTableLayouts();
    render(
      <DataTable tableId="seeded" legacyGridKey="old-board" columns={columns} rows={rows} getRowKey={(r) => r.id} layoutSeeds={seeds} />,
    );
    await pick("Narrow View");
    await waitFor(() => expect(headers()).toEqual(["Alpha", "Bravo", "Charlie"]));
  });

  it("Update writes the team-wide override under the table's own key", async () => {
    respond({});
    mockApi.put.mockResolvedValue({});
    await hydrateTableLayouts();
    render(<DataTable tableId="seeded" columns={columns} rows={rows} getRowKey={(r) => r.id} layoutSeeds={seeds} />);
    fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Layout/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Narrow View" }));
    fireEvent.click(await screen.findByText(/Update for everyone/i));
    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(
        "/api/table-layouts/seeded/shared",
        expect.objectContaining({ name: "narrow" }),
      ),
    );
  });
});

describe("a cross-company board keeps one layout", () => {
  it("stores its prefs unscoped by company", async () => {
    respond({});
    await hydrateTableLayouts();
    render(<DataTable tableId={BOARD} columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /^Bravo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Hide column" }));
    expect(JSON.parse(localStorage.getItem(`dt:hidden:${BOARD}`) ?? "[]")).toContain("b");
    expect(localStorage.getItem(`dt:hidden:c1:${BOARD}`)).toBeNull();
  });
});
