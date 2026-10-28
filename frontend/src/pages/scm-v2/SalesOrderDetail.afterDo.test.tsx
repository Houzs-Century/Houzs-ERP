/* DEV-32 (Syu 2026-10-01) — "Edit SO after DO" in the desktop editor. HC-SO-013143's
 * shape: DELIVERED, every line on HC-DO-2610-011, processing date passed. With
 * `scm.so.edit_after_do` and Override pressed, the customer details and the
 * charge lines reopen; everything else stays as frozen as before.
 *
 * Same harness as SalesOrderDetail.frozenLines.test.tsx: the real page on its
 * route with ?edit=1, the detail read faked, SoLineCard replaced by a probe.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { detail, perms } = vi.hoisted(() => ({ detail: vi.fn(), perms: { afterDo: true } }));

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
  useAuth: () => ({ user: { id: 1, name: "Logistics" }, can: (k: string) => k !== "scm.so.edit_after_do" || perms.afterDo }),
}));
vi.mock("../../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { SalesOrderDetail } from "./SalesOrderDetail";
import { AUTH_TOKEN_KEY } from "../../lib/authToken";

const DOC = "HC-SO-013143";
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
const ITEMS = [line("line-bed", "BF-QUEEN", "bedframe"), line("line-svc", "SVC-TRANSPORT", "service")];

let calls: Array<{ url: string; method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  perms.afterDo = true;
  calls = [];
  sessionStorage.setItem(AUTH_TOKEN_KEY, "test-token"); // authedFetch refuses to send without one
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : {} });
    if ((init?.method ?? "GET") === "GET") return new Promise(() => undefined);
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
const override = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Override" }));
  await screen.findByTestId("so-after-do-notice");
};
const field = (value: string) => screen.getByDisplayValue(value) as HTMLInputElement;

describe("before Override, the delivered order is as locked as it was", () => {
  it("no notice, customer details shut, no line opens", () => {
    mount();
    expect(screen.queryByTestId("so-after-do-notice")).toBeNull();
    expect(field("CHEW WEE LAU").disabled).toBe(true);
    expect(screen.getByTestId("card-line-svc").dataset.editing).toBe("false");
  });
});

describe("Logistics with the permission, after Override", () => {
  it("names the DO the changes go to", async () => {
    mount();
    await override();
    expect(screen.getByTestId("so-after-do-notice").textContent).toContain("HC-DO-2610-011");
  });

  it("reopens the customer details but not the Ref No. or the State", async () => {
    mount();
    await override();
    expect(field("CHEW WEE LAU").disabled).toBe(false);
    expect(field("1 Jalan Satu").disabled).toBe(false);
    expect(field("HC14187").disabled).toBe(true);
  });

  it("reopens the charge line as a charge, and leaves the bedframe frozen", async () => {
    mount();
    await override();
    expect(screen.getByTestId("card-line-svc").dataset).toMatchObject({ editing: "true", charge: "true" });
    expect(screen.getByTestId("card-line-bed").dataset.editing).toBe("false");
    expect((screen.getByRole("button", { name: /add line/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a new line is a charge line and asks the server to put it on the DO", async () => {
    mount();
    await override();
    fireEvent.click(screen.getByRole("button", { name: /add line/i }));
    expect(screen.getByTestId("card-new").dataset.charge).toBe("true");
  });

  it("saving a customer change sends the after-DO flag", async () => {
    mount();
    await override();
    fireEvent.change(field("CHEW WEE LAU"), { target: { value: "CHEW WEE LAU (MR)" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith(`/mfg-sales-orders/${DOC}`) && c.body.afterDo === true)).toBe(true));
  });

  it("with two open DOs, offers the pick", async () => {
    mount({ ...header, after_do_targets: [DO1, { ...DO1, id: "do-2", do_number: "HC-DO-2610-020" }] });
    await override();
    expect(screen.getByLabelText("Delivery Order for new charge lines")).toBeTruthy();
  });

  it("an invoiced DO keeps the customer details shut and says why", async () => {
    mount({ ...header, after_do_targets: [DO1, { ...DO1, id: "do-2", do_number: "HC-DO-2610-020", locked: true }] });
    await override();
    expect(screen.getByTestId("so-after-do-notice").textContent).toContain("HC-DO-2610-020 already has an invoice or return");
    expect(field("CHEW WEE LAU").disabled).toBe(true);
    expect(screen.getByTestId("card-line-svc").dataset.editing).toBe("true");
  });
});

describe("without the permission, Override changes nothing about the DO lock", () => {
  it("no notice, customer details shut, charge line frozen", async () => {
    perms.afterDo = false;
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    await screen.findByRole("button", { name: "Re-lock" });
    expect(screen.queryByTestId("so-after-do-notice")).toBeNull();
    expect(field("CHEW WEE LAU").disabled).toBe(true);
    expect(screen.getByTestId("card-line-svc").dataset.editing).toBe("false");
    expect((screen.getByRole("button", { name: /add line/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
