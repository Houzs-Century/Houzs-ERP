import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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
  useAddSalesInvoiceItem: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../vendor/scm/lib/mfg-products-queries", () => ({
  useMfgProducts: () => ({ data: [] }),
}));
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
import { readSiPaymentIntent, siPaymentIntentSearch, stripSiPaymentIntent } from "./siPaymentIntent";

const ID = "11111111-2222-3333-4444-555555555555";

const TOTAL_SEN = 440_000;
const DEPOSIT_SEN = 200_000;
const OUTSTANDING_SEN = TOTAL_SEN - DEPOSIT_SEN;

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
  search?: string;
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
    <MemoryRouter initialEntries={[`/scm/sales-invoices/${ID}${overrides.search ?? ""}`]}>
      <Routes>
        <Route
          path="/scm/sales-invoices/:id"
          element={<><UrlProbe /><SalesInvoiceDetailV2 /></>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function UrlProbe() {
  const loc = useLocation();
  return <span data-testid="url" data-search={loc.search} />;
}

const currentSearch = () => screen.getByTestId("url").getAttribute("data-search");

const markPaidButton = () => screen.queryByRole("button", { name: /mark paid/i });
const seededRows = () =>
  screen.queryAllByTestId("payment-row").map((el) => Number(el.getAttribute("data-amount-sen")));

beforeEach(() => {
  vi.clearAllMocks();
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

    await waitFor(() => expect(seededRows().length).toBeGreaterThan(0));
    expect(updateStatusMutate).not.toHaveBeenCalled();
  });

  it("seeds a receipt for the OUTSTANDING balance, net of the order's deposit", async () => {
    setup();
    fireEvent.click(markPaidButton()!);

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
    expect(typeof body.method).toBe("string");
    expect(body.method).not.toBe("");
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

describe("the list hands its payment entries to this screen", () => {
  it("?pay=balance seeds the outstanding balance and still writes no status", async () => {
    setup({ search: siPaymentIntentSearch("balance") });
    await waitFor(() => expect(seededRows()).toContain(OUTSTANDING_SEN));
    expect(seededRows()).not.toContain(TOTAL_SEN);
    expect(updateStatusMutate).not.toHaveBeenCalled();
  });

  it("?pay=open opens the editor without seeding an amount", async () => {
    setup({ search: siPaymentIntentSearch("open") });
    await waitFor(() => expect(lastPaymentsTableProps.current?.locked).toBe(false));
    expect(seededRows()).not.toContain(OUTSTANDING_SEN);
    expect(updateStatusMutate).not.toHaveBeenCalled();
  });

  it("an ordinary visit opens nothing", async () => {
    setup();
    await waitFor(() => expect(screen.queryByTestId("payments-table")).not.toBeNull());
    expect(lastPaymentsTableProps.current?.locked).toBe(true);
  });

  it("the old ?tab=payments&record=1 is not an intent", async () => {
    expect(readSiPaymentIntent("?tab=payments&record=1")).toBeNull();
    setup({ search: "?tab=payments&record=1" });
    await waitFor(() => expect(screen.queryByTestId("payments-table")).not.toBeNull());
    expect(lastPaymentsTableProps.current?.locked).toBe(true);
  });

  it("every intent the list can build is one this screen accepts", () => {
    for (const intent of ["open", "balance"] as const) {
      expect(readSiPaymentIntent(siPaymentIntentSearch(intent))).toBe(intent);
    }
  });

  it("acting on the intent strips it from the URL, so a refresh does not re-seed a row", async () => {
    setup({ search: siPaymentIntentSearch("balance") });
    await waitFor(() => expect(seededRows()).toContain(OUTSTANDING_SEN));
    await waitFor(() => expect(currentSearch()).toBe(""));
    expect(readSiPaymentIntent(currentSearch() ?? "")).toBeNull();
  });

  it("stripping keeps every other param", () => {
    expect(stripSiPaymentIntent("?q=abc&pay=balance")).toBe("?q=abc");
  });
});

/* Not about payments — it lives here because this is the one harness that mounts
   the real Sales Invoice detail page. The header BADGE read a hand-written
   STAGE_LABEL that said "Sent" for SENT, while the owner ruled the rung reads
   Submitted everywhere (2026-09-12) and the list pill already did. docs/bugs/0868.
   Asserted on the RENDERED text, because the source scan in
   localStatusMapsAgree.test.ts can only prove the map is gone, not what paints. */
describe("the header badge reads the canonical word", () => {
  it("a SENT invoice shows Submitted, and the word Sent appears nowhere on the page", () => {
    setup({ status: "SENT" });
    expect(screen.getAllByText("Submitted", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Sent", { exact: true })).toHaveLength(0);
  });
});
