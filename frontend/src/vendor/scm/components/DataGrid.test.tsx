import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DataGrid, type DataGridColumn } from "./DataGrid";

const rowTexts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("tr[data-vrow]")].map((tr) => tr.textContent ?? "");

type Row = { id: string; name: string };
const rows: Row[] = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "A1" },
];
const columns: DataGridColumn<Row>[] = [
  { key: "name", label: "Name", accessor: (row) => row.name, searchValue: (row) => row.name },
];

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("DataGrid search scope", () => {
  test("states that built-in search only covers the loaded rows", () => {
    render(
      <DataGrid
        rows={rows}
        columns={columns}
        storageKey="search-scope-test"
        rowKey={(row) => row.id}
      />,
    );
    expect(screen.getByText("Searches 2 loaded rows only")).toBeTruthy();
  });
});

describe("DataGrid selectable — where the tick lives (owner 2026-09-03)", () => {
  const drawSelectable = (checkboxOnly: boolean, onRowDoubleClick?: (r: Row) => void) => {
    const toggles: string[] = [];
    const Host = () => {
      const [sel, setSel] = useState<Set<string>>(new Set());
      return (
        <DataGrid
          rows={rows}
          columns={columns}
          storageKey={`select-${checkboxOnly ? "box" : "row"}`}
          rowKey={(r) => r.id}
          onRowDoubleClick={onRowDoubleClick}
          selectable={{
            selectedKeys: sel,
            onToggle: (k) => { toggles.push(k); setSel((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }); },
            onToggleAll: () => {},
            checkboxOnly: checkboxOnly || undefined,
          }}
        />
      );
    };
    const view = render(<Host />);
    return { toggles, view };
  };

  test("default keeps the Commander rule — a row click IS a tick", () => {
    const { toggles } = drawSelectable(false);
    fireEvent.click(screen.getByText("Alpha"));
    expect(toggles).toEqual(["1"]);
  });

  test("checkboxOnly: the row click ticks NOTHING; only the checkbox cell does, and double-click still opens", () => {
    const opened: string[] = [];
    const { toggles } = drawSelectable(true, (r) => opened.push(r.id));
    fireEvent.click(screen.getByText("Alpha"));
    expect(toggles).toEqual([]);
    const boxes = screen.getAllByLabelText("Select row");
    fireEvent.click(boxes[0]!);
    expect(toggles).toEqual(["1"]);
    fireEvent.doubleClick(screen.getByText("Alpha"));
    expect(opened).toEqual(["1"]);
  });
});

describe("DataGrid structural performance", () => {
  test("keeps 10,000 rows windowed and reaches the final row at the real scroll limit", () => {
    const rowHeight = 30;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("tr[data-vrow]") ? rowHeight : 0;
    });
    const largeRows: Row[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: String(index + 1),
      name: `Order ${index + 1}`,
    }));

    const { container } = render(
      <DataGrid
        rows={largeRows}
        columns={columns}
        storageKey="structural-performance-10k"
        rowKey={(row) => row.id}
      />,
    );

    const tbody = container.querySelector("tbody")!;
    const scroller = container.querySelector("table")!.parentElement as HTMLElement;
    const mountedRows = () => container.querySelectorAll("tr[data-vrow]").length;
    const virtualContentHeight = () =>
      [...tbody.children].reduce((total, child) => {
        const row = child as HTMLTableRowElement;
        if (row.hasAttribute("data-vrow")) return total + row.offsetHeight;
        const spacerHeight = Number.parseFloat(row.querySelector<HTMLElement>("td")?.style.height || "0");
        return total + spacerHeight;
      }, 0);

    expect(screen.getByText("Order 1")).toBeTruthy();
    expect(screen.queryByText("Order 10000")).toBeNull();
    expect(mountedRows()).toBeGreaterThan(0);
    expect(mountedRows()).toBeLessThanOrEqual(60);
    expect(virtualContentHeight()).toBe(largeRows.length * rowHeight);

    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 320 });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: virtualContentHeight,
    });
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    expect(maxScrollTop).toBeGreaterThan(0);
    scroller.scrollTop = maxScrollTop;
    fireEvent.scroll(scroller);

    expect(screen.getByText("Order 10000")).toBeTruthy();
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(mountedRows()).toBeGreaterThan(0);
    expect(mountedRows()).toBeLessThanOrEqual(60);
    expect(virtualContentHeight()).toBe(largeRows.length * rowHeight);
  });
});

describe("DataGrid defaultSort (arrangement queues 2026-08-07)", () => {
  type QRow = { id: string; name: string; rank: number };
  const qRows: QRow[] = [
    { id: "1", name: "Alpha", rank: 3 },
    { id: "2", name: "Bravo", rank: 1 },
    { id: "3", name: "Charlie", rank: 2 },
  ];
  const qColumns: DataGridColumn<QRow>[] = [
    { key: "name", label: "Name", accessor: (r) => r.name, searchValue: (r) => r.name },
  ];
  const byRank = (a: QRow, b: QRow) => a.rank - b.rank;

  test("without defaultSort the rows render exactly as passed (existing contract)", () => {
    const { container } = render(
      <DataGrid rows={qRows} columns={qColumns} storageKey="ds-none" rowKey={(r) => r.id} />,
    );
    expect(rowTexts(container)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("defaultSort orders the rows while no column sort is active", () => {
    const { container } = render(
      <DataGrid
        rows={qRows}
        columns={qColumns}
        storageKey="ds-applied"
        rowKey={(r) => r.id}
        defaultSort={byRank}
      />,
    );
    expect(rowTexts(container)).toEqual(["Bravo", "Charlie", "Alpha"]);
  });

  test("a clicked header overrides the default, and cycling it off returns to the default", () => {
    const { container } = render(
      <DataGrid
        rows={qRows}
        columns={qColumns}
        storageKey="ds-override"
        rowKey={(r) => r.id}
        defaultSort={byRank}
      />,
    );
    const header = screen.getByRole("button", { name: "Name" });
    fireEvent.click(header); // asc
    expect(rowTexts(container)).toEqual(["Alpha", "Bravo", "Charlie"]);
    fireEvent.click(header); // desc
    expect(rowTexts(container)).toEqual(["Charlie", "Bravo", "Alpha"]);
    fireEvent.click(header); // off -> back to the default, not to fetch order
    expect(rowTexts(container)).toEqual(["Bravo", "Charlie", "Alpha"]);
  });
});

describe("DataGrid active-filter chips (stacked filters visible, 2026-08-07)", () => {
  type FRow = { id: string; name: string; state: string; post: string };
  const fRows: FRow[] = [
    { id: "1", name: "R1", state: "Johor", post: "80000" },
    { id: "2", name: "R2", state: "Johor", post: "81000" },
    { id: "3", name: "R3", state: "Selangor", post: "80000" },
  ];
  const fColumns: DataGridColumn<FRow>[] = [
    { key: "name", label: "Name", accessor: (r) => r.name, searchValue: (r) => r.name },
    { key: "state", label: "State", accessor: (r) => r.state, searchValue: (r) => r.state },
    { key: "post", label: "Postcode", accessor: (r) => r.post, searchValue: (r) => r.post },
  ];

  test("filters AND across columns; each active filter shows a chip with its own clear, plus Clear all", () => {
    const { container } = render(
      <DataGrid rows={fRows} columns={fColumns} storageKey="chips-and" rowKey={(r) => r.id} />,
    );
    // No filters -> no chip row, rows untouched.
    expect(container.querySelector("[data-filter-bar]")).toBeNull();
    expect(rowTexts(container)).toHaveLength(3);

    // Filter 1: State = Johor -> R1 + R2 stay, R3 (Selangor) drops.
    fireEvent.click(screen.getByRole("button", { name: "Filter State" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Johor" }));
    expect(rowTexts(container)).toHaveLength(2);
    expect(rowTexts(container).join("|")).not.toContain("R3");
    expect(container.querySelector("[data-filter-bar]")).not.toBeNull();

    // Filter 2 STACKS on top: Postcode = 80000 -> Johor AND 80000 -> R1 only.
    fireEvent.click(screen.getByRole("button", { name: "Filter Postcode" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "80000" }));
    expect(rowTexts(container)).toHaveLength(1);
    expect(rowTexts(container)[0]).toContain("R1");

    // Two chips, one per column filter.
    const bar = container.querySelector("[data-filter-bar]") as HTMLElement;
    expect(bar.textContent).toContain("State");
    expect(bar.textContent).toContain("Postcode");

    // Per-chip clear: dropping State keeps only the Postcode filter -> R1 + R3.
    fireEvent.click(screen.getByRole("button", { name: "Clear the State filter" }));
    expect(rowTexts(container)).toHaveLength(2);
    expect(rowTexts(container).join("|")).toContain("R3");

    // Clear all: every row returns and the chip row disappears.
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(rowTexts(container)).toHaveLength(3);
    expect(container.querySelector("[data-filter-bar]")).toBeNull();
  });

  test("multi-select within one column ORs its values while columns still AND", () => {
    const { container } = render(
      <DataGrid rows={fRows} columns={fColumns} storageKey="chips-or" rowKey={(r) => r.id} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter State" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Johor" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Selangor" }));
    expect(rowTexts(container)).toHaveLength(3); // Johor OR Selangor
    const bar = container.querySelector("[data-filter-bar]") as HTMLElement;
    expect(bar.textContent).toContain("2 values");
  });
});

/* ── Option-B map narrowing is a DEFAULT, never a lock (owner bug 2026-08-08:
   "已经添加了 column 可是它却没有出来" — the overlay kept overriding columns
   the user explicitly ticked in the Columns panel). The page wiring under pin:
   overlayHidden narrows while compact mode is on, and the grid's
   onUserAdjustColumns fires on any explicit Columns-panel visibility choice so
   the page can switch compact OFF and let the user's picks win instantly. */
describe("DataGrid overlay narrowing yields to explicit column choices", () => {
  type WideRow = { id: string; name: string; extra: string; extra2: string };
  const wideRows: WideRow[] = [{ id: "1", name: "Alpha", extra: "E1", extra2: "E2" }];
  /* `extra` starts hidden in the USER's own prefs (defaultHidden) — the
     owner's exact case: they tick it in the Columns panel, so it must render.
     A second defaultHidden column keeps the materialised layout non-pristine
     after the toggle (the grid's pristine-defaults overlay quirk). */
  const wideColumns: DataGridColumn<WideRow>[] = [
    { key: "name", label: "Name", accessor: (r) => r.name, searchValue: (r) => r.name },
    { key: "extra", label: "Extra", accessor: (r) => r.extra, searchValue: (r) => r.extra, defaultHidden: true },
    { key: "extra2", label: "Other", accessor: (r) => r.extra2, searchValue: (r) => r.extra2, defaultHidden: true },
  ];

  /* The same shape the three map pages use: compact defaults ON (the overlay
     hides the non-essential columns) and any explicit user column choice
     switches compact off. */
  function MapPageHarness() {
    const [compact, setCompact] = useState(true);
    return (
      <DataGrid
        rows={wideRows}
        columns={wideColumns}
        storageKey="overlay-default-not-lock"
        rowKey={(r) => r.id}
        overlayHidden={compact ? ["extra", "extra2"] : undefined}
        onUserAdjustColumns={() => setCompact(false)}
      />
    );
  }

  const headerTexts = (container: HTMLElement): string =>
    [...container.querySelectorAll("thead th")].map((th) => th.textContent ?? "").join("|");

  test("map open + user shows a non-essential column in the Columns panel -> that column renders", () => {
    const { container } = render(<MapPageHarness />);

    // Compact on: the overlay hides Extra from the grid...
    expect(headerTexts(container)).not.toContain("Extra");

    // ...the user opens the Columns panel and ticks the Extra column — an
    // EXPLICIT choice, so the compact overlay must yield, not override.
    fireEvent.click(screen.getByRole("button", { name: /^Columns/ }));
    fireEvent.click(screen.getByRole("button", { name: "Extra" }));

    expect(headerTexts(container)).toContain("Extra");
    // The pick is surgical: the OTHER overlay column stays as the user left it
    // (hidden by their own defaults), so yielding shows their real prefs.
    expect(headerTexts(container)).not.toContain("Other");
  });

  test("rendering with the overlay in place writes NOTHING to the persisted layout", () => {
    render(<MapPageHarness />);
    for (const key of Object.keys(window.localStorage)) {
      expect(window.localStorage.getItem(key) ?? "").not.toContain('"extra"');
    }
  });
});
