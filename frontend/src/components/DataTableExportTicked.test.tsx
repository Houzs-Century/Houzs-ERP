import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { DataTable, type Column } from "./DataTable";
import { downloadCSV } from "../lib/csv";
import { tickedOrAll } from "./dataTableTicked";

vi.mock("../lib/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/csv")>();
  return { ...actual, downloadCSV: vi.fn() };
});

/* Owner 2026-09-27: with rows ticked, Export writes only the ticked rows, the
   same rows the footer total and Ctrl+C use. */

type Row = { id: string; party: string };
const rows: Row[] = [
  { id: "a", party: "Alpha" },
  { id: "b", party: "Bravo" },
  { id: "c", party: "Charlie" },
];
const columns: Column<Row>[] = [{ key: "party", label: "Party", render: (r) => r.party, getValue: (r) => r.party }];

beforeEach(() => {
  localStorage.clear();
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

function Ticked({ initial }: { initial: string[] }) {
  const [picked, setPicked] = useState(new Set(initial));
  return (
    <DataTable tableId="export-ticked" exportName="x" columns={columns} rows={rows} getRowKey={(r) => r.id}
      selection={{ selectedIds: picked, onToggle: () => setPicked(new Set()), onToggleAll: () => setPicked(new Set()) }} />
  );
}

const written = () => String(vi.mocked(downloadCSV).mock.calls[0]?.[1] ?? "");

describe("Export with rows ticked", () => {
  it("writes only the ticked rows and says how many on the button", () => {
    render(<Ticked initial={["a", "c"]} />);
    fireEvent.click(screen.getByRole("button", { name: /Export \(2\)/ }));
    expect(written()).toContain("Alpha");
    expect(written()).toContain("Charlie");
    expect(written()).not.toContain("Bravo");
  });

  it("writes every row shown when nothing is ticked", () => {
    render(<Ticked initial={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Export$/ }));
    expect(written()).toContain("Bravo");
  });
});

describe("tickedOrAll", () => {
  it("falls back to all rows when the ticks are not among them", () => {
    expect(tickedOrAll(rows, new Set(["zz"]), (r) => r.id)).toEqual({ rows, picked: false });
  });
});
