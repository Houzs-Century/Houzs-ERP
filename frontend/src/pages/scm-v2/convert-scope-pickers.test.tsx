/* The "Transfer to X" buttons that navigated and scoped nothing (2026-08-16).
 *
 * These are not "does the page call useSearchParams" assertions — each test
 * MOUNTS the real picker under a real router at the real URL its real caller
 * builds (via convertToLink, the same function the button uses), with only the
 * data hook faked, and asserts what the operator SEES: the document they came
 * from, and not the other one that was sitting next to it in the global list.
 *
 * Revert any one of the three source fixes and the matching test fails on the
 * stranger's row still being on screen.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToLink } from "../../lib/convertScope";

const { invoiceableDoLines, deliverableSoLines, outstandingGrnItems } = vi.hoisted(() => ({
  invoiceableDoLines: vi.fn(),
  deliverableSoLines: vi.fn(),
  outstandingGrnItems: vi.fn(),
}));

vi.mock("../../vendor/scm/lib/sales-invoice-queries", () => ({
  useInvoiceableDoLines: invoiceableDoLines,
}));
vi.mock("../../vendor/scm/lib/delivery-order-queries", () => ({
  useDeliverableSoLines: deliverableSoLines,
}));
vi.mock("../../vendor/scm/lib/suppliers-queries", () => ({
  useOutstandingGrnItems: outstandingGrnItems,
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({
  useNotify: () => vi.fn(),
}));

import { SalesInvoiceFromDo } from "./SalesInvoiceFromDo";
import { DeliveryOrderFromSo } from "./DeliveryOrderFromSo";
import { PurchaseInvoiceFromGrn } from "./PurchaseInvoiceFromGrn";

afterEach(cleanup);

const at = (url: string, node: React.ReactNode) =>
  render(<MemoryRouter initialEntries={[url]}>{node}</MemoryRouter>);

const loaded = <T,>(data: T) => ({ data, isLoading: false, isError: false });

/* ── DO → SI ─────────────────────────────────────────────────────────────── */

const doLine = (over: Record<string, unknown>) => ({
  doItemId: "x", deliveryOrderId: "do-1", doNumber: "HC-DO-0001",
  debtorCode: "C1", debtorName: "Ada", itemCode: "MAT-1", itemGroup: "mattress",
  description: "Mattress", description2: null, uom: "UNIT",
  delivered: 5, invoiced: 0, returned: 0, remaining: 5,
  unitPriceSen: 10000, unitCostSen: 5000, discountSen: 0, variants: null,
  ...over,
});

/* Both notes belong to the SAME customer on purpose: the customer lock would
   otherwise do the narrowing for us and the assertions could not tell a scoped
   picker from an unscoped one. */
const TWO_DOS = [
  doLine({ doItemId: "i-1", deliveryOrderId: "do-1", doNumber: "HC-DO-0001" }),
  doLine({ doItemId: "i-2", deliveryOrderId: "do-2", doNumber: "HC-DO-0002" }),
];

describe('DO → SI: "Transfer to Sales Invoice" lands on the note you came from', () => {
  it("shows only the scoped Delivery Order, not the whole company's", () => {
    invoiceableDoLines.mockReturnValue(loaded(TWO_DOS));
    at(convertToLink("doToSi", "do-1"), <SalesInvoiceFromDo />);
    expect(screen.getAllByText("HC-DO-0001").length).toBeGreaterThan(0);
    expect(screen.queryByText("HC-DO-0002")).toBeNull();
  });

  it("pre-ticks the scoped note so the screen is a draft, not a search", () => {
    invoiceableDoLines.mockReturnValue(loaded(TWO_DOS));
    at(convertToLink("doToSi", "do-1"), <SalesInvoiceFromDo />);
    expect(screen.getByText(/Continue with 1 line/)).toBeTruthy();
  });

  it("no parameter still opens the FULL picker", () => {
    invoiceableDoLines.mockReturnValue(loaded(TWO_DOS));
    at("/scm/sales-invoices/from-do", <SalesInvoiceFromDo />);
    expect(screen.getAllByText("HC-DO-0001").length).toBeGreaterThan(0);
    expect(screen.getAllByText("HC-DO-0002").length).toBeGreaterThan(0);
    expect(screen.getByText(/Pick at least 1 line/)).toBeTruthy();
  });

  it("a parameter it cannot act on is shown, never dropped", () => {
    invoiceableDoLines.mockReturnValue(loaded(TWO_DOS));
    at("/scm/sales-invoices/from-do?do=do-1", <SalesInvoiceFromDo />);
    expect(screen.getByRole("alert").textContent).toContain('"do"');
    // and it did NOT quietly scope on the unrecognised name
    expect(screen.getAllByText("HC-DO-0002").length).toBeGreaterThan(0);
  });
});

/* ── SO → DO ─────────────────────────────────────────────────────────────── */

const soLine = (over: Record<string, unknown>) => ({
  soItemId: "x", docNo: "HC-SO-0001", debtorCode: "C1", debtorName: "Ada",
  itemCode: "MAT-1", itemGroup: "mattress", description: "Mattress", description2: null,
  uom: "UNIT", qty: 5, unitPriceSen: 10000, unitCostSen: 5000, discountSen: 0,
  variants: null, delivered: 0, returned: 0, remaining: 5,
  ...over,
});

// Same customer on both orders — see the note on TWO_DOS.
const TWO_SOS = [
  soLine({ soItemId: "s-1", docNo: "HC-SO-0001" }),
  soLine({ soItemId: "s-2", docNo: "HC-SO-0002" }),
];

describe('SO → DO: "Deliver" lands on the order you came from', () => {
  it("shows only the scoped Sales Order", () => {
    deliverableSoLines.mockReturnValue(loaded(TWO_SOS));
    at(convertToLink("soToDo", "HC-SO-0001"), <DeliveryOrderFromSo />);
    expect(screen.getAllByText("HC-SO-0001").length).toBeGreaterThan(0);
    expect(screen.queryByText("HC-SO-0002")).toBeNull();
  });

  it("pre-ticks it", () => {
    deliverableSoLines.mockReturnValue(loaded(TWO_SOS));
    at(convertToLink("soToDo", "HC-SO-0001"), <DeliveryOrderFromSo />);
    expect(screen.getByText(/Continue with 1 line/)).toBeTruthy();
  });

  it("no parameter still opens the FULL picker", () => {
    deliverableSoLines.mockReturnValue(loaded(TWO_SOS));
    at("/scm/delivery-orders/from-so", <DeliveryOrderFromSo />);
    expect(screen.getAllByText("HC-SO-0002").length).toBeGreaterThan(0);
  });

  it("the OLD spelling is reported, not silently honoured", () => {
    deliverableSoLines.mockReturnValue(loaded(TWO_SOS));
    at("/scm/delivery-orders/from-so?so=HC-SO-0001", <DeliveryOrderFromSo />);
    expect(screen.getByRole("alert").textContent).toContain('"so"');
  });
});

/* ── GRN → PI ────────────────────────────────────────────────────────────── */

const grnLine = (over: Record<string, unknown>) => ({
  grnItemId: "x", grnId: "grn-1", grnDocNo: "HC-GR-0001",
  supplierId: "sup-1", supplierName: "Acme", supplierCode: "ACME", poDocNo: null,
  receivedAt: "2026-08-01", currency: "MYR", exchangeRate: 1,
  itemCode: "MAT-1", itemGroup: "mattress", description: "Mattress",
  variants: null, remaining: 5, unitPriceSen: 10000,
  ...over,
});

// Same supplier + currency on both notes — see the note on TWO_DOS. The
// supplier lock must not be what narrows the screen.
const TWO_GRNS = [
  grnLine({ grnItemId: "g-1", grnId: "grn-1", grnDocNo: "HC-GR-0001" }),
  grnLine({ grnItemId: "g-2", grnId: "grn-2", grnDocNo: "HC-GR-0002" }),
];

describe('GRN → PI: "Transfer to Purchase Invoice" lands on the note you came from', () => {
  it("shows only the scoped note", () => {
    outstandingGrnItems.mockReturnValue(loaded(TWO_GRNS));
    at(convertToLink("grnToPi", "grn-1"), <PurchaseInvoiceFromGrn />);
    expect(screen.getAllByText("HC-GR-0001").length).toBeGreaterThan(0);
    expect(screen.queryByText("HC-GR-0002")).toBeNull();
  });

  it("pre-ticks it", () => {
    outstandingGrnItems.mockReturnValue(loaded(TWO_GRNS));
    at(convertToLink("grnToPi", "grn-1"), <PurchaseInvoiceFromGrn />);
    expect(screen.getByText(/Continue with 1 line/)).toBeTruthy();
  });

  it("no parameter still opens the FULL picker", () => {
    outstandingGrnItems.mockReturnValue(loaded(TWO_GRNS));
    at("/scm/purchase-invoices/from-grn", <PurchaseInvoiceFromGrn />);
    expect(screen.getAllByText("HC-GR-0002").length).toBeGreaterThan(0);
  });

  it("the OLD spelling is reported, not silently honoured", () => {
    outstandingGrnItems.mockReturnValue(loaded(TWO_GRNS));
    at("/scm/purchase-invoices/from-grn?grn=grn-1", <PurchaseInvoiceFromGrn />);
    expect(screen.getByRole("alert").textContent).toContain('"grn"');
  });
});
