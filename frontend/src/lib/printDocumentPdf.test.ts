/* ----------------------------------------------------------------------------
   Fetching and rendering ONE document, by type.

   TWO THINGS ARE PINNED HERE, and both have already cost this repo a document.

   1. THE ADDRESS. `GET /mfg-sales-orders/:docNo` is keyed by the document
      NUMBER; every other detail route is `.eq('id', ...)`. Swapping them
      compiles, reads fine and 404s at the printer, so the URL each type builds
      is asserted literally.

   2. "PRINT NOW" GOES THROUGH THE PDF. The global `@media print` block in
      index.css hides `body *` and reveals only `.org-print-area`, so
      `window.print()` from a list prints a BLANK SHEET — which is exactly what
      the Delivery Order's own Print now did before PrintPreviewModal existed.
      So every generator is asserted to receive the `action`, and `window.print`
      is asserted never to be called.
   ---------------------------------------------------------------------------- */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const authedFetch = vi.fn();
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch: (p: string) => authedFetch(p) }));

const gen = {
  so: vi.fn(), do: vi.fn(), si: vi.fn(), dr: vi.fn(),
  po: vi.fn(), grn: vi.fn(), pi: vi.fn(), pr: vi.fn(),
};
vi.mock("../vendor/scm/lib/sales-order-pdf", () => ({ generateSalesOrderPdf: (...a: unknown[]) => gen.so(...a) }));
vi.mock("../vendor/scm/lib/delivery-order-pdf", () => ({ generateDeliveryOrderPdf: (...a: unknown[]) => gen.do(...a) }));
vi.mock("../vendor/scm/lib/sales-invoice-pdf", () => ({ generateSalesInvoicePdf: (...a: unknown[]) => gen.si(...a) }));
vi.mock("../vendor/scm/lib/delivery-return-pdf", () => ({ generateDeliveryReturnPdf: (...a: unknown[]) => gen.dr(...a) }));
vi.mock("../vendor/scm/lib/purchase-order-pdf", () => ({ generatePurchaseOrderPdf: (...a: unknown[]) => gen.po(...a) }));
vi.mock("../vendor/scm/lib/grn-pdf", () => ({ generateGrnPdf: (...a: unknown[]) => gen.grn(...a) }));
vi.mock("../vendor/scm/lib/purchase-invoice-pdf", () => ({ generatePurchaseInvoicePdf: (...a: unknown[]) => gen.pi(...a) }));
vi.mock("../vendor/scm/lib/purchase-return-pdf", () => ({ generatePurchaseReturnPdf: (...a: unknown[]) => gen.pr(...a) }));

import { deliveryReturnPdfBundle, fetchPrintBundle, printPreviewRows, renderPrintBundle } from "./printDocumentPdf";
import type { PrintTarget } from "./printChain";

const t = (doc: PrintTarget["doc"], docNo: string, key: string): PrintTarget => ({ doc, docNo, key });

beforeEach(() => {
  authedFetch.mockReset();
  for (const f of Object.values(gen)) f.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("each document type is fetched at ITS OWN address", () => {
  test("a Sales Order is addressed by its NUMBER, and its payments alongside", async () => {
    authedFetch.mockImplementation((p: string) =>
      p.endsWith("/payments")
        ? Promise.resolve({ payments: [{ amount_sen: 100 }] })
        : Promise.resolve({ salesOrder: { doc_no: "HC-SO-2608-001" }, items: [], pwpCodes: [] }));
    const b = await fetchPrintBundle(t("so", "HC-SO-2608-001", "HC-SO-2608-001"));
    expect(authedFetch.mock.calls.map((c) => c[0])).toEqual([
      "/mfg-sales-orders/HC-SO-2608-001",
      "/mfg-sales-orders/HC-SO-2608-001/payments",
    ]);
    expect(b.payments).toEqual([{ amount_sen: 100 }]);
  });

  /* The payments read used to be `.catch(() => ({ payments: [] }))`. That turns
     "the read failed" into "nothing was paid" on a document the CUSTOMER is
     handed. It must propagate; the caller shows an error and no document. */
  test("a failed payments read stops the Sales Order print rather than claiming nothing was paid", async () => {
    authedFetch.mockImplementation((p: string) =>
      p.endsWith("/payments")
        ? Promise.reject(new Error("Payments are unavailable right now."))
        : Promise.resolve({ salesOrder: {}, items: [] }));
    await expect(fetchPrintBundle(t("so", "HC-SO-2608-001", "HC-SO-2608-001")))
      .rejects.toThrow("Payments are unavailable right now.");
  });

  test.each([
    ["do", "delivery-orders-mfg", { deliveryOrder: {}, items: [] }],
    ["si", "sales-invoices", { salesInvoice: {}, items: [] }],
    ["dr", "delivery-returns", { deliveryReturn: {}, items: [] }],
    ["po", "mfg-purchase-orders", { purchaseOrder: {}, items: [] }],
    ["grn", "grns", { grn: {}, items: [] }],
    ["pi", "purchase-invoices", { purchaseInvoice: {}, items: [] }],
    ["pr", "purchase-returns", { purchaseReturn: {}, items: [] }],
  ] as const)("a %s is addressed by its UUID at /%s/:id", async (doc, path, body) => {
    authedFetch.mockResolvedValue(body);
    await fetchPrintBundle(t(doc, "HUMAN-NUMBER-1", "the-uuid"));
    expect(authedFetch.mock.calls[0]?.[0]).toBe(`/${path}/the-uuid`);
    // The human number is for the MENU. It must never reach the URL.
    expect(authedFetch.mock.calls[0]?.[0]).not.toContain("HUMAN-NUMBER-1");
  });

  test("a Purchase Order resolves its ship-to warehouse into the printed DELIVER TO", async () => {
    authedFetch.mockImplementation((p: string) =>
      p.startsWith("/inventory/warehouses")
        ? Promise.resolve({ warehouses: [{ id: "wh-1", code: "HQ", location: "1 Road, Ipoh" }] })
        : Promise.resolve({ purchaseOrder: { purchase_location_id: "wh-1" }, items: [] }));
    const b = await fetchPrintBundle(t("po", "HC-PO-2608-010", "po-uuid"));
    // Owner 2026-07-24: DELIVER TO shows the warehouse CODE only.
    expect(b.header).toMatchObject({ purchase_location_name: "HQ", delivery_address: "1 Road, Ipoh" });
  });

  /* A failed warehouse read must NOT become "no warehouse" — that prints the
     supplier's copy of the PO telling them to ship nowhere in particular. */
  test("a failed warehouse read stops the Purchase Order print, it does not blank the address", async () => {
    authedFetch.mockImplementation((p: string) =>
      p.startsWith("/inventory/warehouses")
        ? Promise.reject(new Error("Warehouses are unavailable right now."))
        : Promise.resolve({ purchaseOrder: { purchase_location_id: "wh-1" }, items: [] }));
    await expect(fetchPrintBundle(t("po", "HC-PO-2608-010", "po-uuid")))
      .rejects.toThrow("Warehouses are unavailable right now.");
  });

  test("a Purchase Order with no ship-to warehouse reads no warehouse table at all", async () => {
    authedFetch.mockResolvedValue({ purchaseOrder: { purchase_location_id: null }, items: [] });
    await fetchPrintBundle(t("po", "HC-PO-2608-010", "po-uuid"));
    expect(authedFetch.mock.calls.map((c) => c[0])).toEqual(["/mfg-purchase-orders/po-uuid"]);
  });

  /* Was `loadScanId === "do-uuid"` until 2026-08-26. The QR encodes the PUBLIC
     page now (/d/<token>, no login — the owner's call), so the header carries a
     minted TOKEN instead of the row id, fetched from the authed mint endpoint.
     The property is unchanged and is still the one worth pinning: the DO branch
     of this fetcher is where the QR gets armed, so no print call site has to
     remember to. */
  test("a Delivery Order's header carries the PUBLIC scan token, which arms the print's QR", async () => {
    authedFetch.mockImplementation((p: string) =>
      p.endsWith("/scan-token")
        ? Promise.resolve({ scanToken: "f".repeat(64) })
        : Promise.resolve({ deliveryOrder: { do_number: "HC-DO-2608-003" }, items: [] }));
    const b = await fetchPrintBundle(t("do", "HC-DO-2608-003", "do-uuid"));
    expect((b.header as { scanToken?: string }).scanToken).toBe("f".repeat(64));
    expect(authedFetch.mock.calls.map((c) => c[0])).toContain("/delivery-orders-mfg/do-uuid/scan-token");
  });

  /* A print must never be blocked by the QR. The operator asked for the
     document; an unreachable mint endpoint costs the code, not the paper. */
  test("a failed mint still prints the Delivery Order, with no QR", async () => {
    authedFetch.mockImplementation((p: string) =>
      p.endsWith("/scan-token")
        ? Promise.reject(new Error("mint down"))
        : Promise.resolve({ deliveryOrder: { do_number: "HC-DO-2608-003" }, items: [] }));
    const b = await fetchPrintBundle(t("do", "HC-DO-2608-003", "do-uuid"));
    expect((b.header as { scanToken?: string }).scanToken).toBeUndefined();
    expect((b.header as { do_number?: string }).do_number).toBe("HC-DO-2608-003");
  });
});

describe("Print now renders the PDF — never window.print()", () => {
  const printSpy = vi.fn();

  test.each([
    ["so", "sales order"], ["do", "delivery order"], ["si", "sales invoice"],
    ["dr", "delivery return"], ["po", "purchase order"], ["grn", "goods received"],
    ["pi", "purchase invoice"], ["pr", "purchase return"],
  ] as const)("the %s generator is handed action 'print'", async (doc, _name) => {
    vi.stubGlobal("print", printSpy);
    await renderPrintBundle(t(doc, "X-1", "k"), { header: {}, items: [] }, "print");
    expect(gen[doc]).toHaveBeenCalledTimes(1);
    const args = gen[doc].mock.calls[0]!;
    /* The Sales Order generator takes `action` positionally (4th); the other
       seven take it on an options object. Either way it must ARRIVE. */
    const carried = args.includes("print") || args.some((a) => a && typeof a === "object" && (a as { action?: string }).action === "print");
    expect(carried).toBe(true);
    expect(printSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test("'save' and 'preview' reach the generator too, so the dialog's three exits differ", async () => {
    await renderPrintBundle(t("grn", "X-1", "k"), { header: {}, items: [] }, "save");
    await renderPrintBundle(t("grn", "X-1", "k"), { header: {}, items: [] }, "preview");
    expect(gen.grn.mock.calls.map((c) => (c[2] as { action: string }).action)).toEqual(["save", "preview"]);
  });

  test("a type with no generator refuses loudly instead of silently doing nothing", async () => {
    await expect(renderPrintBundle(t("co", "X-1", "k"), { header: {}, items: [] }, "print"))
      .rejects.toThrow(/No PDF generator/);
  });
});

describe("the Delivery Return mapping, which the generator cannot do without", () => {
  /* Migration 0102 put the DO-clone address block on the DR record and the
     printout ignored it, so a Delivery Return left the building with no customer
     address on it (owner UI audit, Item #9). Every one of those fields is
     threaded here, and `customer_state` is the one whose NAME changes. */
  test("the address block is carried, with customer_state mapped to state", () => {
    const { header } = deliveryReturnPdfBundle({
      deliveryReturn: {
        return_number: "HC-DR-2608-002", status: "RECEIVED", return_date: "2026-08-20",
        debtor_name: "A Customer", local_total_sen: 12345,
        address1: "1 Road", address2: "Unit 2", city: "Ipoh",
        customer_state: "Perak", postcode: "30000", phone: "011", email: "a@b.my",
      },
      items: [],
    });
    expect(header).toMatchObject({
      state: "Perak", address1: "1 Road", address2: "Unit 2", city: "Ipoh",
      postcode: "30000", phone: "011", email: "a@b.my",
      refund_sen: 12345,
    });
  });

  test("`note` is preferred over `notes`, and a line's total becomes its refund", () => {
    const { header, items } = deliveryReturnPdfBundle({
      deliveryReturn: { note: "the real one", notes: "the legacy one" },
      items: [{ item_code: "SKU-1", qty_returned: 2, unit_price_sen: 500, line_total_sen: 1000 }],
    });
    expect(header.notes).toBe("the real one");
    expect(items[0]).toMatchObject({ item_code: "SKU-1", refund_sen: 1000 });
  });
});

describe("the preview card names the party the document is actually about", () => {
  test("a sales-side document shows the Customer", () => {
    expect(printPreviewRows(t("do", "HC-DO-2608-003", "k"), { debtor_name: "A Customer", do_date: "2026-08-20" }))
      .toEqual([{ label: "Customer", value: "A Customer" }, { label: "Date", value: "2026-08-20" }]);
  });

  test("a purchase-side document shows the Supplier", () => {
    expect(printPreviewRows(t("grn", "HC-GRN-2608-003", "k"), { supplier: { name: "A Supplier" } }))
      .toEqual([{ label: "Supplier", value: "A Supplier" }]);
  });

  test("a header with nothing recognisable produces no rows rather than blank labels", () => {
    expect(printPreviewRows(t("pi", "X-1", "k"), {})).toEqual([]);
  });
});
