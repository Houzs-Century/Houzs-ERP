/* The SO list quick-view drawer shows a per-line Stock pill (owner 2026-09-20:
 * its order lines showed only item / qty / amount, no stock status — the same
 * gap the drill-down had in 2026-07-24). The quick view is the TWIN of the
 * SoLinesExpansion drill-down, so it uses the IDENTICAL data path: the detail
 * payload plus GET /:docNo/coverage overlaid, rendered through the ONE shared
 * SoStockPill. This pins BOTH that the column exists and that it renders the
 * coverage-healed verdict, so the two surfaces can never hold two opinions.
 *
 * Mounts the real page and opens the drawer with a row click — the same harness
 * as MfgSalesOrdersListV2.export.test.tsx, data hooks faked.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  detailItems: [] as Array<Record<string, unknown>>,
  coverage: undefined as undefined | { coverage: Array<Record<string, unknown>> },
}));

vi.mock("../../vendor/scm/lib/authed-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn(async () => ({})),
}));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, permissions: ["*"] }, can: () => true, pageAccess: () => "edit" }),
}));
vi.mock("../../auth/salesAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auth/salesAccess")>()),
  canViewScmCosting: () => false,
}));
vi.mock("../../hooks/useStaffLookup", () => ({
  useStaffLookup: () => ({ nameOf: (_a: unknown, _b: unknown, fallback: string) => fallback }),
}));
vi.mock("../../vendor/scm/lib/sales-order-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/sales-order-queries")>()),
  useMfgSalesOrdersPaged: () => ({
    data: {
      salesOrders: h.rows,
      total: h.rows.length,
      page: 1,
      pageSize: 25,
      statusCounts: { all: h.rows.length, draft: 0, confirmed: h.rows.length, cancelled: 0 },
    },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  }),
  useEnrichedSoListRows: (rows: unknown[]) => rows,
  useSoLineCoverage: () => ({ data: h.coverage }),
  useMfgSalesOrderDetail: () => ({ data: { items: h.detailItems }, isLoading: false, error: null }),
  useUpdateMfgSalesOrderStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));
vi.mock("../../hooks/useBranding", () => ({
  useBranding: () => ({ companyName: "HOUZS CENTURY SDN BHD", companyCode: "HOUZS" }),
}));

import { MfgSalesOrdersListV2 } from "./MfgSalesOrdersListV2";
import { ToastProvider } from "../../hooks/useToast";

const DOC = "HC-SO-013001";

const soRow = (over: Record<string, unknown> = {}) => ({
  doc_no: DOC, so_date: "2026-09-12", debtor_name: "TAN AH KOW", debtor_code: "300-C002",
  agent: "NICO", salesperson_id: null, sales_location: "KL", ref: "REF-1", branding: "HOUZS",
  status: "CONFIRMED", on_hold: null, local_total_sen: 979900, balance_sen: 979900, paid_sen: 0,
  paid_total_sen: 0, currency: "MYR", processing_date: "2026-09-13", customer_delivery_date: "2026-09-30",
  phone: null, email: null, address1: null, address2: null, city: null, postcode: null,
  customer_state: null, payment_method: null, lines: [], ...over,
});

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/scm/sales-orders"]}>
        <ToastProvider>
          <MfgSalesOrdersListV2 />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const openDrawer = async () => {
  mount();
  // The list renders a desktop table and a mobile card for the same row, so the
  // debtor name appears twice; clicking either fires the row's onRowClick.
  fireEvent.click(screen.getAllByText("TAN AH KOW")[0]!);
  const drawer = await screen.findByRole("dialog", { name: new RegExp(`Sales order ${DOC}`) });
  await waitFor(() => within(drawer).getByText("Order lines"));
  return drawer;
};

beforeEach(() => {
  h.rows = [soRow()];
  h.coverage = undefined;
  h.detailItems = [
    { id: "L1", item_code: "AKEMI IMMORTAL MATT (K)", description: "AKEMI IMMORTAL MATT", item_group: "MATTRESS",
      qty: 1, unit_price_sen: 979900, total_sen: 979900, stock_status: "READY", stock_status_effective: "READY",
      delivered_qty: 0, remaining_qty: 1 },
    { id: "L2", item_code: "AK-CS AIRLOFT COMFY PIL", description: "AK-CS AIRLOFT COMFY PIL", item_group: "ACCESSORY",
      qty: 2, unit_price_sen: 0, total_sen: 0, stock_status: "PENDING", stock_status_effective: "PENDING",
      delivered_qty: 0, remaining_qty: 2 },
  ];
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SO quick-view drawer: per-line Stock", () => {
  it("adds a Stock column that renders each line's effective readiness", async () => {
    const drawer = await openDrawer();
    expect(within(drawer).getByText("Stock")).toBeTruthy();
    expect(within(drawer).getByText("READY")).toBeTruthy();
    expect(within(drawer).getByText("PENDING")).toBeTruthy();
  });

  it("renders the coverage-healed verdict — the same overlay the drill-down uses", async () => {
    // The base detail payload defers MRP, so its stored verdict is PENDING;
    // GET /:docNo/coverage heals it to READY. The drawer must show READY, or it
    // would disagree with the drill-down and the SO detail page for one order.
    h.detailItems = [
      { id: "L1", item_code: "SOFA A", description: "SOFA A", item_group: "SOFA", qty: 1,
        unit_price_sen: 500000, total_sen: 500000, stock_status: "PENDING", stock_status_effective: "PENDING",
        delivered_qty: 0, remaining_qty: 1 },
    ];
    h.coverage = {
      coverage: [
        { id: "L1", stock_state: "stock", stock_status_effective: "READY", coverage_po: null,
          coverage_eta: null, ready_source_pos: [] },
      ],
    };
    const drawer = await openDrawer();
    expect(within(drawer).getByText("READY")).toBeTruthy();
    expect(within(drawer).queryByText("PENDING")).toBeNull();
  });
});
