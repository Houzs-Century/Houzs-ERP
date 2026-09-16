/* DataTable's line export (owner 2026-09-15): one row per LINE over every row the
 * server matched, with the grid's VISIBLE columns in on-screen order, under the
 * grid's labels, after the grid's own funnel filter and sort.
 *
 * The matrix is tested as a function; the wiring is tested on the real
 * DataTable, with the sheet writer mocked so the written matrix can be read. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { primeInVisitColFilters, resetInVisitColFilters } from "./dataTableColFilterMemory";

const h = vi.hoisted(() => ({
  aoa: [] as unknown[][],
  files: [] as string[],
  cells: {} as Record<string, unknown>,
}));
vi.mock("../lib/xlsx-runtime", () => ({
  utils: {
    aoa_to_sheet: (aoa: unknown[][]) => {
      h.aoa = aoa;
      const ws: Record<string, unknown> = {};
      aoa.forEach((row, r) => row.forEach((v, c) => {
        if (v === null || v === undefined) return;
        ws[`${c}:${r}`] = { t: typeof v === "number" ? "n" : "s", v };
      }));
      h.cells = ws;
      return ws;
    },
    encode_cell: ({ r, c }: { r: number; c: number }) => `${c}:${r}`,
    book_new: () => ({}),
    book_append_sheet: () => {},
  },
  writeFileXLSX: (_wb: unknown, name: string) => { h.files.push(name); },
}));

import { DataTable, type Column } from "./DataTable";
import { applyColumnFilters, sortTableRows } from "./dataTableRows";
import { buildLineExportMatrix, excelDaySerial, type LineExportColumn } from "./dataTableLineExport";

type Line = { code: string; qty: number; due: string | null };
type Doc = { id: string; no: string; status: string; totalSen: number; lines: Line[] };

const docs: Doc[] = [
  { id: "a", no: "PO-1", status: "Open", totalSen: 1_500_000, lines: [{ code: "X-1", qty: 2, due: "2026-09-20" }, { code: "X-2", qty: 1, due: null }] },
  { id: "b", no: "PO-2", status: "Closed", totalSen: 5_000, lines: [{ code: "Y-1", qty: 4, due: "2026-10-01" }] },
  { id: "c", no: "PO-3", status: "Open", totalSen: 0, lines: [] },
];

const columns: Column<Doc, Line>[] = [
  { key: "no", label: "Doc No", render: (d) => d.no, getValue: (d) => d.no },
  {
    key: "code", label: "Item Code", render: (d) => d.lines[0]?.code ?? "",
    getValue: (d) => d.lines[0]?.code ?? "",
    getFilterValues: (d) => d.lines.map((l) => l.code),
    lineValue: (_d, l) => l.code,
  },
  { key: "qty", label: "Qty", render: () => "", getValue: () => 0, lineValue: (_d, l) => l.qty, exportFormat: "number" },
  { key: "due", label: "Delivery Date", render: () => "", getValue: () => "", lineValue: (_d, l) => l.due, exportFormat: "date" },
  { key: "status", label: "Status", render: (d) => d.status, getValue: (d) => d.status },
  { key: "total", label: "Total", render: (d) => d.totalSen, getValue: (d) => d.totalSen, exportValue: (d) => d.totalSen / 100, exportFormat: "money" },
  { key: "note", label: "Not exportable", render: () => "x" },
];

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetInVisitColFilters();
  h.aoa = [];
  h.files = [];
});

describe("buildLineExportMatrix", () => {
  it("writes one row per line, repeats document values, and gives a line-less document one row", () => {
    const m = buildLineExportMatrix(docs, (d) => d.lines, columns as LineExportColumn<Doc, Line>[]);
    expect(m.header).toEqual(["Doc No", "Item Code", "Qty", "Delivery Date", "Status", "Total"]);
    expect(m.formats).toEqual(["text", "text", "number", "date", "text", "money"]);
    expect(m.body).toEqual([
      ["PO-1", "X-1", 2, "2026-09-20", "Open", 15000],
      ["PO-1", "X-2", 1, null, "Open", 15000],
      ["PO-2", "Y-1", 4, "2026-10-01", "Closed", 50],
      ["PO-3", null, null, null, "Open", 0],
    ]);
  });

  it("an Excel date serial is timezone-free", () => {
    expect(excelDaySerial("2026-09-20")).toBe(46285);
    expect(excelDaySerial("1900-03-01")).toBe(61);
    expect(excelDaySerial("not a date")).toBeNull();
  });
});

describe("applyColumnFilters / sortTableRows — the grid's own rules", () => {
  it("a multi-value funnel keeps a document when ANY line matches", () => {
    const kept = applyColumnFilters(docs, { code: ["X-2"] }, columns);
    expect(kept.map((d) => d.id)).toEqual(["a"]);
  });

  it("a server-sorted column is left in server order; a disableSort column sorts here", () => {
    expect(sortTableRows(docs, { key: "no", dir: "desc" }, columns, true).map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(sortTableRows(docs, { key: "no", dir: "desc" }, columns, false).map((d) => d.id)).toEqual(["c", "b", "a"]);
  });
});

describe("the grid keeps its rows' identity when nothing filters or sorts", () => {
  /* Found by CI 2026-09-15 (run 34947720029): a copy per call made DataTable
     report a NEW rows array on every render, and a parent that stores that
     report and re-renders with freshly built columns (the list pages do both)
     looped — every frontend test shard hung. */
  it("returns the same array for no funnel and no sort", () => {
    expect(applyColumnFilters(docs, {}, columns)).toBe(docs);
    expect(sortTableRows(docs, null, columns, false)).toBe(docs);
    expect(sortTableRows(docs, { key: "no", dir: "asc" }, columns, true)).toBe(docs);
  });

  it("a parent that stores the reported rows and rebuilds its columns settles", () => {
    function Parent() {
      const [seen, setSeen] = useState<Doc[]>([]);
      const cols = columns.map((c) => ({ ...c }));
      return (
        <>
          <span data-testid="seen">{seen.length}</span>
          <DataTable<Doc, Line> tableId="loop-guard" rows={docs} columns={cols} getRowKey={(d) => d.id} onFilteredRowsChange={setSeen} />
        </>
      );
    }
    render(<Parent />);
    expect(screen.getByTestId("seen").textContent).toBe("3");
  });
});

describe("DataTable exportLines", () => {
  it("exports every fetched row through the stored funnel, with only the visible columns", async () => {
    // The page holds ONE row; the server set holds three. An in-visit funnel keeps Open.
    primeInVisitColFilters("docs-export", { status: ["Open"] });
    localStorage.setItem("dt:hidden:docs-export", JSON.stringify(["due"]));
    const fetchRows = vi.fn(async () => docs);
    const onError = vi.fn();
    render(
      <DataTable<Doc, Line>
        tableId="docs-export"
        rows={[docs[0]!]}
        columns={columns}
        getRowKey={(d) => d.id}
        exportName="purchase-orders"
        exportLines={{ fetchRows, linesOf: (d) => d.lines, sheetName: "Docs", onError }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.files).toHaveLength(1));
    expect(onError).not.toHaveBeenCalled();
    expect(fetchRows).toHaveBeenCalledWith({
      exportKeys: ["no", "code", "qty", "status", "total"],
      filterKeys: ["status"],
    });
    expect(h.aoa).toEqual([
      ["Doc No", "Item Code", "Qty", "Status", "Total"],
      ["PO-1", "X-1", 2, "Open", 15000],
      ["PO-1", "X-2", 1, "Open", 15000],
      ["PO-3", null, null, "Open", 0],
    ]);
    expect(h.files[0]).toMatch(/^purchase-orders-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("formats a money cell as #,##0.00 and a date cell as a yyyy/mm/dd date serial", async () => {
    render(
      <DataTable<Doc, Line>
        tableId="docs-formats"
        rows={docs}
        columns={columns}
        getRowKey={(d) => d.id}
        exportLines={{ fetchRows: async () => [docs[1]!], linesOf: (d) => d.lines, sheetName: "Docs", onError: vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.files).toHaveLength(1));
    // columns: 0 Doc No, 1 Item Code, 2 Qty, 3 Delivery Date, 4 Status, 5 Total; row 1 = first data row
    expect(h.cells["3:1"]).toEqual({ t: "n", v: 46296, z: "yyyy/mm/dd" });
    expect(h.cells["5:1"]).toMatchObject({ t: "n", v: 50, z: "#,##0.00" });
  });

  it("a refused fetch reaches onError and writes no file", async () => {
    const onError = vi.fn();
    render(
      <DataTable<Doc, Line>
        tableId="docs-refused"
        rows={docs}
        columns={columns}
        getRowKey={(d) => d.id}
        exportLines={{ fetchRows: async () => { throw new Error("too many"); }, linesOf: (d) => d.lines, sheetName: "Docs", onError }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(h.files).toHaveLength(0);
  });
});
