/* DEV-70 (syasya 2026-10-12) — "Edit SO line price after DO" in the desktop
 * editor. HC-SO-013490's shape: DELIVERED, product lines on the DO at RM 0.
 * With `scm.so.edit_price_after_do` the frozen line's $ button opens the
 * price dialog (no Override needed) and posts to /price-after-do.
 *
 * Harness copied from SalesOrderDetail.afterDo.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { detail, perms } = vi.hoisted(() => ({ detail: vi.fn(), perms: { afterDo: false, price: true } }));

vi.mock("../../vendor/scm/lib/sales-order-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/sales-order-queries")>()),
  useMfgSalesOrderDetail: detail,
  useSalesOrderAuditLog: () => ({ data: [], isLoading: false, isError: false }),
  useSalesOrderPayments: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("../../vendor/scm/components/SoLineCard", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/components/SoLineCard")>()),
  SoLineCard: (p: { itemId?: string; isEditing?: boolean; chargeOnly?: boolean }) => (
    <div data-testid={`card-${p.itemId ?? "new"}`} data-editing={String(p.isEditing)} data-charge={String(!!p.chargeOnly)} />
  ),
}));
vi.mock("../../hooks/useBreadcrumbs", () => ({ useSetBreadcrumbs: () => undefined }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => async () => "customer moved house" }));
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
  useAuth: () => ({ user: { id: 1, name: "Syasya" }, can: (k: string) => k === "scm.so.edit_after_do" ? perms.afterDo : k === "scm.so.edit_price_after_do" ? perms.price : k !== "scm.so.price_override" }),
}));
vi.mock("../../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { SalesOrderDetail } from "./SalesOrderDetail";
import { AUTH_TOKEN_KEY } from "../../lib/authToken";

const DOC = "HC-SO-013490";
const DO1 = { id: "do-1", do_number: "HC-DO-2610-011", status: "LOADED", locked: false };

const header = {
  doc_no: DOC, status: "DELIVERED", so_date: "2026-08-05", debtor_code: "C1", debtor_name: "CHEW WEE LAU",
  currency: "MYR", local_total_sen: 879900, balance_sen: 0, discount_sen: 0, line_count: 2, version: 3,
  processing_date: "2026-08-06", customer_delivery_date: "2026-10-02", phone: "+60162336952", email: "c@w.l",
  address1: "1 Jalan Satu", customer_state: "Putrajaya", city: "Putrajaya", postcode: "62000", customer_so_no: "HC14187",
  has_children: true, downstream_fully_frozen: true, after_do_targets: [DO1], after_do_invoiced: false,
};

const line = (id: string, code: string, group: string) => ({
  id, doc_no: DOC, item_group: group, item_code: code, description: code, description2: null, uom: "UNIT",
  qty: 1, unit_price_sen: 5000, discount_sen: 0, total_sen: 5000, unit_cost_sen: 0, line_cost_sen: 0,
  line_margin_sen: 0, variants: {}, remark: null, photo_urls: null, cancelled: false,
  line_delivery_date: "2026-10-02", line_delivery_date_overridden: false, deliveries: [], delivered_qty: 1,
  remaining_qty: 0, downstream_frozen: true,
});
const ITEMS = [{ ...line("line-bed", "JAGER-(Q)", "bedframe"), qty: 2, unit_price_sen: 0, total_sen: 0 }];

let calls: Array<{ url: string; method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  perms.afterDo = false;
  perms.price = true;
  calls = [];
  sessionStorage.setItem(AUTH_TOKEN_KEY, "test-token"); // authedFetch refuses to send without one
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : {} });
    if ((init?.method ?? "GET") === "GET") {
      if (!String(url).endsWith(`/mfg-sales-orders/${DOC}`)) return new Promise(() => undefined);
      return Promise.resolve(new Response(JSON.stringify({ salesOrder: header, items: ITEMS }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true, problems: [], version: 4, item: { id: "new-1" } }), { status: 200, headers: { "content-type": "application/json" } }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const mount = (so: Record<string, unknown> = header, items: unknown[] = ITEMS) => {
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
const priceBtn = () => screen.queryByRole("button", { name: "Change price after DO" }) ?? screen.queryByTitle("Change price after DO");

describe("with the price permission", () => {
  it("the delivered line offers the price dialog without Override", () => {
    mount();
    const b = priceBtn() as HTMLButtonElement;
    expect(b).toBeTruthy();
    expect(b.disabled).toBe(false);
  });

  it("saving posts the unit price and discount for that line", async () => {
    mount();
    fireEvent.click(priceBtn()!);
    const dlg = await screen.findByRole("dialog", { name: "Change price after DO" });
    fireEvent.change(screen.getByLabelText("Unit Price (RM)"), { target: { value: "2125" } });
    fireEvent.change(screen.getByLabelText("Discount (RM)"), { target: { value: "50" } });
    expect(dlg.textContent).toContain("4,200.00");
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url.endsWith(`/mfg-sales-orders/${DOC}/items/line-bed/price-after-do`))?.body)
      .toMatchObject({ unitPriceSen: 212500, discountSen: 5000 }));
  });

  it("a discount above qty x unit price cannot be saved", async () => {
    mount();
    fireEvent.click(priceBtn()!);
    await screen.findByRole("dialog", { name: "Change price after DO" });
    fireEvent.change(screen.getByLabelText("Unit Price (RM)"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Discount (RM)"), { target: { value: "20.01" } });
    expect((screen.getByRole("button", { name: "Save price" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("not once every DO of the order has an invoice or return", () => {
    mount({ ...header, after_do_targets: [{ ...DO1, locked: true }] });
    expect(priceBtn()).toBeNull();
  });
});

describe("without the price permission", () => {
  it("the delivered line keeps only the disabled Override price button", () => {
    perms.price = false;
    mount();
    expect(priceBtn()).toBeNull();
    expect((screen.getByTitle("Override price") as HTMLButtonElement).disabled).toBe(true);
  });
});
