/* Search on the "Bill a Goods-Received Note" picker (owner 2026-09-14:
 * 「需要加上search button」, 494 lines across 197 notes).
 *
 * Mounts the real picker under a real router with only the data hook faked, the
 * same harness as convert-scope-pickers.test.tsx, and asserts what the operator
 * sees and what Continue would carry.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { outstandingGrnItems } = vi.hoisted(() => ({ outstandingGrnItems: vi.fn() }));

vi.mock("../../vendor/scm/lib/suppliers-queries", () => ({
  useOutstandingGrnItems: outstandingGrnItems,
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({
  useNotify: () => vi.fn(),
}));

import { PurchaseInvoiceFromGrn } from "./PurchaseInvoiceFromGrn";

afterEach(cleanup);

const grnLine = (over: Record<string, unknown>) => ({
  grnItemId: "x", grnId: "grn-65", grnDocNo: "HC-GRN-2609-065",
  supplierId: "sup-1", supplierName: "DIGLANT MANUFACTURING SDN BHD.", supplierCode: "400-D001",
  purchaseOrderId: null, poDocNo: "HC-PO-010068", receivedAt: "2026-09-12", currency: "MYR", exchangeRate: 1,
  itemCode: "AKEMI EQUINOX MATT (K)", itemGroup: "mattress", description: "AKEMI EQUINOX MATTRESS",
  variants: null, qtyAccepted: 1, remaining: 1, unitPriceSen: 130000,
  ...over,
});

const LINES = [
  grnLine({ grnItemId: "g65-1" }),
  grnLine({ grnItemId: "g66-1", grnId: "grn-66", grnDocNo: "HC-GRN-2609-066", poDocNo: "HC-PO-010069", itemCode: "AKEMI IMMORTAL MATT (K)", description: "AKEMI IMMORTAL MATTRESS" }),
  grnLine({ grnItemId: "g66-2", grnId: "grn-66", grnDocNo: "HC-GRN-2609-066", poDocNo: "HC-PO-010069", itemCode: "AKEMI MONARCH MATT (Q)", description: "AKEMI MONARCH MATTRESS" }),
  grnLine({ grnItemId: "g66-3", grnId: "grn-66", grnDocNo: "HC-GRN-2609-066", poDocNo: "HC-PO-010069", itemCode: "AKEMI IMMORTAL MATT (Q)", description: "AKEMI IMMORTAL MATTRESS" }),
];

const open = (url = "/scm/purchase-invoices/from-grn", truncated = false) => {
  outstandingGrnItems.mockReturnValue({ data: { items: LINES, truncated }, isLoading: false, isError: false });
  return render(
    <MemoryRouter initialEntries={[url]}>
      <PurchaseInvoiceFromGrn />
    </MemoryRouter>,
  );
};

const search = (value: string) =>
  fireEvent.change(screen.getByLabelText("Search outstanding GRN lines"), { target: { value } });

const lineCheckbox = (itemCode: string) => {
  const box = screen.getByText(itemCode).parentElement?.querySelector('input[type="checkbox"]');
  if (!box) throw new Error(`no checkbox on the ${itemCode} row`);
  return box;
};

describe("Bill a Goods-Received Note: search", () => {
  it("shows a search box on the full picker", () => {
    open();
    expect(screen.getByLabelText("Search outstanding GRN lines")).toBeTruthy();
    expect(screen.getByText("4 lines across 2 GRNs")).toBeTruthy();
    expect(screen.queryByText(/This list is not complete/)).toBeNull();
  });

  /* The server reads every note with something still to bill, up to a runaway
     ceiling, and flags the answer when it stops there. A short list that looks
     whole is exactly what the old newest-500 read produced in silence. */
  it("says the list is not complete when the server stopped reading at its ceiling", () => {
    open("/scm/purchase-invoices/from-grn", true);
    expect(screen.getByRole("alert").textContent).toMatch(/This list is not complete/);
    expect(screen.getByText("4 lines across 2 GRNs")).toBeTruthy();
  });

  it("typing narrows the cards to the matching lines and says how many of how many", () => {
    open();
    search("immortal");
    expect(screen.getByText("AKEMI IMMORTAL MATT (K)")).toBeTruthy();
    expect(screen.getByText("AKEMI IMMORTAL MATT (Q)")).toBeTruthy();
    expect(screen.queryByText("AKEMI MONARCH MATT (Q)")).toBeNull();
    expect(screen.queryByText("HC-GRN-2609-065")).toBeNull();
    expect(screen.getByText("2 of 4 lines across 1 GRN")).toBeTruthy();
  });

  it("every word must match, across the note and the line", () => {
    open();
    search("hc-po-010069 (q)");
    expect(screen.getByText("AKEMI MONARCH MATT (Q)")).toBeTruthy();
    expect(screen.getByText("AKEMI IMMORTAL MATT (Q)")).toBeTruthy();
    expect(screen.queryByText("AKEMI IMMORTAL MATT (K)")).toBeNull();
  });

  it("?q= in the link is applied on arrival and is not reported as a parameter the screen does not understand", () => {
    open("/scm/purchase-invoices/from-grn?q=HC-GRN-2609-066");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("Search outstanding GRN lines") as HTMLInputElement).value).toBe("HC-GRN-2609-066");
    expect(screen.queryByText("HC-GRN-2609-065")).toBeNull();
    expect(screen.getByText("AKEMI MONARCH MATT (Q)")).toBeTruthy();
  });

  it("the note's own tick box ticks only the lines the search is showing", () => {
    open("/scm/purchase-invoices/from-grn?q=immortal");
    fireEvent.click(screen.getByLabelText("HC-GRN-2609-066"));
    expect(screen.getByText(/Continue with 2 lines/)).toBeTruthy();
    search("");
    expect((lineCheckbox("AKEMI MONARCH MATT (Q)") as HTMLInputElement).checked).toBe(false);
  });

  it("a ticked line the search hides still goes forward, and the page says so", () => {
    open();
    fireEvent.click(lineCheckbox("AKEMI MONARCH MATT (Q)"));
    search("immortal");
    expect(screen.getByText(/Continue with 1 line/)).toBeTruthy();
    expect(screen.getByText("1 ticked line hidden by this search will still go forward when you Continue.")).toBeTruthy();
    search("");
    expect(screen.queryByText(/hidden by this search/)).toBeNull();
  });

  it("no match says what was searched, and clearing it brings every line back", () => {
    open();
    search("zzz-no-such-item");
    expect(screen.getByText(/No outstanding line matches/)).toBeTruthy();
    expect(screen.queryByText(/Once a GRN is posted/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(screen.getByText("4 lines across 2 GRNs")).toBeTruthy();
    expect((screen.getByLabelText("Search outstanding GRN lines") as HTMLInputElement).value).toBe("");
  });
});
