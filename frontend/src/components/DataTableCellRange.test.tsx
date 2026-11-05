import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";
import { cellRangeStats } from "./dataTableCellRange";

/* HC-0164 (Syu): drag over number cells to add them up, like Excel. */

type Row = { id: string; party: string; amount: number; balance: number };
const rows: Row[] = [
  { id: "a", party: "Alpha", amount: 100, balance: 10 },
  { id: "b", party: "Bravo", amount: 250.5, balance: 0 },
  { id: "c", party: "Charlie", amount: 50, balance: 5 },
];
const columns: Column<Row>[] = [
  { key: "party", label: "Party", render: (r) => r.party, getValue: (r) => r.party },
  { key: "amount", label: "Amount", align: "right", render: (r) => r.amount, getValue: (r) => r.amount, exportValue: (r) => r.amount },
  { key: "balance", label: "Balance", align: "right", render: (r) => r.balance, getValue: (r) => r.balance, exportValue: (r) => r.balance },
];

beforeEach(() => {
  localStorage.clear();
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

const cell = (row: string, col: string) =>
  document.querySelector<HTMLElement>(`tr[data-rowkey="${row}"] td[data-col-key="${col}"]`)!;

function drag(from: HTMLElement, to: HTMLElement) {
  fireEvent.mouseDown(from, { button: 0 });
  document.elementFromPoint = () => to;
  fireEvent.mouseMove(window, { clientX: 1, clientY: 1 });
  fireEvent.mouseUp(window);
  fireEvent.click(to);
}

describe("cellRangeStats", () => {
  it("adds up the number cells of the rectangle and skips text cells", () => {
    const s = cellRangeStats(rows, columns, (r) => r.id, { anchor: { row: "c", col: "balance" }, focus: { row: "a", col: "party" } });
    expect(s).toMatchObject({ rowKeys: ["a", "b", "c"], colKeys: ["party", "amount", "balance"], cells: 9, count: 6, sum: 415.5 });
  });

  it("a key no longer on screen gives no range", () => {
    expect(cellRangeStats(rows, columns, (r) => r.id, { anchor: { row: "a", col: "amount" }, focus: { row: "gone", col: "amount" } })).toBeNull();
  });
});

describe("drag over cells", () => {
  it("dragging down a number column shows its Sum, Count and Average and does not open the row", () => {
    const onRowClick = vi.fn();
    render(<DataTable tableId="crange" columns={columns} rows={rows} getRowKey={(r) => r.id} onRowClick={onRowClick} cellRangeSum />);
    drag(cell("a", "amount"), cell("b", "amount"));
    const pill = screen.getByRole("status");
    expect(pill.textContent).toContain("Sum 350.50");
    expect(pill.textContent).toContain("Count 2");
    expect(pill.textContent).toContain("Average 175.25");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("Shift+click stretches the range to another row", () => {
    render(<DataTable tableId="crange-shift" columns={columns} rows={rows} getRowKey={(r) => r.id} cellRangeSum />);
    fireEvent.mouseDown(cell("a", "amount"), { button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(cell("c", "amount"), { button: 0, shiftKey: true });
    expect(screen.getByRole("status").textContent).toContain("Sum 400.50");
  });

  it("a press on a text cell picks nothing and the row still opens", () => {
    const onRowClick = vi.fn();
    render(<DataTable tableId="crange-text" columns={columns} rows={rows} getRowKey={(r) => r.id} onRowClick={onRowClick} cellRangeSum />);
    drag(cell("a", "party"), cell("a", "party"));
    expect(screen.queryByText(/^Sum/)).toBeNull();
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it("Escape clears the range", () => {
    render(<DataTable tableId="crange-esc" columns={columns} rows={rows} getRowKey={(r) => r.id} cellRangeSum />);
    drag(cell("a", "amount"), cell("c", "balance"));
    expect(screen.getByRole("status").textContent).toContain("Sum 415.50");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(/^Sum/)).toBeNull();
  });

  it("is off unless the table asks for it", () => {
    render(<DataTable tableId="crange-off" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    drag(cell("a", "amount"), cell("b", "amount"));
    expect(screen.queryByText(/^Sum/)).toBeNull();
  });
});
