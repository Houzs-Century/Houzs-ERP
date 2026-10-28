import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_LAYOUT,
  __resetTableLayoutsForTest,
  getTableLayoutsSnapshot,
  hydrateTableLayouts,
  saveCompanyDefault,
  saveMyLayout,
  serializeLayout,
  type StoredLayout,
} from "./tableLayouts";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: { get: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

const TABLE = "sales-orders-v2";

const layout = (over: Partial<StoredLayout> = {}): StoredLayout => ({
  order: ["so_date", "status"],
  hidden: ["reference"],
  shown: [],
  widths: {},
  pinned: [],
  pinnedRight: [],
  groupBy: [],
  ...over,
});

function respond(over: Record<string, unknown> = {}) {
  mockApi.get.mockResolvedValue({
    companies: [{ id: 2, code: "2990", name: "2990's Home" }],
    activeCompanyId: 2,
    canManageDefaults: false,
    defaults: {},
    mine: {},
    ...over,
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  mockApi.get.mockReset();
  mockApi.put.mockReset().mockResolvedValue({ ok: true });
  mockApi.del.mockReset().mockResolvedValue({ ok: true });
  __resetTableLayoutsForTest();
});

afterEach(() => {
  vi.useRealTimers();
  __resetTableLayoutsForTest();
});

describe("table layout sync", () => {
  it("adopts the account's saved layout into the keys the table reads", async () => {
    respond({ mine: { [TABLE]: { layout: layout(), updatedAt: null } } });

    await hydrateTableLayouts();

    // Same keys DataTable reads at mount — that is what makes a machine this
    // user has never arranged render their columns on the first paint.
    expect(JSON.parse(localStorage.getItem(`dt:order:${TABLE}`)!)).toEqual(["so_date", "status"]);
    expect(JSON.parse(localStorage.getItem(`dt:hidden:${TABLE}`)!)).toEqual(["reference"]);
    // The epoch moved, so a table already on screen remounts and re-reads.
    expect(getTableLayoutsSnapshot().epoch).toBe(1);
  });

  it("leaves the epoch alone when the account agrees with this browser", async () => {
    localStorage.setItem(`dt:order:${TABLE}`, JSON.stringify(["so_date", "status"]));
    localStorage.setItem(`dt:hidden:${TABLE}`, JSON.stringify(["reference"]));
    respond({ mine: { [TABLE]: { layout: layout(), updatedAt: null } } });

    await hydrateTableLayouts();

    // Nothing changed, so no table is remounted — the warm-load no-op.
    expect(getTableLayoutsSnapshot().epoch).toBe(0);
  });

  it("keeps local edits the server never received, and re-pushes them", async () => {
    // A push that failed (offline) leaves the marker behind the local value.
    localStorage.setItem(`dt:order:${TABLE}`, JSON.stringify(["unpushed"]));
    localStorage.setItem(`dt:sync:${TABLE}`, serializeLayout(layout({ order: ["older"] })));
    respond({ mine: { [TABLE]: { layout: layout({ order: ["from_server"] }), updatedAt: null } } });

    await hydrateTableLayouts();

    expect(JSON.parse(localStorage.getItem(`dt:order:${TABLE}`)!)).toEqual(["unpushed"]);
    await vi.runAllTimersAsync();
    expect(mockApi.put).toHaveBeenCalledWith(
      `/api/table-layouts/${TABLE}`,
      expect.objectContaining({ layout: expect.objectContaining({ order: ["unpushed"] }) }),
    );
  });

  it("stays inert until hydration succeeds, so a save can never fire first", async () => {
    saveMyLayout(TABLE, layout());
    await vi.runAllTimersAsync();
    expect(mockApi.put).not.toHaveBeenCalled();

    mockApi.get.mockRejectedValue(new Error("offline"));
    await hydrateTableLayouts();
    saveMyLayout(TABLE, layout());
    await vi.runAllTimersAsync();
    // A failed boot fetch leaves the module inert rather than half-live.
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(getTableLayoutsSnapshot().ready).toBe(false);
  });

  it("debounces a burst of changes into one request", async () => {
    respond();
    await hydrateTableLayouts();

    saveMyLayout(TABLE, layout({ order: ["a"] }));
    saveMyLayout(TABLE, layout({ order: ["a", "b"] }));
    saveMyLayout(TABLE, layout({ order: ["a", "b", "c"] }));
    await vi.runAllTimersAsync();

    expect(mockApi.put).toHaveBeenCalledTimes(1);
    expect(mockApi.put.mock.calls[0]![1]).toEqual({
      layout: expect.objectContaining({ order: ["a", "b", "c"] }),
    });
  });

  it("sends a reset as a DELETE, so it survives the next hydration", async () => {
    respond();
    await hydrateTableLayouts();

    saveMyLayout(TABLE, EMPTY_LAYOUT);
    await vi.runAllTimersAsync();

    // An empty row would hydrate as "saved, but empty" — indistinguishable from
    // untouched only by accident. Deleting says it once, unambiguously.
    expect(mockApi.del).toHaveBeenCalledWith(`/api/table-layouts/${TABLE}`);
    expect(mockApi.put).not.toHaveBeenCalled();
  });

  it("reflects a saved company default locally so the panel updates at once", async () => {
    respond({ canManageDefaults: true });
    await hydrateTableLayouts();

    await saveCompanyDefault(TABLE, layout({ order: ["company_view"] }));

    expect(mockApi.put).toHaveBeenCalledWith(
      `/api/table-layouts/${TABLE}/default`,
      expect.anything(),
    );
    expect(getTableLayoutsSnapshot().defaults["2"]?.[TABLE]?.order).toEqual(["company_view"]);

    await saveCompanyDefault(TABLE, EMPTY_LAYOUT);
    expect(mockApi.del).toHaveBeenCalledWith(`/api/table-layouts/${TABLE}/default`);
    expect(getTableLayoutsSnapshot().defaults["2"]?.[TABLE]).toBeUndefined();
  });
});
