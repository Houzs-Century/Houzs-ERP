import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { GlobalSearchProvider, GlobalSearchTrigger } from "./GlobalSearch";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../api/client", () => ({
  api: { get: apiGet },
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderSearch() {
  return render(
    <MemoryRouter initialEntries={["/home"]}>
      <GlobalSearchProvider>
        <GlobalSearchTrigger />
        <LocationProbe />
      </GlobalSearchProvider>
    </MemoryRouter>,
  );
}

async function finishDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(250);
    await Promise.resolve();
  });
}

describe("GlobalSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiGet.mockReset();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("searches from the first character and follows visual order for keyboard navigation", async () => {
    apiGet.mockResolvedValue({
      hits: [
        { type: "project", id: 1, title: "A1 Project", link: "/projects/1" },
        { type: "user", id: 2, title: "A1 User", link: "/team/2" },
        { type: "sales_order", id: "SO-A1", title: "SO-A1", link: "/sales-orders/SO-A1" },
      ],
    });
    renderSearch();

    const trigger = screen.getByRole("button", { name: "Open global search" });
    fireEvent.click(trigger);
    const input = screen.getByRole("combobox", { name: /search orders/i });
    const dialog = screen.getByRole("dialog", { name: "Global search" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "A" } });
    expect(screen.getByRole("status").textContent).toContain("Searching for");
    await finishDebounce();
    expect(apiGet).toHaveBeenCalledWith("/api/search?q=A", expect.any(Object));

    fireEvent.change(input, { target: { value: "A1" } });
    expect(screen.getByRole("status").textContent).toContain("Searching for “A1”");
    await finishDebounce();
    expect(apiGet).toHaveBeenLastCalledWith("/api/search?q=A1", expect.any(Object));

    const listbox = screen.getByRole("listbox", { name: "Search results" });
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["SO-A1", "A1 Project", "A1 User"]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Enter" });
    expect(screen.getByTestId("location").textContent).toBe("/home");
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("location").textContent).toBe("/projects/1");
  });

  it("renders the SCM document sources and navigates each to its detail route by id", async () => {
    apiGet.mockResolvedValue({
      hits: [
        { type: "purchase_order", id: "po-1", title: "PO-0001", subtitle: "Acme Supplier", link: "/scm/purchase-orders/po-1" },
        { type: "grn", id: "grn-1", title: "GRN-0001", subtitle: "Acme Supplier · PO PO-0001", link: "/scm/grns/grn-1" },
        { type: "delivery_order", id: "do-1", title: "DO-0001", subtitle: "Beta Buyer", link: "/scm/delivery-orders/do-1" },
        { type: "sales_invoice", id: "si-1", title: "INV-0001", subtitle: "Beta Buyer", link: "/scm/sales-invoices/si-1" },
        { type: "purchase_invoice", id: "pi-1", title: "PINV-0001", subtitle: "Acme Supplier", link: "/scm/purchase-invoices/pi-1" },
      ],
    });
    renderSearch();
    fireEvent.click(screen.getByRole("button", { name: "Open global search" }));
    const input = screen.getByRole("combobox", { name: /search orders/i });
    fireEvent.change(input, { target: { value: "0001" } });
    await finishDebounce();

    const listbox = screen.getByRole("listbox", { name: "Search results" });
    // All five doc types render, in the group order defined by groupHits.
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "PO-0001Acme Supplier",
      "GRN-0001Acme Supplier · PO PO-0001",
      "DO-0001Beta Buyer",
      "INV-0001Beta Buyer",
      "PINV-0001Acme Supplier",
    ]);

    // Group headers carry the ERP labels.
    expect(screen.getByRole("group", { name: "Purchase Orders" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "GRNs" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Delivery Orders" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Sales Invoices" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Purchase Invoices" })).toBeTruthy();

    // A GRN hit opens its detail route by id (UUID param, not doc number).
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("location").textContent).toBe("/scm/grns/grn-1");
  });

  it("makes an older term impossible to see or open while the next term is pending", async () => {
    apiGet
      .mockResolvedValueOnce({
        hits: [{ type: "sales_order", id: "SO-A1", title: "SO-A1", link: "/sales-orders/SO-A1" }],
      })
      .mockResolvedValueOnce({
        hits: [{ type: "sales_order", id: "SO-A12", title: "SO-A12", link: "/sales-orders/SO-A12" }],
      });
    renderSearch();
    fireEvent.click(screen.getByRole("button", { name: "Open global search" }));
    const input = screen.getByRole("combobox", { name: /search orders/i });

    fireEvent.change(input, { target: { value: "A1" } });
    await finishDebounce();
    expect(screen.getByRole("option", { name: /SO-\s*A1/ })).toBeTruthy();

    fireEvent.change(input, { target: { value: "A12" } });
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Searching for “A12”");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("location").textContent).toBe("/home");

    await finishDebounce();
    expect(screen.getByRole("option", { name: /SO-\s*A12/ })).toBeTruthy();
  });

  it("traps focus and restores it to the opener when dismissed", () => {
    renderSearch();
    const trigger = screen.getByRole("button", { name: "Open global search" });
    trigger.focus();
    fireEvent.click(trigger);

    const input = screen.getByRole("combobox", { name: /search orders/i });
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });
    act(() => vi.runOnlyPendingTimers());
    expect(document.activeElement).toBe(trigger);
  });
});
