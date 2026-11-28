/* Owner 2026-11-21 — "Edit SO line items after DO" (super admin) in the desktop
 * editor. A DELIVERED order whose product line is frozen on the DO: with
 * `scm.so.edit_lines_after_do` the line un-greys and is FULLY editable inline
 * (qty + spec, not charge-only), and its PATCH carries afterDo. An invoice on
 * the DO no longer hides it (the invoice follows); a Delivery Return does.
 *
 * Harness copied from SalesOrderDetail.priceAfterDo.test.tsx.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { detail, perms } = vi.hoisted(() => ({ detail: vi.fn(), perms: { lines: true } }));

vi.mock("../../vendor/scm/lib/sales-order-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/sales-order-queries")>()),
  useOverrideSoLock: () => ({ mutate: (_v: unknown, o?: { onSuccess?: () => void }) => o?.onSuccess?.(), isPending: false }),
  useMfgSalesOrderDetail: detail,
  useSalesOrderAuditLog: () => ({ data: [], isLoading: false, isError: false }),
  useSalesOrderPayments: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("../../vendor/scm/components/SoLineCard", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/components/SoLineCard")>()),
  SoLineCard: (p: { itemId?: string; isEditing?: boolean; chargeOnly?: boolean; canRemove?: boolean }) => (
    <div data-testid={`card-${p.itemId ?? "new"}`} data-editing={String(p.isEditing)} data-charge={String(!!p.chargeOnly)} data-removable={String(!!p.canRemove)} />
  ),
}));
vi.mock("../../hooks/useBreadcrumbs", () => ({ useSetBreadcrumbs: () => undefined }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => async () => "customer changed the order" }));
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
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, name: "Boss" }, can: (k: string) => k === "scm.so.edit_lines_after_do" ? perms.lines : false }),
}));
vi.mock("../../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { SalesOrderDetail } from "./SalesOrderDetail";
import { AUTH_TOKEN_KEY } from "../../lib/authToken";

const DOC = "HC-SO-013490";
const DO1 = { id: "do-1", do_number: "HC-DO-2610-011", status: "LOADED", locked: false, returned: false };

const header = {
  doc_no: DOC, status: "DELIVERED", so_date: "2026-08-05", debtor_code: "C1", debtor_name: "CHEW WEE LAU",
  currency: "MYR", local_total_sen: 879900, balance_sen: 0, discount_sen: 0, line_count: 1, version: 3,
  processing_date: "2026-08-06", customer_delivery_date: "2026-10-02", phone: "+60162336952", email: "c@w.l",
  address1: "1 Jalan Satu", customer_state: "Putrajaya", city: "Putrajaya", postcode: "62000", customer_so_no: "HC14187",
  has_children: true, downstream_fully_frozen: true, after_do_targets: [DO1], after_do_invoiced: false,
};

const ITEMS = [{
  id: "line-bed", doc_no: DOC, item_group: "bedframe", item_code: "JAGER-(Q)", description: "JAGER-(Q)", description2: null, uom: "UNIT",
  qty: 2, unit_price_sen: 400000, discount_sen: 0, total_sen: 800000, unit_cost_sen: 0, line_cost_sen: 0,
  line_margin_sen: 0, variants: {}, remark: null, photo_urls: null, cancelled: false,
  line_delivery_date: "2026-10-02", line_delivery_date_overridden: false, deliveries: [], delivered_qty: 2,
  remaining_qty: 0, downstream_frozen: true,
}];

beforeEach(() => {
  perms.lines = true;
  sessionStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") {
      if (!String(url).endsWith(`/mfg-sales-orders/${DOC}`)) return new Promise(() => undefined);
      return Promise.resolve(new Response(JSON.stringify({ salesOrder: header, items: ITEMS }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true, problems: [], version: 4 }), { status: 200, headers: { "content-type": "application/json" } }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const mount = (so: Record<string, unknown> = header) => {
  detail.mockReturnValue({ data: { salesOrder: so, items: ITEMS }, isLoading: false, isPending: false, isError: false, error: null });
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
const bedCard = () => screen.queryByTestId("card-line-bed");

describe("with the super-admin lines permission", () => {
  it("the delivered PRODUCT line is fully editable inline (not charge-only)", () => {
    mount();
    const c = bedCard()!;
    expect(c.getAttribute("data-editing")).toBe("true");
    expect(c.getAttribute("data-charge")).toBe("false");
    expect(c.getAttribute("data-removable")).toBe("true");
  });

  it("still editable when the DO already has an invoice — the invoice follows", () => {
    mount({ ...header, after_do_targets: [{ ...DO1, locked: true, returned: false }] });
    expect(bedCard()!.getAttribute("data-editing")).toBe("true");
  });

  it("not once the DO has a Delivery Return", () => {
    mount({ ...header, after_do_targets: [{ ...DO1, locked: true, returned: true }] });
    expect(bedCard()!.getAttribute("data-editing")).toBe("false");
  });
});

describe("without the permission", () => {
  it("the delivered product line stays frozen (read-only)", () => {
    perms.lines = false;
    mount();
    expect(bedCard()!.getAttribute("data-editing")).toBe("false");
    expect(bedCard()!.getAttribute("data-removable")).toBe("false");
  });
});
