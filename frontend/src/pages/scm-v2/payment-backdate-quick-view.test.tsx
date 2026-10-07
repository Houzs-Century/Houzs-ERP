/* Owner 2026-10-07:「bank backdate request - 需要右侧打开」. A SINGLE click on a
 * Payment Backdate Requests row opens it in the right-side drawer, with the
 * payment, the reason, the slip and the same Approve / Reject the row carries;
 * a double-click still opens the Sales Order. */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BackdateRequestRow } from '../../vendor/scm/lib/payment-backdate-queries';

let rows: BackdateRequestRow[] = [];
const run = vi.fn(async (_row: BackdateRequestRow, _action: string) => true);
const slipFetches: string[] = [];

vi.mock('../../vendor/scm/lib/payment-backdate-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/payment-backdate-queries')>()),
  useBackdateInbox: () => ({ data: { requests: rows }, isLoading: false, isError: false, error: null }),
}));
vi.mock('../../vendor/scm/components/BackdateRequestsPanel', () => ({
  useBackdateDecisions: () => ({ run, busy: false }),
}));
vi.mock('../../vendor/scm/lib/slip', () => ({
  fetchBackdateRequestSlipUrl: async (id: string) => { slipFetches.push(id); return { url: 'blob:slip-1', contentType: 'image/jpeg' }; },
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 }, can: () => true }) }));
vi.mock('../../hooks/useStaffLookup', () => ({ useStaffLookup: () => ({ actorNameOf: (id: string | null) => (id ? 'Collector Kim' : '—') }) }));

const { PaymentBackdateRequests } = await import('./PaymentBackdateRequests');

const row = (id: string, over: Partial<BackdateRequestRow> = {}): BackdateRequestRow => ({
  id, company_id: 1, so_doc_no: `HC-SO-${id}`, status: 'REQUESTED', reason: `Balance collected on 21/8, slip shared today (${id})`,
  paid_at: '2026-08-21', method: 'merchant', merchant_provider: 'AEON', installment_months: 12, online_type: null,
  approval_code: 'AC-77', amount_sen: 700000, account_sheet: null, collected_by: 'staff-uuid', note: null, slip_key: 'slips/x.jpg',
  requested_by: 7, requested_by_name: 'Syasya', requested_at: '2026-10-07T03:51:00Z',
  decided_by: null, decided_by_name: null, decided_at: null, decision_note: null, payment_id: null,
  ...over,
});

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<PaymentBackdateRequests />} />
        <Route path="/scm/sales-orders/:docNo" element={<div>Sales Order page</div>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

const rowOf = (container: HTMLElement, text: string): HTMLElement => {
  const tr = [...container.querySelectorAll('tr[data-vrow]')].find((r) => r.textContent.includes(text));
  if (!tr) throw new Error(`no grid row carries ${text}`);
  return tr as HTMLElement;
};

afterEach(() => {
  localStorage.clear();
  rows = [];
  run.mockClear();
  slipFetches.length = 0;
});

describe('Payment Backdate Requests inbox', () => {
  test('one click opens the request on the right, with the payment, the reason and the slip', async () => {
    rows = [row('001'), row('002')];
    const { container } = mount();
    expect(screen.queryByRole('button', { name: /Open Sales Order/ })).toBeNull();

    fireEvent.click(rowOf(container, 'HC-SO-002'));
    const drawer = screen.getByRole('dialog', { name: 'Backdate request HC-SO-002' });
    expect(within(drawer).getByText('Payment backdate request')).toBeTruthy();
    expect(within(drawer).getByText('Balance collected on 21/8, slip shared today (002)')).toBeTruthy();
    expect(within(drawer).getByText('Merchant · AEON · 12 months')).toBeTruthy();
    expect(within(drawer).getByText('Collector Kim')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: /Approve & record/ })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect((await within(drawer).findByAltText('Payment slip')).getAttribute('src')).toBe('blob:slip-1');
    expect(slipFetches).toEqual(['002']);
    expect(screen.queryByText('Sales Order page')).toBeNull();
  });

  test('deciding from the drawer goes through the shared runner and closes it', async () => {
    rows = [row('001')];
    const { container } = mount();
    fireEvent.click(rowOf(container, 'HC-SO-001'));
    const drawer = screen.getByRole('dialog', { name: 'Backdate request HC-SO-001' });
    fireEvent.click(within(drawer).getByRole('button', { name: /Approve & record/ }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: '001' }), 'approve');
    expect(await screen.findByRole('dialog', { name: 'Backdate request details' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve & record/ })).toBeNull();
  });

  test('a backed-out decision keeps the drawer open', async () => {
    run.mockResolvedValueOnce(false);
    rows = [row('001')];
    const { container } = mount();
    fireEvent.click(rowOf(container, 'HC-SO-001'));
    const drawer = screen.getByRole('dialog', { name: 'Backdate request HC-SO-001' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Reject' }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: '001' }), 'reject');
    await Promise.resolve();
    expect(screen.getByRole('dialog', { name: 'Backdate request HC-SO-001' })).toBeTruthy();
  });

  test("an admin's own request opens read-only, and a decided one shows who decided it", () => {
    rows = [
      row('mine', { requested_by: 1, requested_by_name: 'Me' }),
      row('done', { status: 'APPROVED', decided_by_name: 'Owner', decided_at: '2026-10-07T04:00:00Z', decision_note: 'Checked the statement', slip_key: null }),
    ];
    const { container } = mount();
    fireEvent.click(rowOf(container, 'HC-SO-mine'));
    let drawer = screen.getByRole('dialog', { name: 'Backdate request HC-SO-mine' });
    expect(within(drawer).getByText(/Your own request/)).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: /Approve & record/ })).toBeNull();

    fireEvent.click(rowOf(container, 'HC-SO-done'));
    drawer = screen.getByRole('dialog', { name: 'Backdate request HC-SO-done' });
    expect(within(drawer).getByText(/Approved by Owner/)).toBeTruthy();
    expect(within(drawer).getByText('“Checked the statement”')).toBeTruthy();
    expect(within(drawer).getByText('No slip was attached to this request.')).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  test('the row Approve button decides without opening the drawer; a double-click opens the Sales Order', () => {
    rows = [row('001')];
    const { container } = mount();
    const tr = rowOf(container, 'HC-SO-001');
    fireEvent.click(within(tr).getByRole('button', { name: 'Approve' }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: '001' }), 'approve');
    expect(screen.queryByRole('button', { name: /Open Sales Order/ })).toBeNull();

    fireEvent.doubleClick(tr);
    expect(screen.getByText('Sales Order page')).toBeTruthy();
  });
});
