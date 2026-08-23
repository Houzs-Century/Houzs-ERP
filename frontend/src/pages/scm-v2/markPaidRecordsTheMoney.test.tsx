/* "Mark paid" has to RECORD THE MONEY.
 *
 * THE DEFECT. The button PATCHed `/sales-invoices/:id/status` with
 * `{ status: 'PAID' }` and wrote no payment row. Two columns of one document
 * then disagreed — status PAID, `paid_sen` 0 — and the disagreement did not
 * last: the server DERIVES the status from the payments ledger
 * (`recomputeSiPaid`, backend `scm/lib/si-order-deposit.ts`), so the next time
 * anything touched that invoice's money the hand-written PAID was silently
 * reverted. In between, an invoice with nothing banked against it read as
 * settled.
 *
 * WHAT THESE TESTS PIN, and each one bites on the pre-fix tree:
 *   1. pressing Mark paid writes NO status — `useUpdateSalesInvoiceStatus` is
 *      never called;
 *   2. it seeds a receipt for the OUTSTANDING balance, NET of the source
 *      order's deposit — 4,400 invoice, 2,000 already collected on the order,
 *      2,400 recorded. Recording 4,400 would book 2,000 of cash that never
 *      arrived (the order's deposit is read THROUGH, never copied, precisely
 *      because both ledgers post Dr cash / Cr AR);
 *   3. saving sends that amount to `POST /:id/payments` — the same endpoint a
 *      manually-entered payment uses, so the GL posting happens once, on one
 *      path;
 *   4. the button is not offered where there is no honest receipt to write:
 *      nothing outstanding, an unreadable order deposit, a cancelled invoice or
 *      a draft (the payment routes 409 the last two with `not_payable`).
 *
 * The page is MOUNTED under a real router with only its data hooks faked, and
 * the assertions are about what the operator gets — not about which symbols the
 * file imports.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentDraft } from "../../vendor/scm/components/PaymentsTable";

const {
  detail,
  payments,
  updateStatus,
  addPayment,
  deletePayment,
  updateHeader,
  notify,
  confirm,
  lastPaymentsTableProps,
} = vi.hoisted(() => ({
  detail: vi.fn(),
  payments: vi.fn(),
  updateStatus: vi.fn(),
  addPayment: vi.fn(),
  deletePayment: vi.fn(),
  updateHeader: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
  lastPaymentsTableProps: { current: null as null | { payments: PaymentDraft[]; locked: boolean } },
}));

vi.mock("../../vendor/scm/lib/sales-invoice-queries", () => ({
  useSalesInvoiceDetail: detail,
  useSalesInvoicePayments: payments,
  useUpdateSalesInvoiceStatus: updateStatus,
  useAddSalesInvoicePayment: addPayment,
  useDeleteSalesInvoicePayment: deletePayment,
  useUpdateSalesInvoiceHeader: updateHeader,
}));
/* The REAL draft helpers stay — `newPaymentDraft` mints the row Mark paid
   seeds, and `labelToApi` / `draftMethodFields` translate it on the way out, so
   faking them would test a fake. Only the TABLE is replaced, with a probe that
   records the drafts it was handed. */
vi.mock("../../vendor/scm/components/PaymentsTable", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  PaymentsTable: (props: { payments: PaymentDraft[]; locked: boolean }) => {
    lastPaymentsTableProps.current = props;
    return (
      <div data-testid="payments-table">
        {props.payments.map((p) => (
          <div key={p.uid} data-testid="payment-row" data-amount-sen={p.amountSen} data-method={p.methodLabel} />
        ))}
      </div>
    );
  },
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
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => "full" }) }));

import { SalesInvoiceDetailV2 } from "./SalesInvoiceDetailV2";

const ID = "11111111-2222-3333-4444-555555555555";

/** MYR 4,400.00 invoice. Sen throughout, as the columns are. */
const TOTAL_SEN = 440_000;
/** MYR 2,000.00 already collected on the SALES ORDER this invoice came from. */
const DEPOSIT_SEN = 200_000;
/** What is genuinely still owed, and the ONLY figure Mark paid may record. */
const OUTSTANDING_SEN = TOTAL_SEN - DEPOSIT_SEN; // 240_000

const header = {
  id: ID,
  invoice_number: "HC-SI-2608-004",
  status: "SENT",
  invoice_date: "2026-08-14",
  due_date: "2026-09-14",
  debtor_code: "C1",
  debtor_name: "Ada",
  currency: "MYR",
  total_sen: TOTAL_SEN,
  local_total_sen: TOTAL_SEN,
  paid_sen: 0,
  phone: null,
  email: null,
};

const orderDeposit = {
  so_doc_no: "HC-SO-2608-011",
  order_collected_sen: DEPOSIT_SEN,
  applied_sen: DEPOSIT_SEN,
  transactions: [],
};

const ok = <T,>(data: T) => ({
  data, isLoading: false, isPending: false, isError: false, isSuccess: true,
  error: null, status: "success" as const,
});

const addPaymentMutateAsync = vi.fn();
const updateStatusMutate = vi.fn();

function setup(overrides: {
  status?: string;
  paidSen?: number;
  deposit?: typeof orderDeposit | null;
  depositUnavailable?: boolean;
} = {}) {
  detail.mockReturnValue(
    ok({
      salesInvoice: { ...header, status: overrides.status ?? "SENT", paid_sen: overrides.paidSen ?? 0 },
      items: [
        { id: "l1", item_code: "SOFA-A", description: "Sofa", line_total_sen: TOTAL_SEN, qty: 1, cancelled: false },
      ],
      orderDeposit: overrides.deposit === undefined ? orderDeposit : overrides.deposit,
      orderDepositUnavailable: overrides.depositUnavailable ?? false,
    }),
  );
  payments.mockReturnValue(ok([]));
  updateStatus.mockReturnValue({ mutate: updateStatusMutate, mutateAsync: vi.fn(), isPending: false });
  addPayment.mockReturnValue({ mutate: vi.fn(), mutateAsync: addPaymentMutateAsync, isPending: false });
  deletePayment.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  updateHeader.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });

  return render(
    <MemoryRouter initialEntries={[`/scm/sales-invoices/${ID}`]}>
      <Routes>
        <Route path="/scm/sales-invoices/:id" element={<SalesInvoiceDetailV2 />} />
      </Routes>
    </MemoryRouter>,
  );
}

const markPaidButton = () => screen.queryByRole("button", { name: /mark paid/i });
const seededRows = () =>
  screen.queryAllByTestId("payment-row").map((el) => Number(el.getAttribute("data-amount-sen")));

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no layout, so it ships no scrollIntoView. The page calls it inside
  // a requestAnimationFrame, where a throw escapes as an unhandled error.
  Element.prototype.scrollIntoView = vi.fn();
  lastPaymentsTableProps.current = null;
  window.localStorage.clear();
  addPaymentMutateAsync.mockResolvedValue({ payment: { id: "p1" } });
  confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe("Mark paid records the money", () => {
  it("writes NO status — the server's derivation owns it", async () => {
    setup();
    const btn = markPaidButton();
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);

    /* RED on the unfixed tree: it called updateStatus.mutate({ status: 'PAID' })
       and that hand-written PAID was the whole bug. `confirm` is checked too —
       the old path went through a confirm dialog before the status write, so an
       await could not hide the call. */
    await waitFor(() => expect(seededRows().length).toBeGreaterThan(0));
    expect(updateStatusMutate).not.toHaveBeenCalled();
  });

  it("seeds a receipt for the OUTSTANDING balance, net of the order's deposit", async () => {
    setup();
    fireEvent.click(markPaidButton()!);

    /* 2,400 — NOT the 4,400 invoice total. The 2,000 the order already collected
       is real cash already in the drawer and already posted to the GL from the
       order side; booking it again here would debit cash twice and leave the
       day's cash-up short by exactly that. */
    await waitFor(() => expect(seededRows()).toContain(OUTSTANDING_SEN));
    expect(seededRows()).not.toContain(TOTAL_SEN);
    expect(seededRows().reduce((s, n) => s + n, 0)).toBe(OUTSTANDING_SEN);
  });

  it("saving sends that amount to POST /:id/payments — the same path a manual payment takes", async () => {
    setup();
    fireEvent.click(markPaidButton()!);
    await waitFor(() => expect(seededRows()).toContain(OUTSTANDING_SEN));

    fireEvent.click(screen.getByRole("button", { name: /save payments/i }));

    await waitFor(() => expect(addPaymentMutateAsync).toHaveBeenCalledTimes(1));
    const body = addPaymentMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(body.id).toBe(ID);
    expect(body.amountSen).toBe(OUTSTANDING_SEN);
    /* A method is always sent, and it is one the server's enum accepts — the
       operator sees and can change the row before Save. */
    expect(typeof body.method).toBe("string");
    expect(body.method).not.toBe("");
    /* And still no hand-written status, on the way out either. */
    expect(updateStatusMutate).not.toHaveBeenCalled();
  });

  it("the seeded row is EDITABLE — the operator picks the method before it commits", async () => {
    setup();
    fireEvent.click(markPaidButton()!);
    await waitFor(() => expect(seededRows()).toContain(OUTSTANDING_SEN));
    expect(lastPaymentsTableProps.current?.locked).toBe(false);
  });
});

describe("Mark paid is not offered where the receipt would be dishonest", () => {
  it("is hidden when there is nothing outstanding — a zero receipt is not a payment", () => {
    setup({ paidSen: OUTSTANDING_SEN });
    expect(markPaidButton()).toBeNull();
  });

  /* The screen's outstanding falls back to the FULL total when the server could
     not read the source order, so it is too high by the whole deposit. Offering
     Mark paid there is offering to book the customer's deposit a second time. */
  it("is hidden when the order's deposit could not be read", () => {
    setup({ deposit: null, depositUnavailable: true });
    expect(markPaidButton()).toBeNull();
  });

  it("is hidden on a cancelled invoice — the payment route answers not_payable", () => {
    setup({ status: "CANCELLED" });
    expect(markPaidButton()).toBeNull();
  });

  it("is hidden on a draft — the payment route answers not_payable", () => {
    setup({ status: "DRAFT" });
    expect(markPaidButton()).toBeNull();
  });
});
