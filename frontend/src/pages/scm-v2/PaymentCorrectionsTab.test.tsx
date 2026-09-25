/* The Finance corrections tab. Pinned: the three summary figures and every
   column of a row are on screen from what the endpoint returns — since
   docs/bugs/0888 that includes an added payment, who FIRST recorded the
   payment, and a row from before the rule; an empty month says so in a
   sentence rather than showing an empty table; a read that fails says it
   failed instead of reading as an empty month; and the person filter narrows
   the table without touching the month's summary; a print that fails says
   so — the generator's refusal reaches the operator as a notice. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
/* The deliver the tab hands the preview is caught here so a test can run it. */
const { deliverRef, notifySpy, generateSpy } = vi.hoisted(() => ({
  deliverRef: { current: null as null | ((action: 'save' | 'print' | 'preview') => void | Promise<void>) },
  notifySpy: vi.fn(),
  generateSpy: vi.fn(),
}));
vi.mock('../../components/scm-v2/PrintPreviewModal', () => ({
  usePrintPreview: (deliver: (action: 'save' | 'print' | 'preview') => void | Promise<void>) => {
    deliverRef.current = deliver;
    return { open: false, openPreview: () => {}, close: () => {}, handlers: {} };
  },
  PrintPreviewModal: () => null,
}));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => notifySpy }));
vi.mock('../../vendor/scm/lib/payment-corrections-pdf', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generatePaymentCorrectionsPdf: generateSpy,
}));

import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { PaymentCorrectionsTab } from './PaymentCorrectionsTab';
import type { PaymentCorrections } from './accounting-phase1-queries';

const mockedFetch = vi.mocked(authedFetch);

const REPORT: PaymentCorrections = {
  month: '2026-09',
  rows: [
    {
      id: 'a', at: '2026-09-10T02:15:00Z', by: 'Chew', docNo: '2990-SO-2606-043', customer: 'Wong li way',
      kind: 'edited', changes: [{ field: 'amountSen', from: 199_000, to: 199_100 }],
      amountFromSen: 199_000, amountToSen: 199_100,
      reason: 'Sales keyed RM 1,990 — receipt shows RM 1,991', beforeRule: false,
      recordedBy: 'Rachael', recordedOn: '2026-08-29T06:00:00Z',
      originalJeNo: 'JE-2609-0031', contraJeNo: 'JE-2609-0057', jeNo: 'JE-2609-0058',
    },
    {
      id: 'b', at: '2026-09-05T08:00:00Z', by: 'Mei Ling', docNo: '2990-SO-2608-092', customer: 'Lim Siew Mei',
      kind: 'deleted', changes: [{ field: 'amountSen', from: 50_000, to: null }],
      amountFromSen: 50_000, amountToSen: null,
      reason: 'Keyed twice', beforeRule: false, recordedBy: null, recordedOn: null,
      originalJeNo: 'JE-2608-0388', contraJeNo: 'JE-2609-0012', jeNo: null,
    },
    /* A payment recorded on the right (docs/bugs/0888): the recorder is itself. */
    {
      id: 'c', at: '2026-09-12T01:00:00Z', by: 'Chew', docNo: '2990-SO-2609-003', customer: 'Tan Ah Kow',
      kind: 'added', changes: [{ field: 'paidAt', from: null, to: '2026-09-12' }, { field: 'method', from: null, to: 'cash' }, { field: 'amountSen', from: null, to: 150_000 }],
      amountFromSen: null, amountToSen: 150_000,
      reason: 'Balance collected on delivery', beforeRule: false, recordedBy: 'Chew', recordedOn: '2026-09-12T01:00:00Z',
      originalJeNo: null, contraJeNo: null, jeNo: 'JE-2609-0070',
    },
    /* The owner's add from before the rule: no reason, marked as such. */
    {
      id: 'd', at: '2026-09-14T00:30:00Z', by: 'Chew', docNo: '2990-SO-2606-025', customer: 'Ng Boon',
      kind: 'added', changes: [{ field: 'amountSen', from: null, to: 20_000 }],
      amountFromSen: null, amountToSen: 20_000,
      reason: '', beforeRule: true, recordedBy: 'Chew', recordedOn: '2026-09-14T00:30:00Z',
      originalJeNo: null, contraJeNo: null, jeNo: null,
    },
  ],
  summary: { corrections: 4, added: 2, edited: 1, deleted: 1, proof: 0, netMovedSen: 100 - 50_000 + 150_000 + 20_000, addedSen: 170_000, deletedSen: 50_000 },
};

const draw = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><PaymentCorrectionsTab /></MemoryRouter>
  </QueryClientProvider>,
);

describe('the corrections tab', () => {
  test('asks for the current month and shows the summary and every column of each row', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(REPORT);
    draw();
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(expect.stringMatching(/^\/accounting\/payment-corrections\?month=\d{4}-\d{2}$/)));

    await waitFor(() => expect(screen.getByText('4')).toBeTruthy());
    expect(screen.getByText('2 added · 1 edited · 1 deleted · 0 proof')).toBeTruthy();
    expect(screen.getByText('+RM 1,201.00')).toBeTruthy();
    expect(screen.getByText(/1 · RM 500\.00/)).toBeTruthy();

    expect(screen.getByText('2990-SO-2606-043').closest('a')?.getAttribute('href')).toBe('/scm/sales-orders/2990-SO-2606-043');
    expect(screen.getByText('Wong li way')).toBeTruthy();
    expect(screen.getByText('Amount RM 1,990.00 → RM 1,991.00')).toBeTruthy();
    expect(screen.getByText('Sales keyed RM 1,990 — receipt shows RM 1,991')).toBeTruthy();
    expect(screen.getByText('JE-2609-0031 → reversed by JE-2609-0057 → JE-2609-0058')).toBeTruthy();

    expect(screen.getByText('Deleted — RM 500.00 removed')).toBeTruthy();
    expect(screen.getByText('JE-2608-0388 → reversed by JE-2609-0012')).toBeTruthy();

    /* Who first recorded the payment (docs/bugs/0888): Rachael's name and day
       beside the edit of her payment; a dash where nothing could be read. */
    expect(screen.getByText('Rachael')).toBeTruthy();
    expect(screen.getByText('2026/08/29')).toBeTruthy();
    /* The add: its own pill, what was recorded, booked once. */
    expect(screen.getByText('Added — RM 1,500.00 (cash on 2026/09/12)')).toBeTruthy();
    expect(screen.getByText('booked JE-2609-0070')).toBeTruthy();
    expect(screen.getByText('Balance collected on delivery')).toBeTruthy();
    /* The row from before the rule says so instead of showing a blank reason. */
    expect(screen.getByText('Before the rule')).toBeTruthy();
  });

  test('the person filter narrows the rows and leaves the month\'s summary alone', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(REPORT);
    draw();
    await waitFor(() => expect(screen.getByText('Keyed twice')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Done by'), { target: { value: 'Mei Ling' } });
    expect(screen.queryByText('Sales keyed RM 1,990 — receipt shows RM 1,991')).toBeNull();
    expect(screen.getByText('Keyed twice')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  test('an empty month says so in a sentence, with no table', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({ month: '2026-09', rows: [], summary: { corrections: 0, added: 0, edited: 0, deleted: 0, proof: 0, netMovedSen: 0, addedSen: 0, deletedSen: 0 } });
    draw();
    await waitFor(() => expect(screen.getByText(/No payment action on the correction right was found for/)).toBeTruthy());
    expect(screen.queryByRole('table')).toBeNull();
  });

  test('a print that fails says so — the notice carries the reason, the page stays', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(REPORT);
    generateSpy.mockReset();
    notifySpy.mockReset();
    generateSpy.mockRejectedValue(new Error('The Chinese font could not be fetched.'));
    draw();
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(deliverRef.current).toBeTruthy();
    await deliverRef.current!('print');
    expect(generateSpy).toHaveBeenCalledWith(expect.objectContaining({ month: '2026-09' }), { action: 'print' });
    expect(notifySpy).toHaveBeenCalledWith({ title: 'PDF generation failed', body: 'The Chinese font could not be fetched.', tone: 'error' });
    expect(screen.getByRole('table')).toBeTruthy();
    /* And a print that works raises no notice. */
    generateSpy.mockResolvedValue(undefined);
    notifySpy.mockReset();
    await deliverRef.current!('print');
    expect(notifySpy).not.toHaveBeenCalled();
  });

  test('a read that fails says so rather than reading as an empty month', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockRejectedValue(new Error('load_failed'));
    draw();
    await waitFor(() => expect(screen.getByText(/The report could not be read/)).toBeTruthy());
    expect(screen.queryByText(/was found for/)).toBeNull();
  });
});
