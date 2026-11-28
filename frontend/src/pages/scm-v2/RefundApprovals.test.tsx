/* A refund request's one approval (owner 2026-11-27: 「只要一级，但这一级的权限和
 * cancel 的第二级一样」), on the desks that sign a cancellation's second level.
 * Pinned:
 *   • a viewer who may not approve sees no section at all;
 *   • what waits is listed with Approve and Reject — approve asks first, reject
 *     asks why, and each sends to the server only after the dialog;
 *   • the person who raised it is offered no signature;
 *   • the Amendment queue shows the section only while something waits;
 *   • an approved request names who approved it, and that Finance has it. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PR = import('../../vendor/scm/lib/payment-request-queries').PaymentRequest;

const req = (over: Partial<PR>): PR => ({
  id: 'q1', request_no: 'PRQ-1', requested_by: 31, requested_by_name: 'Sales A', payee_name: 'Customer A', amount_sen: 40_000,
  due_date: null, purpose: 'Customer cancelled', project_id: null, bank_name: 'Bank A', bank_account_no: '123456', bank_account_name: 'CUSTOMER A',
  status: 'SUBMITTED', pv_id: null, finance_note: null, decided_by: null, decided_at: null,
  created_at: '2026-11-20T02:00:00Z', updated_at: '2026-11-20T02:00:00Z', stage: 'AWAITING_APPROVAL', voucher: null,
  refund_source_type: 'SO', refund_source_doc_no: 'SO-A', refund_approved_by_name: null, refund_approved_at: null,
  ...over,
});

let DATA: { requests: PR[]; mayApprove: boolean; me: number | null } | undefined;
const approve = vi.fn(async (_id: string) => ({ ok: true }));
const sendBack = vi.fn(async (_v: { id: string; note: string }) => ({ ok: true }));
const confirm = vi.fn(async (_o: unknown) => true);
const prompt = vi.fn(async (_o: unknown): Promise<string | null> => 'The customer keeps the order');

vi.mock('../../vendor/scm/lib/payment-request-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/payment-request-queries')>()),
  useRefundApprovals: () => ({ data: DATA, isLoading: false, isError: false, error: null }),
  useApproveRefundRequest: () => ({ mutateAsync: approve, isPending: false }),
  useReturnPaymentRequest: () => ({ mutateAsync: sendBack, isPending: false }),
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirm, usePrompt: () => async () => '' }));
vi.mock('../../vendor/scm/components/PromptDialog', () => ({ usePrompt: () => prompt }));

const { RefundApprovals, refundApproverText, refundStatusText } = await import('./RefundApprovals');
const { viewerMayApproveRefund } = await import('../../vendor/scm/lib/payment-request-queries');

const mount = (onlyWhenWaiting = false) =>
  render(<MemoryRouter initialEntries={['/scm/cancel-requests']}><RefundApprovals onlyWhenWaiting={onlyWhenWaiting} /></MemoryRouter>);

beforeEach(() => {
  DATA = { requests: [req({})], mayApprove: true, me: 41 };
  approve.mockClear(); sendBack.mockClear(); confirm.mockClear(); prompt.mockClear();
  confirm.mockResolvedValue(true);
  prompt.mockResolvedValue('The customer keeps the order');
  try { window.localStorage.clear(); } catch { }
});

describe('RefundApprovals', () => {
  it('shows nothing to a viewer who may not approve', () => {
    DATA = { requests: [], mayApprove: false, me: 9 };
    mount();
    expect(screen.queryByText('Refund requests')).toBeNull();
  });

  it('lists what waits; Approve asks first, then signs that request', async () => {
    mount();
    expect(screen.getByText('Refund requests')).toBeTruthy();
    expect(screen.getByText('SO-A')).toBeTruthy();
    expect(screen.getByText('Waiting approval', { selector: 'span' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith('q1'));
    expect(String((confirm.mock.calls[0]![0] as { title: string }).title)).toBe('Approve the refund of RM 400.00 on SO-A?');
  });

  it('closing the approve dialog signs nothing', async () => {
    confirm.mockResolvedValue(false);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(approve).not.toHaveBeenCalled();
  });

  it('Reject asks why and sends the reason; no reason, nothing sent', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(sendBack).toHaveBeenCalledWith({ id: 'q1', note: 'The customer keeps the order' }));
    prompt.mockResolvedValue(null);
    sendBack.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(sendBack).not.toHaveBeenCalled();
  });

  it('offers the person who raised it no signature', () => {
    DATA = { requests: [req({ requested_by: 41 })], mayApprove: true, me: 41 };
    mount();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Your request — someone else approves it')).toBeTruthy();
  });

  it('on the Amendment queue the section shows only while a refund waits', () => {
    DATA = { requests: [], mayApprove: true, me: 41 };
    const { unmount } = mount(true);
    expect(screen.queryByText('Refund requests')).toBeNull();
    unmount();
    mount(false);
    expect(screen.getByText('Refund requests')).toBeTruthy();
    expect(screen.getByText('No refund is waiting for approval.')).toBeTruthy();
  });
});

describe('the refund approval readings', () => {
  it('an approved request names its approver, then that Finance has it', () => {
    const approved = req({ stage: 'SUBMITTED', refund_approved_by_name: 'Purchaser A', refund_approved_at: '2026-11-21T03:00:00Z' });
    expect(refundStatusText(approved)).toBe('Approved — with Finance');
    expect(refundApproverText(approved)).toMatch(/^Purchaser A · .+$/);
    expect(refundApproverText(req({}))).toBe('—');
    expect(refundStatusText(req({}))).toBe('Waiting approval');
    expect(refundStatusText(req({ stage: 'RETURNED', status: 'REJECTED' }))).toBe('Rejected');
  });

  it('who is offered the signature', () => {
    expect(viewerMayApproveRefund(req({}), 41, true)).toBe(true);
    expect(viewerMayApproveRefund(req({}), 31, true)).toBe(false);
    expect(viewerMayApproveRefund(req({}), 41, false)).toBe(false);
    expect(viewerMayApproveRefund(req({}), null, true)).toBe(false);
    expect(viewerMayApproveRefund(req({ stage: 'SUBMITTED' }), 41, true)).toBe(false);
  });
});
