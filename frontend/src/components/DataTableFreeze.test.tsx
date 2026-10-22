import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";

/* Owner 2026-09-27: freeze the first 5-6 columns in one step. */

type Row = { id: string };
const keys = ["a", "b", "c", "d", "e", "f", "g", "h"];
const columns: Column<Row>[] = keys.map((k) => ({
  key: k, label: `Col ${k.toUpperCase()}`, render: () => k, getValue: () => k,
}));
const rows: Row[] = [{ id: "1" }, { id: "2" }];

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

const frozen = () =>
  Array.from(document.querySelectorAll<HTMLElement>("thead th[data-col-key]"))
    .filter((th) => th.style.position === "sticky")
    .map((th) => th.dataset.colKey);

describe("DataTable freeze up to a column", () => {
  it("freezes every column from the first through the chosen one, then unfreezes all", () => {
    render(<DataTable tableId="freeze-upto" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(frozen()).toEqual([]);

    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /Col F/ }));
    fireEvent.click(screen.getByRole("button", { name: "Freeze up to here" }));
    expect(frozen()).toEqual(["a", "b", "c", "d", "e", "f"]);

    // Choosing an earlier column narrows the frozen run.
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /Col C/ }));
    fireEvent.click(screen.getByRole("button", { name: "Freeze up to here" }));
    expect(frozen()).toEqual(["a", "b", "c"]);

    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /Col A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Unfreeze all" }));
    expect(frozen()).toEqual([]);
  });
});
