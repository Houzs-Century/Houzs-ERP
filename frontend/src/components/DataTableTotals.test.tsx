import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { DataTable, type Column } from "./DataTable";

/* Owner 2026-09-25: a totals row pinned under the table, over the rows on
   screen, or only the ticked rows while any are ticked. */

type Row = { id: string; party: string; amount: number };
const rows: Row[] = [
  { id: "a", party: "Alpha", amount: 100 },
  { id: "b", party: "Bravo", amount: 250 },
  { id: "c", party: "Alpha", amount: 50 },
];
const columns: Column<Row>[] = [
  { key: "party", label: "Party", render: (r) => r.party, getValue: (r) => r.party },
  { key: "amount", label: "Amount", align: "right", render: (r) => r.amount, getValue: (r) => r.amount,
    total: (rs) => rs.reduce((a, r) => a + r.amount, 0) },
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

const footer = (key: string) => document.querySelector(`tfoot [data-total-key="${key}"]`)?.textContent;

function Ticked({ initial }: { initial: string[] }) {
  const [picked, setPicked] = useState(new Set(initial));
  return (
    <DataTable tableId="totals-sel" columns={columns} rows={rows} getRowKey={(r) => r.id}
      selection={{ selectedIds: picked, onToggle: (id) => setPicked(new Set([...picked, id])), onToggleAll: () => setPicked(new Set()) }} />
  );
}

describe("DataTable footer totals", () => {
  it("totals every row on screen, with the row count in the first column", () => {
    render(<DataTable tableId="totals-all" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(footer("amount")).toBe("400");
    expect(footer("party")).toBe("Total · 3 rows");
  });

  it("follows the search", async () => {
    render(<DataTable tableId="totals-f" columns={columns} rows={rows} getRowKey={(r) => r.id} clientSearch={{ placeholder: "Search" }} />);
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "alpha" } });
    await waitFor(() => expect(footer("amount")).toBe("150"));
    expect(footer("party")).toBe("Total · 2 rows");
  });

  it("totals only the ticked rows while any are ticked", () => {
    render(<Ticked initial={["b", "c"]} />);
    expect(footer("amount")).toBe("300");
    expect(footer("party")).toBe("Selected · 2 rows");
  });

  it("has no footer when no column asks for a total", () => {
    render(<DataTable tableId="totals-none" columns={columns.map(({ total: _t, ...c }) => c)} rows={rows} getRowKey={(r) => r.id} />);
    expect(document.querySelector("tfoot")).toBeNull();
  });
});
