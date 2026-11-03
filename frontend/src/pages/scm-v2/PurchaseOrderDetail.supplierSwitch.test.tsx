/* HC-0207 — HC-PO-2611-048 was raised on 400-D002 EADECO, which has no binding
 * for DUNLOPILLO OTHOREST GENERASI 3.0 20CM MATT (S), so the line saved at RM 0.
 * Switching the supplier to 400-D001 Dunlopillo in Edit left it at RM 0: the
 * lines priced off the SAVED supplier's bindings, and an existing line enters
 * Edit with its price locked. Mounts the real page with its data hooks faked;
 * the line PATCH is the seam asserted. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { EADECO, DUNLOP, CODE } = vi.hoisted(() => ({
  EADECO: "sup-eadeco",
  DUNLOP: "sup-dunlop",
  CODE: "DUNLOPILLO OTHOREST GENERASI 3.0 20CM MATT (S)",
}));

const h = vi.hoisted(() => ({
  updateHeader: vi.fn(async (..._a: unknown[]) => ({})),
  updateItem: vi.fn(async (..._a: unknown[]) => ({})),
  addItem: vi.fn(async (..._a: unknown[]) => ({})),
  bindingsBySupplier: {} as Record<string, unknown[]>,
  supplierDetails: new Map<string, unknown>(),
  supplierDetail(id: string) {
    if (!this.supplierDetails.has(id)) {
      this.supplierDetails.set(id, { data: { supplier: { id }, bindings: this.bindingsBySupplier[id] ?? [] }, isLoading: false });
    }
    return this.supplierDetails.get(id);
  },
  /* One object for every render: a fresh items array re-fires the page's edit seed forever. */
  detail: {
    data: {
      purchaseOrder: {
        id: "po-48",
        po_number: "HC-PO-2611-048",
        revision: 1,
        supplier_id: EADECO,
        supplier: { id: EADECO, code: "400-D002", name: "EADECO REFORM INDUSTRIES SDN. BHD." },
        status: "SUBMITTED",
        has_children: false,
        po_date: "2026-11-03",
        expected_at: "2026-11-03",
        currency: "MYR",
        notes: "urgent",
        purchase_location_id: "wh-kl",
        tax_sen: 0,
      },
      items: [{
        id: "item-1",
        binding_id: null,
        material_kind: "mfg_product",
        item_code: CODE,
        material_name: "DUNLOPILLO OTHOREST GENERASI 3.0 20CM MATTRESS (90x190x20CM)",
        notes: null,
        supplier_sku: null,
        qty: 2,
        received_qty: 0,
        unit_price_sen: 0,
        discount_sen: 0,
        line_total_sen: 0,
        delivery_date: "2026-11-03",
        warehouse_id: "wh-kl",
        item_group: "mattress",
        variants: {},
        so_item_id: null,
      }],
    },
    isLoading: false,
    isPending: false,
    error: null,
  },
}));

const mutation = (fn: (...a: unknown[]) => Promise<unknown>) => ({ mutateAsync: fn, mutate: vi.fn(), isPending: false });

vi.mock("../../vendor/scm/lib/suppliers-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/suppliers-queries")>()),
  usePurchaseOrderDetail: () => h.detail,
  useSuppliers: () => ({
    data: [
      { id: EADECO, code: "400-D002", name: "EADECO REFORM INDUSTRIES SDN. BHD." },
      { id: DUNLOP, code: "400-D001", name: "Dunlopillo (M) SDN BHD" },
    ],
    isLoading: false,
  }),
  useSupplierDetail: (id: string | null) => (id ? h.supplierDetail(id) : { data: undefined, isLoading: false }),
  useOutstandingSoItems: () => ({ data: [], isLoading: false }),
  useUpdatePurchaseOrderHeader: () => mutation(h.updateHeader),
  useAddPurchaseOrderItem: () => mutation(h.addItem),
  useUpdatePurchaseOrderItem: () => mutation(h.updateItem),
  useDeletePurchaseOrderItem: () => mutation(vi.fn(async () => ({}))),
  useConfirmPurchaseOrder: () => mutation(vi.fn(async () => ({}))),
  useReopenPurchaseOrder: () => mutation(vi.fn(async () => ({}))),
}));
vi.mock("../../vendor/scm/lib/mfg-products-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/mfg-products-queries")>()),
  useMfgProducts: () => ({ data: [{ code: CODE, category: "MATTRESS" }], isLoading: false }),
  useMaintenanceConfig: () => ({ data: undefined, isLoading: false }),
  useSpecialAddons: () => ({ data: [], isLoading: false }),
}));
vi.mock("../../vendor/scm/lib/fabric-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/fabric-queries")>()),
  useFabricTrackings: () => ({ data: [], isLoading: false }),
}));
vi.mock("../../vendor/scm/lib/inventory-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/inventory-queries")>()),
  useWarehouses: () => ({ data: [{ id: "wh-kl", code: "KL", name: "KL WAREHOUSE" }], isLoading: false }),
}));
vi.mock("../../vendor/scm/lib/so-amendment-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/so-amendment-queries")>()),
  useApprovePo: () => mutation(vi.fn(async () => ({}))),
  useSendAmendment: () => mutation(vi.fn(async () => ({}))),
  usePoRevisions: () => ({ data: [], isLoading: false }),
}));
vi.mock("./use-po-cancel-action", () => ({ usePoCancelAction: () => ({ cancelPo: vi.fn() }) }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn(async () => {}) }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => "edit", user: { id: "u1" } }) }));
vi.mock("../../vendor/scm/components/SearchableSelect", () => ({
  SearchableSelect: ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" />
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import { PurchaseOrderDetail } from "./PurchaseOrderDetail";

const binding = (id: string, supplierId: string, sku: string, sen: number) => ({
  id, supplier_id: supplierId, material_kind: "mfg_product", item_code: CODE, ac_item_code: null,
  material_name: "DUNLOPILLO OTHOREST GENERASI 3.0 20CM MATTRESS (90X190X20CM)", supplier_sku: sku,
  unit_price_sen: sen, currency: "MYR", lead_time_days: 0, payment_terms_override: null, moq: 0,
  price_valid_from: null, price_valid_to: null, is_main_supplier: true, notes: null, price_matrix: null,
});

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={["/scm/purchase-orders/po-48?edit=1"]}>
      <Routes><Route path="/scm/purchase-orders/:id" element={<PurchaseOrderDetail />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

const supplierSelect = () =>
  screen.getAllByRole("combobox").find((s) => within(s).queryByText("400-D001 · Dunlopillo (M) SDN BHD")) as HTMLSelectElement;

afterEach(cleanup);
beforeEach(() => {
  h.updateHeader.mockClear();
  h.updateItem.mockClear();
  h.supplierDetails.clear();
  h.bindingsBySupplier = { [EADECO]: [], [DUNLOP]: [binding("b-dl", DUNLOP, "DL-GENERASI 3.0 20CM (S)", 55_000)] };
});

describe("PO Edit — switching supplier re-prices the lines (HC-0207)", () => {
  it("prices an RM 0 line off the new supplier's binding and saves it", async () => {
    mount();
    await waitFor(() => expect(supplierSelect()).toBeTruthy());
    fireEvent.change(supplierSelect(), { target: { value: DUNLOP } });
    fireEvent.click(await screen.findByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(h.updateItem).toHaveBeenCalledTimes(1));
    expect(h.updateHeader.mock.calls[0]?.[0]).toMatchObject({ supplierId: DUNLOP });
    expect(h.updateItem.mock.calls[0]?.[0]).toMatchObject({
      itemId: "item-1",
      unitPriceSen: 55_000,
      supplierSku: "DL-GENERASI 3.0 20CM (S)",
    });
  });

  it("leaves a line alone when the supplier is not changed", async () => {
    mount();
    await waitFor(() => expect(supplierSelect()).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull());
    expect(h.updateItem).not.toHaveBeenCalled();
  });
});
