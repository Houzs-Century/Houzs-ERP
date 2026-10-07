/**
 * PC Receive shows its own number on the page and on the Print PDF (DEV-57).
 * The record carries receive_number; the page read grn_number, which the
 * endpoint never returns, so the title read "undefined — ..." and the PDF had
 * no number (reported on 2990-PCR-2610-001).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PurchaseConsignmentReceiveDetail } from './PurchaseConsignmentReceiveDetail';

const h = vi.hoisted(() => ({
  deliver: null as null | ((a: string) => unknown),
  genMock: vi.fn(),
}));

const PCR = {
  id: 'R1',
  receive_number: '2990-PCR-2610-001',
  status: 'POSTED',
  has_children: false,
  supplier_id: 'S1',
  supplier: { id: 'S1', name: 'ACME Supplies', code: 'ACM' },
  received_at: '2026-10-07',
  delivery_note_ref: null,
  notes: null,
  posted_at: '2026-10-07',
  currency: 'MYR',
  total_sen: 0,
};
/* Stable references: the page's effects key on these, so a fresh object per
   render loops them. */
const DETAIL = { data: { grn: PCR, items: [] }, isPending: false, isError: false };
const SUPPLIER_DETAIL = { data: { supplier: null, bindings: [] } };
const EMPTY = { data: [] };
const NO_MAINT = { data: undefined };

vi.mock('../../vendor/scm/lib/purchase-consignment-receive-queries', () => ({
  usePurchaseConsignmentReceiveDetail: () => DETAIL,
  useUpdatePurchaseConsignmentReceiveHeader: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePurchaseConsignmentReceiveItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeletePurchaseConsignmentReceiveItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelPurchaseConsignmentReceive: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useSuppliers: () => EMPTY,
  useSupplierDetail: () => SUPPLIER_DETAIL,
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', () => ({
  useMaintenanceConfig: () => NO_MAINT,
}));
vi.mock('../../vendor/scm/lib/fabric-queries', () => ({
  useFabricTrackings: () => EMPTY,
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
vi.mock('../../vendor/scm/lib/grn-pdf', () => ({
  generateGrnPdf: h.genMock,
}));

describe('PurchaseConsignmentReceiveDetail — document number', () => {
  it('shows receive_number in the title and prints it on the PDF', async () => {
    render(
      <MemoryRouter initialEntries={['/scm/purchase-consignment-receives/R1']}>
        <Routes>
          <Route path="/scm/purchase-consignment-receives/:id" element={<PurchaseConsignmentReceiveDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/2990-PCR-2610-001 — ACME Supplies/)).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
    await h.deliver!('save');
    expect(h.genMock).toHaveBeenCalledTimes(1);
    const [header, , opts] = h.genMock.mock.calls[0]!;
    expect(header.grn_number).toBe('2990-PCR-2610-001');
    expect(opts).toMatchObject({ docTitle: 'CONSIGNMENT RECEIVE', docNoLabel: 'Receive No', action: 'save' });
  });
});
