/* HC-0113 (Sim, 2026-10-16): HC-SO-2609-077 was drafted with Processing Date
 * 18/9 and confirmed on 13/10. The Confirm Order dialog now tells the
 * salesperson that a past Processing Date becomes the confirm date (the server
 * makes the change; see processingDateOnConfirm).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { detail, auth, askConfirm } = vi.hoisted(() => ({ detail: vi.fn(), auth: { override: false }, askConfirm: vi.fn(async (_opts: { body?: unknown }) => false) }));

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
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => askConfirm }));
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
/* Every grant except the PO exception, unless a test turns it on. */
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, name: "Desk" }, can: (p: string) => p !== "scm.so.override_po_processing_date" || auth.override }),
}));
vi.mock("../../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { SalesOrderDetail } from "./SalesOrderDetail";

const DOC = "HC-SO-2609-077";

const header = {
  doc_no: DOC, status: "DRAFT", so_date: "2026-09-01", debtor_code: "C1", debtor_name: "Ada",
  currency: "MYR", local_total_sen: 100000, balance_sen: 0, discount_sen: 0, line_count: 1, version: 3,
  processing_date: "2026-09-18", customer_delivery_date: "2026-10-26", phone: "+60123456789", email: "a@b.c",
  address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  has_children: false, downstream_fully_frozen: false,
};

const line = {
  id: "line-1", doc_no: DOC, item_group: "bedframe", item_code: "BF-QUEEN", description: "BF-QUEEN", description2: null, uom: "UNIT",
  qty: 1, unit_price_sen: 100000, discount_sen: 0, total_sen: 100000, unit_cost_sen: 0, line_cost_sen: 0,
  line_margin_sen: 0, variants: {}, remark: null, photo_urls: null, cancelled: false,
  line_delivery_date: "2026-10-26", line_delivery_date_overridden: false, deliveries: [], delivered_qty: 0,
  remaining_qty: 1, downstream_frozen: false,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T09:14:00Z")); // 17:14 MYT
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); askConfirm.mockClear(); });

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

/* The dialog body the Confirm Order click asked with, rendered on its own. */
const confirmBody = async (): Promise<string> => {
  fireEvent.click(screen.getByRole("button", { name: "Confirm Order" }));
  await waitFor(() => expect(askConfirm).toHaveBeenCalled());
  const body = askConfirm.mock.calls[0]![0].body as React.ReactNode;
  cleanup();
  return render(<>{body}</>).container.textContent;
};

describe("desktop Confirm Order — HC-0113 Processing Date note", () => {
  it("says a past Processing Date becomes the confirm date", async () => {
    mount(header);
    expect(await confirmBody()).toContain("The Processing Date 18/09/2026 has passed. Confirming today changes it to the confirm date, 13/10/2026.");
  });

  it("says nothing extra when the Processing Date is today or later", async () => {
    mount({ ...header, processing_date: "2026-10-20" });
    expect(await confirmBody()).not.toContain("has passed");
  });

  it("asks for a new Delivery Date when that has passed too", async () => {
    mount({ ...header, customer_delivery_date: "2026-10-01" });
    expect(await confirmBody()).toContain("The Delivery Date 01/10/2026 has already passed.");
  });
});
