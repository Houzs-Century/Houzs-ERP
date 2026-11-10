/* A long table mounts only the rows on screen, but everything that acts on
   "the rows" must still see all of them: Export writes every filtered row, the
   toolbar search finds a row that is not mounted, and a pinned column stays
   pinned in the windowed rows. The Delivery Planning board relies on this since
   it dropped its 200-row "Load more" cap (3,000 rows scroll in as you go).
   Group-by under windowing is pinned in DataTableGroupByVirtual.test.tsx. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";
import { downloadCSV } from "../lib/csv";

vi.mock("../lib/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/csv")>();
  return { ...actual, downloadCSV: vi.fn() };
});

type Row = { id: number; name: string; city: string };
const ROWS: Row[] = Array.from({ length: 1000 }, (_, i) => ({
  id: i,
  name: `Row ${String(i).padStart(4, "0")}`,
  city: i % 2 ? "Klang" : "Ipoh",
}));
const columns: Column<Row>[] = [
  { key: "name", label: "Name", render: (r) => r.name, getValue: (r) => r.name },
  { key: "city", label: "City", render: (r) => r.city, getValue: (r) => r.city },
];
const mounted = () => document.querySelectorAll("tbody tr[data-vrow]").length;
const written = () => String(vi.mocked(downloadCSV).mock.calls[0]?.[1] ?? "");

beforeEach(() => {
  localStorage.clear();
  vi.mocked(downloadCSV).mockClear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
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

describe("DataTable row windowing", () => {
  it("mounts only a screenful of 1,000 rows, yet Export writes all 1,000", () => {
    render(<DataTable tableId="win-export" exportName="x" columns={columns} rows={ROWS} getRowKey={(r) => r.id} />);
    expect(mounted()).toBeGreaterThan(0);
    expect(mounted()).toBeLessThan(80);
    expect(screen.queryByText("Row 0999")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Export$/ }));
    expect(written()).toContain("Row 0000");
    expect(written()).toContain("Row 0999");
    expect(written().trim().split("\n")).toHaveLength(1001);
  });

  it("the toolbar search finds a row that was never mounted", async () => {
    render(
      <DataTable tableId="win-search" columns={columns} rows={ROWS} getRowKey={(r) => r.id}
        clientSearch={{ placeholder: "Search rows" }} />,
    );
    expect(screen.queryByText("Row 0999")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search rows"), { target: { value: "Row 0999" } });
    await waitFor(() => expect(screen.getByText("Row 0999")).toBeTruthy());
    expect(mounted()).toBe(1);
  });

  it("keeps a pinned column sticky in the windowed rows", () => {
    localStorage.setItem("dt:pinned:win-pin", JSON.stringify(["name"]));
    render(<DataTable tableId="win-pin" columns={columns} rows={ROWS} getRowKey={(r) => r.id} />);
    expect(mounted()).toBeLessThan(80);
    const firstRow = document.querySelector("tbody tr[data-vrow]")!;
    const nameCell = [...firstRow.querySelectorAll("td")].find((td) => td.textContent === "Row 0000")!;
    expect(nameCell.style.position).toBe("sticky");
  });
});
