/* The Purchase Invoices list's exports hold EVERY invoice its filters match, not
 * the screen page (owner 2026-09-15: one row per line item, the whole filtered
 * listing).
 *
 * The toolbar Export wrote DataTable's `sortedRows` — the one page the server
 * had sent. Both exports now ask the server for the whole filtered set, with the
 * SAME tab and search the list is showing. Mounts the real page with its data
 * hooks faked; the network is the one seam asserted. Same harness as
 * PurchaseOrdersListV2.export.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_LINE_EXPORT_COLUMNS } from "../../vendor/scm/lib/pi-line-export-columns";

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  written: [] as string[],
  csv: [] as Array<{ name: string; text: string }>,
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
vi.mock("../../lib/csv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/csv")>()),
  downloadCSV: (name: string, text: string) => { h.csv.push({ name, text }); },
}));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => "edit" }) }));
vi.mock("../../vendor/scm/lib/purchase-invoice-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/purchase-invoice-queries")>()),
  usePurchaseInvoicesPaged: () => ({
    data: {
      purchaseInvoices: h.rows,
      total: 3,
      page: 0,
      pageSize: 1,
      statusCounts: { all: 3, draft: 0, posted: 3, partial: 0, paid: 0, cancelled: 0, on_hold: 0 },
    },
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

const pi = (id: string, invoiceNumber: string, over: Record<string, unknown> = {}) => ({
  id,
  invoice_number: invoiceNumber,
  supplier_invoice_ref: "INV-1",
  supplier_id: "sup-1",
  supplier: { id: "sup-1", code: "400-D001", name: "DIGLANT MANUFACTURING SDN BHD." },
  grn_id: "g-1",
  grn: { id: "g-1", grn_number: "HC-GRN-000601", delivery_note_ref: null },
  purchase_order: null,
  invoice_date: "2026-09-12",
  due_date: null,
  status: "POSTED",
  on_hold: false,
  currency: "MYR",
  total_sen: 130000,
  paid_sen: 0,
  created_at: "2026-09-12T02:00:00Z",
  ...over,
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

const all = [pi("p-1", "HC-PI-000251"), pi("p-2", "HC-PI-000252", { on_hold: true }), pi("p-3", "HC-PI-000253")];

beforeEach(() => {
  h.rows = [all[0]!];
  h.aoa = [];
  h.written = [];
  h.csv = [];
  h.notify.mockClear();
  h.authed.mockReset();
  h.authed.mockImplementation(async (path: string) => {
    if (path.startsWith("/purchase-invoices/export/lines")) {
      return {
        columns: [...PI_LINE_EXPORT_COLUMNS],
        rows: [
          PI_LINE_EXPORT_COLUMNS.map((c) => (c === "Line ID" ? "line-1" : c === "Doc No" ? "HC-PI-000251" : null)),
          PI_LINE_EXPORT_COLUMNS.map((c) => (c === "Line ID" ? "line-2" : c === "Doc No" ? "HC-PI-000253" : null)),
        ],
        piCount: 3,
        lineCount: 2,
        truncated: false,
      };
    }
    if (path.startsWith("/purchase-invoices/export/headers")) return { purchaseInvoices: all, total: 3, truncated: false };
    if (path.startsWith("/purchase-invoices/list-mrp-enrichment")) return { enrichment: {} };
    if (path.startsWith("/purchase-invoices/list-po-price")) {
      return { summary: { "p-3": { linesDiffering: 2, totalDiffSen: 500, comparableLines: 2, lines: 2 } } };
    }
    return {};
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const calledPaths = () => h.authed.mock.calls.map((c) => String(c[0]));

describe("Purchase Invoices list: Export lines", () => {
  it("asks the server for every line under the list's current tab and search", async () => {
    mount("/scm/purchase-invoices?status=posted&q=HC-PI-0002&page=2");
    fireEvent.click(screen.getByRole("button", { name: "Export lines" }));
    await waitFor(() => expect(h.written).toHaveLength(1));
    const path = calledPaths().find((p) => p.startsWith("/purchase-invoices/export/lines"));
    expect(path).toBeDefined();
    const params = new URL(path!, "http://x").searchParams;
    expect(params.get("status")).toBe("posted");
    expect(params.get("q")).toBe("HC-PI-0002");
    expect(params.has("page")).toBe(false);
  });

  it("writes one sheet row per line under the contract header", async () => {
    mount("/scm/purchase-invoices?status=posted");
    fireEvent.click(screen.getByRole("button", { name: "Export lines" }));
    await waitFor(() => expect(h.written).toHaveLength(1));
    expect(h.aoa[0]).toEqual([...PI_LINE_EXPORT_COLUMNS]);
    expect(h.aoa).toHaveLength(3);
    expect(h.written[0]).toMatch(/^purchase-invoice-lines-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("refuses to hand over a short file when the server stopped reading", async () => {
    h.authed.mockImplementation(async () => ({ columns: [...PI_LINE_EXPORT_COLUMNS], rows: [], piCount: 20000, lineCount: 0, truncated: true }));
    mount("/scm/purchase-invoices");
    fireEvent.click(screen.getByRole("button", { name: "Export lines" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.written).toHaveLength(0);
  });
});

describe("Purchase Invoices list: the toolbar Export", () => {
  it("exports every invoice under the list's filters, with the status word and the PO price marker of rows off the page", async () => {
    mount("/scm/purchase-invoices?status=posted&q=HC-PI-0002");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.csv).toHaveLength(1));
    const path = calledPaths().find((p) => p.startsWith("/purchase-invoices/export/headers"));
    expect(path).toBeDefined();
    const params = new URL(path!, "http://x").searchParams;
    expect(params.get("status")).toBe("posted");
    expect(params.get("q")).toBe("HC-PI-0002");
    const text = h.csv[0]!.text;
    for (const r of all) expect(text).toContain(r.invoice_number);
    expect(text).toContain("Submitted (On Hold)");
    expect(text).toContain("2 lines differ");
  });
});
