/* BUG-53 (HC-SO-011143, 2026-10-03): opening the order to add a storage charge
 * raised a second, Purchaser approval for a colour change on the SQUARE PILLOW
 * that nobody made. The edit view's variant cascade FILLED the sofa master's
 * colourLabel onto the saved pillow the moment Edit opened, so the amendment
 * builder saw the pillow's variants move. A saved line must open exactly as
 * stored; it follows the sofa only when the operator moves the sofa.
 *
 * Same harness as SalesOrderDetail.frozenLines.test.tsx: the real page on its
 * real route with ?edit=1, SoLineCard replaced by a probe printing the draft.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { detail } = vi.hoisted(() => ({ detail: vi.fn() }));

vi.mock("../../vendor/scm/lib/sales-order-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/sales-order-queries")>()),
  useMfgSalesOrderDetail: detail,
  useSalesOrderAuditLog: () => ({ data: [], isLoading: false, isError: false }),
  useSalesOrderPayments: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("../../vendor/scm/components/SoLineCard", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/components/SoLineCard")>()),
  SoLineCard: (p: { itemId?: string; draft?: { variants?: unknown } }) => (
    <div data-testid={`card-${p.itemId ?? "new"}`} data-variants={JSON.stringify(p.draft?.variants ?? null)} />
  ),
}));
vi.mock("../../hooks/useBreadcrumbs", () => ({ useSetBreadcrumbs: () => undefined }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../../vendor/scm/components/PaymentsTable", () => ({ PaymentsTable: () => null }));
vi.mock("../../vendor/scm/components/CancelRequestPanel", () => ({ CancelRequestPanel: () => null }));
vi.mock("./use-cancel-request-action", () => ({ useCancelRequestAction: () => vi.fn() }));
vi.mock("./so-relationship-map", () => ({ useSoRelationshipMap: () => ({ nodes: [], edges: [] }) }));
vi.mock("../../components/scm-v2/PrintPreviewModal", () => ({
  PrintPreviewModal: () => null,
  useOpenPrintPreviewFromUrl: () => undefined,
  usePrintPreview: () => ({ openPreview: vi.fn(), close: vi.fn(), state: null, handlers: {} }),
}));
vi.mock("../../components/scm-v2/DocumentRelationshipMapModal", () => ({
  DocumentRelationshipMapModal: () => null,
  DocumentChoiceDialog: () => null,
}));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, name: "Owner" }, can: () => true }) }));
vi.mock("../../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { SalesOrderDetail } from "./SalesOrderDetail";

const DOC = "HC-SO-011143";

const header = {
  doc_no: DOC, status: "CONFIRMED", so_date: "2026-09-20", debtor_code: "C1", debtor_name: "Ada",
  currency: "MYR", local_total_sen: 500000, balance_sen: 0, discount_sen: 0, line_count: 2, version: 3,
  processing_date: "2026-10-10", customer_delivery_date: "2026-10-20", phone: "+60123456789", email: "a@b.c",
  address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  has_children: false, downstream_fully_frozen: false,
};

const line = (id: string, group: string, code: string, variants: Record<string, unknown>) => ({
  id, doc_no: DOC, item_group: group, item_code: code, description: code, description2: null, uom: "UNIT",
  qty: 1, unit_price_sen: 0, discount_sen: 0, total_sen: 0, unit_cost_sen: 0, line_cost_sen: 0,
  line_margin_sen: 0, variants, remark: null, photo_urls: null, cancelled: false,
  line_delivery_date: "2026-10-20", line_delivery_date_overridden: false, deliveries: [], delivered_qty: 0,
  remaining_qty: 1, downstream_frozen: false,
});

const SOFA = { fabricCode: "MODENZA-04", colourId: "MODENZA-04", colourLabel: "NX005 AVOCADO" };
const PILLOW = { fabricCode: "MODENZA-04", specials: ["SPECIAL"], specialLabels: ["MODENZA-04 (MUSTARD)"] };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = (items: unknown[]) => {
  detail.mockReturnValue({ data: { salesOrder: header, items }, isLoading: false, isPending: false, isError: false, error: null });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/scm/sales-orders/${DOC}?edit=1`]}>
        <Routes>
          <Route path="/scm/sales-orders/:docNo" element={<SalesOrderDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const draftVariants = (id: string) => JSON.parse(screen.getByTestId(`card-${id}`).dataset.variants ?? "null");

describe("desktop SO editor — opening Edit leaves saved lines as stored", () => {
  it("a saved sofa accessory does not pick up the sofa's colour label", () => {
    mount([line("sofa", "sofa", "SOFA-3S", SOFA), line("pillow", "fabric_accessory", "SQUARE PILLOW", PILLOW)]);
    expect(draftVariants("pillow")).toEqual(PILLOW);
  });

  it("a saved sofa compartment with a blank axis stays blank", () => {
    mount([
      line("sofa", "sofa", "SOFA-3S", { ...SOFA, seatHeight: "21" }),
      line("sofa2", "sofa", "SOFA-CNR", { fabricCode: "MODENZA-04" }),
    ]);
    expect(draftVariants("sofa2")).toEqual({ fabricCode: "MODENZA-04" });
  });
});
