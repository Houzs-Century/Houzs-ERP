/* The purchase invoice header lists EVERY PO its lines bill (owner 2026-11-10),
   not only `purchase_invoices.purchase_order_id`, which holds the first
   receipt's PO. Mounts the real page with its data hooks faked. */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("../../vendor/scm/lib/authed-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn(async () => ({})),
}));
vi.mock("../../vendor/scm/lib/purchase-invoice-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/purchase-invoice-queries")>()),
  usePurchaseInvoiceDetail: () => ({ data: h.data, isLoading: false, error: null }),
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

const header = {
  id: "pi-1", invoice_number: "HC-PI-2611-001", supplier_invoice_ref: null, status: "POSTED",
  invoice_date: "2026-11-10", due_date: null, currency: "MYR", subtotal_sen: 0, tax_sen: 0, total_sen: 0, paid_sen: 0,
  notes: null, supplier_id: "s-1", supplier: { id: "s-1", code: "S-1", name: "Supplier Sdn Bhd" },
  grn: { id: "g-1", grn_number: "HC-GRN-2611-052" },
  purchase_order: { id: "po-125", po_number: "HC-PO-2610-125" },
};
const line = (id: string, po: string | null) => ({
  id, item_code: `IT-${id}`, material_name: "Foam", qty: 1, unit_price_sen: 0, line_total_sen: 0,
  grn_item_id: `gi-${id}`, source_po_id: po ? `id-${po}` : null, source_po_number: po,
});

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/scm/purchase-invoices/pi-1"]}>
        <Routes>
          <Route path="/scm/purchase-invoices/:id" element={<PurchaseInvoiceDetailV2 />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => cleanup());

describe("PI detail header: every PO the lines bill", () => {
  it("lines from two POs: the header names both, not only the stored first PO", () => {
    h.data = { purchaseInvoice: header, items: [line("a", "HC-PO-2610-202"), line("b", "HC-PO-2610-125")], sourceGrns: [] };
    mount();
    expect(screen.getByText("Purchase orders · 2")).toBeTruthy();
    expect(screen.getByTitle("HC-PO-2610-125, HC-PO-2610-202").textContent).toBe("HC-PO-2610-125, HC-PO-2610-202");
  });

  it("no line names a PO: the header's own PO is shown", () => {
    h.data = { purchaseInvoice: header, items: [line("a", null)], sourceGrns: [] };
    mount();
    expect(screen.getByText("Purchase order")).toBeTruthy();
    expect(screen.getByTitle("HC-PO-2610-125")).toBeTruthy();
  });
});
