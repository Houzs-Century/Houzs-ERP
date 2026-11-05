/**
 * 2990-0040 (Sim 2026-11-05): a Dining line's model / size / colour lives only in
 * the request line's remark. Raising a PC Order piled every remark into the header
 * Notes and left each order line blank, so the remark has to land on its own line,
 * survive Create, show on Detail, and stay editable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PurchaseConsignmentOrderNew } from './PurchaseConsignmentOrderNew';
import { PurchaseConsignmentOrderDetail } from './PurchaseConsignmentOrderDetail';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  updateItem: vi.fn(async (_patch: Record<string, unknown>) => ({ ok: true })),
}));

const REQUEST = {
  data: {
    request: {
      id: 'R1',
      request_no: '2990-PDR-2611-001',
      special_remarks: 'THIS ORDER DONE DELIVERED',
      supplier_id: 'S1',
      delivery_location_id: 'W1',
      expected_delivery_date: '2026-11-20',
      lines: [
        { line_no: 1, item_code: 'DINING TABLE TOP', model: { name: 'DINING TABLE TOP' }, qty: 1, category: 'Dining', remarks: 'MT504R-4.5F TOP+' },
        { line_no: 2, item_code: 'DINING CHAIR', model: { name: 'DINING CHAIR' }, qty: 4, category: 'Dining', remarks: 'DC117-G (F)' },
        { line_no: 3, item_code: 'DINING CHAIR', model: { name: 'DINING CHAIR' }, qty: 2, category: 'Dining', remarks: null },
      ],
    },
  },
};

const ITEM = {
  id: 'I1',
  binding_id: null,
  material_kind: 'mfg_product',
  item_code: 'DINING TABLE TOP',
  material_name: 'DINING TABLE TOP',
  supplier_sku: null,
  qty: 1,
  unit_price_sen: 0,
  discount_sen: 0,
  line_total_sen: 0,
  received_qty: 0,
  delivery_date: null,
  warehouse_id: 'W1',
  item_group: 'dining',
  variants: null,
  notes: 'MT504R-4.5F TOP+',
};
const PCO = {
  id: 'P1',
  pc_number: '2990-PCO-2611-001',
  status: 'SUBMITTED',
  has_children: false,
  supplier_id: 'S1',
  supplier: { id: 'S1', name: 'MAJESTIC CREATION', code: '400-M001' },
  purchase_location_id: 'W1',
  po_date: '2026-11-05',
  expected_at: '2026-11-20',
  currency: 'MYR',
  notes: null,
  total_sen: 0,
};
/* Stable references: the pages' effects key on these. */
const ITEMS = [ITEM];
const DETAIL = { data: { purchaseOrder: PCO, items: ITEMS }, isPending: false, isError: false };
const NO_COPY = { data: undefined };
const SUPPLIER_DETAIL = { data: { supplier: null, bindings: [] } };
const EMPTY = { data: [] };
const WAREHOUSES = { data: [{ id: 'W1', code: 'PG DISPLAY', is_active: true }] };
const NO_MAINT = { data: undefined };

vi.mock('../../vendor/scm/lib/product-request-queries', () => ({
  useProductRequest: () => REQUEST,
}));
vi.mock('../../vendor/scm/lib/purchase-consignment-order-queries', () => ({
  useCreatePurchaseConsignmentOrder: () => ({ mutate: h.create, isPending: false }),
  usePurchaseConsignmentOrderDetail: (id: string | null | undefined) => (id ? DETAIL : NO_COPY),
  useUpdatePurchaseConsignmentOrderHeader: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddPurchaseConsignmentOrderItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePurchaseConsignmentOrderItem: () => ({ mutateAsync: h.updateItem, isPending: false }),
  useDeletePurchaseConsignmentOrderItem: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useCancelPurchaseConsignmentOrder: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useSuppliers: () => EMPTY,
  useSupplierDetail: () => SUPPLIER_DETAIL,
  useSuppliersForMaterial: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', () => ({
  useMaintenanceConfig: () => NO_MAINT,
  useMfgProducts: () => EMPTY,
  mfgCategoryLabel: (c: string) => c,
}));
vi.mock('../../vendor/scm/lib/fabric-queries', () => ({
  useFabricTrackings: () => EMPTY,
  useFabricTrackingsLite: () => EMPTY,
}));
vi.mock('../../vendor/scm/lib/inventory-queries', () => ({
  useWarehouses: () => WAREHOUSES,
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({
  useConfirm: () => async () => true,
  usePrompt: () => async () => 'test reason',
}));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../vendor/scm/components/RelationshipMapButton', () => ({
  RelationshipMapButton: () => null,
}));
vi.mock('../../components/scm-v2/PrintPreviewModal', () => ({
  PrintPreviewModal: () => null,
  usePrintPreview: () => ({ open: false, openPreview: vi.fn(), close: vi.fn(), handlers: {} }),
}));

const renderNew = () => render(
  <MemoryRouter initialEntries={['/scm/purchase-consignment-orders/new?fromProductRequest=R1']}>
    <Routes>
      <Route path="/scm/purchase-consignment-orders/new" element={<PurchaseConsignmentOrderNew />} />
    </Routes>
  </MemoryRouter>,
);
const renderDetail = () => render(
  <MemoryRouter initialEntries={['/scm/pc-orders/P1']}>
    <Routes>
      <Route path="/scm/pc-orders/:id" element={<PurchaseConsignmentOrderDetail />} />
    </Routes>
  </MemoryRouter>,
);
const remarkBoxes = () => screen.getAllByPlaceholderText('Type remarks…') as HTMLInputElement[];

beforeEach(() => { h.create.mockClear(); h.updateItem.mockClear(); });

describe('PC Order from a product request — line remarks', () => {
  it('seeds each remark on its own line, not on the header Notes', async () => {
    renderNew();
    await waitFor(() => expect(remarkBoxes()).toHaveLength(3));
    expect(remarkBoxes().map((b) => b.value)).toEqual(['MT504R-4.5F TOP+', 'DC117-G (F)', '']);
    const headerNotes = screen.getByPlaceholderText(/supplier instructions/) as HTMLTextAreaElement;
    expect(headerNotes.value).toBe('From Product Request 2990-PDR-2611-001 · THIS ORDER DONE DELIVERED');
  });

  it('sends the remark, as edited, on each line', async () => {
    renderNew();
    await waitFor(() => expect(remarkBoxes()).toHaveLength(3));
    fireEvent.change(remarkBoxes()[2]!, { target: { value: 'DC117-C (F)' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Purchase Consignment Order/ }));
    expect(h.create).toHaveBeenCalledTimes(1);
    const body = h.create.mock.calls[0]![0] as { items: Array<{ notes?: string }> };
    expect(body.items.map((i) => i.notes)).toEqual(['MT504R-4.5F TOP+', 'DC117-G (F)', 'DC117-C (F)']);
  });
});

describe('PC Order detail — line remarks', () => {
  it('shows the remark on the line', async () => {
    renderDetail();
    expect(await screen.findByText('Remark: MT504R-4.5F TOP+')).toBeTruthy();
  });

  it('saves a remark-only edit', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
    await waitFor(() => expect(remarkBoxes()).toHaveLength(1));
    expect(remarkBoxes()[0]!.value).toBe('MT504R-4.5F TOP+');
    fireEvent.change(remarkBoxes()[0]!, { target: { value: 'MT504R-4.5F TOP' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(h.updateItem).toHaveBeenCalledTimes(1));
    expect(h.updateItem.mock.calls[0]![0]).toMatchObject({ itemId: 'I1', notes: 'MT504R-4.5F TOP' });
  });
});
