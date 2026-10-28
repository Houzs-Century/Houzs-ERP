import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { DataTable, type Column } from "./DataTable";
import { rowsToTsv } from "./dataTableClipboard";

/* Owner 2026-09-25: Ctrl+C on a table pastes into Excel as cells. */

type Row = { id: string; party: string; amountSen: number; note: string };
const rows: Row[] = [
  { id: "a", party: "Alpha", amountSen: 12345, note: "two\tparts" },
  { id: "b", party: "Bravo", amountSen: 500, note: "" },
];
const columns: Column<Row>[] = [
  { key: "party", label: "Party", render: (r) => r.party, getValue: (r) => r.party },
  { key: "amount", label: "Amount", align: "right", render: (r) => (r.amountSen / 100).toFixed(2), getValue: (r) => r.amountSen, exportValue: (r) => r.amountSen / 100 },
  { key: "note", label: "Note", render: (r) => r.note, getValue: (r) => r.note },
  { key: "action", label: "", render: () => <button type="button">Open</button> },
];

let written: string | null;
beforeEach(() => {
  localStorage.clear();
  written = null;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async (t: string) => { written = t; }) } });
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

const rowEl = (key: string) => document.querySelector<HTMLElement>(`tr[data-rowkey="${key}"]`)!;

function Ticked() {
  const [picked, setPicked] = useState(new Set(["a", "b"]));
  return (
    <DataTable tableId="copy-sel" columns={columns} rows={rows} getRowKey={(r) => r.id}
      selection={{ selectedIds: picked, onToggle: () => setPicked(new Set()), onToggleAll: () => setPicked(new Set()) }} />
  );
}

describe("rowsToTsv", () => {
  it("writes a header line and the export values, one cell per tab", () => {
    expect(rowsToTsv(rows, columns)).toBe("Party\tAmount\tNote\nAlpha\t123.45\ttwo parts\nBravo\t5\t");
  });
});

describe("Ctrl+C on a table", () => {
  it("copies the ticked rows", async () => {
    render(<Ticked />);
    fireEvent.keyDown(rowEl("b"), { key: "c", ctrlKey: true });
    expect(written).toBe("Party\tAmount\tNote\nAlpha\t123.45\ttwo parts\nBravo\t5\t");
    expect(await screen.findByText(/Copied 2 rows/)).toBeTruthy();
  });

  it("copies the row in focus when nothing is ticked", () => {
    render(<DataTable tableId="copy-one" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    fireEvent.keyDown(rowEl("b"), { key: "c", ctrlKey: true });
    expect(written).toBe("Party\tAmount\tNote\nBravo\t5\t");
  });

  it("leaves a text selection to the browser", () => {
    render(<DataTable tableId="copy-text" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    const sel = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "Alpha" } as Selection);
    fireEvent.keyDown(rowEl("a"), { key: "c", ctrlKey: true });
    expect(written).toBeNull();
    sel.mockRestore();
  });
});
