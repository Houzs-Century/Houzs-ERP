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

vi.mock('../vendor/scm/lib/payment-request-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vendor/scm/lib/payment-request-queries')>()),
  usePaymentRequests: () => ({ data: { requests, finance: isFinance }, isLoading: false, isError: false }),
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
    const photo = new File(['jpg'], 'bill.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Take a photo of the bill'), { target: { files: [photo] } });
    expect(screen.getByText('bill.jpg')).toBeTruthy();
    fireEvent.click(screen.getByText('Send to Finance'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0]![0]).toMatchObject({ payeeName: 'MLE EVENTS SDN BHD', amountSen: 850_000, purpose: 'Booth F1 rental', projectId: 348, bankName: 'Maybank' });
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
