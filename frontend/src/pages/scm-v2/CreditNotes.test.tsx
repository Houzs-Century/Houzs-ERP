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
/* Scan supplier CN (owner 2026-10-01): the reader's answer for Diglant's display-discount note. */
const SCAN = {
  ok: true,
  read: { isCreditNote: true, vendorName: 'DIGLANT MANUFACTURING SDN. BHD.', vendorRegNo: '1459872-U', cnNumber: 'DGPSC26000263', cnDate: '2026-09-07', invoiceNumbers: ['DGSIZ26001811'], subtotalSen: 59_091, sstSen: 5_909, totalSen: 65_000, remark: '25% display discount' },
  supplier: { id: 'sup-d', code: '400-D002', name: 'DIGLANT MANUFACTURING SDN BHD.', confidence: 'exact' },
  lines: [
    { description: 'Mattress Akemi Medi+Health Equinox K — Aeon Big Puchong · inv. DGSIZ26001811', itemCode: 'T1MAMJA0MK', qty: 1, printedSen: 29_545, amountSen: 32_499, accountCode: '610-0001', accountName: 'DISCOUNT RECEIVED', rule: 'discount received', creditsDocId: 'pi-17' },
    { description: 'Mattress Akemi Medi+Health Equinox K — Mid Valley · inv. DGSIZ26001811', itemCode: 'T1MAMJA0MK', qty: 1, printedSen: 29_546, amountSen: 32_501, accountCode: '610-0001', accountName: 'DISCOUNT RECEIVED', rule: 'discount received', creditsDocId: 'pi-17' },
  ],
  invoices: [
    { kind: 'PI', id: 'pi-17', number: 'HC-PI-2610-017', invoiceRef: 'DGSIZ26001811', invoiceDate: '2026-09-07', totalSen: 260_000, paidSen: 0, status: 'POSTED', outstandingSen: 260_000 },
    { kind: 'PI', id: 'pi-18', number: 'HC-PI-2610-018', invoiceRef: 'DGSIZ26001811', invoiceDate: '2026-09-07', totalSen: 130_000, paidSen: 0, status: 'POSTED', outstandingSen: 130_000 },
  ],
  suggested: { kind: 'PI', id: 'pi-17', number: 'HC-PI-2610-017' },
  duplicates: [],
  notes: ['SST RM 59.09 is spread over the lines — the purchase was booked with its SST.'],
};
const scanMutate = vi.fn(async (_pages: unknown) => SCAN);
/* Part 2: the posted supplier note n2 has RM 200.00 taken off one invoice, RM 300.00 left. */
const ALLOCS = [{ id: 'al-1', kind: 'PI', docId: 'pi-1', number: '2990-PI-2609-004', amountSen: 20_000, appliedSen: 20_000, createdAt: '2026-09-03T00:00:00Z', createdBy: 'Chew' }];
const OPEN = [{ kind: 'PI', id: 'pi-2', number: '2990-PI-2609-007', invoiceRef: 'INV-77', invoiceDate: '2026-09-05', totalSen: 40_000, paidSen: 0, outstandingSen: 40_000, status: 'POSTED' }];
const applyMutate = vi.fn();
const removeMutate = vi.fn();
const uploadMutate = vi.fn(async (_b: unknown) => ({ ok: true }));
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
    data: id ? { note: NOTES.find((n) => n.id === id)!, lines: LINES, ...(id === 'n2' ? { allocations: ALLOCS, appliedSen: 20_000, leftSen: 30_000 } : {}) } : undefined,
    isLoading: false,
  }),
  useCreditNoteOpenInvoices: (id: string | null) => ({ data: id ? { invoices: OPEN } : undefined, isLoading: false }),
  useApplyCreditNote: () => ({ mutate: applyMutate, isPending: false, isError: false, error: null }),
  useRemoveCreditNoteAllocation: () => ({ mutate: removeMutate, isPending: false, isError: false, error: null }),
  useCreateCreditNote: () => ({ mutateAsync: createMutate, isPending: false, isError: false, error: null }),
  useUpdateCreditNote: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  usePostCreditNote: () => ({ mutate: postMutate, mutateAsync: postMutate, isPending: false, isError: false, isSuccess: false, error: null }),
  useCancelCreditNote: () => ({ mutate: cancelMutate, isPending: false, isError: false, error: null }),
  useScanSupplierCreditNote: () => ({ mutateAsync: scanMutate, isPending: false }),
  useCreditNoteFiles: () => ({ data: { files: [] }, isLoading: false }),
  useUploadCreditNoteFile: () => ({ mutateAsync: uploadMutate, isPending: false }),
  useDeleteCreditNoteFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
/* The Files card asks the shell's notifier (Scm2990Shell provides it in the app). */
vi.mock('../../vendor/scm/components/NotifyDialog', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useNotify: () => vi.fn(),
}));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  fileToBase64: async (f: File) => `b64:${f.name}`,
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
  useSuppliers: () => ({ data: [{ id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' }, { id: 'sup-d', code: '400-D002', name: 'DIGLANT MANUFACTURING SDN BHD.' }], isLoading: false }),
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

/* Scan supplier CN (owner 2026-10-01: supplier 给我 cn，我要做 ocr for cn；这个 cn 可能会 link 去相对应的 supplier invoice). */
describe('Scan supplier CN', () => {
  test('the paper fills the New note form — supplier, CN number, date, reason, lines on their accounts, the invoice it credits; Save sends them and the pages attach', async () => {
    createMutate.mockClear(); scanMutate.mockClear(); uploadMutate.mockClear();
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    const page = new File(['%PDF'], 'DGPSC26000263.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Supplier credit note pages'), { target: { files: [page] } });
    await waitFor(() => expect(scanMutate).toHaveBeenCalledWith([{ name: 'DGPSC26000263.pdf', mime: 'application/pdf', dataBase64: 'b64:DGPSC26000263.pdf' }]));
    const d = await screen.findByLabelText('What the credit note reads');
    expect(within(d).getByText('SST RM 59.09 is spread over the lines — the purchase was booked with its SST.')).toBeTruthy();
    expect((within(d).getByLabelText('Credits HC-PI-2610-017') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Line 1 amount') as HTMLInputElement).value).toBe('324.99');
    expect((screen.getByLabelText('Reference') as HTMLInputElement).value).toBe('DGPSC26000263');
    fireEvent.click(screen.getByText('Save note'));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0]![0]).toMatchObject({
      kind: 'SCN', supplierId: 'sup-d', noteDate: '2026-09-07', sourceDocNo: 'DGPSC26000263', reason: '25% display discount', purchaseInvoiceId: 'pi-17',
      lines: [{ accountCode: '610-0001', amountSen: 32_499 }, { accountCode: '610-0001', amountSen: 32_501 }],
    });
    await waitFor(() => expect(uploadMutate).toHaveBeenCalledWith({ noteId: 'n3', file: { name: 'DGPSC26000263.pdf', mime: 'application/pdf', dataBase64: 'b64:DGPSC26000263.pdf' } }));
  });

  test('choosing none of the invoices leaves the credit with the supplier — no invoice is sent', async () => {
    createMutate.mockClear();
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Supplier credit note pages'), { target: { files: [new File(['%PDF'], 'cn.pdf', { type: 'application/pdf' })] } });
    const d = await screen.findByLabelText('What the credit note reads');
    fireEvent.click(within(d).getByLabelText('Credits no one invoice'));
    fireEvent.click(screen.getByText('Save note'));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0]![0]).not.toHaveProperty('purchaseInvoiceId');
  });
});

/* Supplier CN part 2 (owner 2026-10-01: 有写发票的 CN 直接扣那张发票的欠款；没写的先挂在供应商名下，再选要扣哪几张发票). */
describe('where a posted supplier note\'s credit goes', () => {
  test('the detail shows the invoice it came off and the credit left; the rest comes off the invoice picked; one application is given back', async () => {
    applyMutate.mockClear(); removeMutate.mockClear();
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-SCN-2609-001'));
    const credit = await screen.findByLabelText('Where the credit went');
    expect(within(credit).getByText('2990-PI-2609-004')).toBeTruthy();
    expect(within(credit).getByText('RM 300.00')).toBeTruthy();
    fireEvent.click(within(credit).getByText('Take it off invoices… · 扣发票'));
    fireEvent.change(within(credit).getByLabelText('Amount off 2990-PI-2609-007'), { target: { value: '300' } });
    fireEvent.click(within(credit).getByText('Take it off'));
    expect(applyMutate).toHaveBeenCalledWith({ noteId: 'n2', targets: [{ kind: 'PI', id: 'pi-2', amountSen: 30_000 }] }, expect.anything());

    fireEvent.click(within(credit).getByLabelText('Give back 2990-PI-2609-004'));
    const confirm = await screen.findByRole('button', { name: 'Give back' });
    fireEvent.click(confirm);
    await waitFor(() => expect(removeMutate).toHaveBeenCalledWith({ noteId: 'n2', allocationId: 'al-1' }));
  });

  test('more than is left cannot be taken off', async () => {
    applyMutate.mockClear();
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-SCN-2609-001'));
    const credit = await screen.findByLabelText('Where the credit went');
    fireEvent.click(within(credit).getByText('Take it off invoices… · 扣发票'));
    fireEvent.change(within(credit).getByLabelText('Amount off 2990-PI-2609-007'), { target: { value: '350' } });
    expect((within(credit).getByText('Take it off').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
