// HC-0031: a 3PL invoice is keyed in per DO after delivery and shown beside the
// rate card amount, with the difference.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: (...a: unknown[]) => fetchMock(...a) }));
vi.mock('../../vendor/scm/lib/threepl-companies-queries', () => ({
  useThreePLCompanies: () => ({ data: [{ id: 'msj', code: 'MSJ', name: 'MSJ TRANSPORT' }] }),
}));
const perms = vi.hoisted(() => ({ finance: true }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: (p: string) => perms.finance && p === 'scm.finance.accounting' }) }));

import { ThreePLInvoices, toSen } from './ThreePLInvoices';

afterEach(() => { cleanup(); fetchMock.mockReset(); });

const row = { id: 'c1', doNumber: 'DO-1', doDate: '2026-10-01', doStatus: 'DELIVERED', customer: 'Tan', doCompanyCode: '2990', carrierId: 'msj', carrierName: 'MSJ TRANSPORT', cardName: 'MSJ', invoiceNo: 'INV9', invoiceDate: '2026-10-05', billedSen: 12000, expectedSen: 10000, varianceSen: 2000, note: null };
const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThreePLInvoices /></QueryClientProvider>,
);

describe('3PL invoices (HC-0031)', () => {
  it('reads RM amounts as sen and refuses junk', () => {
    expect(toSen('1,234.50')).toBe(123450);
    expect(toSen('RM 80')).toBe(8000);
    expect(toSen('')).toBeNull();
    expect(toSen('-5')).toBeNull();
    expect(toSen('abc')).toBeNull();
  });

  it('shows the billed amount, the rate card amount and the difference', async () => {
    fetchMock.mockResolvedValue({ rows: [row], invoices: [] });
    mount();
    await screen.findByText('DO-1');
    expect(screen.getAllByText(/\+.*20\.00/).length).toBeGreaterThan(0);
  });

  /* Owner 2026-10-23: Houzs delivers for 2990 and bills it back — what each
     company's deliveries cost on the list, and the bill brought in from its
     AP invoice (Finance only: the AP invoice is Finance's). */
  it('shows what each company\'s deliveries cost, and opens From AP invoice for Finance', async () => {
    fetchMock.mockImplementation((p: string) => Promise.resolve(p.startsWith('/threepl-do-charges/from-ap')
      ? { invoices: [], carriers: [] }
      : { rows: [row, { ...row, id: 'c2', doNumber: 'DO-2', doCompanyCode: 'HOUZS', billedSen: 5000 }], invoices: [] }));
    mount();
    await screen.findByText('DO-2');
    expect(screen.getByText(/By company:/).textContent).toBe('By company: 2990 1 DO · RM 120.00  ·  HOUZS 1 DO · RM 50.00');
    fireEvent.click(screen.getByRole('button', { name: 'From AP invoice' }));
    expect(await screen.findByRole('region', { name: 'From an AP invoice' })).toBeTruthy();
  });

  it('no From AP invoice for someone without Finance', async () => {
    perms.finance = false;
    try {
      fetchMock.mockResolvedValue({ rows: [], invoices: [] });
      mount();
      await screen.findAllByText('Per invoice');
      expect(screen.queryByRole('button', { name: 'From AP invoice' })).toBeNull();
    } finally { perms.finance = true; }
  });

  it('saves a DO line with the amount in sen, and a refusal reaches the screen', async () => {
    fetchMock.mockImplementation((_p: string, init?: RequestInit) =>
      init?.method === 'PUT' ? Promise.reject(new Error('do_not_found')) : Promise.resolve({ rows: [], invoices: [] }));
    mount();
    fireEvent.change(screen.getByLabelText('DO number'), { target: { value: 'DO-404' } });
    fireEvent.change(screen.getByLabelText('3PL'), { target: { value: 'msj' } });
    fireEvent.change(screen.getByLabelText('Billed (RM)'), { target: { value: '150' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('do_not_found'));
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(JSON.parse(put[1].body)).toMatchObject({ doNumber: 'DO-404', threeplCompanyId: 'msj', billedSen: 15000 });
  });
});
