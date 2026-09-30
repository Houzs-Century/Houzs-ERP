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
const createAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({ id: 'r-new' }) }));
const updateAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({}) }));
const withdrawAsync = vi.fn(async (_id: string) => ({ ok: true }));
const returnAsync = vi.fn(async (_b: Req) => ({ ok: true }));
const uploadAsync = vi.fn(async (_b: Req) => ({ ok: true }));

vi.mock('../../vendor/scm/lib/payment-request-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/payment-request-queries')>()),
  usePaymentRequests: () => ({ data: { requests, finance: isFinance }, isLoading: false, isError: false, error: null }),
  usePaymentRequest: (id: string | null) => ({ data: id ? { request: requests.find((r) => r.id === id), finance: isFinance } : undefined, isLoading: false }),
  useCreatePaymentRequest: () => ({ mutateAsync: createAsync, isPending: false }),
  useUpdatePaymentRequest: () => ({ mutateAsync: updateAsync, isPending: false }),
  useWithdrawPaymentRequest: () => ({ mutateAsync: withdrawAsync, isPending: false }),
  useReturnPaymentRequest: () => ({ mutateAsync: returnAsync, isPending: false }),
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
    </Routes>
  </MemoryRouter>,
);

describe('the requester', () => {
  test('raises a request with the event and the payee\'s bank; the bill attaches after it is sent', async () => {
    requests = []; isFinance = false; createAsync.mockClear(); uploadAsync.mockClear();
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
    fireEvent.click(within(d).getByText('Send to Finance'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0]![0]).toEqual({
      payeeName: 'MLE EVENTS SDN BHD', amountSen: 850_000, dueDate: null, purpose: 'Booth F1 rental', projectId: 348,
      bankName: 'Maybank', bankAccountNo: '5123', bankAccountName: null,
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
