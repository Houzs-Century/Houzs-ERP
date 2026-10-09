/* DEV-60: the Purchase Consignment Order list carries a Purchase Location
 * column. The list endpoint now embeds purchase_location; the column and the
 * row drawer show it code-first (warehouseLabel), the same as the PO list.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../vendor/scm/lib/purchase-consignment-order-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/purchase-consignment-order-queries')>()),
  usePurchaseConsignmentOrders: () => ({ data: h.rows, isLoading: false, error: null }),
  usePurchaseConsignmentOrderDetail: () => ({ data: { items: [] }, isLoading: false, isError: false, error: null }),
  useCancelPurchaseConsignmentOrder: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => async () => true }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, pageAccess: () => 'edit' }) }));

import { PurchaseConsignmentOrders } from './PurchaseConsignmentOrders';
import { ToastProvider } from '../../hooks/useToast';

const pco = (id: string, no: string, location: { id: string; code: string; name: string } | null) => ({
  id, pc_number: no, supplier_id: 's1', status: 'SUBMITTED', po_date: '2026-10-07', expected_at: '2026-10-30',
  currency: 'MYR', subtotal_sen: 100000, tax_sen: 0, total_sen: 100000, notes: null, submitted_at: null,
  received_at: null, cancelled_at: null, purchase_location_id: location?.id ?? null, purchase_location: location,
  created_at: '', created_by: '', updated_at: '',
  supplier: { id: 's1', code: '400-H004', name: 'HOOKKA INDUSTRIES SDN. BHD.' },
  items: [],
});

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/scm/purchase-consignment-orders']}>
        <ToastProvider>
          <PurchaseConsignmentOrders />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Purchase Consignment Order list: Purchase Location column', () => {
  it('shows each order its own location code, and a dash when none is set', async () => {
    h.rows = [
      pco('p1', '2990-PCO-2610-003', { id: 'w1', code: '2990S MINI PUCHONG', name: '2990S MINI PUCHONG BP-G-20' }),
      pco('p2', '2990-PCO-2610-004', null),
    ];
    mount();
    expect(await screen.findByText('Purchase Location')).toBeTruthy();
    const row1 = screen.getByText('2990-PCO-2610-003').closest('tr')!;
    expect(within(row1).getByText('2990S MINI PUCHONG')).toBeTruthy();
    const row2 = screen.getByText('2990-PCO-2610-004').closest('tr')!;
    expect(within(row2).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('the row drawer shows the same location label', async () => {
    h.rows = [pco('p1', '2990-PCO-2610-003', { id: 'w1', code: '2990S MINI PUCHONG', name: '2990S MINI PUCHONG BP-G-20' })];
    mount();
    fireEvent.click(await screen.findByText('2990-PCO-2610-003'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Purchase location')).toBeTruthy();
    expect(within(dialog).getByText('2990S MINI PUCHONG')).toBeTruthy();
  });
});
