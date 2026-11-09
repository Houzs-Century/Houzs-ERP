import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataGridCompat, gridColumnToTableColumn, type GridColumn } from "./DataGridCompat";
import { writeLineExportFile, type TablePdfView } from "./dataTableLineExport";

vi.mock("./dataTableLineExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dataTableLineExport")>();
  return { ...actual, writeLineExportFile: vi.fn(() => Promise.resolve()) };
});

type Row = { id: string; code: string; amount: number; date: string };
const rows: Row[] = [
  { id: "1", code: "PO-2", amount: 1200.5, date: "2026/09/02" },
  { id: "2", code: "PO-10", amount: 80, date: "2026/09/01" },
];

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
});
afterEach(() => {
  cleanup();
  vi.mocked(writeLineExportFile).mockClear();
});

describe("gridColumnToTableColumn keeps DataGrid's value rules", () => {
  it("funnels on filterValue, sorts on sortFn, exports exportValue with dates as ISO", () => {
    const c: GridColumn<Row> = {
      key: "code", label: "Doc", accessor: (r) => r.code,
      filterValue: (r) => r.code.toLowerCase(),
      sortFn: (a, b) => Number(a.code.slice(3)) - Number(b.code.slice(3)),
      exportValue: (r) => r.date,
    };
    const t = gridColumnToTableColumn(c);
    expect(t.getValue?.(rows[0])).toBe("po-2");
    expect(t.sortCompare?.(rows[0], rows[1])).toBeLessThan(0);
    expect(t.exportValue?.(rows[0])).toBe("2026-09-02");
  });

  it("an unsortable grid column stays unsortable", () => {
    const t = gridColumnToTableColumn<Row>({ key: "x", label: "X", accessor: () => "x", sortable: false });
    expect(t.sortCompare).toBeUndefined();
    expect(t.disableSort).toBe(true);
  });

  it("falls back to a numeric-aware compare of the cell text", () => {
    const t = gridColumnToTableColumn<Row>({ key: "amount", label: "Amount", accessor: (r) => r.amount });
    expect(t.sortCompare?.(rows[1], rows[0])).toBeLessThan(0);
  });

  it("carries a column's footer total, and adds none where the page gave none", () => {
    const total = (shown: Row[]) => shown.length;
    expect(gridColumnToTableColumn<Row>({ key: "amount", label: "Amount", accessor: (r) => r.amount, total }).total).toBe(total);
    expect("total" in gridColumnToTableColumn<Row>({ key: "amount", label: "Amount", accessor: (r) => r.amount })).toBe(false);
  });
});

/* The PV list's Total and its header print (owner 2026-11-09: 「表格最下面的总数（Total）-
   payment voucher 可以加」, 「我filter 了，right click header print 不行？」) ride through here. */
describe("DataGridCompat's footer total and header PDF", () => {
  const money: GridColumn<Row>[] = [
    { key: "code", label: "Doc", accessor: (r) => r.code },
    {
      key: "amount", label: "Amount", accessor: (r) => r.amount.toFixed(2), exportValue: (r) => r.amount, exportFormat: "money",
      total: (shown) => `Sum ${shown.reduce((s, r) => s + r.amount, 0).toFixed(2)}`,
    },
  ];

  it("draws a column's total under the rows showing", () => {
    render(<DataGridCompat rows={rows} columns={money} storageKey="dg-total" rowKey={(r) => r.id} groupBanner={false} />);
    expect(screen.getByText("Sum 1280.50")).toBeTruthy();
    expect(screen.getByText("Total · 2 rows")).toBeTruthy();
  });

  it("prints from the header's right-click when the page prints, handed the rows showing", () => {
    const pdf = vi.fn<(view: TablePdfView<Row>) => void>();
    render(<DataGridCompat rows={rows} columns={money} storageKey="dg-pdf" rowKey={(r) => r.id} groupBanner={false} onExportPdf={pdf} />);
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /Doc/ }));
    fireEvent.click(screen.getByRole("button", { name: "Export to PDF" }));
    expect(pdf).toHaveBeenCalledTimes(1);
    const view = pdf.mock.calls[0]![0];
    expect(view.keys).toEqual(["code", "amount"]);
    expect(view.matrix.body).toEqual([["PO-2", 1200.5], ["PO-10", 80]]);
    expect(view.rows).toEqual(rows);
  });

  it("offers no PDF where the page does not print", () => {
    render(<DataGridCompat rows={rows} columns={money} storageKey="dg-nopdf" rowKey={(r) => r.id} groupBanner={false} />);
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /Doc/ }));
    expect(screen.getByRole("button", { name: /Export to Excel/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Export to PDF" })).toBeNull();
  });
});

describe("DataGridCompat", () => {
  it("forwards the page's resetFilters as the toolbar Reset", () => {
    const onReset = vi.fn();
    const cols: GridColumn<Row>[] = [{ key: "code", label: "Doc", accessor: (r) => r.code }];
    render(
      <DataGridCompat rows={rows} columns={cols} storageKey="dg-reset" rowKey={(r) => r.id} groupBanner={false}
        resetFilters={{ active: true, onReset, label: "Reset layout" }} />,
    );
    fireEvent.click(screen.getByText("Reset layout"));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("exports the on-screen rows as xlsx with money formats kept", () => {
    const columns: GridColumn<Row>[] = [
      { key: "code", label: "Doc", accessor: (r) => r.code },
      { key: "amount", label: "Amount", accessor: (r) => r.amount.toFixed(2), exportValue: (r) => r.amount, exportFormat: "money" },
    ];
    render(<DataGridCompat rows={rows} columns={columns} storageKey="dg-test" rowKey={(r) => r.id} exportName="Tests" groupBanner={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    const [matrix, sheet, file] = vi.mocked(writeLineExportFile).mock.calls[0];
    expect(matrix.header).toEqual(["Doc", "Amount"]);
    expect(matrix.formats).toEqual(["text", "money"]);
    expect(matrix.body).toEqual([["PO-2", 1200.5], ["PO-10", 80]]);
    expect(sheet).toBe("Sheet1");
    expect(file).toMatch(/^Tests-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});
