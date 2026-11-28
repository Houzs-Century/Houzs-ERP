import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { DataTable, type Column } from "./DataTable";
import { primeInVisitColFilters, resetInVisitColFilters } from "./dataTableColFilterMemory";
import { downloadCSV } from "../lib/csv";

vi.mock("../lib/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/csv")>();
  return { ...actual, downloadCSV: vi.fn() };
});

type Row = { id: number; name: string; status: string };

const rows: Row[] = Array.from({ length: 200 }, (_, index) => ({
  id: index + 1,
  name: `Order ${index + 1}`,
  status: index % 2 ? "Open" : "Closed",
}));

const columns: Column<Row>[] = [
  { key: "name", label: "Order", render: (row) => row.name, getValue: (row) => row.name },
  { key: "status", label: "Status", render: (row) => row.status, getValue: (row) => row.status },
];

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");

function setViewport(width: number) {
  let currentWidth = width;
  const listeners = new Set<EventListener>();
  const setInnerWidth = (next: number) =>
    Object.defineProperty(window, "innerWidth", { configurable: true, value: next });
  setInnerWidth(currentWidth);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      get matches() {
        return query === "(max-width: 639px)" ? currentWidth < 640 : false;
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn((_type: string, listener: EventListener) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: EventListener) => listeners.delete(listener)),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  return {
    resize(next: number) {
      currentWidth = next;
      setInnerWidth(next);
      listeners.forEach((listener) => listener(new Event("change")));
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetInVisitColFilters();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
  if (originalInnerWidth) Object.defineProperty(window, "innerWidth", originalInnerWidth);
  if (originalInnerHeight) Object.defineProperty(window, "innerHeight", originalInnerHeight);
});

describe("DataTable onFilteredRowsChange", () => {
  /* Owner 2026-08-12 — the per-column funnels are client-side AND persisted, so
     a page that summarises its rows had no way to know what the operator can
     actually see. A stuck DATE funnel on Purchase Orders left 5 rows worth
     RM 9,112.50 under a "Sum on this page" card reading RM 164,349.70, and two
     POs were reported missing when they were simply filtered out. */
  it("reports every row when no column filter is set", () => {
    setViewport(1280);
    const seen: Row[][] = [];
    render(
      <DataTable
        tableId="orders-unfiltered"
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        onFilteredRowsChange={(r) => seen.push(r)}
      />,
    );
    expect(seen.at(-1)).toHaveLength(rows.length);
  });

  it("settles when a funnel is saved and the parent stores the report and rebuilds its columns", () => {
    setViewport(1280);
    primeInVisitColFilters("orders-loop", { status: ["Open"] });
    function Parent() {
      const [seen, setSeen] = useState<Row[]>([]);
      const fresh = columns.map((c) => ({ ...c }));
      return (
        <>
          <span data-testid="seen">{seen.length}</span>
          <DataTable tableId="orders-loop" rows={rows} columns={fresh} getRowKey={(row) => row.id} onFilteredRowsChange={setSeen} />
        </>
      );
    }
    render(<Parent />);
    expect(screen.getByTestId("seen").textContent).toBe(String(rows.filter((r) => r.status === "Open").length));
  });

  it("reports only the rows a persisted column filter leaves visible", () => {
    setViewport(1280);
    primeInVisitColFilters("orders-filtered", { status: ["Open"] });
    const seen: Row[][] = [];
    render(
      <DataTable
        tableId="orders-filtered"
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        onFilteredRowsChange={(r) => seen.push(r)}
      />,
    );
    const last = seen.at(-1)!;
    expect(last).toHaveLength(rows.filter((r) => r.status === "Open").length);
    expect(last.every((r) => r.status === "Open")).toBe(true);
    expect(last.length).not.toBe(rows.length);
  });

  it("is optional — omitting it renders exactly as before", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable tableId="orders-no-cb" rows={rows} columns={columns} getRowKey={(row) => row.id} />,
    );
    expect(container.querySelectorAll("tr[data-vrow]").length).toBeGreaterThan(0);
  });
});

describe("DataTable responsive rendering", () => {
  it("does not build the hidden mobile-card tree on desktop", () => {
    setViewport(1280);

    const { container } = render(
      <DataTable tableId="orders" rows={rows} columns={columns} getRowKey={(row) => row.id} />,
    );

    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(0);
    const renderedRows = container.querySelectorAll("tr[data-vrow]").length;
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThanOrEqual(60);
  });

  it("keeps short mobile lists complete and preserves the Cards/Table representation toggle", () => {
    setViewport(375);
    const onRowClick = vi.fn();

    const { container } = render(
      <DataTable
        tableId="orders-short-mobile"
        rows={rows.slice(0, 20)}
        columns={columns}
        getRowKey={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );

    expect(container.querySelector("table")).toBeNull();
    const renderedCards = container.querySelectorAll<HTMLElement>("[data-mobile-card]");
    expect(renderedCards).toHaveLength(20);
    expect(renderedCards[0]?.style.contentVisibility).toBe("auto");
    expect(renderedCards[0]?.getAttribute("role")).toBe("button");
    expect(renderedCards[0]?.tabIndex).toBe(0);
    fireEvent.keyDown(renderedCards[0]!, { key: "Enter" });
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);

    fireEvent.click(screen.getByRole("button", { name: "Switch to table view" }));
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Switch to card view" }));
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(20);
  });

  it("switches the mounted representation at the sm breakpoint and cleans up its listener", () => {
    const viewport = setViewport(1280);
    const { container, unmount } = render(
      <DataTable tableId="orders" rows={rows} columns={columns} getRowKey={(row) => row.id} />,
    );

    expect(container.querySelector("table")).not.toBeNull();
    act(() => viewport.resize(375));
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-mobile-card]").length).toBeLessThanOrEqual(100);
    act(() => viewport.resize(1280));
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(0);

    expect(viewport.listenerCount()).toBe(1);
    unmount();
    expect(viewport.listenerCount()).toBe(0);
  });

  it("keeps a variable-height 10,000-card mobile list bounded and reaches its tail", () => {
    setViewport(375);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.hasAttribute("data-vcard")) return 0;
      return Number(this.dataset.vindex) % 2 === 0 ? 80 : 140;
    });
    const largeRows: Row[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: index + 1,
      name: `Order ${index + 1}`,
      status: index % 2 ? "Open" : "Closed",
    }));
    const { container } = render(
      <DataTable
        tableId="orders-mobile-10k"
        rows={largeRows}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );

    const list = container.querySelector<HTMLElement>("[data-mobile-virtual-list]")!;
    const mountedCards = () => [...list.querySelectorAll<HTMLElement>("[data-vcard]")];
    expect(list.getAttribute("role")).toBe("list");
    expect(list.getAttribute("aria-label")).toBe(
      "10000 loaded records. Only visible records are mounted; scroll to browse this loaded set.",
    );
    expect(mountedCards().length).toBeGreaterThan(0);
    expect(mountedCards().length).toBeLessThanOrEqual(100);
    expect(mountedCards()[0]?.getAttribute("role")).toBe("listitem");
    expect(mountedCards()[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(mountedCards()[0]?.getAttribute("aria-setsize")).toBe("10000");
    expect(mountedCards()[0]?.offsetHeight).toBe(80);
    expect(mountedCards()[1]?.offsetHeight).toBe(140);
    expect(screen.queryByText("Order 10000")).toBeNull();

    let top = 0;
    const virtualContentHeight = () => {
      const children = [...list.children] as HTMLElement[];
      return children.reduce((sum, child) => {
        const height = child.hasAttribute("data-vcard")
          ? child.offsetHeight
          : Number.parseFloat(child.style.height || "0");
        return sum + height;
      }, 0) + Math.max(0, children.length - 1) * 8;
    };
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => ({
      top,
      bottom: top + virtualContentHeight(),
      left: 0,
      right: 375,
      width: 375,
      height: virtualContentHeight(),
      x: 0,
      y: top,
      toJSON: () => ({}),
    }));
    const maxScrollTop = virtualContentHeight() - window.innerHeight;
    expect(maxScrollTop).toBeGreaterThan(0);
    top = -maxScrollTop;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((frame) => frame(0));
    });

    expect(screen.getByText("Order 10000")).toBeTruthy();
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(list.lastElementChild?.hasAttribute("data-vcard")).toBe(true);
    expect(mountedCards().length).toBeLessThanOrEqual(100);
    expect(mountedCards().at(-1)?.getAttribute("aria-posinset")).toBe("10000");
    expect(mountedCards().at(-1)?.getAttribute("aria-setsize")).toBe("10000");

    const download = vi.mocked(downloadCSV);
    download.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(download).toHaveBeenCalledOnce();
    const exportedCSV = download.mock.calls[0]?.[1] ?? "";
    expect(exportedCSV.split("\r\n")).toHaveLength(largeRows.length + 1);
    expect(exportedCSV).toContain("Order 1,Closed");
    expect(exportedCSV).toContain("Order 10000,Open");

    fireEvent.click(screen.getByRole("button", { name: "Switch to table view" }));
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("[data-mobile-virtual-list]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch to card view" }));
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("[data-mobile-virtual-list]")).not.toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]").length).toBeLessThanOrEqual(100);
  });

  it("keeps the DOM bounded and reaches the final row in a 10,000-row dataset", () => {
    setViewport(1280);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const rowHeight = 33;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("tr[data-vrow]") ? rowHeight : 0;
    });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const largeRows: Row[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: index + 1,
      name: `Order ${index + 1}`,
      status: index % 2 ? "Open" : "Closed",
    }));
    const { container } = render(
      <DataTable tableId="orders-10k" rows={largeRows} columns={columns} getRowKey={(row) => row.id} />,
    );

    expect(container.querySelectorAll("tr[data-vrow]").length).toBeLessThanOrEqual(60);
    expect(screen.queryByText("Order 10000")).toBeNull();

    const body = container.querySelector("tbody")!;
    const virtualContentHeight = () =>
      [...body.children].reduce((total, child) => {
        const row = child as HTMLTableRowElement;
        if (row.hasAttribute("data-vrow")) return total + row.offsetHeight;
        return total + Number.parseFloat(row.querySelector<HTMLElement>("td")?.style.height || "0");
      }, 0);
    expect(virtualContentHeight()).toBe(largeRows.length * rowHeight);
    let top = 0;
    vi.spyOn(body, "getBoundingClientRect").mockImplementation(() => ({
      top,
      bottom: top + virtualContentHeight(),
      left: 0,
      right: 1000,
      width: 1000,
      height: virtualContentHeight(),
      x: 0,
      y: top,
      toJSON: () => ({}),
    }));
    const maxScrollTop = virtualContentHeight() - window.innerHeight;
    expect(maxScrollTop).toBeGreaterThan(0);
    top = -maxScrollTop;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((frame) => frame(0));
    });

    expect(screen.getByText("Order 10000")).toBeTruthy();
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(container.querySelectorAll("tr[data-vrow]").length).toBeLessThanOrEqual(60);
    expect(virtualContentHeight()).toBe(largeRows.length * rowHeight);
  });
});

describe("DataTable column width persistence", () => {
  it("uses a bounded family identity instead of a per-document layout key", () => {
    setViewport(1280);

    render(
      <DataTable
        tableId="so-lines-SO-2026-000123"
        layoutFamily="sales-order-lines"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );

    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "");
    expect(keys.some((key) => key.includes("SO-2026-000123"))).toBe(false);
    const perTable = keys.filter((key) => key !== "dt:cols-drawer-az");
    // hidden, shown, order, sort, mview, widths, pinned, pinnedr, groups, groupby, wrap, fit.
    // `groupby` is the group-banner column list (DataGrid parity, 2026-09-25).
    // `wrap` is the wrap-text switch (2026-09-26).
    // `fit` is the fit-to-screen switch (2026-11-02).
    // `pinnedr` is the right-freeze list (owner 2026-08-03) — a second flat list
    // rather than a reshaped `pinned`, so every layout already on disk keeps
    // reading. Funnel filters are NO LONGER here (owner 2026-09-16): they live in
    // in-visit memory (dataTableColFilterMemory), never localStorage.
    expect(perTable).toHaveLength(12);
    expect(perTable.every((key) => key.endsWith(":sales-order-lines"))).toBe(true);
  });

  it("migrates the current document's valid legacy preferences into its family", () => {
    setViewport(1280);
    localStorage.setItem("dt:hidden:so-lines-SO-2026-000123", JSON.stringify(["status"]));

    render(
      <DataTable
        tableId="so-lines-SO-2026-000123"
        layoutFamily="sales-order-lines"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );

    expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("dt:hidden:sales-order-lines")!)).toEqual(["status"]);
  });

  it("sanitizes corrupt persisted preferences instead of crashing the table", () => {
    setViewport(1280);
    localStorage.setItem("dt:hidden:corrupt-layout", JSON.stringify({ status: true }));
    localStorage.setItem("dt:sort:corrupt-layout", JSON.stringify({ key: 7, direction: "sideways" }));
    localStorage.setItem("dt:widths:corrupt-layout", JSON.stringify({ name: "wide", status: -50 }));

    expect(() => render(
      <DataTable
        tableId="corrupt-layout"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    )).not.toThrow();

    expect(screen.getByRole("columnheader", { name: /Status/ })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("dt:hidden:corrupt-layout")!)).toEqual([]);
    expect(JSON.parse(localStorage.getItem("dt:sort:corrupt-layout")!)).toBeNull();
    expect(JSON.parse(localStorage.getItem("dt:widths:corrupt-layout")!)).toEqual({ status: 40 });
  });

  it("updates the drag width live without writing storage, then persists once on mouseup", () => {
    setViewport(1280);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    render(
      <DataTable
        tableId="resize-persistence"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );

    setItem.mockClear();
    const handle = screen.getAllByRole("separator", { name: "Resize column" })[0];

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 140 });

    expect(handle.parentElement?.style.width).toBe("200px");
    expect(setItem.mock.calls.filter(([key]) => key === "dt:widths:resize-persistence")).toHaveLength(0);

    fireEvent.mouseUp(window);

    const widthWrites = setItem.mock.calls.filter(
      ([key]) => key === "dt:widths:resize-persistence",
    );
    expect(widthWrites).toHaveLength(1);
    expect(JSON.parse(String(widthWrites[0]?.[1]))).toEqual({ name: 200 });
  });

  it("persists the final width and detaches drag listeners when the window blurs", () => {
    setViewport(1280);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    render(
      <DataTable
        tableId="resize-blur"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );

    setItem.mockClear();
    removeEventListener.mockClear();
    const handle = screen.getAllByRole("separator", { name: "Resize column" })[0];

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 130 });
    fireEvent(window, new Event("blur"));

    const widthWrites = setItem.mock.calls.filter(([key]) => key === "dt:widths:resize-blur");
    expect(widthWrites).toHaveLength(1);
    expect(JSON.parse(String(widthWrites[0]?.[1]))).toEqual({ name: 190 });
    expect(removeEventListener.mock.calls.some(([type]) => type === "mousemove")).toBe(true);
    expect(removeEventListener.mock.calls.some(([type]) => type === "mouseup")).toBe(true);
    expect(removeEventListener.mock.calls.some(([type]) => type === "blur")).toBe(true);

    fireEvent.mouseMove(window, { clientX: 180 });
    fireEvent.mouseUp(window);
    expect(handle.parentElement?.style.width).toBe("190px");
    expect(setItem.mock.calls.filter(([key]) => key === "dt:widths:resize-blur")).toHaveLength(1);
  });

  it("cleans up an active drag on unmount and directly persists its last width", () => {
    setViewport(1280);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    const { unmount } = render(
      <DataTable
        tableId="resize-unmount"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );

    setItem.mockClear();
    addEventListener.mockClear();
    removeEventListener.mockClear();
    const handle = screen.getAllByRole("separator", { name: "Resize column" })[0];
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 150 });

    const dragListeners = new Map(
      addEventListener.mock.calls
        .filter(([type]) => type === "mousemove" || type === "mouseup" || type === "blur")
        .map(([type, listener]) => [type, listener]),
    );
    expect([...dragListeners.keys()].sort()).toEqual(["blur", "mousemove", "mouseup"]);

    unmount();

    for (const [type, listener] of dragListeners) {
      expect(removeEventListener).toHaveBeenCalledWith(type, listener);
    }
    const widthWrites = setItem.mock.calls.filter(([key]) => key === "dt:widths:resize-unmount");
    expect(widthWrites).toHaveLength(1);
    expect(JSON.parse(String(widthWrites[0]?.[1]))).toEqual({ name: 210 });

    fireEvent.mouseMove(window, { clientX: 200 });
    fireEvent.mouseUp(window);
    fireEvent(window, new Event("blur"));
    expect(setItem.mock.calls.filter(([key]) => key === "dt:widths:resize-unmount")).toHaveLength(1);
  });
});

describe("DataTable server search feedback", () => {
  it("propagates every keystroke and announces when rows are still catching up", () => {
    setViewport(1280);
    const onChange = vi.fn();
    const onToggleAll = vi.fn();

    render(
      <DataTable
        tableId="search-orders"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        search={{
          value: "A",
          onChange,
          debounceMs: 0,
          searching: false,
        }}
        selection={{
          selectedIds: new Set(),
          onToggle: vi.fn(),
          onToggleAll,
        }}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A1" } });

    expect(onChange).toHaveBeenLastCalledWith("A1");
    expect(screen.getByRole("status").textContent).toContain("Searching…");
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(screen.getByRole("button", { name: "Export" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Select all rows" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(onToggleAll).not.toHaveBeenCalled();
  });

  it("keeps stale row actions disabled when the replacement search fails", () => {
    setViewport(1280);
    render(
      <DataTable
        tableId="failed-search-orders"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        error="Search failed"
        selection={{ selectedIds: new Set(), onToggle: vi.fn(), onToggleAll: vi.fn() }}
      />,
    );

    expect(screen.getByRole("button", { name: "Export" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Select all rows" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("2 rows")).toBeNull();
  });

  it("states whether search covers the server set or only loaded rows", () => {
    setViewport(1280);
    const { rerender } = render(
      <DataTable
        tableId="search-scope"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        search={{ value: "", onChange: vi.fn(), scope: "server", totalRecords: 200 }}
      />,
    );
    expect(screen.getByText(/Searches across all pages you can access/)).toBeTruthy();
    expect(screen.getByText(/200 records/)).toBeTruthy();

    rerender(
      <DataTable
        tableId="search-scope"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        search={{ value: "", onChange: vi.fn() }}
      />,
    );
    expect(screen.getByText("Searches loaded rows only")).toBeTruthy();
  });

  it("does not show a stale result count while replacement results are pending", () => {
    setViewport(1280);
    render(
      <DataTable
        tableId="search-scope-pending"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        search={{
          value: "A1",
          onChange: vi.fn(),
          searching: true,
          scope: "server",
          totalRecords: 200,
        }}
      />,
    );
    expect(screen.getByText("Searches across all pages you can access")).toBeTruthy();
    expect(screen.queryByText(/200 matches/)).toBeNull();
  });

  it("does not announce zero records before the first server count settles", () => {
    setViewport(1280);
    render(
      <DataTable
        tableId="search-scope-initial-count"
        rows={[]}
        columns={columns}
        getRowKey={(row) => row.id}
        search={{
          value: "",
          onChange: vi.fn(),
          searching: false,
          countPending: true,
          scope: "server",
          totalRecords: 0,
        }}
      />,
    );
    expect(screen.getByText("Searches across all pages you can access")).toBeTruthy();
    expect(screen.queryByText(/0 records/)).toBeNull();
  });
});

describe("DataTable column reorder", () => {
  /* Four columns whose LABELS sort A-Z into a different order than the table
     order (Alpha, Delta, Charlie, Bravo). That gap is the whole point: PR #1169
     sorted the Columns drawer A-Z on top of the drag added in #1004, and the
     drop then read its target index out of the STORAGE order while the operator
     was pointing at the ALPHABETICAL one — so the column landed somewhere the
     operator never pointed. Anything that re-introduces that mismatch fails
     these tests. */
  const reorderCols: Column<Row>[] = [
    { key: "a", label: "Alpha", render: (r) => r.name },
    { key: "d", label: "Delta", render: (r) => r.name },
    { key: "c", label: "Charlie", render: (r) => r.name },
    { key: "b", label: "Bravo", render: (r) => r.name },
  ];

  const headerLabels = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent?.trim());

  function dragOnto(source: Element, target: Element) {
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    fireEvent.dragEnd(source, { dataTransfer });
  }

  it("moves a column to where it was dropped when a header is dragged", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable
        tableId="reorder-header"
        rows={rows.slice(0, 2)}
        columns={reorderCols}
        getRowKey={(row) => row.id}
      />,
    );
    expect(headerLabels(container)).toEqual(["Alpha", "Delta", "Charlie", "Bravo"]);

    const th = (label: string) =>
      Array.from(container.querySelectorAll("thead th")).find(
        (el) => el.textContent?.trim() === label,
      )!;
    dragOnto(th("Bravo"), th("Alpha"));

    expect(headerLabels(container)).toEqual(["Bravo", "Alpha", "Delta", "Charlie"]);
  });

  it("does not also cycle the sort when a header drag ends in a click", () => {
    setViewport(1280);
    const sortable: Column<Row>[] = reorderCols.map((c) => ({ ...c, getValue: (r: Row) => r.name }));
    const { container } = render(
      <DataTable
        tableId="reorder-no-sort"
        rows={rows.slice(0, 2)}
        columns={sortable}
        getRowKey={(row) => row.id}
      />,
    );
    const th = (label: string) =>
      Array.from(container.querySelectorAll("thead th")).find(
        (el) => el.textContent?.trim().startsWith(label),
      )!;

    dragOnto(th("Bravo"), th("Alpha"));
    fireEvent.click(th("Bravo"));

    expect(JSON.parse(localStorage.getItem("dt:sort:reorder-no-sort") ?? "null")).toBeNull();
  });

  it("drops a drawer row where the operator pointed, not at its storage index", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable
        tableId="reorder-drawer"
        rows={rows.slice(0, 2)}
        columns={reorderCols}
        getRowKey={(row) => row.id}
      />,
    );
    fireEvent.click(screen.getByTitle(/^Columns —/));

    const drawerRow = (label: string) =>
      Array.from(document.querySelectorAll("div[draggable='true']")).find(
        (el) => el.textContent?.includes(label),
      )!;
    dragOnto(drawerRow("Bravo"), drawerRow("Alpha"));

    expect(headerLabels(container)).toEqual(["Bravo", "Alpha", "Delta", "Charlie"]);
  });

  it("cannot be dragged while a search is filtering the list", () => {
    setViewport(1280);
    render(
      <DataTable
        tableId="reorder-az"
        rows={rows.slice(0, 2)}
        columns={reorderCols}
        getRowKey={(row) => row.id}
      />,
    );
    fireEvent.click(screen.getByTitle(/^Columns —/));
    expect(document.querySelectorAll("[title='Drag to reorder']").length).toBe(4);

    fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "a" } });

    expect(document.querySelectorAll("div[draggable='true']").length).toBe(0);
  });
});

describe("DataTable layout presets", () => {
  /* Two companies read the same list differently (owner 2026-08-01: the 2990
     Sales Order view vs the Houzs one), so a page can declare named layouts and
     mark one as this company's default. "Sales Layout" below is deliberately
     IDENTICAL to what the column flags produce on their own — that is the case
     where a stored pick could be mistaken for "never customised" and snap back
     to the other company's default. */
  const presetCols: Column<Row>[] = [
    { key: "a", label: "Alpha", render: (r) => r.name },
    { key: "b", label: "Bravo", render: (r) => r.name },
    { key: "c", label: "Charlie", defaultHidden: true, render: (r) => r.name },
    { key: "d", label: "Delta", render: (r) => r.name },
  ];
  const presets = [
    { id: "ops", label: "Ops Layout", isDefault: true, columns: ["b", "c"] },
    { id: "sales", label: "Sales Layout", columns: ["a", "b", "d"] },
  ];
  const headerLabels = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent?.trim());

  it("starts an untouched table on the default preset, not on the column flags", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable
        tableId="preset-default"
        layoutPresets={presets}
        rows={rows.slice(0, 2)}
        columns={presetCols}
        getRowKey={(row) => row.id}
      />,
    );

    expect(headerLabels(container)).toEqual(["Bravo", "Charlie"]);
  });

  it("leaves an already-customised table alone", () => {
    setViewport(1280);
    localStorage.setItem("dt:hidden:preset-stored", JSON.stringify(["d"]));

    const { container } = render(
      <DataTable
        tableId="preset-stored"
        layoutPresets={presets}
        rows={rows.slice(0, 2)}
        columns={presetCols}
        getRowKey={(row) => row.id}
      />,
    );

    expect(headerLabels(container)).toEqual(["Alpha", "Bravo"]);
  });

  it("applies a picked layout as ordinary column prefs", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable
        tableId="preset-apply"
        layoutPresets={presets}
        rows={rows.slice(0, 2)}
        columns={presetCols}
        getRowKey={(row) => row.id}
      />,
    );

    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getByRole("button", { name: /^Layout/ }));
    fireEvent.click(screen.getByRole("option", { name: /Sales Layout/ }));

    expect(headerLabels(container)).toEqual(["Alpha", "Bravo", "Delta"]);
    expect(JSON.parse(localStorage.getItem("dt:order:preset-apply")!)).toEqual(["a", "b", "d", "c"]);
    expect(JSON.parse(localStorage.getItem("dt:hidden:preset-apply")!)).toEqual(["c"]);
  });

  it("keeps a picked layout that happens to equal the column defaults", () => {
    setViewport(1280);
    render(
      <DataTable
        tableId="preset-equal"
        layoutPresets={presets}
        rows={rows.slice(0, 2)}
        columns={presetCols}
        getRowKey={(row) => row.id}
      />,
    );
    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getByRole("button", { name: /^Layout/ }));
    fireEvent.click(screen.getByRole("option", { name: /Sales Layout/ }));
    cleanup();

    const { container } = render(
      <DataTable
        tableId="preset-equal"
        layoutPresets={presets}
        rows={rows.slice(0, 2)}
        columns={presetCols}
        getRowKey={(row) => row.id}
      />,
    );
    expect(headerLabels(container)).toEqual(["Alpha", "Bravo", "Delta"]);
  });

  it("names the active layout, and says 'edited' once it no longer matches", () => {
    setViewport(1280);
    render(
      <DataTable
        tableId="preset-active"
        layoutPresets={presets}
        rows={rows.slice(0, 2)}
        columns={presetCols}
        getRowKey={(row) => row.id}
      />,
    );
    fireEvent.click(screen.getByTitle(/^Columns —/));

    const picker = screen.getByRole("button", { name: /^Layout/ });
    expect(picker.textContent).toContain("Ops Layout");
    expect(screen.getByText(/of .* shown/).textContent).not.toContain("edited");

    fireEvent.click(picker);
    expect(
      screen.getByRole("option", { name: /Ops Layout/ }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getAllByRole("button", { name: "Hide column" })[0]!);

    expect(screen.getByText(/of .* shown/).textContent).toContain("edited");
    expect(screen.getByRole("button", { name: /^Layout/ }).textContent).toContain("Custom");
  });

  /* Owner 2026-08-14, on Purchase Orders under a "PO Outstanding" default: the
     GRN No checkbox would not tick. Alpha here is the same shape — hidden ONLY
     because the default layout omits it, carrying no `defaultHidden` flag of its
     own. The reveal used to write nothing at all (the hidden list was already
     empty, and the shown list is only written for a flagged column), leaving the
     baseline in charge and the column hidden. Every hidden column on a list whose
     defaults live entirely in a saved layout was un-tickable. */
  it("reveals a column the default layout hides but the column flags don't", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable
        tableId="preset-reveal"
        layoutPresets={presets}
        rows={rows.slice(0, 2)}
        columns={presetCols}
        getRowKey={(row) => row.id}
      />,
    );
    expect(headerLabels(container)).toEqual(["Bravo", "Charlie"]);

    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getAllByRole("button", { name: "Show column" })[0]!);

    expect(headerLabels(container)).toEqual(["Bravo", "Charlie", "Alpha"]);
    expect(JSON.parse(localStorage.getItem("dt:order:preset-reveal")!)).toEqual(["b", "c", "a", "d"]);
    expect(JSON.parse(localStorage.getItem("dt:hidden:preset-reveal")!)).toEqual(["d"]);
  });

  it("hiding one column under a default doesn't unhide the rest on remount", () => {
    setViewport(1280);
    render(
      <DataTable
        tableId="preset-hide"
        layoutPresets={presets}
        rows={rows.slice(0, 2)}
        columns={presetCols}
        getRowKey={(row) => row.id}
      />,
    );
    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getAllByRole("button", { name: "Hide column" })[0]!);
    cleanup();

    const { container } = render(
      <DataTable
        tableId="preset-hide"
        layoutPresets={presets}
        rows={rows.slice(0, 2)}
        columns={presetCols}
        getRowKey={(row) => row.id}
      />,
    );
    expect(headerLabels(container)).toEqual(["Charlie"]);
  });

  it("Show all escapes the default layout too", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable
        tableId="preset-showall"
        layoutPresets={presets}
        rows={rows.slice(0, 2)}
        columns={presetCols}
        getRowKey={(row) => row.id}
      />,
    );
    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getByText("Show all"));

    expect(headerLabels(container)).toEqual(["Bravo", "Charlie", "Alpha", "Delta"]);
  });
});

describe("DataTable header filter + sort menu", () => {
  // status repeats (Open/Closed); name is unique per row. Both have getValue,
  // so both must expose the funnel now (owner 2026-07-24: every header).
  const openFunnel = (label: string) => {
    const btn = screen.getByTitle(`Filter & sort ${label}`);
    fireEvent.click(btn);
  };
  const rowCount = (container: HTMLElement) =>
    container.querySelectorAll("tbody tr[data-vrow]").length;

  it("shows a funnel on every getValue column, not only filterable ones", () => {
    setViewport(1280);
    render(
      <DataTable tableId="filter-ubiquity" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(screen.getByTitle("Filter & sort Order")).toBeTruthy();
    expect(screen.getByTitle("Filter & sort Status")).toBeTruthy();
  });

  it("narrows rows to the ticked value and restores them on Clear", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable tableId="filter-narrow" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(rowCount(container)).toBe(6);

    openFunnel("Status");
    fireEvent.click(screen.getByRole("checkbox", { name: /Open/ }));
    expect(rowCount(container)).toBe(3);

    fireEvent.click(screen.getByText("Clear"));
    expect(rowCount(container)).toBe(6);
  });

  it("Select all ticks every shown value; Invert flips the selection", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable tableId="filter-bulk" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );

    openFunnel("Status");
    fireEvent.click(screen.getByText("Select all"));
    expect(rowCount(container)).toBe(6);
    const boxes = () => screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes().every((b) => b.checked)).toBe(true);

    fireEvent.click(screen.getByText("Invert"));
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(rowCount(container)).toBe(6);
  });

  it("search limits the checklist without touching values outside it", () => {
    setViewport(1280);
    render(
      <DataTable tableId="filter-search" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    openFunnel("Status");
    fireEvent.click(screen.getByRole("checkbox", { name: /Closed/ }));
    fireEvent.change(screen.getByPlaceholderText("Search values…"), { target: { value: "Open" } });
    expect(screen.queryByRole("checkbox", { name: /Closed/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Open/ })).toBeTruthy();

    fireEvent.click(screen.getByText("Select all"));
    fireEvent.change(screen.getByPlaceholderText("Search values…"), { target: { value: "" } });
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.every((b) => b.checked)).toBe(true);
  });

  it("client-sorts a disableSort column on a server-sorted table without touching the server query", () => {
    setViewport(1280);
    const onSortChange = vi.fn();
    const serverCols: Column<Row>[] = [
      { key: "name", label: "Order", render: (r) => r.name, getValue: (r) => r.name },
      { key: "status", label: "Status", render: (r) => r.status, getValue: (r) => r.status, disableSort: true },
    ];
    const { container } = render(
      <DataTable
        tableId="server-client-fallback"
        rows={rows.slice(0, 6)}
        columns={serverCols}
        getRowKey={(r) => r.id}
        serverSort
        onSortChange={onSortChange}
      />,
    );
    expect(onSortChange).toHaveBeenCalledTimes(1);
    expect(onSortChange).toHaveBeenLastCalledWith(null);

    const statusTh = Array.from(container.querySelectorAll("thead th")).find(
      (el) => el.textContent?.trim().startsWith("Status"),
    )!;
    const statusColumn = () =>
      Array.from(container.querySelectorAll("tbody tr[data-vrow]")).map(
        (tr) => tr.querySelectorAll("td")[1]?.textContent?.trim(),
      );
    fireEvent.click(statusTh);
    expect(statusColumn()).toEqual(["Closed", "Closed", "Closed", "Open", "Open", "Open"]);
    fireEvent.click(statusTh);
    expect(statusColumn()).toEqual(["Open", "Open", "Open", "Closed", "Closed", "Closed"]);
    expect(onSortChange).toHaveBeenCalledTimes(1);

    const nameTh = Array.from(container.querySelectorAll("thead th")).find(
      (el) => el.textContent?.trim().startsWith("Order"),
    )!;
    fireEvent.click(nameTh);
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "name", dir: "asc" });
  });

  it("clips cell overflow with an ellipsis and carries the full text on title", () => {
    setViewport(1280);
    const clipCols: Column<Row>[] = [
      { key: "name", label: "Order", width: "80px", render: (r) => r.name, getValue: (r) => r.name },
    ];
    const { container } = render(
      <DataTable tableId="clip-cells" rows={rows.slice(0, 2)} columns={clipCols} getRowKey={(r) => r.id} />,
    );
    const td = container.querySelector<HTMLElement>("tbody tr[data-vrow] td")!;
    expect(td.className).toContain("overflow-hidden");
    expect(td.className).toContain("text-ellipsis");
    expect(td.className).toContain("whitespace-nowrap");
    expect(td.style.maxWidth).toBe("80px");
    expect(td.getAttribute("title")).toBe("Order 1");
    const th = container.querySelector<HTMLElement>("thead th")!;
    expect(th.className).toContain("overflow-hidden");
    expect(th.style.maxWidth).toBe("80px");
  });

  it("Sort A→Z / Z→A order the rows and persist the direction", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable tableId="filter-sort" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    const firstName = () =>
      container.querySelector("tbody tr[data-vrow] td")?.textContent?.trim();

    openFunnel("Order");
    fireEvent.click(screen.getByText("Sort Z → A"));
    expect(JSON.parse(localStorage.getItem("dt:sort:filter-sort") ?? "null")).toEqual({
      key: "name",
      dir: "desc",
    });
    expect(firstName()).toBe("Order 6");
  });

  it("stays open while its own checklist scrolls, and while the page scrolls", () => {
    setViewport(1280);
    render(
      <DataTable tableId="filter-scroll" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    openFunnel("Status");
    const menu = screen.getByPlaceholderText("Search values…").closest("div.fixed")!;
    fireEvent.scroll(menu.querySelector(".overflow-y-auto")!);
    expect(screen.queryByPlaceholderText("Search values…")).toBeTruthy();
    fireEvent.scroll(document);
    expect(screen.queryByPlaceholderText("Search values…")).toBeTruthy();
  });

  /* Owner 2026-09-16 ("进入那个东西都是不要 filter 先的"): a funnel set this visit
     survives a client-side remount (drilling into a record and back), but it
     never reaches localStorage, so a fresh page load opens clean. */
  it("keeps a funnel across a remount this visit, without touching localStorage", () => {
    setViewport(1280);
    const { container, unmount } = render(
      <DataTable tableId="filter-visit" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    openFunnel("Status");
    fireEvent.click(screen.getByRole("checkbox", { name: /Open/ }));
    expect(rowCount(container)).toBe(3);
    expect(localStorage.getItem("dt:filters:filter-visit")).toBeNull();

    unmount();
    const second = render(
      <DataTable tableId="filter-visit" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(rowCount(second.container)).toBe(3);
    expect(screen.getByTitle("Filter & sort Status").className).toContain("text-accent");
    openFunnel("Status");
    fireEvent.click(screen.getByText("Clear"));
    expect(rowCount(second.container)).toBe(6);
    second.unmount();
    const third = render(
      <DataTable tableId="filter-visit" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(rowCount(third.container)).toBe(6);
  });

  it("opens clean on a fresh load and erases a stale localStorage funnel", () => {
    setViewport(1280);
    localStorage.setItem("dt:filters:filter-fresh", JSON.stringify({ status: ["Open"] }));
    resetInVisitColFilters();
    const { container } = render(
      <DataTable tableId="filter-fresh" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(rowCount(container)).toBe(6);
    expect(screen.getByTitle("Filter & sort Status").className).not.toContain("text-accent");
    expect(localStorage.getItem("dt:filters:filter-fresh")).toBeNull();
  });

  /* SKU Master (owner 2026-09-15): a remembered funnel made his catalogue look
     short and hid the row he had just renamed. persistFilters={false} opens with
     no filter every time and erases the one an earlier visit saved. */
  it("persistFilters={false} filters for this visit only and erases a saved filter", () => {
    setViewport(1280);
    localStorage.setItem("dt:filters:filter-session", JSON.stringify({ status: ["Open"] }));
    const first = render(
      <DataTable tableId="filter-session" persistFilters={false} rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(rowCount(first.container)).toBe(6);
    expect(localStorage.getItem("dt:filters:filter-session")).toBeNull();

    openFunnel("Status");
    fireEvent.click(screen.getByRole("checkbox", { name: /Open/ }));
    expect(rowCount(first.container)).toBe(3);
    expect(localStorage.getItem("dt:filters:filter-session")).toBeNull();

    first.unmount();
    const second = render(
      <DataTable tableId="filter-session" persistFilters={false} rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(rowCount(second.container)).toBe(6);
  });

  /* The sticky funnel is the one filter with no representation outside the
     header that set it: owner 2026-08-14, a Purchaser reported 5 of 60 POs
     missing — his own funnel, months old, on a machine whose localStorage the
     owner's login never touched. So the toolbar Reset must see column filters,
     on the lists that pass no `resetFilters` of their own too. */
  it("offers a toolbar Reset for a sticky column filter, and clears it", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable tableId="filter-reset" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(screen.queryByTitle("Clear all filters and search")).toBeNull();

    openFunnel("Status");
    fireEvent.click(screen.getByRole("checkbox", { name: /Open/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(rowCount(container)).toBe(3);

    const reset = screen.getByTitle("Clear all filters and search");
    fireEvent.click(reset);
    expect(rowCount(container)).toBe(6);
    expect(localStorage.getItem("dt:filters:filter-reset")).toBeNull();
    expect(screen.queryByTitle("Clear all filters and search")).toBeNull();
  });

  /* Delivery Planning (owner 2026-10-05): a name typed in the search box
     offered no Reset, while Sales Orders (page-controlled search) did. The
     grid-owned search box now counts, and the one click clears it. */
  it("offers the toolbar Reset for client search text, and clears it", async () => {
    setViewport(1280);
    const { container } = render(
      <DataTable tableId="search-reset" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} clientSearch={{ placeholder: "Find" }} />,
    );
    expect(screen.queryByTitle("Clear all filters and search")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Find"), { target: { value: "Order 2" } });
    await waitFor(() => expect(rowCount(container)).toBe(1));

    fireEvent.click(screen.getByTitle("Clear all filters and search"));
    await waitFor(() => expect(rowCount(container)).toBe(6));
    expect((screen.getByPlaceholderText("Find") as HTMLInputElement).value).toBe("");
    expect(screen.queryByTitle("Clear all filters and search")).toBeNull();
  });

  it("folds column filters into a page-owned Reset instead of shadowing it", () => {
    setViewport(1280);
    const onReset = vi.fn();
    const { container } = render(
      <DataTable
        tableId="filter-reset-page"
        rows={rows.slice(0, 6)}
        columns={columns}
        getRowKey={(r) => r.id}
        resetFilters={{ active: false, onReset, label: "Reset layout" }}
      />,
    );
    openFunnel("Status");
    fireEvent.click(screen.getByRole("checkbox", { name: /Open/ }));
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByText("Reset layout"));
    expect(rowCount(container)).toBe(6);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("ignores any leftover localStorage funnel instead of applying or crashing on it", () => {
    setViewport(1280);
    localStorage.setItem(
      "dt:filters:filter-corrupt",
      JSON.stringify({ status: ["Open"], name: [1, 2], "": ["x"] }),
    );
    const { container } = render(
      <DataTable tableId="filter-corrupt" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(rowCount(container)).toBe(6);
    expect(localStorage.getItem("dt:filters:filter-corrupt")).toBeNull();
  });

  /* The delivery planning boards (owner 2026-10-05): the queue a planner
     narrowed yesterday is still narrowed today. persistFilters="always" keeps
     the funnel in localStorage (dt:funnels:*), so a fresh bundle evaluation
     reads it back; clearing the funnel removes the key. */
  it('persistFilters="always" keeps a funnel across a fresh page load and drops the key on Clear', () => {
    setViewport(1280);
    const first = render(
      <DataTable tableId="filter-kept" persistFilters="always" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    openFunnel("Status");
    fireEvent.click(screen.getByRole("checkbox", { name: /Open/ }));
    expect(rowCount(first.container)).toBe(3);
    expect(JSON.parse(localStorage.getItem("dt:funnels:filter-kept") ?? "null")).toEqual({ status: ["Open"] });
    first.unmount();

    resetInVisitColFilters();
    const second = render(
      <DataTable tableId="filter-kept" persistFilters="always" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(rowCount(second.container)).toBe(3);
    expect(screen.getByTitle("Filter & sort Status").className).toContain("text-accent");

    openFunnel("Status");
    fireEvent.click(screen.getByText("Clear"));
    expect(rowCount(second.container)).toBe(6);
    expect(localStorage.getItem("dt:funnels:filter-kept")).toBeNull();
  });

  /* A name typed in the search box above the delivery board was gone after
     opening an order and coming back, while the funnel next to it stayed
     (owner 2026-10-05). The text now rides the same in-visit memory. */
  it("remembers the client search text across a remount this visit, and opens clean after a page load", async () => {
    setViewport(1280);
    const first = render(
      <DataTable tableId="search-kept" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} clientSearch={{ placeholder: "Find" }} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Find"), { target: { value: "Order 2" } });
    await waitFor(() => expect(rowCount(first.container)).toBe(1));
    first.unmount();

    const second = render(
      <DataTable tableId="search-kept" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} clientSearch={{ placeholder: "Find" }} />,
    );
    expect((screen.getByPlaceholderText("Find") as HTMLInputElement).value).toBe("Order 2");
    await waitFor(() => expect(rowCount(second.container)).toBe(1));
    second.unmount();

    resetInVisitColFilters();
    const third = render(
      <DataTable tableId="search-kept" rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} clientSearch={{ placeholder: "Find" }} />,
    );
    expect((screen.getByPlaceholderText("Find") as HTMLInputElement).value).toBe("");
    expect(rowCount(third.container)).toBe(6);
  });

  it("persistFilters={false} forgets the client search text on remount", async () => {
    setViewport(1280);
    const first = render(
      <DataTable tableId="search-mount" persistFilters={false} rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} clientSearch={{ placeholder: "Find" }} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Find"), { target: { value: "Order 2" } });
    await waitFor(() => expect(rowCount(first.container)).toBe(1));
    first.unmount();
    const second = render(
      <DataTable tableId="search-mount" persistFilters={false} rows={rows.slice(0, 6)} columns={columns} getRowKey={(r) => r.id} clientSearch={{ placeholder: "Find" }} />,
    );
    expect((screen.getByPlaceholderText("Find") as HTMLInputElement).value).toBe("");
    expect(rowCount(second.container)).toBe(6);
  });
});

describe("DataTable windowing with expandable rows", () => {
  const expandable = {
    render: (row: Row) => <div data-testid={`detail-${row.id}`}>detail for {row.name}</div>,
  };

  it("windows a COLLAPSED expandable table instead of rendering every row", () => {
    setViewport(1280);

    const { container } = render(
      <DataTable
        tableId="expandable-collapsed"
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        expandable={expandable}
      />,
    );

    const rendered = container.querySelectorAll("tr[data-vrow]").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(rows.length);
  });

  it("falls back to a FULL render while a row is open, and windows again on collapse", () => {
    setViewport(1280);

    const { container } = render(
      <DataTable
        tableId="expandable-toggle"
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        expandable={expandable}
      />,
    );

    const windowed = container.querySelectorAll("tr[data-vrow]").length;
    expect(windowed).toBeLessThan(rows.length);

    fireEvent.click(screen.getAllByLabelText("Expand row")[0]);

    expect(container.querySelectorAll("tr[data-vrow]").length).toBe(rows.length);
    expect(screen.getByTestId("detail-1")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Collapse row"));

    expect(container.querySelectorAll("tr[data-vrow]").length).toBe(windowed);
    expect(screen.queryByTestId("detail-1")).toBeNull();
  });

  it("leaves a SHORT expandable table alone — below the threshold nothing changes", () => {
    setViewport(1280);

    const { container } = render(
      <DataTable
        tableId="expandable-short"
        rows={rows.slice(0, 10)}
        columns={columns}
        getRowKey={(row) => row.id}
        expandable={expandable}
      />,
    );

    expect(container.querySelectorAll("tr[data-vrow]").length).toBe(10);
  });
});

/* The cancelled-row treatment (owner 2026-08-02) mutes a row AND its
   drill-down: the class from getRowClassName must land on the expanded
   sub-<tr> too, or the expansion under a faded row pops back to full
   strength — live-looking lines on a dead document. */
describe("DataTable getRowClassName with expandable rows", () => {
  it("puts the row class on the expanded sub-row as well", () => {
    setViewport(1280);

    const { container } = render(
      <DataTable
        tableId="rowclass-expansion"
        rows={rows.slice(0, 3)}
        columns={columns}
        getRowKey={(row) => row.id}
        getRowClassName={(row) => (row.id === 1 ? "dt-row-cancelled" : undefined)}
        expandable={{
          render: (row) => <div data-testid={`detail-${row.id}`}>detail for {row.name}</div>,
        }}
      />,
    );

    expect(container.querySelectorAll("tr.dt-row-cancelled").length).toBe(1);

    fireEvent.click(screen.getAllByLabelText("Expand row")[0]);

    expect(container.querySelectorAll("tr.dt-row-cancelled").length).toBe(2);
    expect(screen.getByTestId("detail-1").closest("tr")?.className).toContain(
      "dt-row-cancelled",
    );
  });
});

// ── A stored sort must not outlive "Reset" ───────────────────────────────────
//
// Owner, 2026-08-04, on the Delivery Orders list opening oldest-first every
// single time: "为什么当我打开这个系统的一瞬间，它不是默认自动 sort 那个
// documentation 呢？"
//
// The backend's default IS newest-first (`do_date` DESC). It never got a chance:
// DataTable persists the sort per table in `dt:sort:<id>` and replays it on
// mount, so a column clicked once — months ago — becomes the permanent default
// for that browser. And `resetLayout()` cleared visibility and order but NOT the
// sort, so the one control named for undoing a layout could not undo its most
// visible part.
describe("Sort is persisted, and Reset must clear it", () => {
  const renderSorted = (onSortChange: (s: unknown) => void) =>
    render(
      <DataTable
        tableId="sort-persist"
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        serverSort
        onSortChange={onSortChange}
      />,
    );

  it("replays a sort stored in localStorage on mount — the stickiness itself", () => {
    localStorage.setItem("dt:sort:sort-persist", JSON.stringify({ key: "name", dir: "asc" }));
    const onSortChange = vi.fn();
    renderSorted(onSortChange);
    expect(onSortChange).toHaveBeenCalledWith({ key: "name", dir: "asc" });
  });

  it("reports null when nothing is stored, so the backend default applies", () => {
    const onSortChange = vi.fn();
    renderSorted(onSortChange);
    expect(onSortChange).toHaveBeenCalledWith(null);
  });

  it("Reset clears the stored sort and tells the parent to fall back", () => {
    localStorage.setItem("dt:sort:sort-persist", JSON.stringify({ key: "name", dir: "asc" }));
    const onSortChange = vi.fn();
    renderSorted(onSortChange);
    onSortChange.mockClear();

    fireEvent.click(screen.getByTitle(/^Columns —/));
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    expect(onSortChange).toHaveBeenCalledWith(null);
    const stored = localStorage.getItem("dt:sort:sort-persist");
    expect(stored === null || stored === "null").toBe(true);
  });
});

describe("DataTable onColFiltersChange (server-side funnel push)", () => {
  /* Owner 2026-09-16 — a server-paged list pushes its SERVER-FILTERABLE funnels
     into the list query so pagination runs over the filtered set. The grid still
     owns the funnels (in-visit); it just REPORTS them so the page can build the
     query (mirrors onSortChange + serverSort). */
  it("reports a restored funnel on mount", async () => {
    setViewport(1280);
    primeInVisitColFilters("ccf-mount", { status: ["Open"] });
    const seen: Record<string, string[]>[] = [];
    render(
      <DataTable
        tableId="ccf-mount"
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        onColFiltersChange={(cf) => seen.push(cf)}
      />,
    );
    await waitFor(() => expect(seen.at(-1)).toEqual({ status: ["Open"] }));
  });

  it("reports an empty object when no funnel is set", async () => {
    setViewport(1280);
    const seen: Record<string, string[]>[] = [];
    render(
      <DataTable
        tableId="ccf-empty"
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        onColFiltersChange={(cf) => seen.push(cf)}
      />,
    );
    await waitFor(() => expect(seen.at(-1)).toEqual({}));
  });

  it("reports the new funnel when a value is ticked in the popover", async () => {
    setViewport(1280);
    const seen: Record<string, string[]>[] = [];
    render(
      <DataTable
        tableId="ccf-tick"
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        onColFiltersChange={(cf) => seen.push(cf)}
      />,
    );
    fireEvent.click(screen.getByTitle("Filter & sort Status"));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Open/ }));
    await waitFor(() => expect(seen.at(-1)).toEqual({ status: ["Open"] }));
  });
});

/* A row's own colour must reach the screen (owner 2026-09-15, MRP: "之前是有一点
   看到颜色的"). The zebra class sits on the same <tr> as a row's colour, and in
   the built stylesheet `.bg-surface` / `.bg-surface-dim/35` come AFTER
   `.bg-primary/10`, `.bg-primary-soft` and `.bg-err-bg` — equal specificity, so
   the zebra won and a ticked row or a caller's tone never painted. A row that
   has its own background therefore carries no zebra class at all. */
describe("DataTable row colours are not overpainted by the zebra", () => {
  const zebra = /(^|\s)bg-surface(-dim\/35)?(\s|$)/;
  const dataRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr[data-vrow]"));

  it("a ticked row carries the selected tint and no zebra class", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable
        tableId="row-tone-selected"
        rows={rows.slice(0, 3)}
        columns={columns}
        getRowKey={(row) => row.id}
        selection={{ selectedIds: new Set(["2"]), onToggle: () => {}, onToggleAll: () => {} }}
      />,
    );
    const [first, second] = dataRows(container);
    expect(second!.className).toContain("bg-primary/10");
    expect(second!.className).not.toMatch(zebra);
    expect(first!.className).toMatch(zebra);
  });

  it("a getRowClassName background replaces the zebra; a non-background class keeps it", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable
        tableId="row-tone-custom"
        rows={rows.slice(0, 3)}
        columns={columns}
        getRowKey={(row) => row.id}
        getRowClassName={(row) => (row.id === 1 ? "bg-err-bg" : row.id === 2 ? "opacity-60" : undefined)}
      />,
    );
    const [toned, faded, plain] = dataRows(container);
    expect(toned!.className).toContain("bg-err-bg");
    expect(toned!.className).not.toMatch(zebra);
    expect(faded!.className).toMatch(zebra);
    expect(plain!.className).toMatch(zebra);
  });

  it("the phone card follows the same rule", () => {
    setViewport(375);
    const { container } = render(
      <DataTable
        tableId="row-tone-card"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        getRowClassName={(row) => (row.id === 1 ? "bg-err-bg" : undefined)}
      />,
    );
    const [toned, plain] = Array.from(container.querySelectorAll<HTMLElement>("[data-mobile-card]"));
    expect(toned!.className).toContain("bg-err-bg");
    expect(toned!.className).not.toMatch(zebra);
    expect(plain!.className).toMatch(zebra);
  });
});

/* Document line tables (owner 2026-09-15: "我看到的东西，我要去 edit 的时候，突然它
   位置不见了"). A line table's layout is shared by every document of its kind,
   and so were its sort and funnels: a header clicked on one Sales Order re-sorted
   the lines of every order opened after it, while the editor behind Edit shows
   the document's own line order. persistSort={false} keeps a sort for this visit. */
describe("persistSort={false} sorts for this visit only", () => {
  const names = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("tbody tr[data-vrow] td:first-child")).map((td) => td.textContent);

  it("ignores and erases a stored sort, and never stores a new one", () => {
    setViewport(1280);
    localStorage.setItem("dt:sort:lines-session", JSON.stringify({ key: "name", dir: "desc" }));
    const three = rows.slice(0, 3);
    const first = render(
      <DataTable tableId="lines-session" persistSort={false} rows={three} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(names(first.container)).toEqual(["Order 1", "Order 2", "Order 3"]);
    expect(localStorage.getItem("dt:sort:lines-session")).toBeNull();

    fireEvent.click(screen.getByRole("columnheader", { name: /Order/ }));
    fireEvent.click(screen.getByRole("columnheader", { name: /Order/ }));
    expect(names(first.container)).toEqual(["Order 3", "Order 2", "Order 1"]);
    expect(localStorage.getItem("dt:sort:lines-session")).toBeNull();

    first.unmount();
    const second = render(
      <DataTable tableId="lines-session" persistSort={false} rows={three} columns={columns} getRowKey={(r) => r.id} />,
    );
    expect(names(second.container)).toEqual(["Order 1", "Order 2", "Order 3"]);
  });
});

describe("DataTable initialRowLimit — first page + Load more (owner 2026-09-26)", () => {
  const fewRows: Row[] = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, name: `Order ${i + 1}`, status: "Open",
  }));

  it("renders the first N, reveals another N on Load more, and reports the FULL set", () => {
    setViewport(1280);
    const seen: Row[][] = [];
    render(
      <DataTable
        tableId="orders-limit"
        rows={fewRows}
        columns={columns}
        getRowKey={(row) => row.id}
        initialRowLimit={3}
        onFilteredRowsChange={(r) => seen.push(r)}
      />,
    );
    expect(screen.getByText("Order 1")).toBeTruthy();
    expect(screen.queryByText("Order 4")).toBeNull();
    expect(seen.at(-1)?.length).toBe(10);
    const more = screen.getByRole("button", { name: /7 more rows/ });

    fireEvent.click(more);
    expect(screen.getByText("Order 6")).toBeTruthy();
    expect(screen.queryByText("Order 7")).toBeNull();
    expect(screen.getByRole("button", { name: /4 more rows/ })).toBeTruthy();
  });

  it("shows no Load more when the prop is omitted — the whole set renders", () => {
    setViewport(1280);
    render(<DataTable tableId="orders-nolimit" rows={fewRows} columns={columns} getRowKey={(row) => row.id} />);
    expect(screen.queryByRole("button", { name: /more rows/ })).toBeNull();
    expect(screen.getByText("Order 10")).toBeTruthy();
  });
});

describe("DataTable onRowReorder — drag to reorder (owner 2026-09-26)", () => {
  const fewRows: Row[] = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, name: `Order ${i + 1}`, status: "Open" }));

  it("a drop reports the new order of the whole set, while no column sort is active", () => {
    setViewport(1280);
    const seen: string[][] = [];
    const { container } = render(
      <DataTable tableId="dt-reorder" rows={fewRows} columns={columns} getRowKey={(row) => row.id} onRowReorder={(keys) => seen.push(keys)} />,
    );
    const rows = container.querySelectorAll<HTMLElement>("tr[data-rowkey]");
    const dataTransfer = { effectAllowed: "", setData: () => {}, getData: () => "" };
    fireEvent.dragStart(rows[0], { dataTransfer });
    fireEvent.dragOver(rows[2], { dataTransfer, clientY: 100 });
    fireEvent.drop(rows[2], { dataTransfer });
    expect(seen.at(-1)).toEqual(["2", "1", "3"]);
  });

  it("without onRowReorder the rows are not draggable", () => {
    setViewport(1280);
    const { container } = render(
      <DataTable tableId="dt-noreorder" rows={fewRows} columns={columns} getRowKey={(row) => row.id} />,
    );
    const first = container.querySelector<HTMLElement>("tr[data-rowkey]");
    expect(first?.getAttribute("draggable")).not.toBe("true");
  });
});

describe("DataTable row-cell memoisation", () => {
  // The scroll-smoothness win (owner 2026-10-21 step 2): a row's data cells are
  // memoised on (row, columns, layout). When the table re-renders but none of
  // those inputs changed — which is exactly what a scroll-window update is, a
  // DataTable-internal state change that leaves rows / columns / layout alone —
  // the cells must NOT re-run their render. This is the memory for that
  // optimisation: if a future change hands the cells an unstable prop, the memo
  // stops skipping and the scroll lag returns, and this test fails.
  //
  // (A parent-driven re-render such as a selection toggle is NOT skipped — the
  // board re-creates its `selection` object, which ripples through DataTable's
  // layout memos; that path is kept cheap by the per-cell memoisation in step 1.
  // The scroll path, where the parent does not re-render, is the one this guards.)
  it("skips re-rendering row cells when the table re-renders with unchanged inputs", () => {
    setViewport(1280);
    const renderSpy = vi.fn((row: Row) => row.name);
    const memoCols: Column<Row>[] = [
      { key: "name", label: "Order", render: renderSpy, getValue: (row) => row.name },
      { key: "status", label: "Status", render: (row) => row.status, getValue: (row) => row.status },
    ];
    const smallRows = rows.slice(0, 5);
    const getRowKey = (row: Row) => row.id;
    let bump: () => void = () => {};
    function Wrapper() {
      const [, setTick] = useState(0);
      bump = () => setTick((t) => t + 1);
      return (
        <DataTable tableId="dt-cell-memo" rows={smallRows} columns={memoCols} getRowKey={getRowKey} />
      );
    }
    render(<Wrapper />);
    renderSpy.mockClear();
    act(() => { bump(); });
    expect(renderSpy).not.toHaveBeenCalled();
  });
});
