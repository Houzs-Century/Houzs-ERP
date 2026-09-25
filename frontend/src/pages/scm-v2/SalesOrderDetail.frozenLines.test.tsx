/* A partly delivered Sales Order in the desktop editor (owner 2026-09-15:
 * 「已经送货了的，你就 remain 着，可能要放灰色之类的，设置成不可以被 edit」).
 *
 * The editor is MOUNTED on its real route with ?edit=1, under a real
 * QueryClient; only the detail read is faked and every other request is left
 * pending. SoLineCard is replaced by a probe that prints the props the page
 * hands it — which is exactly the decision under test: does the page open the
 * delivered line for editing, and does it open the undelivered sibling?
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

const DOC = "HC-SO-2609-001";

const header = {
  doc_no: DOC, status: "READY_TO_SHIP", so_date: "2026-09-01", debtor_code: "C1", debtor_name: "Ada",
  currency: "MYR", local_total_sen: 350000, balance_sen: 0, discount_sen: 0, line_count: 2, version: 3,
  processing_date: null, customer_delivery_date: "2026-09-20", phone: "+60123456789", email: "a@b.c",
  address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  /* One live DO carries ONE of the three bedframes. */
  has_children: true, downstream_fully_frozen: false,
};

const line = (id: string, code: string, frozen: boolean) => ({
  id, doc_no: DOC, item_group: "bedframe", item_code: code, description: code, description2: null, uom: "UNIT",
  qty: 1, unit_price_sen: 100000, discount_sen: 0, total_sen: 100000, unit_cost_sen: 0, line_cost_sen: 0,
  line_margin_sen: 0, variants: {}, remark: null, photo_urls: null, cancelled: false,
  line_delivery_date: "2026-09-20", line_delivery_date_overridden: false, deliveries: [], delivered_qty: 0,
  remaining_qty: 1, downstream_frozen: frozen,
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = (so: Record<string, unknown>, items: unknown[]) => {
  detail.mockReturnValue({ data: { salesOrder: so, items }, isLoading: false, isPending: false, isError: false, error: null });
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

describe("desktop SO editor — a partly delivered order", () => {
  it("greys the delivered line and opens it for nothing", () => {
    mount(header, [line("line-delivered", "BF-QUEEN", true), line("line-open", "MT-QUEEN", false)]);
    const card = screen.getByTestId("card-line-delivered");
    expect(card.dataset.editing).toBe("false");
    expect(card.dataset.removable).toBe("false");
    const frame = card.closest("[data-frozen]") as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.style.filter).toBe("grayscale(1)");
    expect(frame.textContent).toContain("On a Delivery Order / Invoice");
    expect((frame.querySelector('button[title="Override price"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the undelivered sibling editable, and new lines can still be added", () => {
    mount(header, [line("line-delivered", "BF-QUEEN", true), line("line-open", "MT-QUEEN", false)]);
    const card = screen.getByTestId("card-line-open");
    expect(card.dataset.editing).toBe("true");
    expect(card.dataset.removable).toBe("true");
    expect(card.closest("[data-frozen]")).toBeNull();
    expect((screen.getByRole("button", { name: /add line/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("freezes the customer fields a delivery order snapshots, but not the delivery date", () => {
    mount(header, [line("line-delivered", "BF-QUEEN", true), line("line-open", "MT-QUEEN", false)]);
    expect((screen.getByDisplayValue("Ada") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByDisplayValue("1 Jalan") as HTMLInputElement).disabled).toBe(true);
  });

  it("moving the header Delivery Date moves the open line and leaves the delivered line on its date", () => {
    mount(header, [line("line-delivered", "BF-QUEEN", true), line("line-open", "MT-QUEEN", false)]);
    const dateBox = screen.getByDisplayValue("2026/09/20") as HTMLInputElement;
    expect(dateBox.disabled).toBe(false);
    fireEvent.change(dateBox, { target: { value: "2026/10/01" } });
    expect(screen.getByTestId("card-line-open").dataset.ddate).toBe("2026-10-01");
    expect(screen.getByTestId("card-line-delivered").dataset.ddate).toBe("2026-09-20");
  });

  it("an order with every line delivered stays locked, as before", () => {
    mount({ ...header, downstream_fully_frozen: true }, [line("line-delivered", "BF-QUEEN", true)]);
    expect(screen.getByTestId("card-line-delivered").dataset.editing).toBe("false");
    expect((screen.getByRole("button", { name: /add line/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
