/* The Purchase Order list's exports hold EVERY order its filters match, not the
 * screen page (owner 2026-09-15: our export "只有一页", AutoCount's chasing list
 * has every line).
 *
 * The old toolbar Export wrote DataTable's `sortedRows` — the one page the
 * server had sent (50 by default) — so a tab of 400 orders exported 50 and said
 * nothing. Both exports now ask the server for the whole filtered set, with the
 * SAME tab and search the list is showing. Mounts the real page with its data
 * hooks faked; the network is the one seam asserted.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PO_LINE_EXPORT_COLUMNS } from "../../vendor/scm/lib/po-line-export-columns";

const h = vi.hoisted(() => ({
  fetch: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  written: [] as string[],
  csv: [] as Array<{ name: string; text: string }>,
  notify: vi.fn(async (..._a: unknown[]) => {}),
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../vendor/scm/lib/authed-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch: h.fetch,
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
vi.mock("../../vendor/scm/lib/suppliers-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/suppliers-queries")>()),
  usePurchaseOrdersPaged: () => ({
    data: {
      purchaseOrders: h.rows,
      total: 3,
      page: 0,
      pageSize: 1,
      statusCounts: { all: 3, draft: 0, outstanding: 3, open: 3, partial: 0, received: 0, cancelled: 0, on_hold: 0 },
    },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  }),
  useEnrichedPoListRows: (rows: unknown[]) => rows,
  usePurchaseOrderDetail: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock("../../vendor/scm/lib/inventory-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/inventory-queries")>()),
  useWarehouses: () => ({ data: [], isLoading: false }),
}));
vi.mock("../../vendor/scm/lib/flow-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/flow-queries")>()),
  usePoSoCoverage: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("./use-hold-action", () => ({ useHoldAction: () => ({ hold: vi.fn(), release: vi.fn(), dialog: null }) }));
vi.mock("./use-po-cancel-action", () => ({ usePoCancelAction: () => ({ cancelPo: vi.fn() }) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));
vi.mock("../../hooks/useBranding", () => ({
  useBranding: () => ({ companyName: "HOUZS CENTURY SDN BHD", companyCode: "HOUZS" }),
}));

import { PurchaseOrdersListV2 } from "./PurchaseOrdersListV2";
import { ToastProvider } from "../../hooks/useToast";

const po = (id: string, poNumber: string) => ({
  id,
  po_number: poNumber,
  revision: 1,
  supplier_id: "sup-1",
  supplier: { id: "sup-1", code: "400-D001", name: "DIGLANT MANUFACTURING SDN BHD." },
  status: "SUBMITTED",
  po_date: "2026-09-12",
  expected_at: "2026-09-20",
  currency: "MYR",
  subtotal_sen: 130000,
  tax_sen: 0,
  total_sen: 130000,
  notes: null,
  purchase_location_id: null,
  purchase_location: null,
  created_at: "2026-09-12T02:00:00Z",
  items: [],
  has_children: false,
  transfer_to_grns: [],
});

const mount = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ToastProvider>
          <PurchaseOrdersListV2 />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const allOrders = [po("po-1", "HC-PO-009949"), po("po-2", "HC-PO-009950"), po("po-3", "HC-PO-009951")];

beforeEach(() => {
  // The SCREEN holds one page of one order; the filtered set holds three.
  h.rows = [allOrders[0]!];
  h.aoa = [];
  h.written = [];
  h.csv = [];
  h.notify.mockClear();
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/mfg-purchase-orders/export/lines")) {
      return {
        columns: [...PO_LINE_EXPORT_COLUMNS],
        rows: [
          PO_LINE_EXPORT_COLUMNS.map((c) => (c === "Line ID" ? "line-1" : c === "Doc No" ? "HC-PO-009949" : null)),
          PO_LINE_EXPORT_COLUMNS.map((c) => (c === "Line ID" ? "line-2" : c === "Doc No" ? "HC-PO-009951" : null)),
        ],
        poCount: 3,
        lineCount: 2,
        truncated: false,
      };
    }
    if (path.startsWith("/mfg-purchase-orders/export/headers")) {
      return { purchaseOrders: allOrders, total: 3, truncated: false };
    }
    if (path.startsWith("/mfg-purchase-orders/list-mrp-enrichment")) return { enrichment: {} };
    return {};
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const calledPaths = () => h.fetch.mock.calls.map((c) => String(c[0]));

describe("Purchase Order list: Export lines", () => {
  it("asks the server for every line under the list's current tab and search", async () => {
    mount("/scm/purchase-orders?status=open&q=HC-PO-0099&page=2");
    fireEvent.click(screen.getByRole("button", { name: "Export lines" }));
    await waitFor(() => expect(h.written).toHaveLength(1));
    const path = calledPaths().find((p) => p.startsWith("/mfg-purchase-orders/export/lines"));
    expect(path).toBeDefined();
    const params = new URL(path!, "http://x").searchParams;
    expect(params.get("status")).toBe("open");
    expect(params.get("q")).toBe("HC-PO-0099");
    // The export is not a page of the list.
    expect(params.has("page")).toBe(false);
    expect(params.has("pageSize")).toBe(false);
  });

  it("writes one sheet row per line under the contract header", async () => {
    mount("/scm/purchase-orders?status=open");
    fireEvent.click(screen.getByRole("button", { name: "Export lines" }));
    await waitFor(() => expect(h.written).toHaveLength(1));
    expect(h.aoa[0]).toEqual([...PO_LINE_EXPORT_COLUMNS]);
    expect(h.aoa).toHaveLength(3);
    expect(h.written[0]).toMatch(/^purchase-order-lines-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("refuses to hand over a short file when the server stopped reading", async () => {
    h.fetch.mockImplementation(async () => ({ columns: [...PO_LINE_EXPORT_COLUMNS], rows: [], poCount: 20000, lineCount: 0, truncated: true }));
    mount("/scm/purchase-orders");
    fireEvent.click(screen.getByRole("button", { name: "Export lines" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.written).toHaveLength(0);
  });
});

describe("Purchase Order list: the toolbar Export", () => {
  it("exports every order under the list's filters, not the page on screen", async () => {
    mount("/scm/purchase-orders?status=open&q=HC-PO-0099");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.csv).toHaveLength(1));
    const path = calledPaths().find((p) => p.startsWith("/mfg-purchase-orders/export/headers"));
    expect(path).toBeDefined();
    const params = new URL(path!, "http://x").searchParams;
    expect(params.get("status")).toBe("open");
    expect(params.get("q")).toBe("HC-PO-0099");
    const text = h.csv[0]!.text;
    for (const r of allOrders) expect(text).toContain(r.po_number);
  });
});
