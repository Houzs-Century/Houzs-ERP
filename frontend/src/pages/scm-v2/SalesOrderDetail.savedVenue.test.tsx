/* The desktop twin of MobileNewSO.savedVenue.test.tsx: a venue already SAVED on
 * an order is what the editor shows (owner 2026-06-23: "never override a manual
 * or loaded pick"). The salesperson-default effect only checked venue_id, and a
 * saved venue usually has none (3,219 of 3,242 live orders on 2026-09-24), so
 * the default could replace it the moment it resolved. Dormant in production
 * only because those default ids (scm.venues) match nothing in useVenues();
 * here they do.
 *
 * Same harness as SalesOrderDetail.frozenLines.test.tsx: the editor MOUNTED on
 * its real route with ?edit=1, plus the venue master and the salesperson list so
 * a default can actually resolve.
 */
import { cleanup, render } from "@testing-library/react";
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
vi.mock("../../vendor/scm/lib/venues-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/venues-queries")>()),
  useVenues: () => ({ data: VENUES, isLoading: false, isError: false }),
}));
vi.mock("../../vendor/scm/lib/admin-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/admin-queries")>()),
  usePickableStaff: () => ({ data: STAFF, isLoading: false, isError: false }),
  useStaff: () => ({ data: STAFF, isLoading: false, isError: false }),
}));
vi.mock("../../vendor/scm/components/SoLineCard", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/components/SoLineCard")>()),
  SoLineCard: () => <div />,
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

const DOC = "2990-SO-2609-014";

const venue = (id: string, name: string) => ({ id, name, address: null, state: null, active: true, created_at: "2026-01-01", origin: "PROJECT", warehouseId: null });
const VENUES = [venue("V-DEFAULT", "PJ SHOWROOM"), venue("107", "2990s PJ")];
/* S1 is Scarlett's shape on production: a default venue of her own. */
const STAFF = [{
  id: "S1", staffCode: "S1", name: "S1", role: "sales", showroomId: null, venueId: "V-DEFAULT", initials: "S1", color: "#000",
  active: true, userId: null, email: null, phone: null,
}];

const header = (venueText: string | null) => ({
  doc_no: DOC, status: "CONFIRMED", so_date: "2026-09-20", debtor_code: "C1", debtor_name: "Ada",
  currency: "MYR", local_total_sen: 100000, balance_sen: 0, discount_sen: 0, line_count: 1, version: 3,
  processing_date: null, customer_delivery_date: null, phone: "+60123456789", email: "a@b.c",
  address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  salesperson_id: "S1", venue: venueText, venue_id: null, has_children: false, downstream_fully_frozen: false,
});
const line = {
  id: "line-1", doc_no: DOC, item_group: "mattress", item_code: "MT-QUEEN", description: "MT-QUEEN", description2: null, uom: "UNIT",
  qty: 1, unit_price_sen: 100000, discount_sen: 0, total_sen: 100000, unit_cost_sen: 0, line_cost_sen: 0,
  line_margin_sen: 0, variants: {}, remark: null, photo_urls: null, cancelled: false,
  line_delivery_date: null, line_delivery_date_overridden: false, deliveries: [], delivered_qty: 0,
  remaining_qty: 1, downstream_frozen: false,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = (so: Record<string, unknown>) => {
  detail.mockReturnValue({ data: { salesOrder: so, items: [line] }, isLoading: false, isPending: false, isError: false, error: null });
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

const shownPlace = (c: HTMLElement) =>
  (c.querySelector("#so-detail-fair") as HTMLSelectElement | null)?.selectedOptions.item(0)?.textContent ?? null;

describe("desktop SO editor — the saved venue is the venue", () => {
  it("keeps the order's own venue, not the salesperson's default", () => {
    const { container } = mount(header("2990s PJ"));
    expect(shownPlace(container)).toBe("2990s PJ");
  });

  it("an order with no venue still takes the salesperson's default", () => {
    const { container } = mount(header(null));
    expect(shownPlace(container)).toBe("PJ SHOWROOM");
  });
});
