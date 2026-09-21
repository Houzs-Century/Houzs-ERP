/* The Deposit Invoices page (docs/bugs/0828): the switch line and the
   backlog button, the list with its filters, one invoice with its payment,
   cancel behind a reason, post again; Print in the detail prints the one
   invoice and ticked rows print as one document in list order
   (docs/bugs/0834). The server half is backend/tests/depositInvoices.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { DepositInvoice } from '../../vendor/scm/lib/deposit-invoice-queries';

const ROWS: DepositInvoice[] = [
  {
    id: 'd1', company_id: 2, di_number: '2990-DI-2609-001', payment_source: 'SOPAY', payment_id: 'p-1', so_doc_no: '2990-SO-2609-001',
    party_code: 'cust-larding', party_name: 'Larding Chen', invoice_date: '2026-09-05', amount_sen: 100000, method: 'cash',
    status: 'ISSUED', je_no: '2990-JE-2609-0011', credit_note_id: null, cancel_reason: null,
    created_at: '2026-09-05T00:00:00Z', created_by: 'u-1', cancelled_at: null, cancelled_by: null,
    /* Part of it refunded (docs/bugs/0860): the list says so, the detail names the note and the voucher. */
    refunded_sen: 40000,
    refund_notes: [{ note_number: '2990-CN-2609-009', total_sen: 40000, status: 'POSTED', note_date: '2026-09-12', pv_number: '2990-CRF-2609-001' }],
  },
  {
    id: 'd2', company_id: 2, di_number: '2990-DI-2609-002', payment_source: 'SOPAY', payment_id: 'p-2', so_doc_no: '2990-SO-2609-002',
    party_code: 'cust-mei', party_name: 'Mei Ling', invoice_date: '2026-09-06', amount_sen: 50000, method: 'merchant',
    status: 'CANCELLED', je_no: '2990-JE-2609-0012', credit_note_id: null, cancel_reason: 'payment on 2990-SO-2609-002 edited — re-issued',
    created_at: '2026-09-06T00:00:00Z', created_by: 'u-1', cancelled_at: '2026-09-07T00:00:00Z', cancelled_by: 'Chew',
  },
  {
    id: 'd3', company_id: 2, di_number: '2990-DI-2609-003', payment_source: 'SOPAY', payment_id: 'p-3', so_doc_no: '2990-SO-2609-003',
    party_code: 'cust-seng', party_name: 'Ah Seng', invoice_date: '2026-09-08', amount_sen: 100000, method: 'cash',
    status: 'ISSUED', je_no: '2990-JE-2609-0013', credit_note_id: null, cancel_reason: null,
    created_at: '2026-09-08T00:00:00Z', created_by: 'u-1', cancelled_at: null, cancelled_by: null,
  },
];
const saveMutate = vi.fn();
const issueMutate = vi.fn();
const invoiceDeliveredMutate = vi.fn();
const settings = { value: { settings: { enabled: true, fromDate: '2026-09-01' }, missingCount: 3, deliveredUninvoicedCount: 2 } };
const cancelMutate = vi.fn();
const postMutate = vi.fn();
const lastList = { value: '' };
const pdfSingle = vi.fn(async (..._args: unknown[]) => {});
const pdfBatch = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../vendor/scm/lib/deposit-invoice-pdf', () => ({ generateDepositInvoicePdf: pdfSingle, generateDepositInvoicesPdf: pdfBatch }));

vi.mock('../../vendor/scm/lib/deposit-invoice-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useDepositInvoices: (status: string, so: string) => { lastList.value = `${status}|${so}`; return { data: { rows: ROWS }, isLoading: false, isError: false, error: null }; },
  useDepositInvoiceDetail: (id: string | null) => ({
    data: id ? { invoice: ROWS.find((r) => r.id === id)!, payment: { id: 'p-1', paid_at: '2026-09-05', method: 'cash', merchant_provider: null, online_type: null, amount_sen: 100000, is_deposit: true, collected_by: null } } : undefined,
    isLoading: false, isError: false, error: null,
  }),
  useDepositInvoiceSettings: () => ({ data: settings.value, isLoading: false, isError: false, error: null }),
  useSaveDepositInvoiceSettings: () => ({ mutate: saveMutate, isPending: false }),
  useIssueMissingDepositInvoices: () => ({ mutate: issueMutate, isPending: false, isSuccess: false, data: undefined }),
  useInvoiceDeliveredOrders: () => ({ mutate: invoiceDeliveredMutate, isPending: false, isSuccess: false, data: undefined }),
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

  test('the delivered backlog waits for the deposit invoices, then invoices on a button', () => {
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    const card = screen.getByLabelText('Deposit invoice switch');
    expect(within(card).getByText(/2 delivered orders still without a final invoice/)).toBeTruthy();
    const btn = within(card).getByText('Invoice them now') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);                       // 3 deposit invoices still to issue
    settings.value = { ...settings.value, missingCount: 0 };
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    const btns = screen.getAllByText('Invoice them now') as HTMLButtonElement[];
    const ready = btns[btns.length - 1]!;
    expect(ready.disabled).toBe(false);
    fireEvent.click(ready);
    expect(invoiceDeliveredMutate).toHaveBeenCalled();
    settings.value = { ...settings.value, missingCount: 3 };
  });

  test('an invoice opens with its payment; Cancel invoice waits for a reason, then sends it; a posted invoice offers no Post', () => {
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-DI-2609-003'));
    const dialog = screen.getByLabelText('Deposit invoice');
    expect(within(dialog).getByText(/cash · .* · RM 1,000\.00/)).toBeTruthy();
    expect(within(dialog).queryByText('Post to ledger')).toBeNull();
    const cancelBtn = within(dialog).getByText('Cancel invoice') as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Cancel reason'), { target: { value: 'Customer changed order' } });
    fireEvent.click(within(dialog).getByText('Cancel invoice'));
    expect(cancelMutate).toHaveBeenCalledWith({ id: 'd3', reason: 'Customer changed order' });
  });

  test('an invoice with a credit note against it offers no Cancel and says why (the closed-DI guard, owner 2026-09-21)', () => {
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-DI-2609-001'));
    const dialog = screen.getByLabelText('Deposit invoice');
    expect(within(dialog).queryByText('Cancel invoice')).toBeNull();
    expect(within(dialog).queryByLabelText('Cancel reason')).toBeNull();
    expect(within(dialog).getByText(/A credit note stands against this invoice, so it cannot be cancelled or re-issued/)).toBeTruthy();
  });

  test('a cancelled invoice shows its reason and offers neither Post nor Cancel', () => {
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-DI-2609-002'));
    const dialog = screen.getByLabelText('Deposit invoice');
    expect(within(dialog).getByText(/payment on 2990-SO-2609-002 edited — re-issued/)).toBeTruthy();
    expect(within(dialog).queryByText('Cancel invoice')).toBeNull();
    expect(within(dialog).queryByLabelText('Cancel reason')).toBeNull();
  });

  test('Print in the detail prints the one invoice — a cancelled one too; ticked rows print as ONE document in list order (docs/bugs/0834)', async () => {
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-DI-2609-002'));
    const dialog = screen.getByLabelText('Deposit invoice');
    fireEvent.click(within(dialog).getByText('Print'));
    await waitFor(() => expect(pdfSingle).toHaveBeenCalled());
    expect(pdfSingle.mock.calls[0]?.[0]).toMatchObject({ di_number: '2990-DI-2609-002', status: 'CANCELLED', so_doc_no: '2990-SO-2609-002', method: 'merchant' });
    expect(pdfSingle.mock.calls[0]?.[1]).toEqual({ action: 'print' });

    /* Ticked in the other order; printed in LIST order. */
    fireEvent.click(screen.getByLabelText('Tick 2990-DI-2609-002'));
    fireEvent.click(screen.getByLabelText('Tick 2990-DI-2609-001'));
    expect(screen.getByText('2 ticked')).toBeTruthy();
    fireEvent.click(screen.getByText('Print 2'));
    await waitFor(() => expect(pdfBatch).toHaveBeenCalled());
    const list = pdfBatch.mock.calls[0]?.[0] as Array<{ di_number: string }>;
    expect(list.map((d) => d.di_number)).toEqual(['2990-DI-2609-001', '2990-DI-2609-002']);
    expect(pdfBatch.mock.calls[0]?.[1]).toEqual({ action: 'print' });
  });
});

/* A refund on a deposit invoice is a credit note against it, whole or in
   part (docs/bugs/0860): the list says how much came off, the detail names
   the note and the refund voucher. */
describe('what a refund took off an invoice', () => {
  test('the list says how much was refunded; the detail names the note and the voucher', () => {
    render(<MemoryRouter><DepositInvoices /></MemoryRouter>);
    expect(screen.getByText('refunded RM 400.00')).toBeTruthy();
    fireEvent.click(screen.getByText('2990-DI-2609-001'));
    expect(screen.getByText(/Refunded RM 400\.00 — the sale this invoice booked is taken back by credit note/)).toBeTruthy();
    expect(screen.getByText(/2990-CN-2609-009 · RM 400\.00 · POSTED · refund 2990-CRF-2609-001/)).toBeTruthy();
  });
});
