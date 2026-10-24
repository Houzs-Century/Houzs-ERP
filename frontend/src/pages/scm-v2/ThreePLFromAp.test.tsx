// From an AP invoice (owner 2026-10-23: 「先做」): pick the AP invoice, read the
// bill attached to it, check what matched each DO — 2990's too — and what was
// not counted, then save what was kept. Nothing is saved before Save.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: (...a: unknown[]) => fetchMock(...a) }));

import { ThreePLFromAp } from './ThreePLFromAp';

afterEach(() => { cleanup(); fetchMock.mockReset(); });

const BILLS = {
  invoices: [
    { id: 'api-9', invoiceNumber: 'HC-API-2610-009', supplierRef: '617797', invoiceDate: '2026-10-13', totalSen: 228_000, status: 'POSTED', supplierId: 's1', supplierName: 'MSJ TRANSPORT SERVICE', files: 1, broughtInDos: 0, broughtInSen: 0, carrierId: 'car-msj' },
    { id: 'api-t', invoiceNumber: 'HC-API-2610-020', supplierRef: null, invoiceDate: '2026-10-14', totalSen: 50_000, status: 'POSTED', supplierId: 's2', supplierName: 'TENAGA NASIONAL BERHAD', files: 1, broughtInDos: 0, broughtInSen: 0, carrierId: null },
  ],
  carriers: [{ id: 'car-msj', name: 'MSJ TRANSPORT SERVICE' }],
};
const READ = {
  invoice: { id: 'api-9', invoiceNumber: 'HC-API-2610-009', supplierRef: '617797', invoiceDate: '2026-10-13', totalSen: 228_000, supplierName: 'MSJ TRANSPORT SERVICE' },
  carrierId: 'car-msj',
  carriers: [{ id: 'car-msj', name: 'MSJ TRANSPORT SERVICE' }, { id: 'car-eu', name: 'EU LOGISTICS' }],
  dos: [
    { doId: 'do-1', doNumber: 'HC-DO-2610-004', doDate: '2026-10-06', soDocNo: 'HC-SO-013216', customer: 'Tan', companyCode: 'HOUZS', billedSen: 22_000, expectedSen: 20_000, varianceSen: 2_000, split: false, lines: ['6/10-SO-013216 — RM 120.00', '6/10-SO-013216 — RM 100.00'], note: 'HC-API-2610-009: 6/10-SO-013216', alreadyOn: null },
    { doId: 'do-2', doNumber: '2990-DO-2610-001', doDate: '2026-10-07', soDocNo: '2990-SO-2606-037', customer: 'Lee', companyCode: '2990', billedSen: 14_500, expectedSen: null, varianceSen: null, split: false, lines: ['2990-SO-2606-037 — RM 145.00'], note: 'HC-API-2610-009: 2990-SO-2606-037', alreadyOn: null },
    { doId: 'do-3', doNumber: 'HC-DO-2609-154', doDate: '2026-09-24', soDocNo: 'HC-SO-012967', customer: 'Ng', companyCode: 'HOUZS', billedSen: 5_000, expectedSen: null, varianceSen: null, split: false, lines: ['HC12975 — RM 50.00'], note: 'HC-API-2610-009: HC12975', alreadyOn: { invoiceNo: 'MANUAL-1', billedSen: 4_000 } },
  ],
  lines: [
    { index: 4, text: 'DISMANTLE SETIA SPICE (2 TRIPS)', date: null, kind: 'dismantle', amountSen: 110_000, printed: [], status: 'not_delivery', dos: [] },
    { index: 6, text: 'DO-010676', date: null, kind: 'delivery', amountSen: 60_000, printed: ['DO-010676'], status: 'not_found', dos: [] },
  ],
  totals: { all: 216_800, matched: 41_500, not_found: 60_000, no_number: 0, service_case: 0, not_delivery: 115_300 },
};

const mount = (onSaved = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThreePLFromAp onClose={vi.fn()} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return onSaved;
};

describe('From an AP invoice', () => {
  it('lists the AP invoices with a bill, a 3PL supplier\'s by default', async () => {
    fetchMock.mockResolvedValue(BILLS);
    mount();
    await screen.findByText('HC-API-2610-009');
    expect(screen.queryByText('HC-API-2610-020')).toBeNull();
    fireEvent.click(screen.getByLabelText('Only suppliers that are a 3PL'));
    expect(screen.getByText('HC-API-2610-020')).toBeTruthy();
  });

  it('reads the bill, shows each DO and what was not counted, and saves only what is kept', async () => {
    fetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/read')) return Promise.resolve(READ);
      if (path.endsWith('/confirm')) return Promise.resolve({ saved: 1, skipped: [] });
      return Promise.resolve(BILLS);
    });
    const onSaved = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Read the bill' }));
    await screen.findByText('HC-DO-2610-004');
    /* 2990's DO, its company shown; the one already on another bill cannot be kept. */
    expect(screen.getByText('2990-DO-2610-001')).toBeTruthy();
    expect((screen.getByLabelText('Keep HC-DO-2609-154') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('MANUAL-1 · RM 40.00')).toBeTruthy();
    /* Not counted: the dismantling and the DO the system never had. */
    expect(screen.getByText('Dismantle: not a delivery, not counted')).toBeTruthy();
    expect(screen.getByText('Number not in the system')).toBeTruthy();
    expect(screen.getByText(/The bill reads RM 2,168\.00/)).toBeTruthy();

    /* The person drops the 2990 DO and corrects a misread amount. */
    fireEvent.click(screen.getByLabelText('Keep 2990-DO-2610-001'));
    fireEvent.change(screen.getByLabelText('Billed for HC-DO-2610-004'), { target: { value: '210' } });
    const save = screen.getByRole('button', { name: /^Save 1 DO/ });
    expect(save.textContent).toBe('Save 1 DO · RM 210.00');
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Saved 1 DO from HC-API-2610-009.'));
    const confirm = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/confirm'))!;
    expect(confirm[0]).toBe('/threepl-do-charges/from-ap/api-9/confirm');
    expect(JSON.parse(confirm[1].body)).toEqual({ carrierId: 'car-msj', rows: [{ doId: 'do-1', billedSen: 21_000, note: 'HC-API-2610-009: 6/10-SO-013216' }] });
  });

  it('another 3PL is priced only after reading again; a refusal is said', async () => {
    fetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path.endsWith('/read')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { carrierId?: string };
        return body.carrierId === 'car-eu' ? Promise.reject(new Error('The reader refused (529)')) : Promise.resolve(READ);
      }
      return Promise.resolve(BILLS);
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Read the bill' }));
    await screen.findByText('HC-DO-2610-004');
    fireEvent.change(screen.getByLabelText('3PL for this bill'), { target: { value: 'car-eu' } });
    const again = screen.getByRole('button', { name: 'Read again with this 3PL' });
    fireEvent.click(again);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The reader refused (529)'));
    expect(within(screen.getByRole('region', { name: 'From an AP invoice' })).queryByText('HC-DO-2610-004')).toBeNull();
  });
});
