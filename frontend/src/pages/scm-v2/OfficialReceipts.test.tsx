/* OfficialReceipts — the OR book (GL redesign 9b): drafts print with the
   watermark, Confirm money formalises, formal rows only print. The server
   half is backend/tests/officialReceipts.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

const { fetchMock, pdfMock } = vi.hoisted(() => {
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
  return {
    fetchMock: vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.startsWith('/accounting/receipts/')) return { ok: true, orNumber: 'HCMOR-2609-001' };
      return { receipts: rows };
    }),
    pdfMock: vi.fn(async (_r: unknown, _o: unknown) => {}),
  };
});
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: (path: string, init?: RequestInit) => fetchMock(path, init),
}));
vi.mock('../../vendor/scm/lib/receipt-pdf', () => ({ generateReceiptPdf: pdfMock }));

import { OfficialReceipts } from './OfficialReceipts';

const draw = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter><QueryClientProvider client={qc}><OfficialReceipts /></QueryClientProvider></MemoryRouter>,
  );
};

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
});
