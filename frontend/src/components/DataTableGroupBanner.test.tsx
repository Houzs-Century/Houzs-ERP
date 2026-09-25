import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";

type Row = { id: number; supplier: string; status: string };
const rows: Row[] = [
  { id: 1, supplier: "Diglant", status: "Open" },
  { id: 2, supplier: "Hookka", status: "Open" },
  { id: 3, supplier: "Diglant", status: "Closed" },
  { id: 4, supplier: "Diglant", status: "Open" },
];
const columns: Column<Row>[] = [
  { key: "id", label: "No", render: (r) => String(r.id), getValue: (r) => r.id },
  { key: "supplier", label: "Supplier", render: (r) => r.supplier, getValue: (r) => r.supplier },
  { key: "status", label: "Status", render: (r) => r.status, getValue: (r) => r.status },
];

const groupRowTexts = () =>
  Array.from(document.querySelectorAll("tbody tr"))
    .filter((tr) => !tr.hasAttribute("data-vrow"))
    .map((tr) => String(tr.textContent).replace(/\s+/g, " ").trim());

function header(name: string) {
  return screen.getByRole("columnheader", { name: new RegExp(name) });
}

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
afterEach(cleanup);

describe("DataTable group banner (DataGrid parity)", () => {
  it("groups by a header dragged onto the banner, then nests a second level", () => {
    render(<DataTable tableId="grp" groupBanner columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    const banner = screen.getByTestId("group-banner");

    fireEvent.dragStart(header("Supplier"), { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
    fireEvent.dragOver(banner, { dataTransfer: { dropEffect: "" } });
    fireEvent.drop(banner, { dataTransfer: {} });
    expect(groupRowTexts()).toEqual(["Supplier: Diglant(3)", "Supplier: Hookka(1)"]);

    fireEvent.contextMenu(header("Status"));
    fireEvent.click(screen.getByRole("button", { name: "Group by this column" }));
    expect(groupRowTexts()).toEqual([
      "Supplier: Diglant(3)",
      "Status: Open(2)",
      "Status: Closed(1)",
      "Supplier: Hookka(1)",
      "Status: Open(1)",
    ]);
    expect(within(banner).getByText("Grouped by:")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("dt:groupby:grp")!)).toEqual(["supplier", "status"]);
  });

  it("collapses one nested bucket without touching its sibling", () => {
    localStorage.setItem("dt:groupby:grp2", JSON.stringify(["supplier", "status"]));
    render(<DataTable tableId="grp2" groupBanner columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    const dataRows = () => document.querySelectorAll("tbody tr[data-vrow]").length;
    expect(dataRows()).toBe(4);
    fireEvent.click(screen.getAllByText("Status: Open")[0].closest("tr")!);
    expect(dataRows()).toBe(2);
  });

  it("removing the chip ungroups", () => {
    localStorage.setItem("dt:groupby:grp3", JSON.stringify(["supplier"]));
    render(<DataTable tableId="grp3" groupBanner columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop grouping by Supplier" }));
    expect(groupRowTexts()).toEqual([]);
  });
});
