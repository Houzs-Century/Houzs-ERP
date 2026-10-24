// HC-0031: a 3PL invoice is keyed in per DO after delivery and shown beside the
// rate card amount, with the difference.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  /* Owner 2026-10-24: bills read by themselves; what is not on a DO waits under
     To check for a person to say where it goes. */
  it('To check and Per bill: a line put somewhere, the bill split by where its lines went', async () => {
    const bill = {
      apInvoiceId: 'api-9', invoiceNumber: 'HC-API-2610-009', supplierRef: '617797', invoiceDate: '2026-10-13', totalSen: 228_000,
      supplierName: 'MSJ TRANSPORT SERVICE', carrierId: 'car-msj', carrierName: 'MSJ TRANSPORT', readBy: 'auto', readAt: '2026-10-24T03:00:00Z', error: null, lines: 7,
      doSen: 36_500, serviceSen: 0, eventSen: 110_000, noneSen: 5_300, openSen: 65_000, openLines: 2,
    };
    const line = (id: string, lineNo: number, text: string, amountSen: number) => ({
      id, apInvoiceId: 'api-9', invoiceNumber: 'HC-API-2610-009', supplierName: 'MSJ TRANSPORT SERVICE', lineNo, text, date: '2026-10-06', kind: 'delivery',
      amountSen, printed: [text], readStatus: 'not_found', assign: null, doIds: [], doNumbers: [], serviceRef: null, projectId: null, assignedBy: null, assignedAt: null, open: true,
    });
    fetchMock.mockImplementation((p: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.resolve({ ok: true, open: false, skipped: [] });
      if (p.startsWith('/threepl-do-charges/bill-lines')) return Promise.resolve({ lines: [line('bl-4', 4, 'HC12975', 5_000), line('bl-7', 7, 'DO-010676', 60_000)] });
      if (p.startsWith('/mfg-sales-orders/fair-options')) return Promise.resolve({ fairs: [] });
      return Promise.resolve({ rows: [], invoices: [], bills: [bill] });
    });
    mount();
    expect(await screen.findByText('To check (2 lines · RM 650.00)')).toBeTruthy();
    /* Per bill: the parts, and what no line accounts for (2,280.00 less 2,168.00). */
    expect(screen.getByText('RM 650.00 · 2 lines')).toBeTruthy();
    expect(screen.getByText('RM 112.00')).toBeTruthy();
    expect(screen.getByText('By itself · 2026/10/24')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Where line 4 of HC-API-2610-009 goes'), { target: { value: 'do' } });
    fireEvent.change(screen.getByLabelText('DO numbers for line 4 of HC-API-2610-009'), { target: { value: 'HC-DO-2609-154' } });
    fireEvent.change(screen.getByLabelText('Where line 7 of HC-API-2610-009 goes'), { target: { value: 'none' } });
    const saves = within(screen.getByRole('region', { name: 'Bills from AP invoices' })).getAllByRole('button', { name: 'Save' }).filter((b) => !(b as HTMLButtonElement).disabled);
    expect(saves).toHaveLength(2);
    fireEvent.click(saves[0]!);
    fireEvent.click(saves[1]!);
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH')).toHaveLength(2));
    const patches = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH');
    expect(patches.map((c) => [c[0], JSON.parse(c[1].body)])).toEqual([
      ['/threepl-do-charges/bill-lines/bl-4', { assign: 'do', doNumber: 'HC-DO-2609-154', serviceRef: null, projectId: null }],
      ['/threepl-do-charges/bill-lines/bl-7', { assign: 'none', doNumber: null, serviceRef: null, projectId: null }],
    ]);

    /* A bill's own lines open under Per bill. */
    fireEvent.click(screen.getByRole('button', { name: 'Lines' }));
    expect(await screen.findByText('Lines of HC-API-2610-009 · MSJ TRANSPORT SERVICE · bill 617797')).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/threepl-do-charges/bill-lines?apInvoiceId=api-9')).toBe(true));
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
