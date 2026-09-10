/**
 * GRN detail — "Add manual item" affordance (owner 2026-09-10: 从 PO 转换后要能加行).
 *
 * Pins the contract of the manual-line add on GoodsReceivedDetail:
 *   1. On an editable GRN (POSTED, no downstream PI/PR), Edit mode shows an
 *      "Add manual item" affordance, and adding commits via useAddGrnItem with
 *      purchase_order_item_id = null — a genuinely free receipt (no PO rollup),
 *      carrying item_code / unit_price_sen (the current field names).
 *   2. On a locked GRN (CANCELLED, or POSTED-with-children) the affordance is
 *      absent — line CRUD is closed (isLocked).
 *   3. The server's unlinked-PO refusal (receiving a PO's own material by hand)
 *      surfaces inline instead of vanishing.
 *
 * The vendored data hooks are mocked so the real component logic runs without a
 * network or a QueryClient; the two in-app dialog hooks throw without their
 * provider, so they are stubbed too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { GoodsReceivedDetail } from './GoodsReceivedDetail';

const h = vi.hoisted(() => ({
  addMock: vi.fn(),
  grn: null as Record<string, unknown> | null,
}));

vi.mock('../../vendor/scm/lib/grn-queries', () => ({
  useGrnDetail: () => ({
    data: h.grn ? { grn: h.grn, items: [] } : undefined,
    isPending: false,
    isError: false,
  }),
  useUpdateGrnHeader: () => ({ mutateAsync: vi.fn().mockResolvedValue({}) }),
  useUpdateGrnItem: () => ({ mutateAsync: vi.fn().mockResolvedValue({}) }),
  useDeleteGrnItem: () => ({ mutate: vi.fn(), isPending: false }),
  useAddGrnItem: () => ({ mutateAsync: h.addMock, isPending: false }),
  useCancelGrn: () => ({ mutate: vi.fn(), isPending: false }),
  usePostGrn: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useSuppliers: () => ({ data: [] }),
  useSupplierDetail: () => ({ data: { supplier: null, bindings: [] } }),
}));

vi.mock('../../vendor/scm/lib/inventory-queries', () => ({
  useWarehouses: () => ({ data: [] }),
}));

vi.mock('../../vendor/scm/lib/warehouse-queries', () => ({
  useRacks: () => ({ data: { racks: [] } }),
}));

vi.mock('../../vendor/scm/lib/mfg-products-queries', () => ({
  useMaintenanceConfig: () => ({ data: undefined }),
  useSpecialAddons: () => ({ data: [] }),
  useMfgProducts: () => ({ data: [] }),
}));

// useConfirm / useNotify read a context and throw outside their provider.
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
  usePrintPreview: () => ({ open: false, openPreview: vi.fn(), close: vi.fn(), handlers: {} }),
}));

const makeGrn = (over: Record<string, unknown> = {}) => ({
  id: 'G1',
  grn_number: 'GR-001',
  status: 'POSTED',
  has_children: false,
  supplier_id: 'S1',
  supplier: { id: 'S1', name: 'ACME Supplies', code: 'ACM' },
  warehouse_id: 'W1',
  currency: 'MYR',
  received_at: '2026-09-10T00:00:00.000Z',
  delivery_note_ref: null,
  notes: null,
  tax_sen: 0,
  ...over,
});

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/scm/grns/G1?edit=1']}>
      <Routes>
        <Route path="/scm/grns/:id" element={<GoodsReceivedDetail />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  h.addMock.mockReset();
  h.addMock.mockResolvedValue({ item: {} });
  h.grn = null;
});

describe('GoodsReceivedDetail — Add manual item', () => {
  it('adds a free line (no PO link) on an editable POSTED GRN', async () => {
    h.grn = makeGrn();
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: /add manual item/i }));

    await user.type(await screen.findByPlaceholderText(/search SKUs by code or name/i), 'ACC-001');
    await user.type(screen.getByPlaceholderText(/auto-filled when an item is picked/i), 'Extra cushion');
    await user.click(screen.getByRole('button', { name: /^add item$/i }));

    await waitFor(() => expect(h.addMock).toHaveBeenCalledTimes(1));
    const payload = h.addMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.grnId).toBe('G1');
    expect(payload.purchaseOrderItemId).toBeNull();
    expect(payload.itemCode).toBe('ACC-001');
    expect(payload.materialName).toBe('Extra cushion');
    expect(payload.qty).toBe(1);
  });

  it('hides the affordance on a CANCELLED GRN', async () => {
    h.grn = makeGrn({ status: 'CANCELLED' });
    renderDetail();
    await screen.findByRole('heading', { name: /Line Items/i });
    expect(screen.queryByRole('button', { name: /add manual item/i })).toBeNull();
  });

  it('hides the affordance on a POSTED GRN that has downstream children', async () => {
    h.grn = makeGrn({ has_children: true });
    renderDetail();
    await screen.findByRole('heading', { name: /Line Items/i });
    expect(screen.queryByRole('button', { name: /add manual item/i })).toBeNull();
  });

  it('surfaces the server unlinked-PO refusal inline (does not close the row)', async () => {
    h.grn = makeGrn();
    h.addMock.mockRejectedValueOnce(new Error(
      'This receipt names Purchase Order PO-9, but 1 line(s) are not linked to it: ACC-001. ' +
      'Pick those materials from the Purchase Order instead.',
    ));
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: /add manual item/i }));
    await user.type(await screen.findByPlaceholderText(/search SKUs by code or name/i), 'ACC-001');
    await user.type(screen.getByPlaceholderText(/auto-filled when an item is picked/i), 'Extra cushion');
    await user.click(screen.getByRole('button', { name: /^add item$/i }));

    expect(await screen.findByText(/not linked to it: ACC-001/i)).toBeTruthy();
    expect(h.addMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /^add item$/i })).toBeTruthy();
  });
});
