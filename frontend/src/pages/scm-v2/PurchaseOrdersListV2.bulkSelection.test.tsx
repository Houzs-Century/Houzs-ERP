/* Sister review G14: a bulk action acts on the ticked rows the operator can
 * SEE. A tick left on a row that a later result no longer shows used to ride
 * into "Supplier date (N)": the dialog listed the visible POs and the server
 * wrote all N. A new search starts with no ticks. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PO_LINE_LABELS, type PoListLine } from "../../vendor/scm/lib/po-line-export-columns";
import { primeInVisitColFilters, resetInVisitColFilters } from "../../components/dataTableColFilterMemory";

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  cells: {} as Record<string, { t?: string; v?: unknown; z?: string }>,
  written: [] as string[],
  notify: vi.fn(async (..._a: unknown[]) => {}),
  rows: [] as Array<Record<string, unknown>>,
  bulkPoIds: [] as string[][],
}));

vi.mock("../../vendor/scm/lib/authed-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch: h.authed,
}));
vi.mock("../../lib/xlsx-runtime", () => ({
  utils: {
    aoa_to_sheet: (aoa: unknown[][]) => {
      h.aoa = aoa;
      const ws: Record<string, { t?: string; v?: unknown; z?: string }> = {};
      aoa.forEach((row, r) => row.forEach((v, c) => {
        if (v === null || v === undefined) return;
        ws[`${c}:${r}`] = { t: typeof v === "number" ? "n" : "s", v };
      }));
      h.cells = ws;
      return ws;
    },
    encode_cell: ({ r, c }: { r: number; c: number }) => `${c}:${r}`,
    book_new: () => ({}),
    book_append_sheet: () => {},
  },
  writeFileXLSX: (_wb: unknown, name: string) => { h.written.push(name); },
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
  useEnrichedPoListRows: (rows: unknown[]) => ({ rows, mrp: { meta: null, refresh: () => {}, refreshing: false } }),
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
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => "edit" }) }));
vi.mock("../../hooks/useBranding", () => ({
  useBranding: () => ({ companyName: "HOUZS CENTURY SDN BHD", companyCode: "HOUZS" }),
}));

vi.mock("../../components/scm-v2/PoBulkSupplierDateModal", () => ({
  PoBulkSupplierDateModal: (p: { open: boolean; poIds: string[] }) => {
    if (p.open) h.bulkPoIds.push(p.poIds);
    return null;
  },
}));

import { PurchaseOrdersListV2 } from "./PurchaseOrdersListV2";
import { ToastProvider } from "../../hooks/useToast";

const ln = (id: string, over: Partial<PoListLine> = {}): PoListLine => ({
  id,
  line_no: 1,
  item_code: "AKEMI-GUARDIAN-(Q)",
  material_name: "AKEMI GUARDIAN MATTRESS (152X190X30CM)",
  item_description: "AKEMI GUARDIAN MATTRESS (153x190x30CM)",
  description2: "QUEEN",
  notes: null,
  item_group: "mattress",
  ac_item_group: "MATTRESS",
  supplier_sku: "AK-GUARDIAN (Q)",
  qty: 2,
  received_qty: 0,
  remaining_qty: 2,
  unit_price_sen: 5.5,
  line_total_sen: 150_000,
  delivery_date: "2026-09-20",
  estimate_delivery_date_1: "2026-09-12",
  estimate_delivery_date_2: null,
  estimate_delivery_date_3: null,
  location: "KL",
  so_doc_no: "HC-SO-013389",
  ...over,
});

const po = (id: string, poNumber: string, lines: PoListLine[], over: Record<string, unknown> = {}) => ({
  id,
  po_number: poNumber,
  linked_ac_docno: null,
  revision: 1,
  supplier_id: "sup-1",
  supplier: { id: "sup-1", code: "400-A006", name: "AKEMI UNITED SDN BHD" },
  status: "SUBMITTED",
  po_date: "2026-09-04",
  expected_at: "2026-09-20",
  currency: "MYR",
  subtotal_sen: 1_500_000,
  tax_sen: 0,
  total_sen: 1_500_000,
  notes: null,
  purchase_location_id: null,
  purchase_location: null,
  created_at: "2026-09-04T02:00:00Z",
  items: [],
  has_children: false,
  transfer_to_grns: [],
  lines,
  ...over,
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

const A = po("po-a", "HC-PO-000001", [ln("l-a")]);
const B = po("po-b", "HC-PO-000002", [ln("l-b")]);
const C = po("po-c", "HC-PO-000003", [ln("l-c")]);

beforeEach(() => {
  h.rows = [A, B];
  h.bulkPoIds = [];
  h.notify.mockClear();
  h.authed.mockReset();
  h.authed.mockImplementation(async (path: string) => {
    if (path.startsWith("/mfg-purchase-orders/list-mrp-enrichment")) return { enrichment: {} };
    return {};
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetInVisitColFilters();
});

const tickRow = (n: number) => fireEvent.click(screen.getAllByRole("checkbox", { name: "Select row" })[n]!);

describe("Purchase Order list: bulk Supplier date acts on visible ticks only", () => {
  it("a tick on a row no longer shown is not counted or sent", async () => {
    const view = mount("/scm/purchase-orders");
    tickRow(0);
    tickRow(1);
    await screen.findByRole("button", { name: /Supplier date \(2\)/ });

    // The page now shows a different result; the earlier ticks are hidden.
    h.rows = [C];
    view.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/scm/purchase-orders"]}>
          <ToastProvider>
            <PurchaseOrdersListV2 />
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    tickRow(0);

    fireEvent.click(await screen.findByRole("button", { name: /Supplier date \(1\)/ }));
    await waitFor(() => expect(h.bulkPoIds.length).toBeGreaterThan(0));
    expect(h.bulkPoIds.at(-1)).toEqual(["po-c"]);
  });

  it("a new search clears the ticks", async () => {
    mount("/scm/purchase-orders");
    tickRow(0);
    await screen.findByRole("button", { name: /Supplier date \(1\)/ });

    fireEvent.change(screen.getAllByPlaceholderText("Search PO no, notes or item code…")[0]!, { target: { value: "HC-PO-0000" } });

    // Past the 300 ms search debounce, the result has settled and the rows are back.
    await new Promise((r) => setTimeout(r, 700));
    await waitFor(() => expect(screen.getAllByRole("checkbox", { name: "Select row" }).length).toBe(2));
    expect(screen.queryByRole("button", { name: /Supplier date/ })).toBeNull();
  });
});
