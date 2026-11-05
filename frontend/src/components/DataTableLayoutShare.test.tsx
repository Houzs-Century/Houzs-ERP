import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";
import {
  __resetTableLayoutsForTest,
  hydrateTableLayouts,
  type StoredLayout,
} from "../lib/tableLayouts";
import { DialogProvider } from "../hooks/useDialog";
import { api } from "../api/client";

/* Team-published layouts (is_shared, not a code seed): a layout manager shares a
   personal layout under its own name, after which EVERY member sees it as a
   pickable row, and the manager can update it for everyone or stop sharing it. */

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

async function openLayoutMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /Layout/ }));
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
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

describe("DataTable team-published layouts", () => {
  it("shows a shared layout to a member who cannot manage layouts, and applies its columns", async () => {
    respond({
      canManageLayouts: false,
      sharedLayouts: { seeded: [{ id: 7, name: "Overdue View", layout: L({ order: ["d", "a"], hidden: ["b"] }) }] },
    });
    await hydrateTableLayouts();
    render(<DataTable tableId="seeded" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Layout/ }));
    fireEvent.click(await screen.findByText("Overdue View"));
    await waitFor(() => expect(headers()).toEqual(["Delta", "Alpha"]));
  });

  it("a member cannot edit a shared layout (no actions menu)", async () => {
    respond({
      canManageLayouts: false,
      sharedLayouts: { seeded: [{ id: 7, name: "Overdue View", layout: L({ hidden: ["b"] }) }] },
    });
    await hydrateTableLayouts();
    render(<DataTable tableId="seeded" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Layout/ }));
    await screen.findByText("Overdue View");
    expect(screen.queryByRole("button", { name: "Actions for Overdue View" })).toBeNull();
  });

  it("Share to team publishes a personal layout to the whole company under its own name", async () => {
    respond({
      myLayouts: { seeded: [{ id: 9, name: "Overdue View", layout: L({ order: ["a", "d"], hidden: ["b"] }) }] },
    });
    mockApi.put.mockResolvedValue({});
    await hydrateTableLayouts();
    render(<DataTable tableId="seeded" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    await openLayoutMenu("Overdue View");
    fireEvent.click(await screen.findByText(/Share to team/i));
    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(
        "/api/table-layouts/seeded/shared",
        expect.objectContaining({ name: "Overdue View" }),
      ),
    );
  });

  it("Stop sharing drops the team-wide layout", async () => {
    respond({
      sharedLayouts: { seeded: [{ id: 7, name: "Overdue View", layout: L({ hidden: ["b"] }) }] },
    });
    mockApi.del.mockResolvedValue({});
    await hydrateTableLayouts();
    render(
      <DialogProvider>
        <DataTable tableId="seeded" columns={columns} rows={rows} getRowKey={(r) => r.id} />
      </DialogProvider>,
    );
    await openLayoutMenu("Overdue View");
    fireEvent.click(await screen.findByText(/Stop sharing/i));
    // The menu item and the confirm button share the label; the dialog's button
    // is portalled last, so confirm via the final match.
    const confirm = await screen.findAllByRole("button", { name: /Stop sharing/i });
    fireEvent.click(confirm[confirm.length - 1]!);
    await waitFor(() =>
      expect(mockApi.del).toHaveBeenCalledWith("/api/table-layouts/seeded/shared/Overdue%20View"),
    );
  });
});
