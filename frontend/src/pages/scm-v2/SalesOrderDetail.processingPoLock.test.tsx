/* BUG-101 (Sim, 2026-10-10): HC-SO-2609-395 had PO-2610-025 out and its
 * Processing Date was still movable. Once a live PO exists the server flags
 * processing_date_po_locked; the editor freezes the Processing Date and leaves
 * the Delivery Date open, directly and in amendment mode.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  SoLineCard: (p: { itemId?: string; isEditing?: boolean; canRemove?: boolean; draft?: { lineDeliveryDate?: string | null } }) => (
    <div data-testid={`card-${p.itemId ?? "new"}`} data-editing={String(p.isEditing)} data-removable={String(p.canRemove)} data-ddate={p.draft?.lineDeliveryDate ?? ""} />
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

const DOC = "HC-SO-2609-395";

const header = {
  doc_no: DOC, status: "IN_PRODUCTION", so_date: "2026-09-01", debtor_code: "C1", debtor_name: "Ada",
  currency: "MYR", local_total_sen: 100000, balance_sen: 0, discount_sen: 0, line_count: 1, version: 3,
  processing_date: "2027-01-10", customer_delivery_date: "2027-01-20", phone: "+60123456789", email: "a@b.c",
  address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  has_children: false, downstream_fully_frozen: false,
};

const line = {
  id: "line-1", doc_no: DOC, item_group: "bedframe", item_code: "BF-QUEEN", description: "BF-QUEEN", description2: null, uom: "UNIT",
  qty: 1, unit_price_sen: 100000, discount_sen: 0, total_sen: 100000, unit_cost_sen: 0, line_cost_sen: 0,
  line_margin_sen: 0, variants: {}, remark: null, photo_urls: null, cancelled: false,
  line_delivery_date: "2027-01-20", line_delivery_date_overridden: false, deliveries: [], delivered_qty: 0,
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

const proc = () => screen.getByDisplayValue("2027/01/10") as HTMLInputElement;
const deliv = () => screen.getByDisplayValue("2027/01/20") as HTMLInputElement;

describe("desktop SO editor — Processing Date under a live PO", () => {
  it("freezes the Processing Date and keeps the Delivery Date open", () => {
    mount({ ...header, processing_date_po_locked: true });
    expect(proc().disabled).toBe(true);
    expect(deliv().disabled).toBe(false);
    expect(screen.getByText(/only the delivery date can change/i)).toBeTruthy();
  });

  it("stays frozen in amendment mode, where the date lock alone would open it", () => {
    mount({ ...header, processing_date: "2026-09-30", processing_date_po_locked: true, amendment_eligible: true });
    expect((screen.getByDisplayValue("2026/09/30") as HTMLInputElement).disabled).toBe(true);
    expect(deliv().disabled).toBe(false);
  });

  it("with no PO, the Processing Date is editable as before", () => {
    mount({ ...header, processing_date_po_locked: false });
    expect(proc().disabled).toBe(false);
  });
});
