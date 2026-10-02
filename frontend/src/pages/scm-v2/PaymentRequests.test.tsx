/* 申请付款 — the Payment Requests page (owner 2026-09-29/30). Pinned:
     • a requester raises a request — pay to, amount, pay by, the event (from the
       requests' own event list), what for, the payee's bank — and the bill
       attaches after it is sent;
     • the stage reads the owner's words, the voucher number beside it;
     • the requester edits or withdraws their own waiting request; a returned one
       shows Finance's note and goes back with "Fix and send again";
     • Finance sees who asked, makes the voucher (PV New ?fromRequest=) or
       returns the request with a note it must give. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

type Req = Record<string, unknown>;
const base = (over: Req): Req => ({
  id: 'r1', request_no: 'HC-PRQ-2609-001', requested_by: 22, requested_by_name: 'James Seow', payee_name: 'MLE EVENTS SDN BHD',
  amount_sen: 850_000, due_date: '2026-09-15', purpose: 'Booth F1 rental', project_id: 348, bank_name: 'Maybank',
  bank_account_no: '5123', bank_account_name: 'MLE EVENTS SDN BHD', status: 'SUBMITTED', pv_id: null, finance_note: null,
  decided_by: null, decided_at: null, created_at: '2026-09-10T02:00:00Z', updated_at: '2026-09-10T02:00:00Z', stage: 'SUBMITTED', voucher: null,
  ...over,
});
let requests: Req[] = [];
let isFinance = false;
let hasEvents: boolean | undefined;
/* What the bill reader read off the bill being attached (item 1, 2026-10-01). */
const plainRead = (over: Req = {}): Req => ({
  ok: true, bill: { billNo: 'MLE-0925', billDate: '2026-09-01', totalSen: 850_000, vendorName: 'MLE EVENTS SDN BHD' },
  hasEvents: true, eventBill: false, eventSuggestions: [], matches: [], ...over,
});
let readResult: Req = plainRead();
const readAsync = vi.fn(async (_b: Req) => readResult);
/* 申请付余额 (item 2). */
const balanceAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({ id: 'r-bal', installment_no: 2, parent_request_id: 'r1' }), overTotal: false }));
const createAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({ id: 'r-new' }) }));
const updateAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({}) }));
const withdrawAsync = vi.fn(async (_id: string) => ({ ok: true }));
const returnAsync = vi.fn(async (_b: Req) => ({ ok: true }));
const uploadAsync = vi.fn(async (_b: Req) => ({ ok: true }));

/* 欠正式单 (item 3): Finance's marks and the requester's upload — stubbed. */
const markOfficial = vi.fn();
const uploadOfficialAsync = vi.fn(async (_b: unknown) => ({ ok: true, received: [{ kind: 'PV', number: 'HC-PV-2610-001' }], note: null as string | null }));
vi.mock('../../vendor/scm/lib/official-doc-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/official-doc-queries')>()),
  useMarkOfficialDoc: () => ({ mutate: markOfficial, isPending: false }),
  useUploadOfficialDoc: () => ({ mutateAsync: uploadOfficialAsync, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/payment-request-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/payment-request-queries')>()),
  usePaymentRequests: () => ({ data: { requests, finance: isFinance, hasEvents }, isLoading: false, isError: false, error: null }),
  useReadRequestBill: () => ({ mutateAsync: readAsync, isPending: false }),
  useRequestBalance: () => ({ mutateAsync: balanceAsync, isPending: false }),
  usePaymentRequest: (id: string | null) => ({ data: id ? { request: requests.find((r) => r.id === id), finance: isFinance } : undefined, isLoading: false }),
  useCreatePaymentRequest: () => ({ mutateAsync: createAsync, isPending: false }),
  useUpdatePaymentRequest: () => ({ mutateAsync: updateAsync, isPending: false }),
  useWithdrawPaymentRequest: () => ({ mutate: (id: string) => { void withdrawAsync(id); }, isPending: false }),
  useReturnPaymentRequest: () => ({ mutate: (b: Req) => { void returnAsync(b); }, isPending: false }),
  useUploadPaymentRequestFile: () => ({ mutateAsync: uploadAsync, isPending: false }),
  useDeletePaymentRequestFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePaymentRequestFiles: () => ({ data: { files: [] }, isLoading: false }),
  fetchPaymentRequestFileBlobUrl: vi.fn(),
}));
const EVENT_OPTIONS = [
  { id: 348, code: 'E-348', name: 'Pulau Pinang [AKEMI] MLE @ PWCC', startDate: '2026-09-25', endDate: '2026-09-27', status: 'confirmed', archived: false, venue: null, brand: 'AKEMI', organizer: 'MLE', boothNo: 'F1' },
];
const optionPaths: string[] = [];
vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventOptions: (_around: unknown, _enabled: unknown, path: string) => { optionPaths.push(path); return { data: EVENT_OPTIONS, isLoading: false }; },
  useEventLabels: () => ({ data: new Map(EVENT_OPTIONS.map((e) => [e.id, e])) }),
}));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/payment-voucher-queries')>()),
  fileToBase64: async (f: File) => `b64:${f.name}`,
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 22 }, can: () => true }) }));
const confirmFn = vi.fn(async (_o: unknown) => true);
const promptFn = vi.fn(async (_o: unknown) => 'Attach the organiser invoice' as string | null);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn, usePrompt: () => promptFn }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));

import { PaymentRequests } from './PaymentRequests';

const draw = () => render(
  <MemoryRouter initialEntries={['/scm/payment-requests']}>
    <Routes>
      <Route path="/scm/payment-requests" element={<PaymentRequests />} />
      <Route path="/scm/payment-vouchers/new" element={<div>PV New opened</div>} />
      <Route path="/scm/ap-invoices" element={<div>AP Invoices opened</div>} />
    </Routes>
  </MemoryRouter>,
);

describe('the requester', () => {
  test('raises a request with the event and the payee\'s bank; the bill is read, and attaches after it is sent', async () => {
    requests = []; isFinance = false; hasEvents = undefined; readResult = plainRead(); createAsync.mockClear(); uploadAsync.mockClear(); readAsync.mockClear();
    draw();
    expect(screen.getByText(/You have not raised a payment request yet/)).toBeTruthy();
    fireEvent.click(screen.getByText('New request'));
    const d = screen.getByRole('dialog');
    fireEvent.change(within(d).getByLabelText('Pay to'), { target: { value: 'MLE EVENTS SDN BHD' } });
    const amount = within(d).getByLabelText('Amount');
    fireEvent.focus(amount); fireEvent.change(amount, { target: { value: '8500' } }); fireEvent.blur(amount);
    fireEvent.change(within(d).getByLabelText('What is it for'), { target: { value: 'Booth F1 rental' } });
    fireEvent.focus(within(d).getByLabelText('Event'));
    fireEvent.mouseDown(screen.getByText(/MLE @ PWCC/));
    fireEvent.change(within(d).getByLabelText("Payee's bank"), { target: { value: 'Maybank' } });
    fireEvent.change(within(d).getByLabelText('Account no.'), { target: { value: '5123' } });
    const bill = new File(['%PDF'], 'mle-invoice.pdf', { type: 'application/pdf' });
    fireEvent.change(within(d).getByLabelText('Bill files'), { target: { files: [bill] } });
    /* Read as it is attached: number, date and total said back. */
    await waitFor(() => expect(within(d).getByText(/Read from the bill: No\. MLE-0925 · 2026\/09\/01 · total RM 8,500\.00/)).toBeTruthy());
    expect(readAsync).toHaveBeenCalledWith({ files: [{ name: 'mle-invoice.pdf', mime: 'application/pdf', dataBase64: 'b64:mle-invoice.pdf' }] });
    fireEvent.click(within(d).getByText('Send to Finance'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0]![0]).toEqual({
      payeeName: 'MLE EVENTS SDN BHD', amountSen: 850_000, dueDate: null, purpose: 'Booth F1 rental', projectId: 348,
      bankName: 'Maybank', bankAccountNo: '5123', bankAccountName: null,
      billNo: 'MLE-0925', billDate: '2026-09-01', billTotalSen: 850_000, eventBill: false, noEventReason: null, payPct: null,
    });
    await waitFor(() => expect(uploadAsync).toHaveBeenCalledWith({ id: 'r-new', file: { name: 'mle-invoice.pdf', mime: 'application/pdf', dataBase64: 'b64:mle-invoice.pdf' } }));
    /* The requester's picker reads the requests' own event list, not Finance's. */
    expect(optionPaths.every((p) => p === '/payment-requests/event-options')).toBe(true);
  });

  test('the stage reads the owner\'s words with the voucher beside it; a waiting request is theirs to edit or withdraw', async () => {
    requests = [
      base({ id: 'r1' }),
      base({ id: 'r2', request_no: 'HC-PRQ-2609-002', status: 'VOUCHERED', stage: 'PAID', voucher: { id: 'pv-9', pvNumber: 'HC-PV-2609-014', status: 'POSTED', approvedAt: '2026-09-12T03:00:00Z', postedAt: '2026-09-12T03:00:00Z', bankConfirmed: false } }),
    ];
    isFinance = false; withdrawAsync.mockClear();
    draw();
    expect(screen.getByText('Paid · 已付')).toBeTruthy();
    expect(screen.getByText(/HC-PV-2609-014/)).toBeTruthy();
    expect(screen.queryByText('Requested by')).toBeNull();
    fireEvent.click(screen.getByText('HC-PRQ-2609-001'));
    const d = screen.getByRole('dialog');
    expect(within(d).getByText('Edit')).toBeTruthy();
    expect(within(d).queryByText('Make voucher')).toBeNull();
    fireEvent.click(within(d).getByText('Withdraw'));
    await waitFor(() => expect(withdrawAsync).toHaveBeenCalledWith('r1'));
  });

  /* Item 1 (owner 2026-10-01): an event bill goes with its Event — the strongest
     suggestion picked for them — or with the reason there is none. */
  const fillBasics = (d: HTMLElement) => {
    fireEvent.change(within(d).getByLabelText('Pay to'), { target: { value: 'MLE EVENTS SDN BHD' } });
    const amount = within(d).getByLabelText('Amount');
    fireEvent.focus(amount); fireEvent.change(amount, { target: { value: '8500' } }); fireEvent.blur(amount);
    fireEvent.change(within(d).getByLabelText('What is it for'), { target: { value: 'Booth F1 rental' } });
  };
  const attach = (d: HTMLElement) => fireEvent.change(within(d).getByLabelText('Bill files'), { target: { files: [new File(['%PDF'], 'mle.pdf', { type: 'application/pdf' })] } });

  test('an event bill picks the event it points at most strongly; the request carries it', async () => {
    requests = []; isFinance = false; hasEvents = true; createAsync.mockClear();
    readResult = plainRead({ eventBill: true, eventSuggestions: [{ id: 348, score: 70, reasons: ['booth F1', 'same days'], event: EVENT_OPTIONS[0] }] });
    draw();
    fireEvent.click(screen.getByText('New request'));
    const d = screen.getByRole('dialog');
    fillBasics(d);
    attach(d);
    await waitFor(() => expect(within(d).getByText('Event * — this bill is for an event')).toBeTruthy());
    expect(within(d).getByText('✓ in use')).toBeTruthy();
    fireEvent.click(within(d).getByText('Send to Finance'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0]![0]).toMatchObject({ projectId: 348, eventBill: true, noEventReason: null });
  });

  test('an event bill without its event waits for the reason why there is none', async () => {
    requests = []; isFinance = false; hasEvents = true; createAsync.mockClear();
    readResult = plainRead({ eventBill: true, eventSuggestions: [] });
    draw();
    fireEvent.click(screen.getByText('New request'));
    const d = screen.getByRole('dialog');
    fillBasics(d);
    attach(d);
    await waitFor(() => expect(within(d).getByText('Event * — this bill is for an event')).toBeTruthy());
    fireEvent.click(within(d).getByText('Send to Finance'));
    expect(createAsync).not.toHaveBeenCalled();
    fireEvent.click(within(d).getByLabelText('I cannot find this event'));
    fireEvent.change(within(d).getByLabelText('Why there is no event'), { target: { value: 'Fair not in PMS yet' } });
    fireEvent.click(within(d).getByText('Send to Finance'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0]![0]).toMatchObject({ projectId: null, eventBill: true, noEventReason: 'Fair not in PMS yet' });
  });

  test('the same bill elsewhere is said out loud — and the request still goes', async () => {
    requests = []; isFinance = false; hasEvents = true; createAsync.mockClear();
    readResult = plainRead({ matches: [{ kind: 'PRQ', id: 'r9', number: 'HC-PRQ-2609-003', amountSen: 425_000, status: 'VOUCHERED', answeredBy: 'HC-PV-2609-010' }] });
    draw();
    fireEvent.click(screen.getByText('New request'));
    const d = screen.getByRole('dialog');
    fillBasics(d);
    attach(d);
    await waitFor(() => expect(within(d).getByText('Same bill already asked for or paid · 这张单已经有了')).toBeTruthy());
    expect(within(d).getByText('Request HC-PRQ-2609-003 · RM 4,250.00 → HC-PV-2609-010 · answered')).toBeTruthy();
    fireEvent.click(within(d).getByText('Send to Finance'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
  });

  test('without the bill nothing is sent; a company without events shows no Event field', () => {
    requests = []; isFinance = false; hasEvents = false; createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New request'));
    const d = screen.getByRole('dialog');
    fillBasics(d);
    expect(within(d).queryByLabelText('Event')).toBeNull();
    fireEvent.click(within(d).getByText('Send to Finance'));
    expect(createAsync).not.toHaveBeenCalled();
  });

  /* Item 2 (owner 2026-10-01): the first payment as an amount OR a percent of the bill. */
  test('a percent of the bill\'s total fills the amount; the request carries both', async () => {
    requests = []; isFinance = false; hasEvents = true; createAsync.mockClear();
    readResult = plainRead({ bill: { billNo: 'MLE-0925', billDate: '2026-09-01', totalSen: 1_000_000, vendorName: 'MLE' } });
    draw();
    fireEvent.click(screen.getByText('New request'));
    const d = screen.getByRole('dialog');
    fillBasics(d);
    attach(d);
    await waitFor(() => expect(within(d).getByText(/Read from the bill/)).toBeTruthy());
    fireEvent.change(within(d).getByLabelText('Percent of the bill'), { target: { value: '50' } });
    fireEvent.click(within(d).getByText('Send to Finance'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0]![0]).toMatchObject({ amountSen: 500_000, billTotalSen: 1_000_000, payPct: 50 });
  });

  test('a bill in instalments reads its figures; 申请付余额 asks the balance — no upload', async () => {
    const family = {
      rootId: 'r1', rootNo: 'HC-PRQ-2609-001', totalSen: 1_000_000, askedSen: 500_000, paidSen: 500_000, pendingSen: 0, remainingSen: 500_000,
      installments: [{ id: 'r1', request_no: 'HC-PRQ-2609-001', installment_no: 1, amount_sen: 500_000, pay_pct: 50, stage: 'PAID' }],
    };
    requests = [base({ status: 'VOUCHERED', stage: 'PAID', amount_sen: 500_000, family, voucher: { id: 'pv-1', pvNumber: 'HC-PV-2609-020', status: 'POSTED', approvedAt: null, postedAt: '2026-09-20T02:00:00Z', bankConfirmed: false } })];
    isFinance = false; balanceAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('HC-PRQ-2609-001'));
    const d = screen.getByRole('dialog');
    expect(within(d).getByText('Total RM 10,000.00 · Paid RM 5,000.00 · Left to ask RM 5,000.00')).toBeTruthy();
    expect(within(d).getByText('#1 · HC-PRQ-2609-001 · RM 5,000.00 (50%) · Paid · 已付')).toBeTruthy();
    fireEvent.click(within(d).getByText('Request the balance · 申请付余额'));
    const b = screen.getByRole('dialog', { name: 'Request the balance' });
    expect(within(b).getByText(/Left to ask on this bill: RM 5,000\.00 of RM 10,000\.00\./)).toBeTruthy();
    /* 漏洞 3: the official invoice attached here goes up AS the official invoice, on the new balance. */
    fireEvent.change(within(b).getByLabelText('Official invoice files'), { target: { files: [new File(['x'], 'official.pdf', { type: 'application/pdf' })] } });
    uploadOfficialAsync.mockClear(); uploadAsync.mockClear();
    fireEvent.click(within(b).getByText('Send to Finance'));
    await waitFor(() => expect(balanceAsync).toHaveBeenCalledTimes(1));
    expect(balanceAsync.mock.calls[0]![0]).toEqual({ id: 'r1', amountSen: 500_000, dueDate: null, purpose: 'Balance — Booth F1 rental', payPct: null });
    await waitFor(() => expect(uploadOfficialAsync).toHaveBeenCalledWith({ requestId: 'r-bal', file: { name: 'official.pdf', mime: 'application/pdf', dataBase64: 'b64:official.pdf' } }));
    expect(uploadAsync).not.toHaveBeenCalled();
  });

  /* Item 3 (owner 2026-10-01): paid on a proforma — the official invoice is owed. */
  test('a payment owing its official invoice is marked and filtered; the requester uploads it on the request', async () => {
    requests = [
      base({ status: 'VOUCHERED', stage: 'PAID', officialDoc: { state: 'OWED', note: null }, voucher: { id: 'pv-1', pvNumber: 'HC-PV-2610-001', status: 'POSTED', approvedAt: null, postedAt: '2026-10-01T02:00:00Z', bankConfirmed: false } }),
      base({ id: 'r2', request_no: 'HC-PRQ-2609-002' }),
    ];
    isFinance = false; uploadOfficialAsync.mockClear();
    draw();
    expect(screen.getAllByText('Official invoice owed · 欠正式单').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Official invoice owed · 欠正式单' }));
    expect(screen.getByText('HC-PRQ-2609-001')).toBeTruthy();
    expect(screen.queryByText('HC-PRQ-2609-002')).toBeNull();
    fireEvent.click(screen.getByText('HC-PRQ-2609-001'));
    const d = screen.getByRole('dialog');
    expect(within(d).getByText(/upload the official invoice when you have it/)).toBeTruthy();
    fireEvent.change(within(d).getByLabelText('Upload the official invoice'), { target: { files: [new File(['%PDF'], 'official.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(uploadOfficialAsync).toHaveBeenCalledWith({ requestId: 'r1', file: { name: 'official.pdf', mime: 'application/pdf', dataBase64: 'b64:official.pdf' } }));
  });

  test('a returned request shows Finance\'s note and goes back with "Fix and send again"', () => {
    requests = [base({ status: 'REJECTED', stage: 'RETURNED', finance_note: 'Attach the organiser invoice', decided_by: 'Chew', decided_at: '2026-09-11T02:00:00Z' })];
    isFinance = false;
    draw();
    fireEvent.click(screen.getByText('HC-PRQ-2609-001'));
    const d = screen.getByRole('dialog');
    expect(within(d).getByText(/Returned by Chew .*: Attach the organiser invoice/)).toBeTruthy();
    fireEvent.click(within(d).getByText('Fix and send again'));
    expect(screen.getByText('Finance returned it: Attach the organiser invoice')).toBeTruthy();
    expect(screen.getByText('Send again')).toBeTruthy();
  });
});

describe('Finance', () => {
  test('sees who asked; makes the voucher on PV New from the request', () => {
    requests = [base({ requested_by: 40, requested_by_name: 'Luis Teo' })];
    isFinance = true;
    draw();
    expect(screen.getByText('Requested by')).toBeTruthy();
    expect(screen.getByText('Luis Teo')).toBeTruthy();
    fireEvent.click(screen.getByText('HC-PRQ-2609-001'));
    const d = screen.getByRole('dialog');
    /* Not Finance's own request: no Edit / Withdraw. */
    expect(within(d).queryByText('Edit')).toBeNull();
    fireEvent.click(within(d).getByText('Make voucher'));
    expect(screen.getByText('PV New opened')).toBeTruthy();
  });

  /* 6.1 (owner 2026-09-30): or book the supplier's bill first as an AP invoice. */
  test('may answer with an AP invoice instead, opened from the request', () => {
    requests = [base({ requested_by: 40, requested_by_name: 'Luis Teo' })];
    isFinance = true;
    draw();
    fireEvent.click(screen.getByText('HC-PRQ-2609-001'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Make AP invoice'));
    expect(screen.getByText('AP Invoices opened')).toBeTruthy();
  });

  test('a request answered by an AP invoice reads how much of it is paid, and links the bill', () => {
    requests = [base({
      requested_by: 40, requested_by_name: 'Luis Teo', status: 'VOUCHERED', stage: 'PARTLY_PAID', ap_invoice_id: 'api-7',
      invoice: { id: 'api-7', invoiceNumber: 'HC-API-2609-007', status: 'PARTIALLY_PAID', totalSen: 850_000, paidSen: 300_000, paidBy: ['HC-PV-2609-010'], bankConfirmed: false },
    })];
    isFinance = true;
    draw();
    expect(screen.getByText(/HC-API-2609-007 · RM 3,000\.00 of RM 8,500\.00 paid/)).toBeTruthy();
    fireEvent.click(screen.getByText('HC-PRQ-2609-001'));
    const d = screen.getByRole('dialog');
    expect(within(d).queryByText('Make voucher')).toBeNull();
    expect(within(d).getByText('Open HC-API-2609-007 →').getAttribute('href')).toBe('/scm/ap-invoices?open=api-7');
    expect(d.textContent).toContain('by HC-PV-2609-010');
  });

  test('a request whose bill is on another document is marked on the list, and the request says which and what was read', () => {
    requests = [base({
      requested_by: 40, requested_by_name: 'Luis Teo', bill_no: 'MLE-0925', bill_date: '2026-09-01', bill_total_sen: 850_000,
      billMatches: [{ kind: 'PV', id: 'pv-4', number: 'HC-PV-2609-004', amountSen: 850_000, status: 'POSTED', answeredBy: null }],
    })];
    isFinance = true;
    draw();
    expect(screen.getByLabelText('Same bill elsewhere').textContent).toBe('⚠ same bill');
    fireEvent.click(screen.getByText('HC-PRQ-2609-001'));
    const d = screen.getByRole('dialog');
    expect(within(d).getByText('No. MLE-0925 · 2026/09/01 · total RM 8,500.00')).toBeTruthy();
    expect(within(d).getByText('Voucher HC-PV-2609-004 · RM 8,500.00 · posted')).toBeTruthy();
  });

  /* Item 2: a balance of a bill booked as an AP invoice is paid ON that invoice. */
  test('a balance of a bill booked as an AP invoice offers "Pay on" that invoice', () => {
    requests = [base({
      id: 'r2', request_no: 'HC-PRQ-2610-002', requested_by: 40, requested_by_name: 'Luis Teo', parent_request_id: 'r1', installment_no: 2,
      familyInvoice: { id: 'api-7', invoiceNumber: 'HC-API-2610-001', status: 'POSTED', supplierId: 'sup-mle', totalSen: 1_000_000, paidSen: 500_000 },
    })];
    isFinance = true;
    draw();
    expect(screen.getByText('#2 · balance')).toBeTruthy();
    fireEvent.click(screen.getByText('HC-PRQ-2610-002'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Pay on HC-API-2610-001'));
    expect(screen.getByText('PV New opened')).toBeTruthy();
  });

  test('returns a request with the note the prompt demands', async () => {
    requests = [base({ requested_by: 40, requested_by_name: 'Luis Teo' })];
    isFinance = true; returnAsync.mockClear(); promptFn.mockClear();
    draw();
    fireEvent.click(screen.getByText('HC-PRQ-2609-001'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Return…'));
    await waitFor(() => expect(returnAsync).toHaveBeenCalledWith({ id: 'r1', note: 'Attach the organiser invoice' }));
    expect(JSON.stringify(promptFn.mock.calls[0]![0])).toContain('"required":true');
  });
});

/* Owner 2026-10-02: upload 后很多资料都没有填 — and 自动填了资料还能手动改. */
describe('the form filled from the bill', () => {
  test('fills what is still empty; what was typed stays, and every field stays theirs to change', async () => {
    requests = []; isFinance = false; hasEvents = undefined; createAsync.mockClear(); readAsync.mockClear();
    readResult = plainRead({ bill: { billNo: 'HV-INV-202608-0051', billDate: '2026-08-31', totalSen: 808_233, vendorName: 'HOUZS VENTURE HOLDINGS SDN BHD', dueDate: '2026-09-30', summary: "Payroll cost share — Aug'26 · adjustment", bankName: 'Hong Leong Bank Berhad', bankAccountNo: '123-4567-8901', bankAccountName: 'Houzs Venture Holding Sdn Bhd' } });
    draw();
    fireEvent.click(screen.getByText('New request'));
    const d = screen.getByRole('dialog');
    /* Typed before the bill is read — it stays. */
    fireEvent.change(within(d).getByLabelText('What is it for'), { target: { value: 'HC share of Aug payroll' } });
    fireEvent.change(within(d).getByLabelText('Bill files'), { target: { files: [new File(['%PDF'], 'invoice-HV-INV-202608-0051.pdf', { type: 'application/pdf' })] } });
    const note = await within(d).findByLabelText('Filled in from the bill');
    expect(note.textContent).toContain("Pay to · Amount · Pay by · Payee's bank · Account no. · Account name");
    expect(note.textContent).toContain('都可以自己改');
    expect((within(d).getByLabelText('Pay to') as HTMLInputElement).value).toBe('HOUZS VENTURE HOLDINGS SDN BHD');
    expect((within(d).getByLabelText('What is it for') as HTMLTextAreaElement).value).toBe('HC share of Aug payroll');
    expect((within(d).getByLabelText('Account no.') as HTMLInputElement).value).toBe('123-4567-8901');
    /* Still theirs to change: a changed field leaves the note and goes as typed. */
    fireEvent.change(within(d).getByLabelText('Pay to'), { target: { value: 'Houzs Venture Holding Sdn Bhd' } });
    expect(within(d).getByLabelText('Filled in from the bill').textContent).not.toContain('Pay to');
    fireEvent.click(within(d).getByText('Send to Finance'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0]![0]).toMatchObject({
      payeeName: 'Houzs Venture Holding Sdn Bhd', amountSen: 808_233, dueDate: '2026-09-30', purpose: 'HC share of Aug payroll',
      bankName: 'Hong Leong Bank Berhad', bankAccountNo: '123-4567-8901', bankAccountName: 'Houzs Venture Holding Sdn Bhd',
      billNo: 'HV-INV-202608-0051', billDate: '2026-08-31', billTotalSen: 808_233,
    });
  });
});

/* Owner 2026-10-02: 看了有点乱，整齐一点 — the form in the order it is filled: the
   bill (it fills the rest), who is paid with their bank, how much, what for. */
describe('the form in the order it is filled', () => {
  const STEPS = ['单据 · The bill', '付给谁 · Pay to', '付多少 · Amount', '用途 · What for'];
  const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });

  test('four steps; the bank sits with who is paid; a second file adds to the first and ✕ takes one off', async () => {
    requests = []; isFinance = false; hasEvents = undefined; readResult = plainRead(); readAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New request'));
    const d = screen.getByRole('dialog');
    expect(within(d).getAllByRole('region').map((r) => r.getAttribute('aria-label')).filter((l) => STEPS.includes(l ?? ''))).toEqual(STEPS);
    const payTo = within(d).getByRole('region', { name: '付给谁 · Pay to' });
    expect(within(payTo).getByLabelText("Payee's bank")).toBeTruthy();
    expect(within(payTo).getByLabelText('Account no.')).toBeTruthy();
    const amount = within(d).getByRole('region', { name: '付多少 · Amount' });
    expect(['Bill total', 'Amount', 'Percent of the bill', 'Pay by'].every((l) => within(amount).queryByLabelText(l) != null)).toBe(true);

    fireEvent.change(within(d).getByLabelText('Bill files'), { target: { files: [pdf('page-1.pdf')] } });
    await waitFor(() => expect(readAsync).toHaveBeenCalledTimes(1));
    fireEvent.change(within(d).getByLabelText('Bill files'), { target: { files: [pdf('page-2.pdf')] } });
    await waitFor(() => expect(readAsync).toHaveBeenCalledTimes(2));
    expect(readAsync.mock.calls[1]![0]).toEqual({ files: [
      { name: 'page-1.pdf', mime: 'application/pdf', dataBase64: 'b64:page-1.pdf' },
      { name: 'page-2.pdf', mime: 'application/pdf', dataBase64: 'b64:page-2.pdf' },
    ] });
    expect(within(d).getByText('page-1.pdf')).toBeTruthy();
    fireEvent.click(within(d).getByLabelText('Remove page-1.pdf'));
    await waitFor(() => expect(readAsync).toHaveBeenCalledTimes(3));
    expect(readAsync.mock.calls[2]![0]).toEqual({ files: [{ name: 'page-2.pdf', mime: 'application/pdf', dataBase64: 'b64:page-2.pdf' }] });
    expect(within(d).queryByText('page-1.pdf')).toBeNull();
    /* What was read is said once, under the bill. */
    const bill = within(d).getByRole('region', { name: '单据 · The bill' });
    await waitFor(() => expect(within(bill).getByText(/Read from the bill: No\. MLE-0925/)).toBeTruthy());
  });

  test('an edit has no bill step — its files are on the request; it opens on who is paid', () => {
    requests = [base({ id: 'r1' })]; isFinance = false;
    draw();
    fireEvent.click(screen.getByText('HC-PRQ-2609-001'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Edit'));
    expect(screen.queryByRole('region', { name: '单据 · The bill' })).toBeNull();
    const payTo = screen.getByRole('region', { name: '付给谁 · Pay to' });
    expect(within(payTo).getByText('1')).toBeTruthy();
    expect((within(payTo).getByLabelText('Pay to') as HTMLInputElement).value).toBe('MLE EVENTS SDN BHD');
  });
});
