/* The Sales Order and Delivery Order lists' export wiring (owner 2026-09-15):
 * "Export lines" writes the line sheet for the list's CURRENT filter, the
 * toolbar Export writes every document with the grid's visible columns, a
 * failure reaches the person as a notice (never a silent nothing), and the two
 * list screens actually pass these to their header and grid.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({
  notify: vi.fn(async (..._a: unknown[]) => {}),
  csv: [] as Array<{ name: string; text: string }>,
  soLines: vi.fn(async (..._a: unknown[]) => ({ columns: [], rows: [], lineCount: 0, truncated: false })),
  doLines: vi.fn(async (..._a: unknown[]) => ({ columns: [], rows: [], lineCount: 0, truncated: false })),
  soRows: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => [{ doc_no: "SO-1", status: "CONFIRMED" }]),
  doRows: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => [{ id: "do-1", status: "LOADED" }]),
  writeSo: vi.fn(async (..._a: unknown[]) => {}),
  writeDo: vi.fn(async (..._a: unknown[]) => {}),
}));

vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));
vi.mock("../../lib/csv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/csv")>()),
  downloadCSV: (name: string, text: string) => { h.csv.push({ name, text }); },
}));
vi.mock("../../vendor/scm/lib/sales-list-export", () => ({
  fetchSoLineExport: h.soLines,
  fetchDoLineExport: h.doLines,
  fetchAllSoListRows: h.soRows,
  fetchAllDoListRows: h.doRows,
  writeSoLineExportXlsx: h.writeSo,
  writeDoLineExportXlsx: h.writeDo,
}));

import { useDoListExports, useSoListExports } from "./use-sales-list-exports";

beforeEach(() => {
  vi.clearAllMocks();
  h.csv = [];
});

const soFilters = { status: "confirmed", q: "alice", sort: "doc_no:asc", filters: [{ field: "state" as const, op: "is" as const, value: "SELANGOR" }] };

describe("the Sales Order list exports", () => {
  it("Export lines reads the line export for the list's filter and writes the sheet", async () => {
    const { result } = renderHook(() => useSoListExports(soFilters));
    expect(result.current.linesAction.label).toBe("Export lines");
    await act(async () => { result.current.linesAction.onClick(); });
    expect(h.soLines).toHaveBeenCalledWith(soFilters);
    expect(h.writeSo).toHaveBeenCalledTimes(1);
    expect(String(h.writeSo.mock.calls[0]![1])).toMatch(/^sales-order-lines-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("the toolbar Export writes every row with the visible columns, healing MRP columns only when one is shown", async () => {
    const { result } = renderHook(() => useSoListExports<{ doc_no: string; status: string }>(soFilters));
    await act(async () => { result.current.exportHeaders([{ key: "doc_no", label: "Doc No.", getValue: (r) => r.doc_no }]); });
    expect(h.soRows).toHaveBeenLastCalledWith(soFilters, false);
    expect(h.csv[0]!.text).toContain("SO-1");
    await act(async () => { result.current.exportHeaders([{ key: "stock_status", label: "Stock Status", getValue: () => "" }]); });
    expect(h.soRows).toHaveBeenLastCalledWith(soFilters, true);
  });

  it("a failed export reaches the person as a notice", async () => {
    h.soLines.mockRejectedValueOnce(new Error("More sales orders match these filters than one export can hold"));
    const { result } = renderHook(() => useSoListExports(soFilters));
    await act(async () => { result.current.linesAction.onClick(); });
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Export lines failed", tone: "error" }));
    expect(h.writeSo).not.toHaveBeenCalled();
  });
});

describe("the Delivery Order list exports", () => {
  it("Export lines and the toolbar Export read the list's filter", async () => {
    const f = { status: "delivered", q: "bob", sort: undefined };
    const { result } = renderHook(() => useDoListExports<{ id: string }>(f));
    await act(async () => { result.current.linesAction.onClick(); });
    expect(h.doLines).toHaveBeenCalledWith(f);
    expect(h.writeDo).toHaveBeenCalledTimes(1);
    await act(async () => { result.current.exportHeaders([{ key: "id", label: "Id", getValue: (r) => r.id }]); });
    expect(h.doRows).toHaveBeenCalledWith(f);
    expect(h.csv[0]!.name).toMatch(/^delivery-orders-/);
  });
});

describe("the two list screens are wired to it", () => {
  const page = (name: string) => readFileSync(resolve(process.cwd(), `src/pages/scm-v2/${name}`), "utf8");

  it("Sales Orders: the header carries Export lines, the grid Export reads every page, the status column prints the pill word", () => {
    const src = page("MfgSalesOrdersListV2.tsx");
    expect(src).toContain("useSoListExports<SoRow>({ status, q: debouncedSearch, sort, filters: soFilters })");
    expect(src).toContain("soExports.linesAction,");
    expect(src).toContain("onExport={soExports.exportHeaders}");
    expect(src).toContain("getValue: (r) => soListStatusWord(r.status, r.delivery_state ?? null, r.lifecycle_state ?? null, rowIsHeld(r))");
  });

  it("Delivery Orders: the same, with the tab it is on", () => {
    const src = page("MfgDeliveryOrdersListV2.tsx");
    expect(src).toContain("useDoListExports<DoRow>({ status: apiStatus, q: debouncedSearch, sort })");
    expect(src).toContain("doExports.linesAction,");
    expect(src).toContain("onExport={doExports.exportHeaders}");
    expect(src).toContain("getValue: (r) => doStatusWord(r.status, rowIsHeld(r))");
  });
});
