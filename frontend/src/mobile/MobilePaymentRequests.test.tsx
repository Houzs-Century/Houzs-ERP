/* 申请付款 on the phone (owner 2026-09-30). Pinned: the list reads the stage in
   the owner's words; a new request carries the event (from the requests' own
   list), the payee's bank and the bill's photo, which attaches after the
   request is sent; a returned request shows Finance's note and goes back as
   "Send again"; Finance returns one with the note the prompt demands. The
   hooks are the desktop page's own — this file stubs them. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

type Req = Record<string, unknown>;
const base = (over: Req): Req => ({
  id: 'r1', request_no: 'HC-PRQ-2609-001', requested_by: 22, requested_by_name: 'James Seow', payee_name: 'MLE EVENTS SDN BHD',
  amount_sen: 850_000, due_date: '2026-09-15', purpose: 'Booth F1 rental', project_id: 348, bank_name: 'Maybank',
  bank_account_no: '5123', bank_account_name: null, status: 'SUBMITTED', pv_id: null, finance_note: null,
  decided_by: null, decided_at: null, created_at: '2026-09-10T02:00:00Z', updated_at: '2026-09-10T02:00:00Z', stage: 'SUBMITTED', voucher: null,
  ...over,
});
let requests: Req[] = [];
let isFinance = false;
const createAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({ id: 'r-new' }) }));
const updateAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({}) }));
const uploadAsync = vi.fn(async (_b: Req) => ({ ok: true }));
const returnMutate = vi.fn();
/* 申请付余额 (item 2, 2026-10-01). */
const balanceAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({ id: 'r-bal' }), overTotal: false }));
/* The bill reader's answer for the photo being attached (item 1, 2026-10-01). */
const readAsync = vi.fn(async (_b: Req): Promise<Req> => ({
  ok: true, bill: { billNo: 'MLE-0925', billDate: '2026-09-01', totalSen: 850_000, vendorName: 'MLE EVENTS SDN BHD' },
  hasEvents: true, eventBill: false, eventSuggestions: [], matches: [],
}));

/* 欠正式单 (item 3): Finance's marks and the requester's upload — stubbed. */
const markOfficial = vi.fn();
const uploadOfficialAsync = vi.fn(async (_b: unknown) => ({ ok: true, received: [{ kind: 'PV', number: 'HC-PV-2610-001' }], note: null as string | null }));
vi.mock('../vendor/scm/lib/official-doc-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vendor/scm/lib/official-doc-queries')>()),
  useMarkOfficialDoc: () => ({ mutate: markOfficial, isPending: false }),
  useUploadOfficialDoc: () => ({ mutateAsync: uploadOfficialAsync, isPending: false }),
}));
vi.mock('../vendor/scm/lib/payment-request-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vendor/scm/lib/payment-request-queries')>()),
  usePaymentRequests: () => ({ data: { requests, finance: isFinance, hasEvents: true }, isLoading: false, isError: false }),
  useReadRequestBill: () => ({ mutateAsync: readAsync, isPending: false }),
  useRequestBalance: () => ({ mutateAsync: balanceAsync, isPending: false }),
  usePaymentRequest: (id: string | null) => ({ data: id ? { request: requests.find((r) => r.id === id), finance: isFinance } : undefined, isLoading: false }),
  useCreatePaymentRequest: () => ({ mutateAsync: createAsync, isPending: false }),
  useUpdatePaymentRequest: () => ({ mutateAsync: updateAsync, isPending: false }),
  useWithdrawPaymentRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useReturnPaymentRequest: () => ({ mutate: returnMutate, isPending: false }),
  useUploadPaymentRequestFile: () => ({ mutateAsync: uploadAsync, isPending: false }),
  useDeletePaymentRequestFile: () => ({ mutate: vi.fn(), isPending: false }),
  usePaymentRequestFiles: () => ({ data: { files: [] }, isLoading: false }),
  fetchPaymentRequestFileBlobUrl: vi.fn(),
}));
const EVENT_OPTIONS = [
  { id: 348, code: 'E-348', name: 'Pulau Pinang [AKEMI] MLE @ PWCC', startDate: '2026-09-25', endDate: '2026-09-27', status: 'confirmed', archived: false, venue: null, brand: 'AKEMI', organizer: 'MLE', boothNo: 'F1' },
];
vi.mock('../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => ({ data: EVENT_OPTIONS, isLoading: false }),
  useEventLabels: () => ({ data: new Map(EVENT_OPTIONS.map((e) => [e.id, e])) }),
}));
vi.mock('../vendor/scm/lib/payment-voucher-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vendor/scm/lib/payment-voucher-queries')>()),
  fileToBase64: async (f: File) => `b64:${f.name}`,
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 22 }, can: () => true }) }));
const promptFn = vi.fn(async (_o: unknown) => 'Attach the organiser invoice' as string | null);
vi.mock('../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => vi.fn(async () => true), usePrompt: () => promptFn }));

import { MobilePaymentRequests } from './MobilePaymentRequests';

describe('MobilePaymentRequests', () => {
  test('a new request carries the event, the payee\'s bank and the bill\'s photo', async () => {
    requests = []; isFinance = false; createAsync.mockClear(); uploadAsync.mockClear();
    render(<MobilePaymentRequests onBack={() => undefined} />);
    expect(screen.getByText(/You have not asked Finance to pay anything yet/)).toBeTruthy();
    fireEvent.click(screen.getByText('New request'));
    fireEvent.change(screen.getByLabelText('Pay to'), { target: { value: 'MLE EVENTS SDN BHD' } });
    const amount = screen.getByLabelText('Amount');
    fireEvent.focus(amount); fireEvent.change(amount, { target: { value: '8500' } }); fireEvent.blur(amount);
    fireEvent.change(screen.getByLabelText('What is it for'), { target: { value: 'Booth F1 rental' } });
    fireEvent.focus(screen.getByLabelText('Event'));
    fireEvent.mouseDown(screen.getByText(/MLE @ PWCC/));
    fireEvent.change(screen.getByLabelText("Payee's bank"), { target: { value: 'Maybank' } });
    /* No photo yet: nothing is sent, and the sheet says what is missing. */
    fireEvent.click(screen.getByText('Send to Finance'));
    expect(screen.getByText('Still needed: a photo of the bill.')).toBeTruthy();
    expect(createAsync).not.toHaveBeenCalled();
    const photo = new File(['jpg'], 'bill.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Take a photo of the bill'), { target: { files: [photo] } });
    expect(screen.getByText('bill.jpg')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Read from the bill: No\. MLE-0925/)).toBeTruthy());
    fireEvent.click(screen.getByText('Send to Finance'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0]![0]).toMatchObject({ payeeName: 'MLE EVENTS SDN BHD', amountSen: 850_000, purpose: 'Booth F1 rental', projectId: 348, bankName: 'Maybank', billNo: 'MLE-0925', billDate: '2026-09-01', eventBill: false });
    await waitFor(() => expect(uploadAsync).toHaveBeenCalledWith({ id: 'r-new', file: { name: 'bill.jpg', mime: 'image/jpeg', dataBase64: 'b64:bill.jpg' } }));
  });

  test('the list reads the stage; a returned request shows the note and goes back as "Send again"', () => {
    requests = [
      base({ id: 'r2', request_no: 'HC-PRQ-2609-002', status: 'VOUCHERED', stage: 'BANK_CONFIRMED', voucher: { id: 'pv', pvNumber: 'HC-PV-2609-014', status: 'POSTED', approvedAt: '2026-09-12T03:00:00Z', postedAt: '2026-09-12T03:00:00Z', bankConfirmed: true } }),
      base({ status: 'REJECTED', stage: 'RETURNED', finance_note: 'Attach the organiser invoice', decided_by: 'Chew' }),
    ];
    isFinance = false;
    render(<MobilePaymentRequests onBack={() => undefined} />);
    expect(screen.getByText('Bank confirmed · 银行已确认')).toBeTruthy();
    fireEvent.click(screen.getByText('Returned · 已退回').closest('button')!);
    expect(screen.getByText('Returned by Chew: Attach the organiser invoice')).toBeTruthy();
    fireEvent.click(screen.getByText('Fix and send again'));
    expect(screen.getByText('Send again')).toBeTruthy();
  });

  test('a paid first instalment offers 申请付余额; the balance goes with no upload', async () => {
    const family = {
      rootId: 'r1', rootNo: 'HC-PRQ-2609-001', totalSen: 1_000_000, askedSen: 400_000, paidSen: 400_000, pendingSen: 0, remainingSen: 600_000,
      installments: [{ id: 'r1', request_no: 'HC-PRQ-2609-001', installment_no: 1, amount_sen: 400_000, pay_pct: 40, stage: 'PAID' }],
    };
    requests = [base({ status: 'VOUCHERED', stage: 'PAID', amount_sen: 400_000, family })];
    isFinance = false; balanceAsync.mockClear();
    render(<MobilePaymentRequests onBack={() => undefined} />);
    fireEvent.click(screen.getByText('MLE EVENTS SDN BHD').closest('button')!);
    expect(screen.getByText('Total RM 10,000.00 · Paid RM 4,000.00 · Left to ask RM 6,000.00')).toBeTruthy();
    fireEvent.click(screen.getByText('申请付余额 · Balance'));
    expect(screen.getByText(/Left to ask: RM 6,000\.00 of RM 10,000\.00\./)).toBeTruthy();
    /* 漏洞 3: the official invoice goes up AS the official invoice. */
    fireEvent.change(screen.getByLabelText('Official invoice files'), { target: { files: [new File(['x'], 'official.jpg', { type: 'image/jpeg' })] } });
    uploadOfficialAsync.mockClear(); uploadAsync.mockClear();
    fireEvent.click(screen.getByText('Send to Finance'));
    await waitFor(() => expect(balanceAsync).toHaveBeenCalledTimes(1));
    expect(balanceAsync.mock.calls[0]![0]).toMatchObject({ id: 'r1', amountSen: 600_000, payPct: null });
    await waitFor(() => expect(uploadOfficialAsync).toHaveBeenCalledWith({ requestId: 'r-bal', file: { name: 'official.jpg', mime: 'image/jpeg', dataBase64: 'b64:official.jpg' } }));
    expect(uploadAsync).not.toHaveBeenCalled();
  });

  /* Item 3: paid on a proforma — 欠正式单 on the list, and 补正式单 on the request. */
  test('a payment owing its official invoice is marked; the requester uploads it from the phone', async () => {
    requests = [base({ status: 'VOUCHERED', stage: 'PAID', officialDoc: { state: 'OWED', note: null } })];
    isFinance = false; uploadOfficialAsync.mockClear();
    render(<MobilePaymentRequests onBack={() => undefined} />);
    expect(screen.getByText('Official invoice owed · 欠正式单')).toBeTruthy();
    fireEvent.click(screen.getByText('MLE EVENTS SDN BHD').closest('button')!);
    fireEvent.change(screen.getByLabelText('Upload the official invoice'), { target: { files: [new File(['jpg'], 'official.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(uploadOfficialAsync).toHaveBeenCalledWith({ requestId: 'r1', file: { name: 'official.jpg', mime: 'image/jpeg', dataBase64: 'b64:official.jpg' } }));
  });

  test('Finance returns a waiting request with the note the prompt demands', async () => {
    requests = [base({ requested_by: 40, requested_by_name: 'Luis Teo' })];
    isFinance = true; returnMutate.mockClear();
    render(<MobilePaymentRequests onBack={() => undefined} />);
    fireEvent.click(screen.getByText('MLE EVENTS SDN BHD').closest('button')!);
    expect(screen.getByText(/Answer it on the computer — Payment Requests › Make voucher or Make AP invoice/)).toBeTruthy();
    fireEvent.click(screen.getByText('Return…'));
    await waitFor(() => expect(returnMutate).toHaveBeenCalledWith({ id: 'r1', note: 'Attach the organiser invoice' }));
  });
});

/* Owner 2026-10-02: upload 后很多资料都没有填 — and 自动填了资料还能手动改. On the
   phone the bill comes page by page: a later page fills more, never what was typed. */
describe('the phone form filled from the bill', () => {
  test('page one fills the payee and the summary; page two fills the rest; what was typed stays', async () => {
    requests = []; isFinance = false; createAsync.mockClear();
    const read = (bill: Req) => ({ ok: true, bill, hasEvents: true, eventBill: false, eventSuggestions: [], matches: [] });
    const full: Req = { billNo: 'HV-INV-202608-0051', billDate: '2026-08-31', totalSen: 808_233, vendorName: 'HOUZS VENTURE HOLDINGS SDN BHD', dueDate: '2026-09-30', summary: "Payroll cost share — Aug'26 · adjustment", bankName: 'Hong Leong Bank Berhad', bankAccountNo: '123-4567-8901', bankAccountName: 'Houzs Venture Holding Sdn Bhd' };
    readAsync
      .mockImplementationOnce(async () => read({ ...full, totalSen: null, dueDate: null, bankName: null, bankAccountNo: null, bankAccountName: null }))
      .mockImplementationOnce(async () => read(full));
    render(<MobilePaymentRequests onBack={() => undefined} />);
    fireEvent.click(screen.getByText('New request'));
    fireEvent.change(screen.getByLabelText('Take a photo of the bill'), { target: { files: [new File(['jpg'], 'page-1.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect((screen.getByLabelText('Pay to') as HTMLInputElement).value).toBe('HOUZS VENTURE HOLDINGS SDN BHD'));
    expect((screen.getByLabelText('What is it for') as HTMLTextAreaElement).value).toBe("Payroll cost share — Aug'26 · adjustment");
    /* They change what it is for — the next page does not take it back. */
    fireEvent.change(screen.getByLabelText('What is it for'), { target: { value: 'HC share of Aug payroll' } });
    fireEvent.change(screen.getByLabelText('Take a photo of the bill'), { target: { files: [new File(['jpg'], 'page-2.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect((screen.getByLabelText('Account no.') as HTMLInputElement).value).toBe('123-4567-8901'));
    expect((screen.getByLabelText('What is it for') as HTMLTextAreaElement).value).toBe('HC share of Aug payroll');
    expect(screen.getByLabelText('Filled in from the bill').textContent).toContain("Pay to · Amount · Pay by · Payee's bank · Account no. · Account name");
    fireEvent.click(screen.getByText('Send to Finance'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0]![0]).toMatchObject({
      payeeName: 'HOUZS VENTURE HOLDINGS SDN BHD', amountSen: 808_233, dueDate: '2026-09-30', purpose: 'HC share of Aug payroll',
      bankName: 'Hong Leong Bank Berhad', bankAccountNo: '123-4567-8901', bankAccountName: 'Houzs Venture Holding Sdn Bhd',
    });
  });
});

/* Owner 2026-10-02: 整齐一点 — the phone form runs in the desktop form's four steps. */
test('the phone form runs bill, who is paid (with the bank), how much, what for', () => {
  requests = []; isFinance = false;
  render(<MobilePaymentRequests onBack={() => undefined} />);
  fireEvent.click(screen.getByText('New request'));
  const heads = ['① 单据 · The bill *', '② 付给谁 · Pay to', '③ 付多少 · Amount', '④ 用途 · What for'].map((t) => screen.getByText(t));
  const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  for (let i = 1; i < heads.length; i += 1) expect(before(heads[i - 1]!, heads[i]!)).toBe(true);
  expect(before(screen.getByLabelText("Payee's bank"), screen.getByLabelText('Amount'))).toBe(true);
  expect(before(screen.getByLabelText('Amount'), screen.getByLabelText('What is it for'))).toBe(true);
});

/* Owner 2026-10-02: ⑤ the note to Finance, on the phone too. */
test('the phone form takes a note to Finance, sent trimmed; the request shows it', async () => {
  requests = []; isFinance = false; createAsync.mockClear();
  render(<MobilePaymentRequests onBack={() => undefined} />);
  fireEvent.click(screen.getByText('New request'));
  expect(screen.getByText('⑤ 备注 · Note')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: ' Pay before Friday ' } });
  fireEvent.change(screen.getByLabelText('Pay to'), { target: { value: 'MLE EVENTS SDN BHD' } });
  const amount = screen.getByLabelText('Amount');
  fireEvent.focus(amount); fireEvent.change(amount, { target: { value: '8500' } }); fireEvent.blur(amount);
  fireEvent.change(screen.getByLabelText('What is it for'), { target: { value: 'Booth F1 rental' } });
  fireEvent.change(screen.getByLabelText('Take a photo of the bill'), { target: { files: [new File(['jpg'], 'bill.jpg', { type: 'image/jpeg' })] } });
  await waitFor(() => expect(screen.getByText(/Read from the bill/)).toBeTruthy());
  fireEvent.click(screen.getByText('Send to Finance'));
  await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
  expect(createAsync.mock.calls[0]![0]).toMatchObject({ note: 'Pay before Friday' });
});
