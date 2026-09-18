/* OfficialReceipts — the OR book (GL redesign 9b): drafts print with the
   watermark, Confirm money formalises, formal rows only print. Since
   2026-09-16 (owner: or 我如何查看 amount 是对的) the page opens on this month:
   the list carries the month and sums under it, and the month's CHECK reads
   the customer payments against the receipts and names every row behind a
   difference. The server half is backend/tests/officialReceipts.test.ts and
   backend/tests/receiptsCheck.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

const { fetchMock, pdfMock, check } = vi.hoisted(() => {
  const rows = [
    {
      id: 5, or_number: 'HCDraftOR-2609-002', status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p2',
      doc_no: 'HC-SO-013400', customer_name: 'TAN MEI LING', method: 'transfer', amount_sen: 150000,
      paid_at: '2026-09-04', channel_account_code: null, issued_at: null, issued_by: null, created_at: '2026-09-04',
    },
    {
      id: 4, or_number: 'HCCOR-2609-001', status: 'FORMAL', payment_source: 'SOPAY', payment_id: 'p1',
      doc_no: 'HC-SO-013399', customer_name: 'AHMAD BIN ALI', method: 'cash', amount_sen: 50000,
      paid_at: '2026-09-03', channel_account_code: '300-0000', issued_at: '2026-09-03', issued_by: 'Chew', created_at: '2026-09-03',
    },
  ];
  /* A dirty month: three payments came in, two have receipts. */
  const check = {
    current: {
      month: '2026-09',
      payments: { count: 3, totalSen: 250000 },
      receipts: { count: 2, totalSen: 200000 },
      diffSen: 50000,
      missing: [{ source: 'SOPAY', paymentId: 'p9', docNo: 'HC-SO-013401', paidAt: '2026-09-07', method: 'transfer', amountSen: 50000 }],
      mismatched: [],
      orphans: [],
    } as Record<string, unknown>,
  };
  return {
    fetchMock: vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.startsWith('/accounting/receipts/check')) return check.current;
      if (path.startsWith('/accounting/receipts/')) return { ok: true, orNumber: 'HCMOR-2609-001' };
      return { receipts: rows };
    }),
    pdfMock: vi.fn(async (_r: unknown, _o: unknown) => {}),
    check,
  };
});
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: (path: string, init?: RequestInit) => fetchMock(path, init),
}));
vi.mock('../../vendor/scm/lib/receipt-pdf', () => ({ generateReceiptPdf: pdfMock }));

import { OfficialReceipts, monthWord, mytMonth } from './OfficialReceipts';

const draw = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter><QueryClientProvider client={qc}><OfficialReceipts /></QueryClientProvider></MemoryRouter>,
  );
};
const listPaths = () => fetchMock.mock.calls.map(([p]) => p).filter((p) => p.startsWith('/accounting/receipts') && !p.startsWith('/accounting/receipts/'));

describe('the OR book', () => {
  test('a draft offers Print + Confirm money; a formal row only prints', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('HCDraftOR-2609-002')).toBeTruthy());
    expect(screen.getByText('HCCOR-2609-001')).toBeTruthy();
    /* One Confirm money (the draft), two Prints (both rows). */
    expect(screen.getAllByText('Confirm money')).toHaveLength(1);
    expect(screen.getAllByText('Print')).toHaveLength(2);
  });

  test('Print hands the ROW to the pdf (draft prints the watermark side)', async () => {
    pdfMock.mockClear();
    draw();
    await waitFor(() => expect(screen.getByText('HCDraftOR-2609-002')).toBeTruthy());
    fireEvent.click(screen.getAllByText('Print')[0]!);
    await waitFor(() => expect(pdfMock).toHaveBeenCalledTimes(1));
    const [r, opts] = pdfMock.mock.calls[0]!;
    expect((r as { or_number: string }).or_number).toBe('HCDraftOR-2609-002');
    expect(opts).toEqual({ action: 'print' });
  });

  test('Confirm money POSTs the formalise route for THAT receipt', async () => {
    fetchMock.mockClear();
    draw();
    await waitFor(() => expect(screen.getByText('Confirm money')).toBeTruthy());
    fireEvent.click(screen.getByText('Confirm money'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([p]) => p === '/accounting/receipts/5/formalise')).toBe(true));
  });

  test('opens on this month: the list carries it and sums under the rows; the check names the totals, the difference and the payment without a receipt', async () => {
    fetchMock.mockClear();
    draw();
    await waitFor(() => expect(screen.getByText('HCDraftOR-2609-002')).toBeTruthy());
    expect(listPaths()).toContain(`/accounting/receipts?month=${mytMonth()}`);
    expect(fetchMock.mock.calls.some(([p]) => p === `/accounting/receipts/check?month=${mytMonth()}`)).toBe(true);
    expect((screen.getByLabelText('Receipts month') as HTMLInputElement).value).toBe(mytMonth());
    const total = screen.getByTestId('receipts-total');
    expect(total.textContent).toContain(`2 receipts in ${monthWord(mytMonth())}`);
    expect(total.textContent).toContain('RM 2,000.00');
    const card = await screen.findByLabelText('Receipts check');
    await waitFor(() => expect(card.textContent).toContain('Customer payments RM 2,500.00 (3)'));
    expect(card.textContent).toContain('Receipts RM 2,000.00 (2)');
    expect(card.textContent).toContain('Difference RM 500.00');
    expect(card.textContent).toContain('Payments without a receipt (1)');
    expect(card.textContent).toContain('HC-SO-013401');
    expect(card.textContent).not.toContain('Every payment of the month has its receipt');
  });

  test('a clean month says so; Any month drops the check and reads the newest', async () => {
    check.current = { month: '2026-09', payments: { count: 2, totalSen: 200000 }, receipts: { count: 2, totalSen: 200000 }, diffSen: 0, missing: [], mismatched: [], orphans: [] };
    fetchMock.mockClear();
    draw();
    const card = await screen.findByLabelText('Receipts check');
    await waitFor(() => expect(card.textContent).toContain('Every payment of the month has its receipt, for its own amount.'));
    expect(card.textContent).toContain('Difference RM 0.00');
    fireEvent.click(screen.getByText('Any month'));
    await waitFor(() => expect(listPaths()).toContain('/accounting/receipts'));
    expect(screen.queryByLabelText('Receipts check')).toBeNull();
    expect(screen.getByText('This month')).toBeTruthy();
  });

  test('monthWord', () => {
    expect(monthWord('2026-06')).toBe('06/2026');
    expect(monthWord('')).toBe('');
  });
});
