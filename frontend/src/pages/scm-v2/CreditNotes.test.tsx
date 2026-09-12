/* The Credit & Debit Notes page (docs/bugs/0827): the list with kind and
   status filters; New note raises a draft with the customer's sales order or
   name (a supplier for an SCN) and lines whose account may stay blank; a
   note opens to its lines and posts or cancels; Print in the detail prints
   the one note and ticked rows print as one document in list order
   (docs/bugs/0834). The server half is backend/tests/creditNotes.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfirmProvider } from '../../vendor/scm/components/ConfirmDialog';
import { describe, expect, test, vi } from 'vitest';
import type { CreditNote } from '../../vendor/scm/lib/credit-note-queries';

const NOTES: CreditNote[] = [
  {
    id: 'n1', note_number: '2990-CN-2609-001', kind: 'CN', party_type: 'CUSTOMER', party_code: 'C-1', party_name: 'Larding Chen',
    supplier_id: null, so_doc_no: '2990-SO-2607-019', sales_invoice_id: null, ap_invoice_id: null, purchase_invoice_id: null, source_doc_no: 'DR-2609-001',
    note_date: '2026-09-01', total_sen: 15000, reason: 'Scratched leg', notes: null, status: 'DRAFT', je_no: null,
    created_at: '2026-09-01T00:00:00Z', created_by: 'Chew', posted_at: null, cancelled_at: null,
  },
  {
    id: 'n2', note_number: '2990-SCN-2609-001', kind: 'SCN', party_type: 'SUPPLIER', party_code: '405-H001', party_name: 'HOUZS VENTURE HOLDING SDN BHD',
    supplier_id: 'sup-h', so_doc_no: null, sales_invoice_id: null, ap_invoice_id: null, purchase_invoice_id: null, source_doc_no: 'PRT-2609-003',
    note_date: '2026-09-03', total_sen: 50000, reason: null, notes: null, status: 'POSTED', je_no: '2990-JE-2609-0007',
    created_at: '2026-09-03T00:00:00Z', created_by: 'Chew', posted_at: '2026-09-03T00:00:00Z', cancelled_at: null,
  },
];
const createMutate = vi.fn(async (body: unknown) => ({ ok: true, note: { ...NOTES[0]!, id: 'n3', note_number: '2990-CN-2609-002', ...(body as object) } }));
const postMutate = vi.fn(async () => ({ ok: true, jeNo: '2990-JE-2609-0008', status: 'posted' }));
const cancelMutate = vi.fn(async () => ({ ok: true }));
const lastList = { value: '' };
const pdfSingle = vi.fn(async (..._args: unknown[]) => {});
const pdfBatch = vi.fn(async (..._args: unknown[]) => {});
const LINES = [{ id: 'l1', line_no: 1, description: 'Scratched leg — goodwill', account_code: '510-0000', amount_sen: 15000 }];

vi.mock('../../vendor/scm/lib/credit-note-pdf', () => ({ generateCreditNotePdf: pdfSingle, generateCreditNotesPdf: pdfBatch }));
vi.mock('../../vendor/scm/lib/authed-fetch', async (importOriginal) => ({
  ...(await importOriginal() as object),
  authedFetch: vi.fn(async (path: string) => {
    if (path === '/accounting/accounts') return { accounts: [{ account_code: '510-0000', account_name: 'RETURN INWARDS' }] };
    const m = /^\/credit-notes\/([^/]+)$/.exec(path);
    if (m) return { note: NOTES.find((n) => n.id === m[1])!, lines: LINES };
    throw new Error(`unexpected ${path}`);
  }),
}));

vi.mock('../../vendor/scm/lib/credit-note-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useCreditNotes: (kind: string, status: string) => { lastList.value = `${kind}|${status}`; return { data: { rows: NOTES }, isLoading: false, isError: false, error: null }; },
  useCreditNoteDetail: (id: string | null) => ({
    data: id ? { note: NOTES.find((n) => n.id === id)!, lines: LINES } : undefined,
    isLoading: false,
  }),
  useCreateCreditNote: () => ({ mutateAsync: createMutate, isPending: false, isError: false, error: null }),
  useUpdateCreditNote: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  usePostCreditNote: () => ({ mutate: postMutate, mutateAsync: postMutate, isPending: false, isError: false, isSuccess: false, error: null }),
  useCancelCreditNote: () => ({ mutate: cancelMutate, isPending: false, isError: false, error: null }),
}));
vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useAccounts: () => ({ data: { accounts: [
    { account_code: '510-0000', account_name: 'RETURN INWARDS', account_type: 'INCOME', parent_code: null, is_active: true },
    { account_code: '520-0000', account_name: 'DISCOUNT ALLOWED', account_type: 'INCOME', parent_code: null, is_active: true },
  ] }, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useSuppliers: () => ({ data: [{ id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' }], isLoading: false }),
}));

const { CreditNotes, bodyOf } = await import('./CreditNotes');

describe('the Credit & Debit Notes page', () => {
  test('lists the notes with their kind, party, reference, total and journal; the filters reach the query', () => {
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    expect(screen.getByText('2990-CN-2609-001')).toBeTruthy();
    expect(screen.getByText('2990-SCN-2609-001')).toBeTruthy();
    expect(screen.getByText('Larding Chen')).toBeTruthy();
    expect(screen.getByText('2990-SO-2607-019 · DR-2609-001')).toBeTruthy();
    expect(screen.getByText('2990-JE-2609-0007')).toBeTruthy();
    expect(lastList.value).toBe('ALL|ALL');
    fireEvent.click(screen.getByRole('tab', { name: 'SCN' }));
    expect(lastList.value).toBe('SCN|ALL');
    fireEvent.change(screen.getByLabelText('Note status'), { target: { value: 'POSTED' } });
    expect(lastList.value).toBe('SCN|POSTED');
  });

  test('a note opens to its lines, and a draft posts', async () => {
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-CN-2609-001'));
    const dialog = await screen.findByLabelText('Credit or debit note');
    expect(within(dialog).getByText('Scratched leg — goodwill')).toBeTruthy();
    expect(within(dialog).getByText('510-0000')).toBeTruthy();
    fireEvent.click(within(dialog).getByText('Post to ledger'));
    expect(postMutate).toHaveBeenCalledWith('n1');
  });

  test('New note raises a draft: the sales order names the customer, a blank account is left to the default', async () => {
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    fireEvent.click(screen.getByText('New note'));
    const dialog = await screen.findByLabelText('Note form');
    fireEvent.change(within(dialog).getByLabelText('Sales order'), { target: { value: '2990-SO-2607-019' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Scratched leg' } });
    fireEvent.change(within(dialog).getByLabelText('Line 1 description'), { target: { value: 'Goodwill' } });
    fireEvent.change(within(dialog).getByLabelText('Line 1 amount'), { target: { value: '150' } });
    fireEvent.click(within(dialog).getByText('Save note'));
    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    expect(createMutate.mock.calls[0]?.[0]).toEqual({
      kind: 'CN', noteDate: expect.any(String), reason: 'Scratched leg', sourceDocNo: null, soDocNo: '2990-SO-2607-019',
      lines: [{ description: 'Goodwill', accountCode: null, amountSen: 15000 }],
    });
  });

  test('the body of a supplier note carries the supplier, and a typed customer name stands in for an order', () => {
    const scn = bodyOf({ kind: 'SCN', noteDate: '2026-09-03', soDocNo: '', partyName: '', supplierId: 'sup-h', sourceDocNo: 'PRT-2609-003', reason: '', lines: [{ rid: 1, description: '', accountCode: '', amountRm: '500' }] });
    expect(scn).toEqual({ kind: 'SCN', noteDate: '2026-09-03', reason: null, sourceDocNo: 'PRT-2609-003', supplierId: 'sup-h', lines: [{ description: null, accountCode: null, amountSen: 50000 }] });
    const typed = bodyOf({ kind: 'DN', noteDate: '2026-09-03', soDocNo: '', partyName: 'Walk-in Ah Meng', supplierId: '', sourceDocNo: '', reason: 'Late fee', lines: [{ rid: 1, description: 'Late fee', accountCode: '520-0000', amountRm: '20.50' }] });
    expect(typed).toMatchObject({ kind: 'DN', partyName: 'Walk-in Ah Meng', lines: [{ description: 'Late fee', accountCode: '520-0000', amountSen: 2050 }] });
  });

  test('Print in the detail prints the one note with its lines and the chart\'s names; ticked rows print as ONE document in list order (docs/bugs/0834)', async () => {
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-CN-2609-001'));
    const dialog = await screen.findByLabelText('Credit or debit note');
    fireEvent.click(within(dialog).getByText('Print'));
    await waitFor(() => expect(pdfSingle).toHaveBeenCalled());
    expect(pdfSingle.mock.calls[0]?.[0]).toMatchObject({ note_number: '2990-CN-2609-001' });
    expect(pdfSingle.mock.calls[0]?.[1]).toEqual([expect.objectContaining({ account_code: '510-0000', amount_sen: 15000 })]);
    expect((pdfSingle.mock.calls[0]?.[2] as (code: string) => string | null)('510-0000')).toBe('RETURN INWARDS');
    expect(pdfSingle.mock.calls[0]?.[3]).toEqual({ action: 'print' });

    /* Ticked in the other order; printed in LIST order. */
    fireEvent.click(screen.getByLabelText('Tick 2990-SCN-2609-001'));
    fireEvent.click(screen.getByLabelText('Tick 2990-CN-2609-001'));
    expect(screen.getByText('2 ticked')).toBeTruthy();
    fireEvent.click(screen.getByText('Print 2'));
    await waitFor(() => expect(pdfBatch).toHaveBeenCalled());
    const items = pdfBatch.mock.calls[0]?.[0] as Array<{ header: { note_number: string }; lines: unknown[] }>;
    expect(items.map((i) => i.header.note_number)).toEqual(['2990-CN-2609-001', '2990-SCN-2609-001']);
    expect(items[0]?.lines).toHaveLength(1);
    expect(pdfBatch.mock.calls[0]?.[2]).toEqual({ action: 'print' });
  });
});
