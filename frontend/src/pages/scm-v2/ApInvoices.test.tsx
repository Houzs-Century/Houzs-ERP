/* AP Invoices — the Finance list shows BOTH kinds (owner 2026-09-06: 我想要
   两个都看到, 现有的 purchase invoice remain): purchase invoices as a
   read-only mirror linking to their own page, AP invoices raised here.
   Round 2: the list filters by supplier and prints what it shows, the bill
   carries an overall description. Round 3: a bill opens in a pop-out over
   the list; every field can be edited (a posted bill re-posts); a bill can
   be copied; the form's lines are a table in the owner's order with Insert
   adding a line and landing on it, amounts reading 1,800.00; the form scans
   a bill and attaches its pages after save. The server half is
   backend/tests/apInvoices.test.ts + apInvoiceEdit.test.ts. */

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

const ROWS = [
  { kind: 'API', id: 'api-1', invoiceNumber: '2990-API-2609-001', supplierId: 'sup-h', supplierCode: '405-H001', supplierName: 'HOUZS VENTURE HOLDING SDN BHD', supplierInvoiceRef: 'HVH-0912', description: 'Rent September', invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'MYR', totalSen: 420_000, paidSen: 0, outstandingSen: 420_000, status: 'DRAFT' },
  { kind: 'PI', id: 'pi-1', invoiceNumber: '2990-PI-2607-005', supplierId: 'sup-t', supplierCode: '400-H004', supplierName: 'HOOKKA INDUSTRIES SDN. BHD.', supplierInvoiceRef: null, description: null, invoiceDate: '2026-06-27', dueDate: '2026-07-27', currency: 'MYR', totalSen: 300_000, paidSen: 100_000, outstandingSen: 200_000, status: 'PARTIALLY_PAID' },
];

vi.mock('../../vendor/scm/lib/ap-invoice-queries', () => ({
  useApInvoices: () => ({ data: { rows: ROWS }, isLoading: false, isError: false, error: null }),
  useApInvoiceDetail: (id: string | null) => ({ data: id ? {
    invoice: { id: 'api-1', invoice_number: '2990-API-2609-001', supplier_id: 'sup-h', supplier_invoice_ref: 'HVH-0912', invoice_date: '2026-09-01', due_date: null, currency: 'MYR', total_sen: 420_000, paid_sen: 0, status: detailStatus, notes: 'Rent September', posted_at: null, posted_by: null },
    lines: [{ id: 'l1', line_no: 1, description: 'Rent Sept', debit_account_code: '900-A001', amount_sen: 400_000 }, { id: 'l2', line_no: 2, description: null, debit_account_code: '900-A002', amount_sen: 20_000 }],
    supplier: { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' },
  } : undefined, isLoading: false }),
  useCreateApInvoice: () => ({ mutateAsync: createAsync, isPending: false }),
  useUpdateApInvoice: () => ({ mutateAsync: updateAsync, isPending: false }),
  usePostApInvoice: () => ({ mutateAsync: postAsync, isPending: false }),
  useCancelApInvoice: () => ({ mutateAsync: cancelAsync, isPending: false }),
  useApInvoiceFiles: (id: string | null) => ({ data: id ? { files: [{ id: 'f1', file_name: 'rent.pdf', mime: 'application/pdf', size_bytes: 120_000, sort_no: 1, created_at: '2026-09-06T02:00:00Z' }] } : undefined, isLoading: false }),
  useUploadApInvoiceFile: () => ({ mutateAsync: uploadAsync, isPending: false }),
  useDeleteApInvoiceFile: () => ({ mutateAsync: deleteAsync, isPending: false }),
  fetchApInvoiceFileBlobUrl: vi.fn(),
}));
vi.mock('../../vendor/scm/lib/payment-request-queries', () => ({
  usePaymentRequest: (id: string | null) => ({ data: id && requestDetail ? { request: requestDetail, finance: true } : undefined, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  useExtractBills: () => ({ mutateAsync: extractAsync, isPending: false }),
  useExtractRequestBill: () => ({ mutateAsync: extractRequestAsync, isPending: false }),
  fileToBase64: async (f: File) => `b64:${f.name}`,
  PV_FILE_ACCEPT: 'image/jpeg,image/png,image/webp,application/pdf',
}));
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
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));
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

const draw = () => render(<MemoryRouter><ApInvoices /></MemoryRouter>);
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
    expect(screen.getByText('Purchase Invoice')).toBeTruthy();
    expect(screen.getByText('AP Invoice')).toBeTruthy();
    expect(screen.getByText('2990-PI-2607-005').closest('a')!.getAttribute('href')).toBe('/scm/purchase-invoices/pi-1');
    expect(screen.getByText('2990-PI-2607-005').closest('tr')!.textContent).toContain('2,000.00');
    expect(screen.getByText('Rent September')).toBeTruthy();
  });

  test('an AP invoice opens in a pop-out OVER the list with its lines and description; Post confirms then calls the post', async () => {
    postAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    const d = dialog();
    expect(within(d).getByText('Rent Sept')).toBeTruthy();
    expect(within(d).getByText('Rent September')).toBeTruthy();
    /* The list is still there behind it — nothing was pushed in above it. */
    expect(screen.getByText('2990-PI-2607-005')).toBeTruthy();
    fireEvent.click(within(d).getByText('Post'));
    await waitFor(() => expect(postAsync).toHaveBeenCalledWith('api-1'));
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/Post 2990-API-2609-001/);
    fireEvent.click(within(d).getByLabelText('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('the supplier filter narrows the list, and Print listing prints exactly what is shown', () => {
    listingAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('Print listing'));
    expect((listingAsync.mock.calls[0]![0] as unknown[]).length).toBe(2);
    expect(listingAsync.mock.calls[0]![1]).toEqual({ kind: 'ALL', supplierName: null });
    fireEvent.focus(screen.getByLabelText('Filter by supplier'));
    fireEvent.mouseDown(screen.getByText('400-H004 · HOOKKA INDUSTRIES SDN. BHD.'));
    expect(screen.queryByText('2990-API-2609-001')).toBeNull();
    fireEvent.click(screen.getByText('Print listing'));
    expect((listingAsync.mock.calls[1]![0] as unknown[]).length).toBe(1);
    expect(listingAsync.mock.calls[1]![1]).toEqual({ kind: 'ALL', supplierName: 'HOOKKA INDUSTRIES SDN. BHD.' });
  });
});

describe('raising an AP invoice', () => {
  test('supplier, a line on a LEAF account (headers and controls never offered), an amount that reads 420.00 → the create payload', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New AP invoice'));
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
    fireEvent.click(screen.getByText('New AP invoice'));
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
    fireEvent.click(screen.getByText('New AP invoice'));
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
    fireEvent.click(screen.getByText('New AP invoice'));
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
  test('Scan bills sits beside New AP invoice and opens the pile page', () => {
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

  test('the Files card in the pop-out: a draft bill may lose a file; a posted bill keeps its files but still takes one', () => {
    detailStatus = 'DRAFT';
    const first = draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    expect(screen.getByText('rent.pdf')).toBeTruthy();
    expect(screen.getByLabelText('Remove rent.pdf')).toBeTruthy();
    expect(screen.getByLabelText('Attach bill files')).toBeTruthy();
    first.unmount();

    detailStatus = 'POSTED';
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    expect(screen.getByText('rent.pdf')).toBeTruthy();
    expect(screen.queryByLabelText('Remove rent.pdf')).toBeNull();
    expect(screen.getByLabelText('Attach bill files')).toBeTruthy();
    expect(screen.getByText(/locked with the posted bill/)).toBeTruthy();
    detailStatus = 'DRAFT';
  });
});

describe('editing and copying a bill (round 3)', () => {
  test('Edit opens the form filled from the bill and saving sends the PATCH; a posted bill says it will re-post', async () => {
    updateAsync.mockClear();
    detailStatus = 'DRAFT';
    const first = draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    fireEvent.click(screen.getByText('Edit'));
    const form = screen.getAllByRole('dialog')[1]!;
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
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    fireEvent.click(screen.getByText('Edit'));
    const posted = screen.getAllByRole('dialog')[1]!;
    expect(within(posted).getByText(/saving re-posts it/)).toBeTruthy();
    expect(within(posted).getByText('Save & re-post')).toBeTruthy();
    detailStatus = 'DRAFT';
  });

  test("Copy opens the form with the bill's supplier, description and lines, no supplier number and today's date; saving raises a new bill", async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    fireEvent.click(screen.getByText('Copy'));
    const form = screen.getAllByRole('dialog')[1]!;
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
    fireEvent.click(screen.getByText('New AP invoice'));
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
      });
    } finally {
      requestDetail = undefined;
    }
  });

  test('?open= opens a bill\'s detail — the request\'s link to its invoice', () => {
    render(<MemoryRouter initialEntries={['/scm/ap-invoices?open=api-1']}><ApInvoices /></MemoryRouter>);
    expect(within(dialog()).getByText('Rent Sept')).toBeTruthy();
  });
});
