/* The purchase invoice's Back (owner 2026-11-20, from a voucher's Applies to:
   点开打开那invoice，退回来就是退回这一页): opened as a document from another
   page, Back returns to that page; opened on its own, Back still goes to the
   Purchase Invoices list (owner 2026-07-24). Mounts the real page with its data
   hooks faked, inside the real tab strip. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../vendor/scm/lib/authed-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn(async () => ({})),
}));
vi.mock("../../vendor/scm/lib/purchase-invoice-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/purchase-invoice-queries")>()),
  usePurchaseInvoiceDetail: () => ({
    data: {
      purchaseInvoice: {
        id: "pi-7", invoice_number: "HC-PI-2611-007", supplier_invoice_ref: null, status: "POSTED",
        invoice_date: "2026-11-10", due_date: null, currency: "MYR", subtotal_sen: 0, tax_sen: 0, total_sen: 0, paid_sen: 0,
        notes: null, supplier_id: "s-1", supplier: { id: "s-1", code: "S-1", name: "Supplier Sdn Bhd" },
        grn: null, purchase_order: null,
      },
      items: [],
      sourceGrns: [],
    },
    isLoading: false,
    error: null,
  }),
  useCancelPurchaseInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePostPurchaseInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../vendor/scm/lib/suppliers-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/suppliers-queries")>()),
  useSupplierDetail: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => "edit" }) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../vendor/scm/components/FlowDocFilesCard", () => ({ FlowDocFilesCard: () => null }));

import { PurchaseInvoiceDetailV2 } from "./PurchaseInvoiceDetailV2";
import { FinanceDocLink } from "./finance/FinanceDocLink";
import { WorkspaceTabs } from "../../components/WorkspaceTabs";
import { resetWorkspaceTabsForTests } from "../../lib/workspaceTabs";

const mount = (start: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[start]}>
        <WorkspaceTabs />
        <Routes>
          <Route path="/scm/payment-vouchers/:id" element={<FinanceDocLink to="/scm/purchase-invoices/pi-7">HC-PI-2611-007</FinanceDocLink>} />
          <Route path="/scm/purchase-invoices" element={<div>Purchase invoice list</div>} />
          <Route path="/scm/purchase-invoices/:id" element={<PurchaseInvoiceDetailV2 />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const backButton = (name: string | RegExp) => screen.getAllByRole("button", { name })[0]!;

beforeEach(() => {
  sessionStorage.clear();
  resetWorkspaceTabsForTests();
});
afterEach(() => cleanup());

describe("PI detail: Back", () => {
  it("opened from a voucher: Back returns to the voucher, not the PI list", () => {
    mount("/scm/payment-vouchers/pv-9");
    fireEvent.click(screen.getByRole("link", { name: "HC-PI-2611-007" }));
    const back = backButton(/^Back to /);
    expect(back.getAttribute("aria-label")).not.toBe("Back to Purchase Invoices");
    fireEvent.click(back);
    expect(screen.getByRole("link", { name: "HC-PI-2611-007" })).toBeTruthy();
    expect(screen.queryByText("Purchase invoice list")).toBeNull();
  });

  it("opened on its own: Back goes to the Purchase Invoices list", () => {
    mount("/scm/purchase-invoices/pi-7");
    fireEvent.click(backButton("Back to Purchase Invoices"));
    expect(screen.getByText("Purchase invoice list")).toBeTruthy();
  });
});
