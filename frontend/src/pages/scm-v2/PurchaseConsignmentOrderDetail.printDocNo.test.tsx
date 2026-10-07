/**
 * PCO Print PDF carries the document number (DEV-57). The PCO record stores it
 * as pc_number; the shared PO generator prints po_number, so the exported PDF
 * showed no number (reported on 2990-PCR-2610-001).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PurchaseConsignmentOrderDetail } from './PurchaseConsignmentOrderDetail';

const h = vi.hoisted(() => ({
  deliver: null as null | ((a: string) => unknown),
  genMock: vi.fn(),
}));

const PCO = {
  id: 'P1',
  pc_number: '2990-PCR-2610-001',
  status: 'SUBMITTED',
  has_children: false,
  supplier_id: 'S1',
  supplier: { id: 'S1', name: 'ACME Supplies', code: 'ACM' },
  po_date: '2026-10-07',
  expected_at: null,
  currency: 'MYR',
  notes: null,
  total_sen: 0,
};
/* Stable references: the page's effects key on these, so a fresh object per
   render loops them. */
const DETAIL = { data: { purchaseOrder: PCO, items: [] }, isPending: false, isError: false };
const SUPPLIER_DETAIL = { data: { supplier: null, bindings: [] } };
const EMPTY = { data: [] };
const NO_MAINT = { data: undefined };

vi.mock('../../vendor/scm/lib/purchase-consignment-order-queries', () => ({
  usePurchaseConsignmentOrderDetail: () => DETAIL,
  useUpdatePurchaseConsignmentOrderHeader: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddPurchaseConsignmentOrderItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePurchaseConsignmentOrderItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeletePurchaseConsignmentOrderItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelPurchaseConsignmentOrder: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useSuppliers: () => EMPTY,
  useSupplierDetail: () => SUPPLIER_DETAIL,
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', () => ({
  useMaintenanceConfig: () => NO_MAINT,
  useMfgProducts: () => EMPTY,
}));
vi.mock('../../vendor/scm/lib/fabric-queries', () => ({
  useFabricTrackingsLite: () => EMPTY,
}));
vi.mock('../../vendor/scm/lib/inventory-queries', () => ({
  useWarehouses: () => EMPTY,
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({
  useConfirm: () => async () => true,
}));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../vendor/scm/components/RelationshipMapButton', () => ({
  RelationshipMapButton: () => null,
}));
vi.mock('../../components/scm-v2/PrintPreviewModal', () => ({
  PrintPreviewModal: () => null,
  usePrintPreview: (deliver: (a: string) => unknown) => {
    h.deliver = deliver;
    return { open: false, openPreview: vi.fn(), close: vi.fn(), handlers: {} };
  },
}));
vi.mock('../../vendor/scm/lib/purchase-order-pdf', () => ({
  generatePurchaseOrderPdf: h.genMock,
}));

describe('PurchaseConsignmentOrderDetail — Print PDF', () => {
  it('prints the PCO number as the document number', async () => {
    render(
      <MemoryRouter initialEntries={['/scm/pc-orders/P1']}>
        <Routes>
          <Route path="/scm/pc-orders/:id" element={<PurchaseConsignmentOrderDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/Print PDF/);
    await h.deliver!('save');
    expect(h.genMock).toHaveBeenCalledTimes(1);
    const [header, , opts] = h.genMock.mock.calls[0]!;
    expect(header.po_number).toBe('2990-PCR-2610-001');
    expect(opts).toMatchObject({ docTitle: 'PURCHASE CONSIGNMENT ORDER', action: 'save' });
  });
});
