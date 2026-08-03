import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";

/* ────────────────────────────────────────────────────────────────────────────
   Columns drawer — design handoff "Direction A" (2026-08-01).

   Driven through DataTable rather than in isolation on purpose: the drawer
   holds no column state of its own, and the property worth pinning is that
   every gesture lands on the TABLE immediately (`Done` only closes). Testing
   the drawer alone would test a shell.
   ──────────────────────────────────────────────────────────────────────────── */

type Row = { id: number; name: string };
const rows: Row[] = [{ id: 1, name: "One" }];

const columns: Column<Row>[] = [
  { key: "date", label: "Date", group: "Basic", width: "96px", render: (r) => r.name },
  { key: "customer", label: "Customer", group: "Basic", width: "180px", render: (r) => r.name },
  { key: "total", label: "Total", group: "Amounts", width: "120px", render: (r) => r.name },
  { key: "tax", label: "Tax", group: "Amounts", defaultHidden: true, render: (r) => r.name },
  { key: "carrier", label: "Carrier", group: "Logistics", render: (r) => r.name },
];

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(max-width: 639px)" ? width < 640 : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const headerLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent?.trim());

const openDrawer = () => fireEvent.click(screen.getByTitle(/^Columns —/));

const renderTable = (tableId: string, extra?: Partial<React.ComponentProps<typeof DataTable<Row>>>) =>
  render(
    <DataTable
      tableId={tableId}
      rows={rows}
      columns={columns}
      getRowKey={(row) => row.id}
      {...extra}
    />,
  );

beforeEach(() => {
  localStorage.clear();
  setViewport(1280);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("columns drawer", () => {
  it("groups columns under their headers, with a shown/total count each", () => {
    renderTable("groups");
    openDrawer();

    // 44 flat rows is a scroll, not a chooser — hence the groups.
    expect(screen.getByText("Basic")).toBeTruthy();
    expect(screen.getByText("Amounts")).toBeTruthy();
    expect(screen.getByText("Logistics")).toBeTruthy();
    // Amounts: Total shows, Tax is defaultHidden.
    expect(screen.getByText("Amounts").parentElement?.textContent).toContain("1/2");
  });

  it("collapses a group without forgetting what it holds", () => {
    const { container } = renderTable("collapse");
    openDrawer();

    fireEvent.click(screen.getByText("Amounts"));
    expect(screen.queryByRole("button", { name: "Total" })).toBeNull();
    // The count survives the collapse, and the TABLE is untouched — collapsing
    // is about the drawer, not about the columns.
    expect(screen.getByText("Amounts").parentElement?.textContent).toContain("1/2");
    expect(headerLabels(container)).toContain("Total");
  });

  it("filters on search, highlights the match, and offers a way back", () => {
    renderTable("search");
    openDrawer();

    fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "tot" } });
    expect(screen.getByRole("button", { name: "Total" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Carrier" })).toBeNull();
    expect(document.querySelector("mark")?.textContent).toBe("Tot");

    fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "invoice" } });
    expect(screen.getByText(/No columns match/)).toBeTruthy();
    fireEvent.click(screen.getByText("Clear search"));
    expect(screen.getByRole("button", { name: "Carrier" })).toBeTruthy();
  });

  it("applies a toggle to the table immediately — Done only closes", () => {
    const { container } = renderTable("immediate");
    openDrawer();

    fireEvent.click(screen.getByRole("button", { name: "Total" }));
    expect(headerLabels(container)).not.toContain("Total");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("Search columns")).toBeNull();
    // Still hidden after closing: Done is not a commit step.
    expect(headerLabels(container)).not.toContain("Total");
  });

  it("commits a width from the px chip, clamped, and cancels on Escape", () => {
    renderTable("width");
    openDrawer();

    fireEvent.click(screen.getByText("96px"));
    const field = screen.getByLabelText("Width of Date in pixels");
    fireEvent.change(field, { target: { value: "9999" } });
    fireEvent.keyDown(field, { key: "Enter" });
    // Clamped to the 60–400 the design specifies.
    expect(JSON.parse(localStorage.getItem("dt:widths:width")!)).toEqual({ date: 400 });

    fireEvent.click(screen.getByText("400px"));
    const again = screen.getByLabelText("Width of Date in pixels");
    fireEvent.change(again, { target: { value: "120" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(JSON.parse(localStorage.getItem("dt:widths:width")!)).toEqual({ date: 400 });
  });

  it("cycles a column none → left → right → none, never both", () => {
    const { container } = renderTable("freeze");
    openDrawer();

    fireEvent.click(screen.getAllByTitle("Freeze to the left")[0]!);
    expect(JSON.parse(localStorage.getItem("dt:pinned:freeze")!)).toEqual(["date"]);

    fireEvent.click(screen.getByTitle(/^Frozen left/));
    // MOVED, not added — frozen to both edges is not a table anyone can render.
    expect(JSON.parse(localStorage.getItem("dt:pinned:freeze")!)).toEqual([]);
    expect(JSON.parse(localStorage.getItem("dt:pinnedr:freeze")!)).toEqual(["date"]);
    // A right-frozen column renders LAST, whatever its place in the order.
    expect(headerLabels(container)).toEqual(["Customer", "Total", "Carrier", "Date"]);

    fireEvent.click(screen.getByTitle(/^Frozen right/));
    expect(JSON.parse(localStorage.getItem("dt:pinnedr:freeze")!)).toEqual([]);
    expect(headerLabels(container)).toEqual(["Date", "Customer", "Total", "Carrier"]);
  });

  it("sticks a right-frozen column to the right edge, with a divider on its left", () => {
    const { container } = renderTable("stickright");
    openDrawer();
    fireEvent.click(screen.getAllByTitle("Freeze to the left")[0]!);
    fireEvent.click(screen.getByTitle(/^Frozen left/));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    const head = [...container.querySelectorAll<HTMLElement>("thead th")];
    const last = head[head.length - 1]!;
    expect(last.style.position).toBe("sticky");
    // Offset from the RIGHT edge: nothing is frozen outside it, so zero.
    expect(last.style.right).toBe("0px");
    expect(last.className).toContain("border-l");
    expect(last.style.left).toBe("");
  });

  it("Show all reveals even a defaultHidden column, and says so in the footer", () => {
    const { container } = renderTable("showall");
    openDrawer();

    expect(screen.getByText(/of 5 shown/).textContent).toContain("4 of 5");
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));

    expect(headerLabels(container)).toContain("Tax");
    expect(screen.getByText(/of 5 shown/).textContent).toContain("5 of 5");
  });

  it("reorders within a group and refuses a drop across groups", () => {
    const { container } = renderTable("reorder");
    openDrawer();

    const row = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-column-row]")).find(
        (el) => el.textContent?.includes(label),
      )!;
    const drag = (from: Element, to: Element) => {
      const dataTransfer = { effectAllowed: "", setData: vi.fn(), getData: vi.fn() };
      fireEvent.dragStart(from, { dataTransfer });
      fireEvent.dragOver(to, { dataTransfer });
      fireEvent.drop(to, { dataTransfer });
      fireEvent.dragEnd(from, { dataTransfer });
    };

    drag(row("Customer"), row("Date"));
    expect(headerLabels(container)).toEqual(["Customer", "Date", "Total", "Carrier"]);

    // Group order belongs to the page, not the operator: an Amounts column
    // cannot be dropped among the Basic ones.
    drag(row("Total"), row("Customer"));
    expect(headerLabels(container)).toEqual(["Customer", "Date", "Total", "Carrier"]);
  });

  it("stacks two right-frozen columns by width, counted from the right edge", () => {
    const { container } = renderTable("stack");
    openDrawer();
    // Freeze Total (120px) and Carrier right; Carrier is last in table order.
    const freezeRight = (label: string) => {
      const row = Array.from(document.querySelectorAll<HTMLElement>("[data-column-row]")).find(
        (el) => el.textContent?.includes(label),
      )!;
      fireEvent.click(row.querySelector<HTMLElement>("[title='Freeze to the left']")!);
      fireEvent.click(row.querySelector<HTMLElement>("[title^='Frozen left']")!);
    };
    freezeRight("Total");
    freezeRight("Carrier");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    const head = [...container.querySelectorAll<HTMLElement>("thead th")];
    const last = head[head.length - 1]!;
    const secondLast = head[head.length - 2]!;
    // The outermost sits at 0; the one inside it is offset by the OUTER one's
    // width — accumulated from the right, not from the left.
    expect(last.style.right).toBe("0px");
    expect(secondLast.style.right).not.toBe("0px");
    expect(Number.parseInt(secondLast.style.right, 10)).toBeGreaterThan(0);
  });

  it("refuses a header drop across freeze sides, both ways", () => {
    const { container } = renderTable("crossdrop");
    openDrawer();
    const row = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-column-row]")).find(
        (el) => el.textContent?.includes(label),
      )!;
    // Freeze Date to the RIGHT, leave Customer unfrozen (same Basic group).
    fireEvent.click(row("Date").querySelector<HTMLElement>("[title='Freeze to the left']")!);
    fireEvent.click(row("Date").querySelector<HTMLElement>("[title^='Frozen left']")!);

    const before = headerLabels(container);
    const drag = (from: Element, to: Element) => {
      const dataTransfer = { effectAllowed: "", setData: vi.fn(), getData: vi.fn() };
      fireEvent.dragStart(from, { dataTransfer });
      fireEvent.dragOver(to, { dataTransfer });
      fireEvent.drop(to, { dataTransfer });
      fireEvent.dragEnd(from, { dataTransfer });
    };

    /* A right-frozen column and an unfrozen one are BOTH "not left-pinned", so
       a guard that asked only that would let this through — rewriting the
       stored order while the column stayed in the right run. */
    drag(row("Date"), row("Customer"));
    expect(headerLabels(container)).toEqual(before);
    drag(row("Customer"), row("Date"));
    expect(headerLabels(container)).toEqual(before);
  });

  it("becomes a bottom sheet on a phone, with an Apply that only closes", () => {
    setViewport(375);
    renderTable("sheet");
    // The mobile shell renders cards; the drawer trigger lives in the toolbar.
    openDrawer();

    expect(screen.getByRole("dialog", { name: "Columns" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Apply · 4 columns/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Apply · 4 columns/ }));
    expect(screen.queryByRole("dialog", { name: "Columns" })).toBeNull();
  });

  it("groups a table that annotates nothing, by inferring from the columns", () => {
    // Owner 2026-08-02: 全部 column 都要像 sales order column 那样分类. A page
    // no longer has to annotate anything — lib/columnGroups infers it, and an
    // explicit `group` still wins where a page did the sorting by hand.
    render(
      <DataTable
        tableId="flat"
        rows={rows}
        columns={columns.map(({ group: _group, ...rest }) => rest)}
        getRowKey={(row) => row.id}
      />,
    );
    openDrawer();

    expect(screen.getByText("Basic")).toBeTruthy();
    expect(screen.getByText("Amounts")).toBeTruthy();
    expect(screen.getByText("Logistics")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Carrier" })).toBeTruthy();
  });

  it("draws no group header when everything lands in one group", () => {
    render(
      <DataTable
        tableId="onegroup"
        rows={rows}
        columns={[
          { key: "amount", label: "Amount", render: (r: Row) => r.name },
          { key: "balance", label: "Balance", render: (r: Row) => r.name },
        ]}
        getRowKey={(row) => row.id}
      />,
    );
    openDrawer();

    // One group is no grouping — the header would say only "everything below".
    expect(screen.queryByText("Amounts")).toBeNull();
    expect(screen.getByRole("button", { name: "Amount" })).toBeTruthy();
  });
});

/* The Sales Orders list is the first page to annotate its columns (PR 2 of the
   redesign). Its 44 columns are what the grouping was built for, so the map
   itself is worth a test: a group that quietly loses its columns turns the
   drawer back into the flat scroll it replaced. */
describe("Sales Orders column groups", () => {
  it("puts every declared column in a group, and none in the fallback", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/pages/scm-v2/MfgSalesOrdersListV2.tsx", "utf8"),
    );
    const columnsBlock = source.slice(
      source.indexOf("const columns: Column<SoRow>[] = ["),
      source.indexOf("/* One pill per vocabulary status"),
    );
    const keys = [...columnsBlock.matchAll(/^\s*key: "([a-z0-9_]+)",$/gm)].map((m) => m[1]);
    const groups = [...columnsBlock.matchAll(/^\s*group: "([^"]+)",$/gm)].map((m) => m[1]);

    // Every column carries a group — a new column added without one would
    // silently fall to the bottom of the drawer, ungrouped.
    expect(keys.length).toBeGreaterThanOrEqual(44);
    expect(groups.length).toBe(keys.length);
    expect(new Set(groups)).toEqual(
      new Set(["Basic", "Customer", "Amounts", "Logistics", "Finance"]),
    );
  });
});
