/**
 * GRN detail — the line Rack is settable after the GRN exists (owner
 * 2026-10-01: HC-GRN-2610-005 could not get a rack). Rack is placement only, so
 * it saves through its own endpoint (useSetGrnLineRack) and stays editable
 * when a PI/PR has locked the lines; it never rides the line PATCH.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { GoodsReceivedDetail } from './GoodsReceivedDetail';

const h = vi.hoisted(() => ({
  splitRows: [] as { grnItemId: string; rackId: string; qty: number }[],
  rackMock: vi.fn(),
  updateMock: vi.fn(),
  grn: null as Record<string, unknown> | null,
}));

const LINE = {
  id: 'I1', item_code: 'JAGER-(Q)', material_name: 'JAGER BEDFRAME', qty_received: 1, qty_accepted: 1,
  unit_price_sen: 36000, discount_sen: 0, delivery_date: null, item_group: 'bedframe',
  description: 'JAGER BEDFRAME', variants: null, rack_id: null,
};

vi.mock('../../vendor/scm/lib/grn-queries', () => ({
  useGrnDetail: () => ({
    data: h.grn ? { grn: h.grn, items: [LINE] } : undefined,
    isPending: false,
    isError: false,
  }),
  useUpdateGrnHeader: () => ({ mutateAsync: vi.fn().mockResolvedValue({}) }),
  useUpdateGrnItem: () => ({ mutateAsync: h.updateMock }),
  useSetGrnLineRack: () => ({ mutateAsync: h.rackMock }),
  useGrnItemRacks: () => ({ data: h.splitRows, isLoading: false }),
  useSetGrnLineRacks: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteGrnItem: () => ({ mutate: vi.fn(), isPending: false }),
  useAddGrnItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
  useRacks: () => ({ data: { racks: [{ id: 'R1', rack: 'L1.1', warehouse_id: 'W1' }] }, isLoading: false }),
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
  h.rackMock.mockReset().mockResolvedValue({ ok: true });
  h.updateMock.mockReset().mockResolvedValue({ ok: true });
  h.grn = null;
  h.splitRows = [];
});

const pickRack = async () => {
  const input = await screen.findByLabelText('Rack for line 1');
  expect((input as HTMLInputElement).disabled).toBe(false);
  fireEvent.focus(input);
  fireEvent.mouseDown(await screen.findByText('L1.1'));
};

describe('GoodsReceivedDetail — line Rack', () => {
  it('saves a rack picked on a POSTED GRN line through the rack endpoint only', async () => {
    h.grn = makeGrn();
    const user = userEvent.setup();
    renderDetail();
    await pickRack();
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(h.rackMock).toHaveBeenCalledWith({ grnId: 'G1', itemId: 'I1', rackId: 'R1' }));
    expect(h.updateMock).not.toHaveBeenCalled();
  });

  it('stays editable when a PI/PR has locked the lines', async () => {
    h.grn = makeGrn({ has_children: true });
    renderDetail();
    await pickRack();
  });

  it('on a DRAFT, offers the split editor instead of the one-rack picker', async () => {
    h.grn = makeGrn({ status: 'DRAFT' });
    renderDetail();
    expect(await screen.findByLabelText('Add a rack')).toBeTruthy();
    expect(screen.queryByLabelText('Rack for line 1')).toBeNull();
    expect(screen.getByText('1 of 1 not on a rack yet')).toBeTruthy();
  });

  it('shows a posted split as its racks, not as a picker', async () => {
    h.grn = makeGrn();
    h.splitRows = [{ grnItemId: 'I1', rackId: 'R1', qty: 1 }, { grnItemId: 'I1', rackId: 'R9', qty: 2 }];
    renderDetail();
    expect(await screen.findByDisplayValue('L1.1 x1, ? x2')).toBeTruthy();
    expect(screen.queryByLabelText('Rack for line 1')).toBeNull();
  });

  it('is read-only on a CANCELLED GRN', async () => {
    h.grn = makeGrn({ status: 'CANCELLED' });
    renderDetail();
    await screen.findByRole('heading', { name: /Line Items/i });
    expect(screen.queryByLabelText('Rack for line 1')).toBeNull();
  });
});
