/* The Deposit Invoices page (docs/bugs/0828): the switch line and the
   backlog button, the list with its filters, one invoice with its payment,
   cancel behind a reason, post again. The server half is
   backend/tests/depositInvoices.test.ts. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { DepositInvoice } from '../../vendor/scm/lib/deposit-invoice-queries';

const ROWS: DepositInvoice[] = [
  {
    id: 'd1', company_id: 2, di_number: '2990-DI-2609-001', payment_source: 'SOPAY', payment_id: 'p-1', so_doc_no: '2990-SO-2609-001',
    party_code: 'cust-larding', party_name: 'Larding Chen', invoice_date: '2026-09-05', amount_sen: 100000, method: 'cash',
    status: 'ISSUED', je_no: '2990-JE-2609-0011', credit_note_id: null, cancel_reason: null,
    created_at: '2026-09-05T00:00:00Z', created_by: 'u-1', cancelled_at: null, cancelled_by: null,
  },
  {
    id: 'd2', company_id: 2, di_number: '2990-DI-2609-002', payment_source: 'SOPAY', payment_id: 'p-2', so_doc_no: '2990-SO-2609-002',
    party_code: 'cust-mei', party_name: 'Mei Ling', invoice_date: '2026-09-06', amount_sen: 50000, method: 'merchant',
    status: 'CANCELLED', je_no: '2990-JE-2609-0012', credit_note_id: null, cancel_reason: 'payment on 2990-SO-2609-002 edited — re-issued',
    created_at: '2026-09-06T00:00:00Z', created_by: 'u-1', cancelled_at: '2026-09-07T00:00:00Z', cancelled_by: 'Chew',
  },
];
const saveMutate = vi.fn();
const issueMutate = vi.fn();
const cancelMutate = vi.fn();
const postMutate = vi.fn();
const lastList = { value: '' };

vi.mock('../../vendor/scm/lib/deposit-invoice-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useDepositInvoices: (status: string, so: string) => { lastList.value = `${status}|${so}`; return { data: { rows: ROWS }, isLoading: false, isError: false, error: null }; },
  useDepositInvoiceDetail: (id: string | null) => ({
    data: id ? { invoice: ROWS.find((r) => r.id === id)!, payment: { id: 'p-1', paid_at: '2026-09-05', method: 'cash', merchant_provider: null, online_type: null, amount_sen: 100000, is_deposit: true, collected_by: null } } : undefined,
    isLoading: false, isError: false, error: null,
  }),
  useDepositInvoiceSettings: () => ({ data: { settings: { enabled: true, fromDate: '2026-09-01' }, missingCount: 3 }, isLoading: false, isError: false, error: null }),
  useSaveDepositInvoiceSettings: () => ({ mutate: saveMutate, isPending: false }),
  useIssueMissingDepositInvoices: () => ({ mutate: issueMutate, isPending: false, isSuccess: false, data: undefined }),
  useCancelDepositInvoice: () => ({ mutate: cancelMutate, isPending: false, isError: false, isSuccess: false, error: null, data: undefined }),
  usePostDepositInvoice: () => ({ mutate: postMutate, isPending: false, isError: false, isSuccess: false, error: null, data: undefined }),
}));

const { DepositInvoices } = await import('./DepositInvoices');

describe('the Deposit Invoices page', () => {
  test('lists the invoices with customer, order, amount, status and journal; the filters reach the query', () => {
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    expect(screen.getByText('2990-DI-2609-001')).toBeTruthy();
    expect(screen.getByText('2990-DI-2609-002')).toBeTruthy();
    expect(screen.getByText('Larding Chen')).toBeTruthy();
    expect(screen.getByText('2990-SO-2609-002')).toBeTruthy();
    expect(screen.getByText('2990-JE-2609-0011')).toBeTruthy();
    expect(screen.getByText('CANCELLED')).toBeTruthy();
    expect(lastList.value).toBe('ALL|');
    fireEvent.change(screen.getByLabelText('Invoice status'), { target: { value: 'ISSUED' } });
    expect(lastList.value).toBe('ISSUED|');
    fireEvent.change(screen.getByLabelText('Sales order'), { target: { value: ' 2990-SO-2609-001 ' } });
    expect(lastList.value).toBe('ISSUED|2990-SO-2609-001');
  });

  test('the switch line says on and from when; the backlog names its count and the button issues it; Save sends the pair', () => {
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    const card = screen.getByLabelText('Deposit invoice switch');
    expect(within(card).getByText(/On — payments dated from/)).toBeTruthy();
    expect(within(card).getByText(/3 payments dated from .* still without a deposit invoice/)).toBeTruthy();
    fireEvent.click(within(card).getByText('Issue them now'));
    expect(issueMutate).toHaveBeenCalled();
    const save = within(card).getByText('Save');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByLabelText('Issue a deposit invoice for every customer payment'));
    fireEvent.click(within(card).getByText('Save'));
    expect(saveMutate.mock.calls[0]?.[0]).toEqual({ enabled: false, fromDate: '2026-09-01' });
  });

  test('an invoice opens with its payment; Cancel invoice waits for a reason, then sends it; a posted invoice offers no Post', () => {
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-DI-2609-001'));
    const dialog = screen.getByLabelText('Deposit invoice');
    expect(within(dialog).getByText(/cash · .* · RM 1,000\.00/)).toBeTruthy();
    expect(within(dialog).queryByText('Post to ledger')).toBeNull();
    const cancelBtn = within(dialog).getByText('Cancel invoice') as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Cancel reason'), { target: { value: 'Customer changed order' } });
    fireEvent.click(within(dialog).getByText('Cancel invoice'));
    expect(cancelMutate).toHaveBeenCalledWith({ id: 'd1', reason: 'Customer changed order' });
  });

  test('a cancelled invoice shows its reason and offers no actions', () => {
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-DI-2609-002'));
    const dialog = screen.getByLabelText('Deposit invoice');
    expect(within(dialog).getByText(/payment on 2990-SO-2609-002 edited — re-issued/)).toBeTruthy();
    expect(within(dialog).queryByText('Cancel invoice')).toBeNull();
    expect(within(dialog).queryByLabelText('Cancel reason')).toBeNull();
  });
});
