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
/* Knock off (2026-10-02): the posted supplier note n2 (RM 500.00) has knocked off
   RM 200.00 — all of PI-004 — and PI-007 still owes RM 400.00. */
const ALLOCS = [{ id: 'al-1', kind: 'PI', docId: 'pi-1', number: '2990-PI-2609-004', amountSen: 20_000, appliedSen: 20_000, createdAt: '2026-09-03T00:00:00Z', createdBy: 'Chew' }];
const KO_ROWS = [
  { kind: 'PI', id: 'pi-1', number: '2990-PI-2609-004', invoiceRef: 'INV-70', invoiceDate: '2026-09-02', totalSen: 20_000, owedSen: 20_000, noteSen: 20_000, status: 'PAID' },
  { kind: 'PI', id: 'pi-2', number: '2990-PI-2609-007', invoiceRef: 'INV-77', invoiceDate: '2026-09-05', totalSen: 40_000, owedSen: 40_000, noteSen: 0, status: 'POSTED' },
];
/* Diglant's invoices still owing — the scanned note's table. */
const SUP_ROWS = [
  { kind: 'PI', id: 'pi-17', number: 'HC-PI-2610-017', invoiceRef: 'DGSIZ26001811', invoiceDate: '2026-09-07', totalSen: 260_000, owedSen: 260_000, noteSen: 0, status: 'POSTED' },
  { kind: 'PI', id: 'pi-18', number: 'HC-PI-2610-018', invoiceRef: 'DGSIZ26001811', invoiceDate: '2026-09-07', totalSen: 130_000, owedSen: 130_000, noteSen: 0, status: 'POSTED' },
];
const setMutate = vi.fn();
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
  useCreditNoteKnockOff: (id: string | null) => ({ data: id === 'n2' ? { rows: KO_ROWS, totalSen: 50_000, takenSen: 20_000, leftSen: 30_000, posted: true } : undefined, isLoading: false, isError: false, error: null }),
  useSupplierKnockOff: (supplierId: string | null) => ({ data: supplierId === 'sup-d' ? { rows: SUP_ROWS } : supplierId ? { rows: [] } : undefined, isLoading: false, isError: false, error: null }),
  useSetCreditNoteAllocations: () => ({ mutate: setMutate, isPending: false, isError: false, error: null, data: undefined }),
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
    /* A supplier note always says its ticks — none ticked is a plan too. */
    expect(scn).toEqual({ kind: 'SCN', noteDate: '2026-09-03', reason: null, sourceDocNo: 'PRT-2609-003', supplierId: 'sup-h', allocations: [], lines: [{ description: null, accountCode: null, amountSen: 50000 }] });
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
  test('the paper fills the New note form — supplier, CN number, date, reason, lines on their accounts, the invoice it names ticked; Save sends them and the pages attach', async () => {
    createMutate.mockClear(); scanMutate.mockClear(); uploadMutate.mockClear();
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    const page = new File(['%PDF'], 'DGPSC26000263.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Supplier credit note pages'), { target: { files: [page] } });
    await waitFor(() => expect(scanMutate).toHaveBeenCalledWith([{ name: 'DGPSC26000263.pdf', mime: 'application/pdf', dataBase64: 'b64:DGPSC26000263.pdf' }]));
    const d = await screen.findByLabelText('What the credit note reads');
    expect(within(d).getByText('SST RM 59.09 is spread over the lines — the purchase was booked with its SST.')).toBeTruthy();
    expect(within(d).getByLabelText('The invoice the paper names').textContent).toContain('HC-PI-2610-017 is ticked under Knock off below');
    /* The knock-off table: the named invoice ticked for the whole credit (RM 650.00 — it owes RM 2,600.00). */
    const ko = screen.getByLabelText("Knock off the supplier's invoices");
    expect((within(ko).getByLabelText('Knock off HC-PI-2610-017') as HTMLInputElement).checked).toBe(true);
    expect((within(ko).getByLabelText('Amount off HC-PI-2610-017') as HTMLInputElement).value).toBe('650.00');
    expect((within(ko).getByLabelText('Knock off HC-PI-2610-018') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Line 1 amount') as HTMLInputElement).value).toBe('324.99');
    expect((screen.getByLabelText('Reference') as HTMLInputElement).value).toBe('DGPSC26000263');
    fireEvent.click(screen.getByText('Save note'));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0]![0]).toMatchObject({
      kind: 'SCN', supplierId: 'sup-d', noteDate: '2026-09-07', sourceDocNo: 'DGPSC26000263', reason: '25% display discount', purchaseInvoiceId: 'pi-17',
      allocations: [{ kind: 'PI', id: 'pi-17', amountSen: 65_000 }],
      lines: [{ accountCode: '610-0001', amountSen: 32_499 }, { accountCode: '610-0001', amountSen: 32_501 }],
    });
    await waitFor(() => expect(uploadMutate).toHaveBeenCalledWith({ noteId: 'n3', file: { name: 'DGPSC26000263.pdf', mime: 'application/pdf', dataBase64: 'b64:DGPSC26000263.pdf' } }));
  });

  test('unticking the named invoice keeps the credit with the supplier — the invoice on the paper stays its reference', async () => {
    createMutate.mockClear();
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Supplier credit note pages'), { target: { files: [new File(['%PDF'], 'cn.pdf', { type: 'application/pdf' })] } });
    await screen.findByLabelText('What the credit note reads');
    const ko = screen.getByLabelText("Knock off the supplier's invoices");
    fireEvent.click(within(ko).getByLabelText('Knock off HC-PI-2610-017'));
    expect(screen.getByLabelText('Knock-off total').textContent).toContain('credit left RM 650.00 of RM 650.00');
    fireEvent.click(screen.getByText('Save note'));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    /* The paper's invoice stays as the note's reference; nothing is knocked off. */
    expect(createMutate.mock.calls[0]![0]).toMatchObject({ purchaseInvoiceId: 'pi-17', allocations: [] });
  });

  test("another of the supplier's invoices can be ticked instead", async () => {
    createMutate.mockClear();
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Supplier credit note pages'), { target: { files: [new File(['%PDF'], 'cn.pdf', { type: 'application/pdf' })] } });
    await screen.findByLabelText('What the credit note reads');
    const ko = screen.getByLabelText("Knock off the supplier's invoices");
    fireEvent.click(within(ko).getByLabelText('Knock off HC-PI-2610-017'));
    fireEvent.click(within(ko).getByLabelText('Knock off HC-PI-2610-018'));
    fireEvent.click(screen.getByText('Save note'));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0]![0]).toMatchObject({ allocations: [{ kind: 'PI', id: 'pi-18', amountSen: 65_000 }] });
  });
});

/* Knock off like an AP Payment (owner 2026-10-02: CN 的方式应该是类似 ap payment 这样 knock off；
   扣错了就我 untick 会 knock off 的 invoice 就行了). */
describe('a posted supplier note\'s knock-off', () => {
  test('untick gives an invoice back, a tick takes another; Save knock-off carries it out', async () => {
    setMutate.mockClear();
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-SCN-2609-001'));
    const ko = await screen.findByLabelText("Knock off the supplier's invoices");
    expect((within(ko).getByLabelText('Knock off 2990-PI-2609-004') as HTMLInputElement).checked).toBe(true);
    expect((within(ko).getByLabelText('Knock off 2990-PI-2609-007') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByLabelText('Knock-off total').textContent).toContain('credit left RM 300.00 of RM 500.00');
    expect(screen.queryByText('Save knock-off · 保存')).toBeNull();

    fireEvent.click(within(ko).getByLabelText('Knock off 2990-PI-2609-004'));
    fireEvent.click(within(ko).getByLabelText('Knock off 2990-PI-2609-007'));
    /* PI-007 owes RM 400.00 and the whole RM 500.00 is free — it takes RM 400.00. */
    expect((within(ko).getByLabelText('Amount off 2990-PI-2609-007') as HTMLInputElement).value).toBe('400.00');
    fireEvent.click(screen.getByText('Save knock-off · 保存'));
    expect(setMutate).toHaveBeenCalledWith({ noteId: 'n2', targets: [{ kind: 'PI', id: 'pi-2', amountSen: 40_000 }] }, expect.anything());
  });

  test('a typed figure takes part; more than the credit reaches is pulled back; Undo changes puts the ticks back', async () => {
    setMutate.mockClear();
    render(<MemoryRouter><ConfirmProvider><CreditNotes /></ConfirmProvider></MemoryRouter>);
    fireEvent.click(screen.getByText('2990-SCN-2609-001'));
    const ko = await screen.findByLabelText("Knock off the supplier's invoices");
    const amount = within(ko).getByLabelText('Amount off 2990-PI-2609-007');
    fireEvent.focus(amount); fireEvent.change(amount, { target: { value: '450' } }); fireEvent.blur(amount);
    /* PI-004 keeps RM 200.00 of the RM 500.00 — RM 300.00 is all PI-007 can take. */
    await waitFor(() => expect((within(ko).getByLabelText('Amount off 2990-PI-2609-007') as HTMLInputElement).value).toBe('300.00'));
    expect(screen.getByLabelText('Knock-off total').textContent).toContain('credit left RM 0.00 of RM 500.00');
    fireEvent.click(screen.getByText('Save knock-off · 保存'));
    expect(setMutate).toHaveBeenCalledWith({ noteId: 'n2', targets: [{ kind: 'PI', id: 'pi-1', amountSen: 20_000 }, { kind: 'PI', id: 'pi-2', amountSen: 30_000 }] }, expect.anything());
    fireEvent.click(screen.getByText('Undo changes'));
    expect((within(ko).getByLabelText('Knock off 2990-PI-2609-007') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText('Save knock-off · 保存')).toBeNull();
  });
});
