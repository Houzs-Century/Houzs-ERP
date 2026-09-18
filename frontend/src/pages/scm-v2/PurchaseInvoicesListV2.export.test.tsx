/* The Purchase Invoices list's ONE Export (owner 2026-09-15: "exactly like
 * AutoCount — one row per line, the columns I show").
 *
 * Mounts the real page with its data hooks faked; the network and the sheet
 * writer are the seams asserted:
 *   - the Export asks /purchase-invoices/export/rows with the list's tab and search, no page;
 *   - the file holds one row per LINE of every receipt, not the page on screen;
 *   - a fresh grid's columns are AutoCount's Purchase Invoice Detail Listing
 *     (layout "SS"), in its order, with its captions;
 *   - money cells are ringgit numbers, never sen;
 *   - a stopped read writes no file.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  written: [] as string[],
  notify: vi.fn(async (..._a: unknown[]) => {}),
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../vendor/scm/lib/authed-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch: h.authed,
}));
vi.mock("../../lib/xlsx-runtime", () => ({
  utils: {
    aoa_to_sheet: (aoa: unknown[][]) => { h.aoa = aoa; return {}; },
    encode_cell: ({ r, c }: { r: number; c: number }) => `${c}:${r}`,
    book_new: () => ({}),
    book_append_sheet: () => {},
  },
  writeFileXLSX: (_wb: unknown, name: string) => { h.written.push(name); },
}));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => "edit" }) }));
vi.mock("../../vendor/scm/lib/purchase-invoice-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/purchase-invoice-queries")>()),
  usePurchaseInvoicesPaged: () => ({
    data: { purchaseInvoices: h.rows, total: 2, page: 0, pageSize: 1, statusCounts: { all: 2, draft: 0, posted: 2, partial: 0, paid: 0, cancelled: 0, on_hold: 0 } },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  }),
  useEnrichedPiListRows: (rows: unknown[]) => rows,
  usePurchaseInvoiceDetail: () => ({ data: undefined, isLoading: false, error: null }),
  useCancelPurchaseInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePostPurchaseInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../vendor/scm/lib/pi-list-po-price", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/pi-list-po-price")>()),
  usePiListPoPriceMap: () => new Map(),
}));
vi.mock("../../vendor/scm/lib/flow-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/flow-queries")>()),
  usePoSoCoverage: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("./use-hold-action", () => ({ useHoldAction: () => ({ hold: vi.fn(), release: vi.fn(), dialog: null }) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));
vi.mock("../../hooks/useBranding", () => ({
  useBranding: () => ({ companyName: "HOUZS CENTURY SDN BHD", companyCode: "HOUZS" }),
}));

import { PurchaseInvoicesListV2 } from "./PurchaseInvoicesListV2";
import { ToastProvider } from "../../hooks/useToast";

const line = (id: string, over: Record<string, unknown> = {}) => ({
  id, item_code: "CODY-(K)", ac_item_code: "AK-CODY (K)", book_description: "AKEMI CODY MATTRESS (K)", book_item_group: "MATTRESS",
  book_uom: "UNIT", supplier_sku: null, description: "CODY KING", description2: "FABRIC KN-12", remarks: null, item_group: "mattress",
  uom: "UNIT", location: "KL", qty: 2, po_unit_price_sen: 150000, unit_price_sen: 150000.5, discount_sen: 0, line_total_sen: 300001,
  grn_no: "HC-GRN-000601", po_no: "HC-PO-009951", our_po_no: "PO-009951", so_doc_no: null, ...over,
});
const pi = (id: string, invoiceNumber: string, lines: unknown[], over: Record<string, unknown> = {}) => ({
  id, invoice_number: invoiceNumber, linked_ac_docno: `PI-${invoiceNumber.slice(-6)}`, supplier_invoice_ref: "INV-1",
  supplier_id: "sup-1", supplier: { id: "sup-1", code: "400-D001", name: "DIGLANT MANUFACTURING SDN BHD." },
  grn_id: "g-1", grn: { id: "g-1", grn_number: "HC-GRN-000601" }, purchase_order: null, invoice_date: "2026-09-12",
  due_date: null, status: "POSTED", on_hold: false, currency: "MYR", exchange_rate: 1, subtotal_sen: 300001, tax_sen: 0,
  total_sen: 300001, paid_sen: 0, created_at: "2026-09-12T02:00:00Z", lines, ...over,
});

const mount = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ToastProvider>
          <PurchaseInvoicesListV2 />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const all = [
  pi("p-1", "HC-PI-000251", [line("l-1"), line("l-2", { ac_item_code: "AK-BASTION (Q)" })]),
  pi("p-2", "HC-PI-000252", [line("l-3")]),
];

beforeEach(() => {
  // The SCREEN holds one receipt; the filtered set holds two with three lines.
  h.rows = [all[0]!];
  h.aoa = [];
  h.written = [];
  h.notify.mockClear();
  h.authed.mockReset();
  h.authed.mockImplementation(async (path: string) => {
    if (path.startsWith("/purchase-invoices/export/rows")) return { purchaseInvoices: all, total: 2, lineCount: 3, truncated: false };
    if (path.startsWith("/purchase-invoices/list-mrp-enrichment")) return { enrichment: {} };
    if (path.startsWith("/purchase-invoices/list-po-price")) return { summary: {} };
    return {};
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const exportNow = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(h.written).toHaveLength(1));
};

describe("Purchase Invoices list: the one Export", () => {
  it("asks the server for every invoice under the list's tab and search, not a page", async () => {
    mount("/scm/purchase-invoices?status=posted&q=HC-PI-0002&page=2");
    await exportNow();
    const path = h.authed.mock.calls.map((c) => String(c[0])).find((p) => p.startsWith("/purchase-invoices/export/rows"));
    const params = new URL(path!, "http://x").searchParams;
    expect(params.get("status")).toBe("posted");
    expect(params.get("q")).toBe("HC-PI-0002");
    expect(params.has("page")).toBe(false);
    expect(screen.queryByRole("button", { name: "Export lines" })).toBeNull();
  });

  it("writes AutoCount's Detail Listing columns in its order, one row per line", async () => {
    mount("/scm/purchase-invoices?status=posted");
    await exportNow();
    expect(h.aoa[0]).toEqual([
      "Doc No", "Supplier Invoice No.", "Doc Date", "Creditor Code", "Creditor Name", "Agent", "Curr. Code", "Curr. Rate",
      "Inclusive?", "SubTotal (Ex)", "Tax", "Total", "Local Total", "Cancelled", "Item Code", "Detail Description",
      "Detail Description 2", "UOM", "Location", "Proj No", "Qty", "Unit Price", "Discount", "Total", "Detail Tax Code", "Tax",
      "Total (Ex)", "Total (Inc)", "Desc2",
    ]);
    expect(h.aoa).toHaveLength(4);
    const col = (label: string, nth = 0) => {
      const idx = (h.aoa[0] as string[]).map((l, i) => [l, i] as const).filter(([l]) => l === label)[nth]![1];
      return h.aoa.slice(1).map((r) => r[idx]);
    };
    expect(col("Doc No")).toEqual(["PI-000251", "PI-000251", "PI-000252"]);
    expect(col("Item Code")).toEqual(["AK-CODY (K)", "AK-BASTION (Q)", "AK-CODY (K)"]);
    expect(h.written[0]).toMatch(/^purchase-invoices-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("writes money as ringgit, never sen", async () => {
    mount("/scm/purchase-invoices");
    await exportNow();
    const header = h.aoa[0] as string[];
    const moneyLabels = new Set(["SubTotal (Ex)", "Tax", "Total", "Local Total", "Unit Price", "Discount", "Total (Ex)", "Total (Inc)"]);
    for (const row of h.aoa.slice(1)) {
      header.forEach((label, i) => {
        if (!moneyLabels.has(label)) return;
        const v = row[i];
        if (typeof v === "number") expect(v, `${label} looks like sen`).toBeLessThan(100_000);
      });
    }
    const unitPrice = header.indexOf("Unit Price");
    expect(h.aoa[1]![unitPrice]).toBe(1500.005);
    const total = header.indexOf("Total");
    expect(h.aoa[1]![total]).toBe(3000.01);
  });

  it("refuses to hand over a short file when the server stopped reading", async () => {
    h.authed.mockImplementation(async () => ({ purchaseInvoices: [], total: 0, lineCount: 0, truncated: true }));
    mount("/scm/purchase-invoices");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.written).toHaveLength(0);
  });
});
