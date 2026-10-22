import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";

/* The row behaviours the SCM DataGrid pages rely on, which DataTable must carry
   before those pages can move onto it (one-table plan, owner 2026-09-25). */

type Row = { id: number; code: string; rank: number };
const rows: Row[] = [
  { id: 1, code: "B", rank: 2 },
  { id: 2, code: "A", rank: 3 },
  { id: 3, code: "C", rank: 1 },
];
const columns: Column<Row>[] = [
  { key: "code", label: "Code", render: (r) => r.code, getValue: (r) => r.code },
  { key: "rank", label: "Rank", render: (r) => String(r.rank), sortCompare: (a, b) => a.rank - b.rank },
];

function bodyCodes(): string[] {
  return Array.from(document.querySelectorAll("tbody tr[data-vrow]")).map(
    (tr) => tr.querySelector("td")?.textContent ?? "",
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
});
afterEach(cleanup);

describe("DataTable DataGrid-parity row behaviours", () => {
  it("opens in defaultSort order while no header sort is active", () => {
    render(
      <DataTable tableId="parity-default" columns={columns} rows={rows} getRowKey={(r) => r.id}
        defaultSort={(a, b) => a.code.localeCompare(b.code)} />,
    );
    expect(bodyCodes()).toEqual(["A", "B", "C"]);
  });

  it("sorts a comparator-only column from its header", () => {
    render(<DataTable tableId="parity-compare" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole("columnheader", { name: /Rank/ }));
    expect(bodyCodes()).toEqual(["C", "B", "A"]);
  });

  it("fires onRowDoubleClick and paints getRowStyle", () => {
    const onDouble = vi.fn();
    render(
      <DataTable tableId="parity-dbl" columns={columns} rows={rows} getRowKey={(r) => r.id}
        onRowDoubleClick={onDouble}
        getRowStyle={(r) => (r.code === "A" ? { backgroundColor: "rgb(255, 0, 0)" } : undefined)} />,
    );
    const rowA = screen.getByText("A").closest("tr")!;
    fireEvent.doubleClick(rowA);
    expect(onDouble).toHaveBeenCalledWith(rows[1]);
    expect(rowA.style.backgroundColor).toBe("rgb(255, 0, 0)");
  });

  it("skips disabled rows in select-all and ticks on row click when asked", () => {
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();
    render(
      <DataTable tableId="parity-sel" columns={columns} rows={rows} getRowKey={(r) => r.id}
        selection={{
          selectedIds: new Set(),
          onToggle,
          onToggleAll,
          isDisabled: (id) => id === "2",
          toggleOnRowClick: true,
        }} />,
    );
    fireEvent.click(screen.getByLabelText("Select all rows"));
    expect(onToggleAll).toHaveBeenCalledWith(["1", "3"], false);

    fireEvent.click(screen.getByText("B").closest("tr")!);
    expect(onToggle).toHaveBeenCalledWith("1");
    fireEvent.click(screen.getByText("A").closest("tr")!);
    expect(onToggle).not.toHaveBeenCalledWith("2");
    const boxA = screen.getByText("A").closest("tr")!.querySelector("input")!;
    expect(boxA.disabled).toBe(true);
  });

  it("clientSearch filters the loaded rows by searchValue", async () => {
    const searchCols: Column<Row>[] = [
      { ...columns[0], searchValue: (r) => `${r.code} rank-${r.rank}` },
      columns[1],
    ];
    render(
      <DataTable tableId="parity-search" columns={searchCols} rows={rows} getRowKey={(r) => r.id}
        clientSearch={{ placeholder: "Find" }} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Find"), { target: { value: "RANK-3" } });
    await waitFor(() => expect(bodyCodes()).toEqual(["A"]));
  });

  it("a date column's funnel filters by a from/to range", () => {
    type D = { id: number; d: string };
    const dRows: D[] = [
      { id: 1, d: "2026-09-01" },
      { id: 2, d: "2026-09-20" },
    ];
    const dCols: Column<D>[] = [
      { key: "d", label: "Date", render: (r) => r.d, getValue: (r) => r.d, filterType: "date", dateValue: (r) => r.d },
    ];
    render(<DataTable tableId="parity-date" persistFilters={false} columns={dCols} rows={dRows} getRowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole("button", { name: /Filter & sort Date/ }));
    const from = screen.getByLabelText("From date");
    fireEvent.focus(from);
    fireEvent.change(from, { target: { value: "2026/09/10" } });
    fireEvent.blur(from);
    fireEvent.click(screen.getByRole("button", { name: "Apply Range" }));
    expect(bodyCodes()).toEqual(["2026-09-20"]);
  });

  it("the header menu lists hidden columns to show again, and scrolls when long", () => {
    // #4290 on the old grid: ~20 hidden columns on the Delivery Planning board
    // ran the Show list off the screen.
    const many: Column<Row>[] = [
      columns[0],
      ...Array.from({ length: 20 }, (_, i) => ({
        key: `x${i}`, label: `Extra ${i}`, defaultHidden: true, render: () => "x", getValue: () => "x",
      })),
    ];
    render(<DataTable tableId="parity-hidden" columns={many} rows={rows} getRowKey={(r) => r.id} />);
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /^Code/ }));
    const show = screen.getByRole("button", { name: "Show Extra 19" });
    const menu = show.parentElement!;
    expect(menu.className).toContain("overflow-y-auto");
    expect(menu.style.maxHeight).toBe("calc(100vh - 16px)");
    fireEvent.click(show);
    expect(screen.getByRole("columnheader", { name: /^Extra 19/ })).toBeTruthy();
  });

  it("a clickable row works from the keyboard: Enter clicks, Shift+Enter double-clicks", () => {
    const onClick = vi.fn();
    const onDouble = vi.fn();
    render(
      <DataTable tableId="parity-keys" columns={columns} rows={rows} getRowKey={(r) => r.id}
        onRowClick={onClick} onRowDoubleClick={onDouble} />,
    );
    const rowA = screen.getByText("A").closest("tr")!;
    expect(rowA.tabIndex).toBe(0);
    fireEvent.keyDown(rowA, { key: "Enter" });
    expect(onClick).toHaveBeenCalledWith(rows[1]);
    fireEvent.keyDown(rowA, { key: "Enter", shiftKey: true });
    expect(onDouble).toHaveBeenCalledWith(rows[1]);
  });

  it("a row with no click handler is not a tab stop", () => {
    render(<DataTable tableId="parity-nokeys" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    // -1: out of the Tab order, but a click still focuses it so Ctrl+C knows the row.
    expect(screen.getByText("A").closest("tr")!.tabIndex).toBe(-1);
  });

  it("an embedded grid renders no toolbar", () => {
    render(
      <DataTable tableId="parity-embed" columns={columns} rows={rows} getRowKey={(r) => r.id}
        exportName="x" embedded />,
    );
    expect(screen.getByRole("button", { name: /Export/ }).closest("div.hidden")).not.toBeNull();
  });
});
