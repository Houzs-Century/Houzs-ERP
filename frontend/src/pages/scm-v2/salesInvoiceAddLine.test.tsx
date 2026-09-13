/* The SALES INVOICE could not add a line ON ANY SURFACE.
 *
 * Measured 2026-09-13, on `main`:
 *   · `backend/src/scm/routes/sales-invoices.ts` HAS `POST /:id/items`;
 *   · `vendor/scm/lib/sales-invoice-queries.ts` exports `useAddSalesInvoiceItem`;
 *   · that hook had ZERO call sites in `frontend/src`.
 * So the endpoint existed, was guarded, was audited, posted revenue — and no
 * operator could reach it. The other four SCM documents got an "Add line"
 * button on 2026-09-13 (docs/bugs/0853); this one was left out because it has
 * no separate V1 editor page to forward `?edit=1` to.
 *
 * WHY THE SURFACE IS DIFFERENT HERE, and why that is not a shortcut. The four
 * siblings put the button on the detail page and hand the operator to an
 * EDITOR page through `add-line-handoff.ts`. The sales invoice has exactly one
 * page — `SalesInvoiceDetailV2.tsx` — so there is nothing to hand off TO. A
 * second editor page would be a whole surface built to carry one button. The
 * add row therefore lives on the detail page itself, in the Line items section
 * header where the lines already are, and still spells the action with the
 * shared `ADD_LINE_LABEL` so the owner reads one word on all five documents.
 *
 * The page is MOUNTED under a real router with only its data hooks faked, so
 * these assertions are about what the operator can actually reach — not about
 * which symbols the file imports.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  detail, payments, updateStatus, addPayment, deletePayment, updateHeader, addItem,
  notify, confirm,
} = vi.hoisted(() => ({
  detail: vi.fn(),
  payments: vi.fn(),
  updateStatus: vi.fn(),
  addPayment: vi.fn(),
  deletePayment: vi.fn(),
  updateHeader: vi.fn(),
  addItem: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../../vendor/scm/lib/sales-invoice-queries", () => ({
  useSalesInvoiceDetail: detail,
  useSalesInvoicePayments: payments,
  useUpdateSalesInvoiceStatus: updateStatus,
  useAddSalesInvoicePayment: addPayment,
  useDeleteSalesInvoicePayment: deletePayment,
  useUpdateSalesInvoiceHeader: updateHeader,
  useAddSalesInvoiceItem: addItem,
}));
vi.mock("../../vendor/scm/lib/mfg-products-queries", () => ({
  useMfgProducts: () => ({ data: [{ id: "p1", code: "ACC-001", name: "Scatter cushion", category: "ACCESSORY" }] }),
}));
vi.mock("../../vendor/scm/components/PaymentsTable", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  PaymentsTable: () => <div data-testid="payments-table" />,
}));
vi.mock("../../hooks/useBreadcrumbs", () => ({ useSetBreadcrumbs: () => undefined }));
vi.mock("../../hooks/useStaffLookup", () => ({ useStaffLookup: () => ({ nameOf: () => "Kris" }) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => notify }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => confirm }));
vi.mock("./sales-doc-relationship-map", () => ({
  useSiRelationshipMap: () => ({
    nodes: [], onNodeClick: vi.fn(), choice: null, closeChoice: vi.fn(), pickChoice: vi.fn(),
  }),
}));
vi.mock("../../components/scm-v2/PrintPreviewModal", () => ({
  PrintPreviewModal: () => null,
  useOpenPrintPreviewFromUrl: () => undefined,
  usePrintPreview: () => ({ openPreview: vi.fn(), close: vi.fn(), state: null }),
}));
vi.mock("../../components/scm-v2/DocumentRelationshipMapModal", () => ({
  DocumentRelationshipMapModal: () => null,
  DocumentChoiceDialog: () => null,
}));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => access.current }) }));

import { SalesInvoiceDetailV2 } from "./SalesInvoiceDetailV2";
import { ADD_LINE_LABEL } from "../../vendor/scm/lib/add-line-handoff";

/** Mutable so one test can drop the operator to read-only without a new mock. */
const access = { current: "full" as "full" | "view" };

const ID = "11111111-2222-3333-4444-555555555555";

const header = {
  id: ID,
  invoice_number: "HC-SI-2609-004",
  status: "DRAFT",
  invoice_date: "2026-09-13",
  due_date: "2026-10-13",
  debtor_code: "C1",
  debtor_name: "Ada",
  currency: "MYR",
  total_sen: 440_000,
  local_total_sen: 440_000,
  paid_sen: 0,
  phone: null,
  email: null,
};

const ok = <T,>(data: T) => ({
  data, isLoading: false, isPending: false, isError: false, isSuccess: true,
  error: null, status: "success" as const,
});

const addMutateAsync = vi.fn();

function setup(overrides: { status?: string; pageAccess?: "full" | "view" } = {}) {
  access.current = overrides.pageAccess ?? "full";
  detail.mockReturnValue(
    ok({
      salesInvoice: { ...header, status: overrides.status ?? "DRAFT" },
      items: [
        { id: "l1", item_code: "SOFA-A", description: "Sofa", line_total_sen: 440_000, qty: 1, cancelled: false },
      ],
      orderDeposit: null,
      orderDepositUnavailable: false,
    }),
  );
  payments.mockReturnValue(ok([]));
  updateStatus.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  addPayment.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  deletePayment.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  updateHeader.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  addItem.mockReturnValue({ mutate: vi.fn(), mutateAsync: addMutateAsync, isPending: false });

  return render(
    <MemoryRouter initialEntries={[`/scm/sales-invoices/${ID}`]}>
      <Routes>
        <Route path="/scm/sales-invoices/:id" element={<SalesInvoiceDetailV2 />} />
      </Routes>
    </MemoryRouter>,
  );
}

const addLineButton = () => screen.queryByRole("button", { name: ADD_LINE_LABEL });

/* Scoped to the add row's own fieldset. The line TABLE's column headers carry
   "Unit price" / "Discount" filter buttons with those exact accessible names,
   so an unscoped query matches two elements and the field is unaddressable. */
const row = () => within(screen.getByRole("group", { name: /new line/i }));

/** Fill the add row. MoneyInput commits on BLUR, so money goes change+blur. */
function fillRow(opts: { code?: string; description?: string; qty?: string; price?: string; discount?: string } = {}) {
  const r = row();
  if (opts.code !== undefined) {
    fireEvent.change(r.getByLabelText(/item code/i), { target: { value: opts.code } });
  }
  if (opts.description !== undefined) {
    fireEvent.change(r.getByLabelText(/description/i), { target: { value: opts.description } });
  }
  if (opts.qty !== undefined) {
    fireEvent.change(r.getByLabelText(/^qty$/i), { target: { value: opts.qty } });
  }
  if (opts.price !== undefined) {
    const el = r.getByLabelText(/unit price/i);
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: opts.price } });
    fireEvent.blur(el);
  }
  if (opts.discount !== undefined) {
    const el = r.getByLabelText(/discount/i);
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: opts.discount } });
    fireEvent.blur(el);
  }
}

const saveRow = () => fireEvent.click(screen.getByRole("button", { name: /^add to invoice$/i }));

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom ships no layout, so no scrollIntoView; the page calls it in a rAF
  // where a throw escapes as an unhandled error.
  Element.prototype.scrollIntoView = vi.fn();
  addMutateAsync.mockResolvedValue({ item: { id: "new" } });
  confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe("Sales invoice — adding a line by hand", () => {
  it("offers the action from the page you start on, under the shared name", async () => {
    /* THE GAP. Before this change the page rendered no such control on any
       surface, and `useAddSalesInvoiceItem` had zero call sites — so this
       assertion is the whole defect in one line. */
    setup();
    await screen.findByText(/line items/i);
    expect(addLineButton()).not.toBeNull();
    expect(ADD_LINE_LABEL).toBe("Add line");
  });

  it("posts the line to POST /:id/items with the money in SEN", async () => {
    setup();
    await screen.findByText(/line items/i);
    fireEvent.click(addLineButton()!);

    fillRow({ code: "ACC-001", description: "Scatter cushion", qty: "3", price: "55", discount: "5" });
    saveRow();

    await waitFor(() => expect(addMutateAsync).toHaveBeenCalledTimes(1));
    const payload = addMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.id).toBe(ID);
    expect(payload.itemCode).toBe("ACC-001");
    expect(payload.description).toBe("Scatter cushion");
    expect(payload.qty).toBe(3);
    /* Sen, not ringgit. `buildItemRow` multiplies qty × unitPriceSen straight
       into line_total_sen — a ringgit here would under-bill by 100×. */
    expect(payload.unitPriceSen).toBe(5_500);
    expect(payload.discountSen).toBe(500);
  });

  it("closes the row on success so a second save cannot double-post", async () => {
    setup();
    await screen.findByText(/line items/i);
    fireEvent.click(addLineButton()!);
    fillRow({ code: "ACC-001", qty: "1", price: "10" });
    saveRow();

    await waitFor(() => expect(addMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^add to invoice$/i })).toBeNull());
  });

  it("refuses an empty item code WITHOUT calling the server", async () => {
    /* The backend answers 400 `item_code_required`. Saying so inline costs one
       round trip less and keeps what the operator typed. */
    setup();
    await screen.findByText(/line items/i);
    fireEvent.click(addLineButton()!);
    fillRow({ description: "no code", qty: "1", price: "10" });
    saveRow();

    expect(await screen.findByText(/item code is required/i)).toBeTruthy();
    expect(addMutateAsync).not.toHaveBeenCalled();
  });

  it("shows the server's refusal INLINE and keeps the row open", async () => {
    /* The repo's recurring bug class is a refusal that reaches nobody
       (vendor/scm/lib/mutation-error.ts). The 409s this endpoint can answer —
       an unknown item code, a line still pending on the source Delivery Order,
       an over-remaining quantity — all carry a sentence worth reading, and it
       has to arrive next to the row that caused it, still holding the typing. */
    setup();
    await screen.findByText(/line items/i);
    fireEvent.click(addLineButton()!);
    fillRow({ code: "ACC-001", qty: "1", price: "10" });
    addMutateAsync.mockRejectedValueOnce(new Error(
      "ACC-001 is still pending on the source Delivery Order — add it through \"Add from Delivery Order\" so the delivered quantity is tracked.",
    ));
    saveRow();

    expect(await screen.findByText(/still pending on the source Delivery Order/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^add to invoice$/i })).toBeTruthy();
  });

  it("is absent once the invoice is ISSUED — the backend 409s it, so do not offer it", async () => {
    /* `isIssuedSi` = any status but DRAFT and CANCELLED. Lines are frozen
       wholesale there: adding one raises what the customer owes and void+reposts
       the GL, without the PDF in their hand changing. */
    setup({ status: "SENT" });
    await screen.findByText(/line items/i);
    expect(addLineButton()).toBeNull();
  });

  it("is absent on a CANCELLED invoice", async () => {
    setup({ status: "CANCELLED" });
    await screen.findByText(/line items/i);
    expect(addLineButton()).toBeNull();
  });

  it("is absent for an operator with read-only access to sales invoices", async () => {
    /* Gated exactly as the page's own Edit affordance is — `pageAccess` in
       ("edit" | "full") — so one permission answers for both. */
    setup({ pageAccess: "view" });
    await screen.findByText(/line items/i);
    expect(addLineButton()).toBeNull();
  });
});
