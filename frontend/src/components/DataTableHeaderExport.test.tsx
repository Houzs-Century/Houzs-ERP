/* Owner 2026-11-06: 「export 出来我觉得可以 right click export」 and 「支持pdf?」.
 * A header's right-click menu exports what the toolbar's Export exports: the same
 * rows, the same columns. A table that hands a PDF handler offers that too, with
 * the very cells the Excel would hold. And the sheet's widths fit what a column
 * holds: a width read off the heading alone cut every document number. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  aoa: [] as unknown[][],
  files: [] as string[],
  sheet: {} as Record<string, unknown>,
}));
vi.mock("../lib/xlsx-runtime", () => ({
  utils: {
    aoa_to_sheet: (aoa: unknown[][]) => {
      h.aoa = aoa;
      h.sheet = {};
      return h.sheet;
    },
    encode_cell: ({ r, c }: { r: number; c: number }) => `${c}:${r}`,
    book_new: () => ({}),
    book_append_sheet: () => {},
  },
  writeFileXLSX: (_wb: unknown, name: string) => { h.files.push(name); },
}));
vi.mock("../lib/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/csv")>();
  return { ...actual, downloadCSV: vi.fn() };
});

import { DataTable, type Column } from "./DataTable";
import { downloadCSV } from "../lib/csv";
import { fittedColumnWidths, writeLineExportFile, type TablePdfView } from "./dataTableLineExport";

type Row = { id: string; doc: string; amountSen: number; note: string };
const rows: Row[] = [
  { id: "a", doc: "HC-SO-1", amountSen: 370000, note: "first" },
  { id: "b", doc: "HC-SO-2", amountSen: 648800, note: "second" },
];
const columns: Column<Row>[] = [
  { key: "doc", label: "Document", render: (r) => r.doc, getValue: (r) => r.doc },
  {
    key: "amount", label: "Amount", align: "right", render: (r) => r.amountSen,
    getValue: (r) => r.amountSen, exportValue: (r) => r.amountSen / 100, exportFormat: "money",
  },
  { key: "note", label: "Note", render: (r) => r.note, getValue: (r) => r.note },
];

beforeEach(() => {
  localStorage.clear();
  h.aoa = [];
  h.files = [];
  vi.mocked(downloadCSV).mockClear();
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
afterEach(cleanup);

const menuOn = (name: RegExp) => fireEvent.contextMenu(screen.getByRole("columnheader", { name }));
const item = (name: string) => screen.getByRole("button", { name });

describe("the header's right-click export", () => {
  it("comes first in the menu, writes what the toolbar writes, and closes the menu", async () => {
    render(<DataTable tableId="hx-1" exportName="cards" exportXlsx columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    menuOn(/Document/);
    expect(item("Export to Excel").parentElement?.querySelector("button")?.textContent).toBe("Export to Excel");
    fireEvent.click(item("Export to Excel"));
    await waitFor(() => expect(h.files).toHaveLength(1));
    expect(h.files[0]).toMatch(/^cards-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(h.aoa).toEqual([["Document", "Amount", "Note"], ["HC-SO-1", 3700, "first"], ["HC-SO-2", 6488, "second"]]);
    expect(screen.queryByRole("button", { name: "Export to Excel" })).toBeNull();
  });

  it("a table that writes CSV says CSV", () => {
    render(<DataTable tableId="hx-2" exportName="cards" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    menuOn(/Document/);
    fireEvent.click(item("Export to CSV"));
    expect(downloadCSV).toHaveBeenCalledTimes(1);
  });

  it("a table with an export of its own keeps its own words and its own handler", () => {
    const own = vi.fn();
    render(<DataTable tableId="hx-3" exportLabel="Export all" onExport={own} columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    menuOn(/Document/);
    /* The toolbar's button says the same words; the menu's line is the later of the two. */
    const [, inTheMenu] = screen.getAllByRole("button", { name: "Export all" });
    fireEvent.click(inTheMenu!);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it("with rows ticked it says how many, and writes only those", async () => {
    render(
      <DataTable tableId="hx-4" exportName="cards" exportXlsx columns={columns} rows={rows} getRowKey={(r) => r.id}
        selection={{ selectedIds: new Set(["b"]), onToggle: () => {}, onToggleAll: () => {} }} />,
    );
    menuOn(/Document/);
    fireEvent.click(item("Export to Excel (1)"));
    await waitFor(() => expect(h.files).toHaveLength(1));
    expect(h.aoa).toEqual([["Document", "Amount", "Note"], ["HC-SO-2", 6488, "second"]]);
  });

  it("is greyed out while the table is still loading", () => {
    render(<DataTable tableId="hx-5" exportName="cards" exportXlsx loading columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    menuOn(/Document/);
    expect(item("Export to Excel").hasAttribute("disabled")).toBe(true);
  });

  it("offers no PDF on a table that did not ask for one", () => {
    render(<DataTable tableId="hx-6" exportName="cards" exportXlsx columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    menuOn(/Document/);
    expect(screen.queryByRole("button", { name: "Export to PDF" })).toBeNull();
  });

  it("hands the PDF the cells the Excel would hold, without a column the reader hid", () => {
    const pdf = vi.fn<(view: TablePdfView<Row>) => void>();
    render(<DataTable tableId="hx-7" exportName="cards" exportXlsx onExportPdf={pdf} columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    menuOn(/Note/);
    fireEvent.click(item("Hide column"));
    menuOn(/Document/);
    fireEvent.click(item("Export to PDF"));
    expect(pdf).toHaveBeenCalledTimes(1);
    const view = pdf.mock.calls[0]![0];
    expect(view.keys).toEqual(["doc", "amount"]);
    expect(view.matrix).toEqual({
      header: ["Document", "Amount"],
      formats: ["text", "money"],
      body: [["HC-SO-1", 3700], ["HC-SO-2", 6488]],
    });
    expect(view.rows).toEqual(rows);
    expect(screen.queryByRole("button", { name: "Export to PDF" })).toBeNull();
  });
});

describe("the sheet's column widths", () => {
  it("fit the longest thing in the column, not only its heading", () => {
    expect(fittedColumnWidths({
      header: ["Document", "Amount", "Paid on", "Days", "Note"],
      formats: ["text", "money", "date", "number", "text"],
      body: [
        ["HC-SO-2609-163", 1234567.5, "2026-08-01", 97, null],
        ["HC-SO-1", 1, "2026-08-02", 5, null],
      ],
    })).toEqual([16, 14, 12, 10, 10]);
  });

  it("a long heading still decides when the cells are short", () => {
    expect(fittedColumnWidths({ header: ["Customer paid on"], formats: ["date"], body: [["2026-08-01"]] })).toEqual([18]);
  });

  it("a Chinese character takes two cells' width", () => {
    expect(fittedColumnWidths({ header: ["M"], formats: ["text"], body: [["未标未标未标未标"]] })).toEqual([18]);
  });

  it("stops at 42, and a column is never narrower than 10", () => {
    expect(fittedColumnWidths({ header: ["A", "B"], formats: ["text", "text"], body: [["x".repeat(90), "y"]] })).toEqual([42, 10]);
  });

  it("the written file carries them", async () => {
    await writeLineExportFile(
      { header: ["Document"], formats: ["text"], body: [["HC-SO-2609-163"]] }, "Sheet1", "x.xlsx",
    );
    expect(h.sheet["!cols"]).toEqual([{ wch: 16 }]);
  });
});
