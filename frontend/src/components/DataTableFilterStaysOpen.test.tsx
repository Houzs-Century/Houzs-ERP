import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";
import { resetInVisitColFilters } from "./dataTableColFilterMemory";

/* Owner 2026-11-12 on Finance › Reports › Event Commission, "filter 点一个会自动关":
   ticking ONE value in a funnel closed the popover, so he could not tick several.
   Ticking a value shortens the table; when the rows had been scrolled (inside the
   frozen table box, or the page near its end) the browser pulls that scrollTop
   back inside the shorter content and fires `scroll` for it, and the popover
   closed on any scroll. jsdom has no layout, so each test fires the scroll the
   browser would. */

type Row = { id: number; fair: string };
const FAIRS = ["Fair A", "Fair B", "Fair C", "Fair D", "Fair E"];
const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, fair: FAIRS[i % FAIRS.length]! }));
const columns: Column<Row>[] = [
  { key: "id", label: "Doc", render: (r) => `SO-${r.id}`, getValue: (r) => `SO-${r.id}` },
  { key: "fair", label: "Fair", render: (r) => r.fair, getValue: (r) => r.fair },
];

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(max-width: 639px)" ? width < 640 : false,
      media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
}
/* The app's page scroller is <main> (Layout.tsx); the table box is the
   element right around the <table>. */
const renderReport = () =>
  render(
    <main>
      <DataTable tableId="stays-open" freezeHeight="screen" rows={rows} columns={columns} getRowKey={(r) => r.id} />
    </main>,
  );
const popover = () => screen.queryByPlaceholderText("Search values…")?.closest<HTMLElement>("div.fixed") ?? null;
const drawn = () => document.querySelectorAll("tbody tr[data-vrow]").length;
const tick = (value: string) => fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(value) }));

beforeEach(() => {
  localStorage.clear();
  resetInVisitColFilters();
  setViewport(1280);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DataTable funnel popover stays open while values are ticked", () => {
  it("survives the scroll the browser fires when a tick shortens the table", () => {
    renderReport();
    fireEvent.click(screen.getByTitle("Filter & sort Fair"));
    const tableBox = document.querySelector("table")!.parentElement!;

    tick("Fair A");
    expect(popover()).not.toBeNull(); // the click itself never reached the close handler
    fireEvent.scroll(tableBox); // the frozen box's scrollTop pulled back to the shorter rows
    expect(popover()).not.toBeNull();

    tick("Fair B");
    fireEvent.scroll(document.querySelector("main")!); // the page's scrollTop pulled back too
    expect(popover()).not.toBeNull();

    tick("Fair C");
    expect(popover()).not.toBeNull();
    expect(screen.getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked)).toHaveLength(3);
    expect(drawn()).toBe(18);
  });

  it("moves with its funnel when the page scrolls", () => {
    renderReport();
    const funnel = screen.getByTitle("Filter & sort Fair");
    let top = 100;
    vi.spyOn(funnel, "getBoundingClientRect").mockImplementation(
      () => ({ top, bottom: top + 14, left: 300, right: 314, width: 14, height: 14, x: 300, y: top, toJSON: () => ({}) }) as DOMRect,
    );
    fireEvent.click(funnel);
    expect(popover()!.style.top).toBe("118px"); // hangs 4px under the funnel

    top = 200;
    fireEvent.scroll(document.querySelector("main")!);
    expect(popover()!.style.top).toBe("218px");
  });

  it("still closes on an outside click and on Escape", () => {
    renderReport();
    fireEvent.click(screen.getByTitle("Filter & sort Fair"));
    tick("Fair A");
    expect(popover()).not.toBeNull();
    fireEvent.click(document.body);
    expect(popover()).toBeNull();

    fireEvent.click(screen.getByTitle("Filter & sort Fair"));
    expect(popover()).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(popover()).toBeNull();
  });
});
