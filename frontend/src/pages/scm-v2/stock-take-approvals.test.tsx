/* Owner 2026-11-24:「盘点审批 - 像 payment backdate request」. The Stock Take
 * Approvals inbox lists over-limit counts waiting for a supervisor; a row carries
 * inline Approve / Return, a SINGLE click opens the count on the right (with its
 * variance lines and the same Approve / Return), and a double-click opens the
 * full stock take. */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { StockTakeRow, StockTakeDetail } from '../../vendor/scm/lib/stock-queries';

let rows: StockTakeRow[] = [];
const approveMutate = vi.fn();
const rejectMutate = vi.fn();

const row = (id: string, over: Partial<StockTakeRow> = {}): StockTakeRow => ({
  id, take_no: `HC-STK-26${id}`, status: 'PENDING_APPROVAL', warehouse_id: 'w1',
  scope_type: 'CATEGORY', scope_value: 'MATTRESS', take_date: '2026-11-24', notes: null,
  posted_at: null, cancelled_at: null, created_at: '2026-11-24T00:00:00Z', created_by: null,
  submitted_at: '2026-11-24T02:00:00Z', submitted_by: 's-sim', variance_total: 10,
  warehouse: { id: 'w1', code: 'KL WAREHOUSE', name: 'Balakong' }, ...over,
});

const detail = (r: StockTakeRow): StockTakeDetail => ({
  take: r,
  lines: [{
    id: 'l1', stock_take_id: r.id, item_code: 'MATT-A', product_name: 'Mattress A', variant_key: '',
    variant_label: null, system_qty: 4, counted_qty: 14, variance: 10, notes: null, created_at: '',
    est_unit_cost_sen: 50_000,
  }],
  viewer: { isAssignee: false, canSupervise: true, blindActive: false },
});

vi.mock('../../vendor/scm/lib/stock-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/stock-queries')>()),
  useStockTakes: () => ({ data: rows, isLoading: false, isError: false, error: null }),
  useStockTakeDetail: (id: string | null) => ({ data: id ? detail(rows.find((r) => r.id === id) ?? rows[0]) : undefined, isPending: false, error: null }),
  useApproveStockTake: () => ({ isPending: false, mutate: approveMutate }),
  useRejectStockTake: () => ({ isPending: false, mutate: rejectMutate }),
}));
vi.mock('../../hooks/useStaffLookup', () => ({ useStaffLookup: () => ({ actorNameOf: (id: string | null) => (id ? 'Sim' : '—') }) }));
vi.mock('../../vendor/scm/components/NotifyDialog', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/components/NotifyDialog')>()),
  useNotify: () => vi.fn(),
}));

const { StockTakeApprovals } = await import('./StockTakeApprovals');

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/scm/stock-take-approvals']}>
      <Routes>
        <Route path="/scm/stock-take-approvals" element={<StockTakeApprovals />} />
        <Route path="/scm/stock-takes/:id" element={<div>Stock take page</div>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

const rowOf = (container: HTMLElement, text: string): HTMLElement => {
  const tr = [...container.querySelectorAll('tr[data-vrow]')].find((r) => r.textContent.includes(text));
  if (!tr) throw new Error(`no grid row carries ${text}`);
  return tr as HTMLElement;
};

afterEach(() => { localStorage.clear(); rows = []; approveMutate.mockClear(); rejectMutate.mockClear(); });

describe('Stock Take Approvals inbox', () => {
  test('one click opens the count on the right, with its variance line and Approve / Return', () => {
    rows = [row('11'), row('12')];
    const { container } = mount();
    expect(screen.queryByRole('button', { name: /Open stock take/ })).toBeNull();

    fireEvent.click(rowOf(container, 'HC-STK-2612'));
    const drawer = screen.getByRole('dialog', { name: 'Stock take approval HC-STK-2612' });
    expect(within(drawer).getByText('Stock take approval')).toBeTruthy();
    expect(within(drawer).getByText('MATT-A')).toBeTruthy();
    expect(within(drawer).getByText('Sim')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: /Approve & post/ })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: /Return to Open/ })).toBeTruthy();
    expect(screen.queryByText('Stock take page')).toBeNull();
  });

  test('deciding from the drawer calls the approve mutation', () => {
    rows = [row('11')];
    const { container } = mount();
    fireEvent.click(rowOf(container, 'HC-STK-2611'));
    const drawer = screen.getByRole('dialog', { name: 'Stock take approval HC-STK-2611' });
    fireEvent.click(within(drawer).getByRole('button', { name: /Approve & post/ }));
    expect(approveMutate).toHaveBeenCalledWith('11', expect.anything());
  });

  test('the row Approve button decides without opening the drawer; a double-click opens the stock take', () => {
    rows = [row('11')];
    const { container } = mount();
    const tr = rowOf(container, 'HC-STK-2611');
    fireEvent.click(within(tr).getByRole('button', { name: 'Approve' }));
    expect(approveMutate).toHaveBeenCalledWith('11', expect.anything());
    expect(screen.queryByRole('button', { name: /Open stock take/ })).toBeNull();

    fireEvent.doubleClick(tr);
    expect(screen.getByText('Stock take page')).toBeTruthy();
  });
});
