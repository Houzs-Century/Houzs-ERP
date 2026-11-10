/* AP Invoices — the Finance list shows BOTH kinds (owner 2026-09-06: 我想要
   两个都看到, 现有的 purchase invoice remain): purchase invoices as a
   read-only mirror linking to their own page, AP invoices raised here.
   Round 2: the list filters by supplier and prints what it shows, the bill
   carries an overall description. Round 3: a bill opens in a pop-out over
   the list; every field can be edited (a posted bill re-posts); a bill can
   be copied; the form's lines are a table in the owner's order with Insert
   adding a line and landing on it, amounts reading 1,800.00; the form scans
   a bill and attaches its pages after save. The server half is
   backend/tests/apInvoices.test.ts + apInvoiceEdit.test.ts.
   The redesign (batch 4, step 5): Money out › Supplier bills — kind tabs with
   the suppliers' credit notes, Trade / Other, status chips, the sand tint,
   ticks, the row's next step and its ⋯ menu. Step 8: the prints — the ticks
   as one document (With files), ⋯ Print / Print + files, a paid row's Print,
   and the bill page's print preview. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import { stashPvFiles } from '../../vendor/scm/lib/pv-file-handoff';

const createAsync = vi.fn(async (_b: unknown) => ({ ok: true, invoice: { id: 'api-2', invoice_number: '2990-API-2609-002', total_sen: 42_000 } }));
const updateAsync = vi.fn(async (_v: unknown) => ({ ok: true, invoice: { id: 'api-1', invoice_number: '2990-API-2609-001', total_sen: 420_000 }, reposted: false }));
const postAsync = vi.fn(async (_id: unknown) => ({ ok: true, jeNo: '2990-JE-2609-030', status: 'posted' }));
const cancelAsync = vi.fn(async (_id: unknown) => ({ ok: true }));
const uploadAsync = vi.fn(async (_v: unknown) => ({ ok: true, file: { id: 'f9' } }));
const deleteAsync = vi.fn(async (_v: unknown) => ({ ok: true }));
const listingAsync = vi.fn(async (_rows: unknown, _filter: unknown) => undefined);
const planAsync = vi.fn(async (_b: unknown) => ({ ok: true, plannedOn: '2099-12-15' }));
const extractAsync = vi.fn(async (_bills: unknown) => ({ bills: [{
  index: 0, ok: true,
  extraction: {
    vendorName: 'HOUZS VENTURE HOLDING SDN. BHD.', vendorRegNo: null, documentKind: 'invoice', invoiceNumber: 'HVH-0912',
    invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'MYR', totalSen: 400_000, sstSen: null,
    lines: [{ description: 'Rent Sept', amountSen: 400_000 }],
  },
  supplierMatch: { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD', confidence: 'contains' },
  memory: { payeeName: 'HOUZS VENTURE HOLDING SDN BHD', debitAccountCode: '900-A001', purpose: 'SUPPLIER_PAYMENT', timesSeen: 1 },
}] }));
/* 申请付款 answered by a bill (owner 2026-09-30, 6.1–6.2) — set by that test only. */
let requestDetail: Record<string, unknown> | undefined;
const extractRequestAsync = vi.fn(async (_id: unknown) => ({ bills: [{
  index: 0, ok: true,
  extraction: {
    vendorName: 'HOUZS VENTURE HOLDING SDN. BHD.', vendorRegNo: null, documentKind: 'invoice', invoiceNumber: 'HVH-0930',
    invoiceDate: '2026-09-10', dueDate: null, currency: 'MYR', totalSen: 800_000, sstSen: null,
    lines: [{ description: 'Booth F1 rental 50%', amountSen: 800_000 }],
  },
  supplierMatch: { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD', confidence: 'contains' },
  memory: { payeeName: 'HOUZS VENTURE HOLDING SDN BHD', debitAccountCode: '900-A001', purpose: 'SUPPLIER_PAYMENT', timesSeen: 1 },
}] }));
/* The detail's status — flipped by tests: a DRAFT may lose a file and edits plainly, a POSTED bill keeps files and re-posts on edit. */
let detailStatus = 'DRAFT';
let detailPaidSen = 0;
/* What paid the bill (the bill page's Payments, step 6) — none unless a test sets it. */
let detailPayments: Array<Record<string, unknown>> = [];
let filesLocked: boolean | undefined;
/* What the list was asked for — kind and docKind (the supplier debit notes, 2026-10-28). */
const lastApList = { value: '' };

const ROWS = [
  { kind: 'API', id: 'api-1', invoiceNumber: '2990-API-2609-001', supplierId: 'sup-h', supplierCode: '405-H001', supplierName: 'HOUZS VENTURE HOLDING SDN BHD', supplierInvoiceRef: 'HVH-0912', description: 'Rent September', invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'MYR', totalSen: 420_000, paidSen: 0, outstandingSen: 420_000, status: 'DRAFT', controlRole: 'AP_OTHER' },
  { kind: 'PI', id: 'pi-1', invoiceNumber: '2990-PI-2607-005', supplierId: 'sup-t', supplierCode: '400-H004', supplierName: 'HOOKKA INDUSTRIES SDN. BHD.', supplierInvoiceRef: null, description: null, invoiceDate: '2026-06-27', dueDate: '2026-07-27', currency: 'MYR', totalSen: 300_000, paidSen: 100_000, outstandingSen: 200_000, status: 'PARTIALLY_PAID', controlRole: 'AP' },
];
/* What the list hands over — ROWS unless a test swaps it (a held invoice). */
let apRowsNow: Array<Record<string, unknown>> = ROWS;

/* The suppliers' credit notes on Supplier bills — none unless a test sets them. */
let notes: Array<Record<string, unknown>> = [];
const postNoteAsync = vi.fn(async (_id: unknown) => ({ ok: true, jeNo: '2990-JE-2611-0007', status: 'POSTED', applied: [] }));
vi.mock('../../vendor/scm/lib/credit-note-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/credit-note-queries')>()),
  useCreditNotes: () => ({ data: { rows: notes }, isLoading: false, isError: false, error: null }),
  usePostCreditNote: () => ({ mutateAsync: postNoteAsync, isPending: false }),
  useCancelCreditNote: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useScanSupplierCreditNote: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
/* The note's own pop-out and form belong to the CN / DN page (CreditNotes.test.tsx); here they only say they opened. */
vi.mock('./CreditNotes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./CreditNotes')>()),
  NoteDetail: ({ id }: { id: string }) => <div role="dialog">NOTE {id}</div>,
  NoteForm: ({ kinds }: { kinds: string[] }) => <div role="dialog">NOTE FORM {kinds.join(',')}</div>,
}));

/* 欠正式单 (item 3): Finance's marks and the requester's upload — stubbed. */
const markOfficial = vi.fn();
const uploadOfficialAsync = vi.fn(async (_b: unknown) => ({ ok: true, received: [{ kind: 'PV', number: 'HC-PV-2610-001' }], note: null as string | null }));
vi.mock('../../vendor/scm/lib/official-doc-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/official-doc-queries')>()),
  useMarkOfficialDoc: () => ({ mutate: markOfficial, isPending: false }),
  useUploadOfficialDoc: () => ({ mutateAsync: uploadOfficialAsync, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/ap-invoice-queries', () => ({
  useApInvoices: (kind?: string, docKind?: string) => { lastApList.value = `${kind ?? ''}|${docKind ?? ''}`; return { data: { rows: apRowsNow }, isLoading: false, isError: false, error: null }; },
  useApInvoiceDetail: (id: string | null) => ({ data: id ? {
    invoice: { id: 'api-1', invoice_number: '2990-API-2609-001', supplier_id: 'sup-h', supplier_invoice_ref: 'HVH-0912', invoice_date: '2026-09-01', due_date: null, currency: 'MYR', total_sen: 420_000, paid_sen: detailPaidSen, status: detailStatus, notes: 'Rent September', posted_at: null, posted_by: null },
    lines: [{ id: 'l1', line_no: 1, description: 'Rent Sept', debit_account_code: '900-A001', amount_sen: 400_000 }, { id: 'l2', line_no: 2, description: null, debit_account_code: '900-A002', amount_sen: 20_000 }],
    supplier: { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' },
    payments: detailPayments,
  } : undefined, isLoading: false }),
  useCreateApInvoice: () => ({ mutateAsync: createAsync, isPending: false }),
  useUpdateApInvoice: () => ({ mutateAsync: updateAsync, isPending: false }),
  usePostApInvoice: () => ({ mutateAsync: postAsync, isPending: false }),
  useCancelApInvoice: () => ({ mutateAsync: cancelAsync, isPending: false }),
  usePlanBill: () => ({ mutateAsync: planAsync, mutate: vi.fn(), isPending: false }),
  useApInvoiceFiles: (id: string | null) => ({ data: id ? { files: [{ id: 'f1', file_name: 'rent.pdf', mime: 'application/pdf', size_bytes: 120_000, sort_no: 1, created_at: '2026-09-06T02:00:00Z' }], locked: filesLocked } : undefined, isLoading: false }),
  useUploadApInvoiceFile: () => ({ mutateAsync: uploadAsync, isPending: false }),
  useDeleteApInvoiceFile: () => ({ mutateAsync: deleteAsync, isPending: false }),
  fetchApInvoiceFileBlobUrl: vi.fn(),
}));
/* The same bill elsewhere (owner 2026-10-05: 提醒也加) — answered by number|date;
   every ask is kept with what it excluded. */
let sameBill: Record<string, unknown[]> = {};
const billMatchAsks: Array<[string, string, string | null, string | null]> = [];
vi.mock('../../vendor/scm/lib/payment-request-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/payment-request-queries')>()),
  usePaymentRequest: (id: string | null) => ({ data: id && requestDetail ? { request: requestDetail, finance: true } : undefined, isLoading: false }),
  useBillMatches: (no: string, date: string, excludeRequest: string | null = null, excludeApInvoice: string | null = null) => {
    billMatchAsks.push([no, date, excludeRequest, excludeApInvoice]);
    return { data: { matches: sameBill[`${no.trim()}|${date}`] ?? [] } };
  },
}));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  useExtractBills: () => ({ mutateAsync: extractAsync, isPending: false }),
  useExtractRequestBill: () => ({ mutateAsync: extractRequestAsync, isPending: false }),
  fileToBase64: async (f: File) => `b64:${f.name}`,
  PV_FILE_ACCEPT: 'image/jpeg,image/png,image/webp,application/pdf',
}));
/* Supplier bills on paper (step 8): what was asked to print, in what order, with or without files. */
const printBills = vi.fn(async (_docs: unknown, _opts: unknown) => undefined);
vi.mock('../../vendor/scm/lib/supplier-bills-print', () => ({
  printSupplierBills: (docs: unknown, opts: unknown) => printBills(docs, opts),
}));
/* The print preview's letterhead band reads the branding; no query client here. */
vi.mock('../../hooks/useBranding', () => ({ useBranding: () => ({ companyName: 'Houzs Century Sdn Bhd', companyCode: 'HOUZS' }) }));
vi.mock('../../vendor/scm/lib/ap-invoice-listing-pdf', () => ({
  generateApListingPdf: (rows: unknown, filter: unknown) => listingAsync(rows, filter),
}));
vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  /* The real pure helpers stay (postableAccounts — docs/bugs/0693); only the hooks are stubbed. */
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useAccounts: () => ({ data: { accounts: [
    { account_code: '900-0000', account_name: 'Operating Expense', account_type: 'EXPENSE', parent_code: null, is_active: true, acc_money: false, special_type: null },
    { account_code: '900-A001', account_name: 'RENTAL', account_type: 'EXPENSE', parent_code: '900-0000', is_active: true, acc_money: false, special_type: null },
    { account_code: '900-A002', account_name: 'SERVICE FEE', account_type: 'EXPENSE', parent_code: '900-0000', is_active: true, acc_money: false, special_type: null },
    { account_code: '400-0000', account_name: 'ACCOUNT PAYABLE', account_type: 'LIABILITY', parent_code: null, is_active: true, acc_money: false, special_type: 'SCC' },
  ] }, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useSuppliers: () => ({ data: [{ id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' }], isLoading: false }),
  /* The finance-details reminder reads the detail; this supplier has its TIN, so it stays quiet. */
  useSupplierDetail: (id: string | null) => ({ data: id ? { supplier: { id, name: 'HOUZS VENTURE HOLDING SDN BHD', tin_number: 'C123', business_reg_no: '201901', registration_no: null }, bindings: [] } : undefined }),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn, usePrompt: () => async () => null }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));

/* Events (owner 2026-09-30, 5a) — the picker's list and the labels, stubbed; the real eventLabel stays. */
const EVENT_OPTIONS = [
  { id: 336, code: 'E-336', name: 'Pulau Pinang [AKEMI] HOMELOVE @ SETIA SPICE', startDate: '2026-09-04', endDate: '2026-09-06', status: 'confirmed', archived: false, venue: null, brand: 'AKEMI', organizer: 'HOMELOVE', boothNo: null },
  { id: 348, code: 'E-348', name: 'Pulau Pinang [AKEMI] MLE @ PWCC', startDate: '2026-09-25', endDate: '2026-09-27', status: 'confirmed', archived: false, venue: null, brand: 'AKEMI', organizer: 'MLE', boothNo: 'F1' },
];
const retagMutate = vi.fn();
vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => ({ data: EVENT_OPTIONS, isLoading: false }),
  useEventLabels: () => ({ data: new Map(EVENT_OPTIONS.map((e) => [e.id, e])) }),
  useRetagPvLine: () => ({ mutate: retagMutate, isPending: false }),
}));

import { ApInvoices } from './ApInvoices';
import { ApBillPage } from './ApBillPage';

/* The list, with the pages it opens: a bill's own page (step 6) and a note's (stubbed). */
const draw = (at = '/scm/ap-invoices') => render(
  <MemoryRouter initialEntries={[at]}>
    <Routes>
      <Route path="/scm/ap-invoices" element={<ApInvoices />} />
      <Route path="/scm/ap-invoices/:id" element={<ApBillPage />} />
      <Route path="/scm/supplier-notes/:id" element={<div>NOTE PAGE</div>} />
    </Routes>
  </MemoryRouter>,
);
const dialog = () => screen.getByRole('dialog');
const setAmount = (label: string, rm: string) => {
  const box = screen.getByLabelText(label);
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: rm } });
  fireEvent.blur(box);
};

describe('both kinds on one list', () => {
  test('a purchase invoice mirrors with a link to its own page; the description shows', () => {
    draw();
    /* The kind tabs count what each holds (the design). */
    expect(screen.getByRole('tab', { name: /AP bills/ }).textContent).toBe('AP bills 1');
    expect(screen.getByRole('tab', { name: /Purchase invoices/ }).textContent).toBe('Purchase invoices 1');
    expect(screen.getByText('2990-PI-2607-005').closest('a')!.getAttribute('href')).toBe('/scm/purchase-invoices/pi-1');
    expect(screen.getByText('2990-PI-2607-005').closest('tr')!.textContent).toContain('2,000.00');
    expect(screen.getByText('Rent September')).toBeTruthy();
  });

  test('an AP bill opens as its own page (step 6) with its lines, description and books line; Post confirms then calls the post', async () => {
    postAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    expect(screen.getByText('Rent Sept')).toBeTruthy();
    expect(screen.getByText('Rent September')).toBeTruthy();
    expect(screen.getByText('Posts when posted').parentElement!.textContent).toMatch(/Dr 900-A001 RENTAL, 900-A002 SERVICE FEE · Cr the supplier’s control · RM 4,200\.00/);
    expect(screen.getByText('Post the bill before paying it.')).toBeTruthy();
    fireEvent.click(screen.getByText('Post'));
    await waitFor(() => expect(postAsync).toHaveBeenCalledWith('api-1'));
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/Post 2990-API-2609-001/);
  });

  test('the supplier filter narrows the list, and Print listing prints exactly what is shown', () => {
    listingAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('Print listing'));
    expect((listingAsync.mock.calls[0]![0] as unknown[]).length).toBe(2);
    expect(listingAsync.mock.calls[0]![1]).toEqual({ showing: 'All kinds · All suppliers · Any status' });
    fireEvent.focus(screen.getByLabelText('Filter by supplier'));
    fireEvent.mouseDown(screen.getByText('400-H004 · HOOKKA INDUSTRIES SDN. BHD.'));
    expect(screen.queryByText('2990-API-2609-001')).toBeNull();
    fireEvent.click(screen.getByText('Print listing'));
    expect((listingAsync.mock.calls[1]![0] as unknown[]).length).toBe(1);
    expect(listingAsync.mock.calls[1]![1]).toEqual({ showing: 'All kinds · 400-H004 · HOOKKA INDUSTRIES SDN. BHD. · Any status' });
  });
});

describe('raising an AP invoice', () => {
  test('supplier, a line on a LEAF account (headers and controls never offered), an amount that reads 420.00 → the create payload', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New AP bill'));
    const d = dialog();
    fireEvent.focus(within(d).getByLabelText('AP invoice supplier'));
    fireEvent.mouseDown(screen.getByText('405-H001 · HOUZS VENTURE HOLDING SDN BHD'));
    fireEvent.change(within(d).getByLabelText('Supplier invoice ref'), { target: { value: 'HVH-1001' } });
    fireEvent.change(within(d).getByLabelText('AP invoice description'), { target: { value: 'Rent October' } });
    fireEvent.change(within(d).getByLabelText('line 1 description'), { target: { value: 'Rent Oct' } });
    const accountBox = within(d).getAllByRole('combobox').find((el) => (el as HTMLInputElement).placeholder.includes('account this line'))!;
    fireEvent.focus(accountBox);
    expect(screen.queryByText(/Operating Expense/)).toBeNull();
    expect(screen.queryByText(/ACCOUNT PAYABLE/)).toBeNull();
    fireEvent.mouseDown(screen.getByText('900-A001 · RENTAL'));
    setAmount('line 1 amount', '420');
    expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('420.00');
    fireEvent.click(within(d).getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync.mock.calls[0]![0]).toMatchObject({
      supplierId: 'sup-h', supplierInvoiceRef: 'HVH-1001', notes: 'Rent October',
      lines: [{ description: 'Rent Oct', debitAccountCode: '900-A001', amountSen: 42_000 }],
    });
  });

  test("the lines are a table in the owner's order; Insert adds a line and lands on its account; Enter on an amount moves down; a line can be removed", () => {
    draw();
    fireEvent.click(screen.getByText('New AP bill'));
    const d = dialog();
    const amountHead = within(d).getByText('Amount (RM)');
    expect([...amountHead.parentElement!.children].map((c) => c.textContent)).toEqual(['Account', 'Description', 'Amount (RM)', 'Event', '']);

    fireEvent.keyDown(within(d).getByLabelText('line 1 amount'), { key: 'Insert' });
    expect(within(d).getByLabelText('line 2 amount')).toBeTruthy();
    const landed = document.activeElement as HTMLElement | null;
    expect(landed?.getAttribute('role')).toBe('combobox');
    expect(landed?.closest('tr')?.getAttribute('data-line')).toBe('2');

    fireEvent.keyDown(within(d).getByLabelText('line 2 amount'), { key: 'Enter' });
    expect(within(d).getByLabelText('line 3 amount')).toBeTruthy();
    expect((document.activeElement as HTMLElement | null)?.closest('tr')?.getAttribute('data-line')).toBe('3');

    fireEvent.click(within(d).getByLabelText('remove line 3'));
    expect(within(d).queryByLabelText('line 3 amount')).toBeNull();
  });
});

describe('the scanned bill (OCR) and its files', () => {
  test("Scan bill pre-fills the supplier, the bill's number, dates and lines with the remembered account; the pages attach after save", async () => {
    createAsync.mockClear(); uploadAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New AP bill'));
    const d = dialog();
    const page = new File(['%PDF'], 'rent.pdf', { type: 'application/pdf' });
    fireEvent.change(within(d).getByLabelText('Scan bill files'), { target: { files: [page] } });
    await waitFor(() => expect(within(d).getByText(/Read — check every figure/)).toBeTruthy());
    expect(extractAsync).toHaveBeenCalledWith([{ files: [{ name: 'rent.pdf', mime: 'application/pdf', dataBase64: 'b64:rent.pdf' }] }]);
    expect((within(d).getByLabelText('Supplier invoice ref') as HTMLInputElement).value).toBe('HVH-0912');
    /* The amount re-dresses from the new line value in a passive effect — a tick after the note. */
    await waitFor(() => expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('4,000.00'));
    expect(within(d).getByText(/Account 900-A001 filled/)).toBeTruthy();
    expect(within(d).getByText(/1 scanned file\(s\) will be attached/)).toBeTruthy();

    fireEvent.click(within(d).getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync.mock.calls[0]![0]).toMatchObject({
      supplierId: 'sup-h', supplierInvoiceRef: 'HVH-0912', invoiceDate: '2026-09-01', dueDate: '2026-09-30',
      /* What the reader fills is upper case (owner 2026-09-08: 帮我 fill data 时默认全部大写). */
      lines: [{ description: 'RENT SEPT', debitAccountCode: '900-A001', amountSen: 400_000 }],
    });
    await waitFor(() => expect(uploadAsync).toHaveBeenCalledWith({ invoiceId: 'api-2', file: { name: 'rent.pdf', mime: 'application/pdf', dataBase64: 'b64:rent.pdf' } }));
  });

  /* 拖进来 upload (owner 2026-09-08): a bill dropped on the scan row reads like a picked one. */
  test('a bill dropped onto the New form is read like a picked one', async () => {
    extractAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New AP bill'));
    const zone = within(dialog()).getByLabelText('Drop the bill here');
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['%PDF'], 'drop.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(extractAsync).toHaveBeenCalledWith([{ files: [{ name: 'drop.pdf', mime: 'application/pdf', dataBase64: 'b64:drop.pdf' }] }]));
  });
});

/* The pile for AP invoices (owner 2026-09-08: 我可能同时 upload 多张 supplier 给的
   invoice, 所以要分出来一张一张): "Scan bills" beside New opens the pile page,
   and a bill handed back opens the New form pre-filled, upper case, its pages
   waiting to attach. */
describe('the bill pile hands one bill over as one AP invoice', () => {
  test('Scan bills sits beside New AP bill and opens the pile page', () => {
    const view = render(
      <MemoryRouter initialEntries={['/scm/ap-invoices']}>
        <Routes>
          <Route path="/scm/ap-invoices" element={<ApInvoices />} />
          <Route path="/scm/ap-invoices/scan" element={<div>PILE PAGE</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Scan bills'));
    expect(screen.getByText('PILE PAGE')).toBeTruthy();
    view.unmount();
  });

  test('a bill handed over from the pile opens the New form pre-filled, in upper case, with its pages waiting to attach', async () => {
    createAsync.mockClear(); uploadAsync.mockClear();
    stashPvFiles([{ name: 'rent.pdf', mime: 'application/pdf', dataBase64: 'b64:rent.pdf' }]);
    render(
      <MemoryRouter initialEntries={[{ pathname: '/scm/ap-invoices', state: { apPrefill: {
        extraction: {
          vendorName: 'HOUZS VENTURE HOLDING SDN. BHD.', vendorRegNo: null, documentKind: 'invoice', invoiceNumber: 'hvh-0913',
          invoiceDate: '2026-09-02', dueDate: null, currency: 'MYR', totalSen: 150_000, sstSen: null,
          lines: [{ description: 'Rent Oct', amountSen: 150_000 }],
        },
        supplierMatch: { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD', confidence: 'contains' },
        memory: { payeeName: 'HOUZS VENTURE HOLDING SDN BHD', debitAccountCode: '900-A001', purpose: 'SUPPLIER_PAYMENT', timesSeen: 2 },
      } } }]}><ApInvoices /></MemoryRouter>,
    );
    const d = dialog();
    expect(within(d).getByText(/Read — check every figure/)).toBeTruthy();
    expect((within(d).getByLabelText('Supplier invoice ref') as HTMLInputElement).value).toBe('HVH-0913');
    expect((within(d).getByLabelText('line 1 description') as HTMLInputElement).value).toBe('RENT OCT');
    expect(within(d).getByText(/1 scanned file\(s\) will be attached/)).toBeTruthy();
    fireEvent.click(within(d).getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync.mock.calls[0]![0]).toMatchObject({
      supplierId: 'sup-h', supplierInvoiceRef: 'HVH-0913', invoiceDate: '2026-09-02',
      lines: [{ description: 'RENT OCT', debitAccountCode: '900-A001', amountSen: 150_000 }],
    });
    await waitFor(() => expect(uploadAsync).toHaveBeenCalledWith({ invoiceId: 'api-2', file: { name: 'rent.pdf', mime: 'application/pdf', dataBase64: 'b64:rent.pdf' } }));
  });

  test('the Files card on the bill page: a draft or posted-unpaid bill may lose a file (HC-0181); a paid one, or one the server says a checked voucher holds, keeps its files but still takes one', () => {
    detailStatus = 'DRAFT';
    const first = draw('/scm/ap-invoices/api-1');
    expect(screen.getByText('rent.pdf')).toBeTruthy();
    expect(screen.getByLabelText('Remove rent.pdf')).toBeTruthy();
    expect(screen.getByLabelText('Attach bill files')).toBeTruthy();
    first.unmount();

    detailStatus = 'POSTED';
    const second = draw('/scm/ap-invoices/api-1');
    expect(screen.getByLabelText('Remove rent.pdf')).toBeTruthy();
    expect(screen.queryByText(/locked with the AP Payment/)).toBeNull();
    second.unmount();

    detailPaidSen = 100_000;
    const third = draw('/scm/ap-invoices/api-1');
    expect(screen.queryByLabelText('Remove rent.pdf')).toBeNull();
    expect(screen.getByLabelText('Attach bill files')).toBeTruthy();
    expect(screen.getByText(/locked with the AP Payment that holds this bill/)).toBeTruthy();
    third.unmount();

    detailPaidSen = 0;
    filesLocked = true;
    draw('/scm/ap-invoices/api-1');
    expect(screen.queryByLabelText('Remove rent.pdf')).toBeNull();
    filesLocked = undefined;
    detailStatus = 'DRAFT';
  });
});

describe('editing and copying a bill (round 3)', () => {
  test('Edit opens the form filled from the bill and saving sends the PATCH; a posted bill says it will re-post', async () => {
    updateAsync.mockClear();
    detailStatus = 'DRAFT';
    const first = draw('/scm/ap-invoices/api-1');
    fireEvent.click(screen.getByText('Edit'));
    const form = dialog();
    expect((within(form).getByLabelText('Supplier invoice ref') as HTMLInputElement).value).toBe('HVH-0912');
    expect((within(form).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('4,000.00');
    fireEvent.change(within(form).getByLabelText('AP invoice description'), { target: { value: 'Rent Sept revised' } });
    fireEvent.click(within(form).getByText('Save changes'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalled());
    expect(updateAsync.mock.calls[0]![0]).toMatchObject({
      id: 'api-1',
      body: { supplierId: 'sup-h', supplierInvoiceRef: 'HVH-0912', invoiceDate: '2026-09-01', notes: 'Rent Sept revised',
        lines: [{ description: 'Rent Sept', debitAccountCode: '900-A001', amountSen: 400_000 }, { debitAccountCode: '900-A002', amountSen: 20_000 }] },
    });
    first.unmount();

    detailStatus = 'POSTED';
    draw('/scm/ap-invoices/api-1');
    fireEvent.click(screen.getByText('Edit'));
    const posted = dialog();
    expect(within(posted).getByText(/saving re-posts it/)).toBeTruthy();
    expect(within(posted).getByText('Save & re-post')).toBeTruthy();
    detailStatus = 'DRAFT';
  });

  test("Copy opens the form with the bill's supplier, description and lines, no supplier number and today's date; saving raises a new bill", async () => {
    createAsync.mockClear();
    draw('/scm/ap-invoices/api-1');
    fireEvent.click(screen.getByText('Copy'));
    const form = dialog();
    expect((within(form).getByLabelText('Supplier invoice ref') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('AP invoice description') as HTMLInputElement).value).toBe('Rent September');
    expect((within(form).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('4,000.00');
    expect((within(form).getByLabelText('line 2 amount') as HTMLInputElement).value).toBe('200.00');
    fireEvent.click(within(form).getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    const body = createAsync.mock.calls[0]![0] as { supplierId: string; supplierInvoiceRef?: string; notes?: string; lines: unknown[] };
    expect(body.supplierId).toBe('sup-h');
    expect(body.supplierInvoiceRef).toBeUndefined();
    expect(body.notes).toBe('Rent September');
    expect(body.lines).toHaveLength(2);
  });
});

describe('the event each line is for (owner 2026-09-30, 5a — the header a default)', () => {
  test('the header event sets every line and rides the create payload; the event column sits after the amount', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New AP bill'));
    const d = dialog();
    fireEvent.focus(within(d).getByLabelText('AP invoice supplier'));
    fireEvent.mouseDown(screen.getByText('405-H001 · HOUZS VENTURE HOLDING SDN BHD'));
    const accountBox = within(d).getAllByRole('combobox').find((el) => (el as HTMLInputElement).placeholder.includes('account this line'))!;
    fireEvent.focus(accountBox);
    fireEvent.mouseDown(screen.getByText('900-A001 · RENTAL'));
    setAmount('line 1 amount', '800');
    fireEvent.focus(within(d).getByLabelText('Event for all lines'));
    fireEvent.mouseDown(screen.getByText(/MLE @ PWCC/));
    expect((within(d).getByLabelText('line 1 event') as HTMLInputElement).value).toBe('Pulau Pinang [AKEMI] MLE @ PWCC · 09/25 - 09/27 · booth F1');
    fireEvent.click(within(d).getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect((createAsync.mock.calls[0]![0] as { lines: unknown }).lines).toEqual([{ debitAccountCode: '900-A001', amountSen: 80_000, projectId: 348 }]);
  });
});

describe('the event a scanned bill names (owner 2026-09-30, 6a — suggest, never bind)', () => {
  test('the pile hands over the suggestions; nothing is set until Use, which puts the event on every line', async () => {
    createAsync.mockClear();
    stashPvFiles([]);
    render(
      <MemoryRouter initialEntries={[{ pathname: '/scm/ap-invoices', state: { apPrefill: {
        extraction: {
          vendorName: 'MLE EVENTS SDN BHD', vendorRegNo: null, documentKind: 'invoice', invoiceNumber: 'MLE-0925',
          invoiceDate: '2026-09-02', dueDate: null, currency: 'MYR', totalSen: 850_000, sstSen: null,
          lines: [{ description: 'Booth F1 rental', amountSen: 850_000 }],
          event: { name: 'MLE Home Expo', venue: 'PWCC', booth: 'F1', dateFrom: '2026-09-25', dateTo: '2026-09-27' },
        },
        supplierMatch: { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD', confidence: 'contains' },
        memory: { payeeName: null, debitAccountCode: '900-A001', purpose: 'SUPPLIER_PAYMENT', timesSeen: 1 },
        eventSuggestions: [{ id: 348, score: 120, reasons: ['booth F1', 'same days', 'organiser MLE'], event: EVENT_OPTIONS[1] }],
      } } }]}><ApInvoices /></MemoryRouter>,
    );
    const d = dialog();
    const note = within(d).getByRole('note', { name: 'Events the bill names' });
    expect(note.textContent).toContain('booth F1 · same days · organiser MLE');
    expect((within(d).getByLabelText('line 1 event') as HTMLInputElement).value).toBe('— No event —');
    fireEvent.click(within(note).getByLabelText('Use Pulau Pinang [AKEMI] MLE @ PWCC'));
    expect((within(d).getByLabelText('line 1 event') as HTMLInputElement).value).toMatch(/MLE @ PWCC/);
    expect(within(note).getByText('✓ in use')).toBeTruthy();
    fireEvent.click(within(d).getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect((createAsync.mock.calls[0]![0] as { lines: unknown }).lines).toEqual([expect.objectContaining({ amountSen: 850_000, projectId: 348 })]);
  });
});

describe('a payment request answered by a bill (?fromRequest=, owner 2026-09-30 6.1–6.2)', () => {
  test('its bill is read first; what was asked is overlaid, every line on its event; a total that differs is said; the save names the request', async () => {
    createAsync.mockClear(); extractRequestAsync.mockClear();
    requestDetail = {
      id: 'prq-1', request_no: 'HC-PRQ-2609-001', requested_by_name: 'James Seow', payee_name: 'MLE EVENTS SDN BHD',
      amount_sen: 850_000, purpose: 'Booth F1 rental', due_date: '2026-09-15', project_id: 348, status: 'SUBMITTED', stage: 'SUBMITTED', voucher: null,
    };
    try {
      render(<MemoryRouter initialEntries={['/scm/ap-invoices?fromRequest=prq-1']}><ApInvoices /></MemoryRouter>);
      const d = await screen.findByRole('dialog');
      expect(extractRequestAsync).toHaveBeenCalledWith('prq-1');
      expect(d.textContent).toContain('Answering HC-PRQ-2609-001 from James Seow — its bill is copied onto this invoice when you save.');
      expect(d.textContent).toContain('The bill reads RM 8,000.00 but James Seow asked for RM 8,500.00 — check which is right.');
      expect((within(d).getByLabelText('AP invoice description') as HTMLInputElement).value).toBe('Payment request HC-PRQ-2609-001 — Booth F1 rental');
      expect((within(d).getByLabelText('line 1 event') as HTMLInputElement).value).toMatch(/MLE @ PWCC/);
      fireEvent.click(within(d).getByText('Save as draft'));
      await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
      expect(createAsync.mock.calls[0]![0]).toEqual({
        supplierId: 'sup-h', supplierInvoiceRef: 'HVH-0930', invoiceDate: '2026-09-10', dueDate: '2026-09-15',
        notes: 'Payment request HC-PRQ-2609-001 — Booth F1 rental',
        lines: [{ description: 'BOOTH F1 RENTAL 50%', debitAccountCode: '900-A001', amountSen: 800_000, projectId: 348 }],
        paymentRequestId: 'prq-1',
        /* One key per opened form (fix/failed-save-looks-ok). */
        idempotencyKey: expect.any(String),
      });
    } finally {
      requestDetail = undefined;
    }
  });

  test('?open= lands on the bill\'s own page — the request\'s link to its invoice', () => {
    draw('/scm/ap-invoices?open=api-1');
    expect(screen.getByText('Rent Sept')).toBeTruthy();
  });
});

/* 提醒也加 (owner 2026-10-05): a bill whose printed number and date already sit
   on another request, voucher or AP invoice is said under the bill's own
   fields — a warning, never a block; an edited bill never finds itself. */
describe('the same bill already entered', () => {
  test('a pile bill already on the books is said under its number and date, and the save still goes', async () => {
    createAsync.mockClear();
    sameBill = { 'HVH-0913|2026-09-02': [{ kind: 'API', id: 'api-9', number: '2990-API-2609-009', amountSen: 150_000, status: 'POSTED', answeredBy: null }] };
    try {
      render(
        <MemoryRouter initialEntries={[{ pathname: '/scm/ap-invoices', state: { apPrefill: {
          extraction: {
            vendorName: 'HOUZS VENTURE HOLDING SDN. BHD.', vendorRegNo: null, documentKind: 'invoice', invoiceNumber: 'hvh-0913',
            invoiceDate: '2026-09-02', dueDate: null, currency: 'MYR', totalSen: 150_000, sstSen: null,
            lines: [{ description: 'Rent Oct', amountSen: 150_000 }],
          },
          supplierMatch: { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD', confidence: 'contains' },
          memory: { payeeName: 'HOUZS VENTURE HOLDING SDN BHD', debitAccountCode: '900-A001', purpose: 'SUPPLIER_PAYMENT', timesSeen: 2 },
        } } }]}><ApInvoices /></MemoryRouter>,
      );
      const d = dialog();
      const note = within(d).getByRole('alert', { name: 'Same bill elsewhere' });
      expect(note.textContent).toContain('这张单已经有了');
      expect(note.textContent).toContain('AP invoice 2990-API-2609-009 · RM 1,500.00 · posted');
      /* Only a warning: the bill still saves. */
      fireEvent.click(within(d).getByText('Save as draft'));
      await waitFor(() => expect(createAsync).toHaveBeenCalled());
    } finally {
      sameBill = {};
    }
  });

  test('a bill with nothing else under its number shows no warning; an edited bill asks without itself', () => {
    detailStatus = 'DRAFT';
    billMatchAsks.length = 0;
    draw('/scm/ap-invoices/api-1');
    fireEvent.click(screen.getByText('Edit'));
    const form = dialog();
    expect(within(form).queryByRole('alert', { name: 'Same bill elsewhere' })).toBeNull();
    expect(billMatchAsks.at(-1)).toEqual(['HVH-0912', '2026-09-01', null, 'api-1']);
  });
});

/* Supplier debit notes (owner 2026-10-28: Supplier & Other Creditor CN / DN — 再加 supplier DN):
   this page narrowed to them, shown inside the CN / DN page's Debit notes tab. */
describe('the supplier debit notes', () => {
  test('docKind="DN" asks for the debit notes alone, has no page header, and New debit note raises one as a DN', async () => {
    createAsync.mockClear();
    render(<MemoryRouter><ApInvoices docKind="DN" /></MemoryRouter>);
    expect(lastApList.value).toBe('API|DN');
    expect(screen.queryByText('New AP bill')).toBeNull();
    expect(screen.getByText('Supplier debit notes — we owe the supplier more')).toBeTruthy();
    fireEvent.click(screen.getByText('New debit note'));
    const d = dialog();
    expect(within(d).getAllByText(/New supplier debit note/).length).toBeGreaterThan(0);
    fireEvent.focus(within(d).getByLabelText('AP invoice supplier'));
    fireEvent.mouseDown(screen.getByText('405-H001 · HOUZS VENTURE HOLDING SDN BHD'));
    fireEvent.change(within(d).getByLabelText('Supplier invoice ref'), { target: { value: 'DN-HVH-77' } });
    const accountBox = within(d).getAllByRole('combobox').find((el) => (el as HTMLInputElement).placeholder.includes('account this line'))!;
    fireEvent.focus(accountBox);
    fireEvent.mouseDown(screen.getByText('900-A001 · RENTAL'));
    setAmount('line 1 amount', '300');
    fireEvent.click(within(d).getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync.mock.calls[0]![0]).toMatchObject({ docKind: 'DN', supplierId: 'sup-h', supplierInvoiceRef: 'DN-HVH-77', lines: [{ debitAccountCode: '900-A001', amountSen: 30_000 }] });
  });

  test('the AP Invoices page itself still asks for every kind', () => {
    draw();
    expect(lastApList.value).toBe('ALL|');
  });
});

/* Money out › Supplier bills in the owner's Claude Design (batch 4, step 5). */
describe('Supplier bills — the redesign', () => {
  const SCN = {
    id: 'scn-1', note_number: '2990-SCN-2610-001', kind: 'SCN', party_type: 'SUPPLIER', party_code: '400-H004', party_name: 'HOOKKA INDUSTRIES SDN. BHD.',
    supplier_id: 'sup-t', debtor_id: null, so_doc_no: null, sales_invoice_id: null, ap_invoice_id: null, purchase_invoice_id: null, source_doc_no: 'CN-77',
    note_date: '2026-10-05', total_sen: 50_000, reason: 'Short delivery', notes: null, status: 'POSTED', je_no: '2990-JE-2610-0100',
    created_at: '2026-10-05T01:00:00Z', created_by: null, posted_at: '2026-10-05T01:00:00Z', cancelled_at: null,
    appliedSen: 10_000, unusedSen: 40_000, controlRole: 'AP',
  };
  const tr = (text: string) => screen.getByText(text).closest('tr')!;

  test('a supplier credit note sits under Credit notes with To use; no Overdue there; open rows wear the sand', () => {
    notes = [SCN];
    try {
      draw();
      expect(screen.getByRole('tab', { name: /Credit notes/ }).textContent).toBe('Credit notes 1');
      /* The posted purchase invoice still owes: sand. The draft bill does not. */
      expect(tr('2990-PI-2607-005').style.backgroundColor).toBe('rgb(252, 247, 236)');
      expect(tr('2990-API-2609-001').style.backgroundColor).toBe('');
      fireEvent.click(screen.getByRole('tab', { name: /Credit notes/ }));
      expect(screen.queryByText('2990-PI-2607-005')).toBeNull();
      expect(within(tr('2990-SCN-2610-001')).getByText('To use')).toBeTruthy();
      const chips = within(screen.getByRole('group', { name: 'Status' }));
      expect(chips.getByText('To use').textContent).toBe('To use 1');
      expect(chips.queryByText('Overdue')).toBeNull();
      /* Its next step opens the note's own page, where the knock-off lives. */
      fireEvent.click(within(tr('2990-SCN-2610-001')).getByText('Knock off'));
      expect(screen.getByText('NOTE PAGE')).toBeTruthy();
    } finally { notes = []; }
  });

  test('Unpaid and Overdue read what is owed and the due date; Make voucher opens New AP payment on the bill; a held invoice refuses', () => {
    const view = render(
      <MemoryRouter initialEntries={['/scm/ap-invoices']}>
        <Routes>
          <Route path="/scm/ap-invoices" element={<ApInvoices />} />
          <Route path="/scm/payment-vouchers/new" element={<div>NEW AP PAYMENT</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const chips = within(screen.getByRole('group', { name: 'Status' }));
    expect(chips.getByText('Unpaid').textContent).toBe('Unpaid 1');
    expect(chips.getByText('Overdue').textContent).toBe('Overdue 1');
    expect(chips.getByText('Draft').textContent).toBe('Draft 1');
    expect(within(tr('2990-PI-2607-005')).getByText(/^Partly paid$/)).toBeTruthy();
    fireEvent.click(within(tr('2990-PI-2607-005')).getByText('Make voucher'));
    expect(screen.getByText('NEW AP PAYMENT')).toBeTruthy();
    view.unmount();

    apRowsNow = [{ ...ROWS[1]!, held: true, holdReason: 'Short delivery' }];
    try {
      draw();
      const make = within(tr('2990-PI-2607-005')).getByText('Make voucher') as HTMLButtonElement;
      expect(make.disabled).toBe(true);
      expect(make.title).toMatch(/On hold · Short delivery/);
      expect(within(tr('2990-PI-2607-005')).getByText('On hold')).toBeTruthy();
    } finally { apRowsNow = ROWS; }
  });

  test('the ⋯ menu offers what the row may do; Post on a draft confirms, then posts', async () => {
    postAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('2990-API-2609-001 menu'));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Open', 'Edit', 'Post', 'Print', 'Print + files', 'Copy as new', 'Cancel bill…']);
    fireEvent.click(within(menu).getByText('Post'));
    await waitFor(() => expect(postAsync).toHaveBeenCalledWith('api-1'));
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/Post 2990-API-2609-001/);
    /* A purchase invoice is Procurement's: open it, plan when we pay it (step 7), print it — it keeps no files here (step 8). */
    fireEvent.click(screen.getByLabelText('2990-PI-2607-005 menu'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Open', 'Plan date', 'Print']);
  });

  test('Plan date sets when we will pay a bill; the Planned column shows it (step 7)', async () => {
    planAsync.mockClear();
    apRowsNow = [ROWS[0]!, { ...ROWS[1]!, plannedOn: '2026-11-20' }];
    try {
      draw();
      expect(within(tr('2990-PI-2607-005')).getByText('2026/11/20')).toBeTruthy();
      fireEvent.click(screen.getByLabelText('2990-PI-2607-005 menu'));
      fireEvent.click(within(screen.getByRole('menu')).getByText('Plan date'));
      const d = dialog();
      expect(d.textContent).toContain('Plan the payment of 2990-PI-2607-005 · HOOKKA INDUSTRIES SDN. BHD. · RM 2,000.00');
      const box = within(d).getByLabelText('Planned payment date');
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: '20991215' } });
      fireEvent.click(within(d).getByText('Save planned date'));
      await waitFor(() => expect(planAsync).toHaveBeenCalledWith({ kind: 'PI', id: 'pi-1', plannedOn: '2099-12-15' }));
    } finally { apRowsNow = ROWS; }
  });

  test('Trade / Other narrows by control; the search finds an amount; ticks add up in the bar', () => {
    draw();
    fireEvent.focus(screen.getByLabelText('Filter by supplier'));
    fireEvent.mouseDown(screen.getByText('All other creditors · 405'));
    expect(screen.queryByText('2990-PI-2607-005')).toBeNull();
    expect(screen.getByText('2990-API-2609-001')).toBeTruthy();
    fireEvent.focus(screen.getByLabelText('Filter by supplier'));
    fireEvent.mouseDown(screen.getByText('All suppliers'));
    fireEvent.change(screen.getByLabelText('Find a bill'), { target: { value: '2,000' } });
    expect(screen.queryByText('2990-API-2609-001')).toBeNull();
    expect(screen.getByText('2990-PI-2607-005')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Find a bill'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Tick 2990-API-2609-001'));
    fireEvent.click(screen.getByLabelText('Tick 2990-PI-2607-005'));
    const bar = screen.getByLabelText('Ticked bills');
    expect(bar.textContent).toContain('2 ticked');
    expect(bar.textContent).toContain('7,200.00');
    fireEvent.click(within(bar).getByText('Clear'));
    expect(screen.queryByLabelText('Ticked bills')).toBeNull();
  });
});

/* The bill as its own page, and Save & post (the redesign, batch 4 step 6). */
describe('the bill page and Save & post', () => {
  test('a part-paid bill lists what paid it, offers Make voucher for the rest, and reads its trail', () => {
    detailStatus = 'PARTIALLY_PAID'; detailPaidSen = 100_000;
    detailPayments = [{ kind: 'PV', id: 'pv-1', number: '2990-PV-2609-004', date: '2026-09-20', stage: 'Approved', amountSen: 100_000, fromAdvance: false }];
    try {
      render(
        <MemoryRouter initialEntries={['/scm/ap-invoices/api-1']}>
          <Routes>
            <Route path="/scm/ap-invoices/:id" element={<ApBillPage />} />
            <Route path="/scm/payment-vouchers/new" element={<div>NEW AP PAYMENT</div>} />
          </Routes>
        </MemoryRouter>,
      );
      expect(screen.getByText('2990-PV-2609-004').closest('a')!.getAttribute('href')).toBe('/scm/payment-vouchers/pv-1');
      expect(screen.getByText('Partly paid')).toBeTruthy();
      expect(screen.getByText('Posted').parentElement!.textContent).toMatch(/^Posted · Dr /);
      /* No cancel once money is on it; the rest is paid from a new voucher. */
      expect(screen.queryByText('Cancel…')).toBeNull();
      fireEvent.click(screen.getByText('Make voucher'));
      expect(screen.getByText('NEW AP PAYMENT')).toBeTruthy();
    } finally { detailStatus = 'DRAFT'; detailPaidSen = 0; detailPayments = []; }
  });

  test('Save & post asks first, raises the bill, then posts it and opens it', async () => {
    createAsync.mockClear(); postAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByText('New AP bill'));
    const d = dialog();
    fireEvent.focus(within(d).getByLabelText('AP invoice supplier'));
    fireEvent.mouseDown(screen.getByText('405-H001 · HOUZS VENTURE HOLDING SDN BHD'));
    const accountBox = within(d).getAllByRole('combobox').find((el) => (el as HTMLInputElement).placeholder.includes('account this line'))!;
    fireEvent.focus(accountBox);
    fireEvent.mouseDown(screen.getByText('900-A001 · RENTAL'));
    setAmount('line 1 amount', '420');
    fireEvent.click(within(d).getByText('Save & post'));
    await waitFor(() => expect(postAsync).toHaveBeenCalledWith('api-2'));
    expect(createAsync).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(confirmFn.mock.calls.at(-1)![0])).toMatch(/Save and post this bill/);
  });
});

/* Supplier bills on paper (the redesign, batch 4 step 8). */
describe('printing supplier bills', () => {
  const API_DOC = { kind: 'API', id: 'api-1', number: '2990-API-2609-001' };
  const PI_DOC = { kind: 'PI', id: 'pi-1', number: '2990-PI-2607-005' };

  test('the ticks print as one document in list order — With files on by default — and Save as PDF keeps it', async () => {
    printBills.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Tick 2990-PI-2607-005'));
    fireEvent.click(screen.getByLabelText('Tick 2990-API-2609-001'));
    const bar = screen.getByLabelText('Ticked bills');
    expect((within(bar).getByLabelText("Include each document's attached files") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(bar).getByText('Print 2 + files'));
    await waitFor(() => expect(printBills).toHaveBeenCalledTimes(1));
    /* The list's order (newest first), not the order ticked. */
    expect(printBills.mock.calls[0]).toEqual([[API_DOC, PI_DOC], { withFiles: true, action: 'print' }]);
    fireEvent.click(within(bar).getByLabelText("Include each document's attached files"));
    expect(within(bar).getByText('Print 2')).toBeTruthy();
    fireEvent.click(within(bar).getByText('Save as PDF'));
    await waitFor(() => expect(printBills).toHaveBeenCalledTimes(2));
    expect(printBills.mock.calls[1]).toEqual([[API_DOC, PI_DOC], { withFiles: false, action: 'save' }]);
  });

  test('a ticked row a filter hides is left out of the print, and the bar says so', async () => {
    printBills.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Tick 2990-PI-2607-005'));
    fireEvent.click(screen.getByLabelText('Tick 2990-API-2609-001'));
    fireEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByText('Draft'));
    const bar = screen.getByLabelText('Ticked bills');
    expect(bar.textContent).toContain('1 hidden by a filter, left out');
    fireEvent.click(within(bar).getByText('Print 1 + files'));
    await waitFor(() => expect(printBills).toHaveBeenCalledWith([API_DOC], { withFiles: true, action: 'print' }));
  });

  test('⋯ prints one paper in place — alone, or with its files', async () => {
    printBills.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('2990-API-2609-001 menu'));
    fireEvent.click(within(screen.getByRole('menu')).getByText('Print + files'));
    await waitFor(() => expect(printBills).toHaveBeenCalledWith([API_DOC], { withFiles: true, action: 'print' }));
    fireEvent.click(screen.getByLabelText('2990-PI-2607-005 menu'));
    fireEvent.click(within(screen.getByRole('menu')).getByText('Print'));
    await waitFor(() => expect(printBills).toHaveBeenCalledWith([PI_DOC], { withFiles: false, action: 'print' }));
  });

  test('a paid bill has no next step, so its row offers Print', async () => {
    printBills.mockClear();
    apRowsNow = [ROWS[0]!, { ...ROWS[1]!, status: 'PAID', paidSen: 300_000, outstandingSen: 0 }];
    try {
      draw();
      const row = screen.getByText('2990-PI-2607-005').closest('tr')!;
      expect(within(row).queryByText('Make voucher')).toBeNull();
      fireEvent.click(within(row).getByText('Print'));
      await waitFor(() => expect(printBills).toHaveBeenCalledWith([PI_DOC], { withFiles: false, action: 'print' }));
      /* A draft's next step is Post — no Print link beside it. */
      expect(within(screen.getByText('2990-API-2609-001').closest('tr')!).queryByText('Print')).toBeNull();
    } finally { apRowsNow = ROWS; }
  });

  test('the bill page prints through its preview: its files after it unless unticked', async () => {
    printBills.mockClear();
    draw('/scm/ap-invoices/api-1');
    fireEvent.click(screen.getByText('Print'));
    const preview = screen.getByRole('dialog', { name: 'Print preview' });
    const files = within(preview).getByLabelText('Include attached files in the print') as HTMLInputElement;
    expect(files.checked).toBe(true);
    expect(preview.textContent).toContain('include the 1 attached file(s) after the bill page');
    fireEvent.click(within(preview).getByText('Print now'));
    await waitFor(() => expect(printBills).toHaveBeenCalledWith([API_DOC], { withFiles: true, action: 'print' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Print preview' })).toBeNull());

    fireEvent.click(screen.getByText('Print'));
    const again = screen.getByRole('dialog', { name: 'Print preview' });
    fireEvent.click(within(again).getByLabelText('Include attached files in the print'));
    fireEvent.click(within(again).getByText('Download PDF'));
    await waitFor(() => expect(printBills).toHaveBeenCalledWith([API_DOC], { withFiles: false, action: 'save' }));
  });
});
