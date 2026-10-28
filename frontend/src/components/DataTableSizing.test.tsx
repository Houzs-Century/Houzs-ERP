import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";

/* Owner 2026-09-25: resizing one column must not move the others; long text
   can wrap; headers read as English Title Case. */

type Row = { id: number; name: string; note: string };
const rows: Row[] = [
  { id: 1, name: "Alpha", note: "a long remark that would normally be clipped" },
  { id: 2, name: "Bravo", note: "short" },
];
const columns: Column<Row>[] = [
  { key: "name", label: "Customer name", render: (r) => r.name, getValue: (r) => r.name },
  { key: "note", label: "delivery_remark", render: (r) => r.note, getValue: (r) => r.note },
];

const realRect = Element.prototype.getBoundingClientRect;
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
  // jsdom lays nothing out; give every header a real width so the table measures.
  Element.prototype.getBoundingClientRect = function () {
    return { width: this.tagName === "TH" ? 150 : 0, height: 20, top: 0, left: 0, right: 150, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = realRect;
});

const table = () => document.querySelector("table")!;
const header = (name: RegExp) => screen.getByRole("columnheader", { name });

describe("DataTable sizing", () => {
  it("fixes the measured widths and adds a blank column for the slack", () => {
    render(<DataTable tableId="size-a" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(table().style.tableLayout).toBe("fixed");
    expect(header(/^Customer Name/).style.width).toBe("150px");
    // two real columns + the filler
    expect(document.querySelectorAll("thead th").length).toBe(3);
    expect(document.querySelector("thead th[aria-hidden]")).not.toBeNull();
  });

  it("resizing one column leaves the other exactly as it was", () => {
    render(<DataTable tableId="size-b" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    const name = header(/^Customer Name/);
    const handle = name.querySelector('[role="separator"]')!;
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 180 });
    fireEvent.mouseUp(window);
    expect(header(/^Customer Name/).style.width).toBe("230px");
    expect(header(/^Delivery Remark/).style.width).toBe("150px");
  });

  it("stays in the auto layout while nothing is laid out (a hidden tab)", () => {
    Element.prototype.getBoundingClientRect = realRect;
    render(<DataTable tableId="size-c" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(table().style.tableLayout).toBe("");
  });

  it("the Wrap switch lets cells run onto more lines, and is remembered", () => {
    render(<DataTable tableId="size-d" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    const cell = screen.getByText(/a long remark/).closest("td")!;
    expect(cell.className).toContain("whitespace-nowrap");
    fireEvent.click(screen.getByRole("button", { name: /Wrap/ }));
    expect(screen.getByText(/a long remark/).closest("td")!.className).toContain("whitespace-normal");
    expect(localStorage.getItem("dt:wrap:size-d")).toBe("true");
  });

  it("headers read as English Title Case, whatever the column literal says", () => {
    render(<DataTable tableId="size-e" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(header(/^Customer Name/)).toBeTruthy();
    expect(header(/^Delivery Remark/)).toBeTruthy();
    expect(header(/^Customer Name/).className).not.toContain("uppercase");
  });
});
