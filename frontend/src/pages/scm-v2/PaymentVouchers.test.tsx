/* 批量tick yes (the owner, 2026-09-02: 这个批量的功能肯定需要). What is pinned:
     • only rows whose yes is YOURS to give can be ticked — a raw draft and a
       posted voucher render DISABLED checkboxes;
     • the bar counts each button's own targets (Check n / Approve & post n);
     • the run stamps ONE BY ONE through the real hooks, a failure names its
       voucher and the rest carry on, and the summary says both.
   The doors themselves are pinned server-side in tests/pvApproval.test.ts —
   here the mutateAsyncs are canned and the arithmetic around them is what is
   under test. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const prepareAsync = vi.fn(async (_id: string) => ({}));
const checkAsync = vi.fn(async (_id: string) => ({}));
const approveAsync = vi.fn(async (_id: string) => ({}));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  usePaymentVouchers: () => ({ data: { paymentVouchers: [
    { id: 'raw', pv_number: 'PV-2609-001', payee_name: 'Raw Draft Co', status: 'DRAFT', voucher_date: '2026-09-01', total_sen: 10000, currency: 'MYR', exchange_rate: 1, submitted_at: null, checked_at: null, approved_at: null },
    { id: 'prep', pv_number: 'PV-2609-002', payee_name: 'Prepared Co', status: 'DRAFT', voucher_date: '2026-09-01', total_sen: 20000, currency: 'MYR', exchange_rate: 1, submitted_at: '2026-09-02T01:00:00Z', checked_at: null, approved_at: null },
    { id: 'chk', pv_number: 'PV-2609-003', payee_name: 'Checked Co', status: 'DRAFT', voucher_date: '2026-09-01', total_sen: 30000, currency: 'MYR', exchange_rate: 1, submitted_at: '2026-09-02T01:00:00Z', checked_at: '2026-09-02T02:00:00Z', approved_at: null },
    { id: 'done', pv_number: 'PV-2609-004', payee_name: 'Posted Co', status: 'POSTED', voucher_date: '2026-09-01', total_sen: 40000, currency: 'MYR', exchange_rate: 1, submitted_at: '2026-09-02T01:00:00Z', checked_at: '2026-09-02T02:00:00Z', approved_at: '2026-09-02T03:00:00Z' },
  ] }, isLoading: false, error: null }),
  useCancelPaymentVoucher: () => ({ mutate: vi.fn(), isPending: false }),
  useSubmitPaymentVoucher: () => ({ mutateAsync: prepareAsync, isPending: false }),
  useCheckPaymentVoucher: () => ({ mutateAsync: checkAsync, isPending: false }),
  useApprovePaymentVoucher: () => ({ mutateAsync: approveAsync, isPending: false }),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));
const notifyFn = vi.fn((_a: unknown) => undefined);
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => notifyFn }));

import { PaymentVouchers } from './PaymentVouchers';

const draw = () => render(<MemoryRouter><PaymentVouchers /></MemoryRouter>);

describe('批量 tick yes', () => {
  test('only the rows whose next step is yours can be ticked; posted renders disabled', () => {
    draw();
    const boxes = screen.getAllByLabelText('Select row') as HTMLInputElement[];
    expect(boxes).toHaveLength(4);
    /* Row order mirrors the data: raw / prepared / checked / posted. A raw
       draft ticks too since 我draft 也要批量去prepared (owner, 2026-09-02). */
    expect(boxes.map((b) => b.disabled)).toEqual([false, false, false, true]);
  });

  test('batch Prepare runs WITHOUT a dialog — freely reversible, same as the detail button', async () => {
    prepareAsync.mockClear(); confirmFn.mockClear(); notifyFn.mockClear();
    draw();
    const boxes = screen.getAllByLabelText('Select row') as HTMLInputElement[];
    fireEvent.click(boxes[0]!); // raw draft
    expect(screen.getByText('Prepare 1')).toBeTruthy();
    fireEvent.click(screen.getByText('Prepare 1'));
    await waitFor(() => expect(prepareAsync).toHaveBeenCalledWith('raw'));
    expect(confirmFn).not.toHaveBeenCalled();
    await waitFor(() => expect(notifyFn).toHaveBeenCalled());
    expect(JSON.stringify(notifyFn.mock.calls[0]![0])).toMatch(/1 of 1 prepared/);
  });

  test('the bar counts each button\'s own targets, and the run stamps one by one', async () => {
    checkAsync.mockClear(); approveAsync.mockClear(); confirmFn.mockClear(); notifyFn.mockClear();
    draw();
    const boxes = screen.getAllByLabelText('Select row') as HTMLInputElement[];
    fireEvent.click(boxes[1]!); // prepared
    fireEvent.click(boxes[2]!); // checked

    expect(screen.getByText('2 ticked')).toBeTruthy();
    expect(screen.getByText('Check 1')).toBeTruthy();
    expect(screen.getByText('Approve & post 1')).toBeTruthy();

    fireEvent.click(screen.getByText('Approve & post 1'));
    await waitFor(() => expect(approveAsync).toHaveBeenCalledWith('chk'));
    expect(checkAsync).not.toHaveBeenCalled();
    /* The dialog carried the MYR figure of ITS targets only (RM 300.00). */
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/300\.00/);
    await waitFor(() => expect(notifyFn).toHaveBeenCalled());
    expect(JSON.stringify(notifyFn.mock.calls[0]![0])).toMatch(/1 of 1 approved/);
  });

  test('a refusal names its voucher and the rest carry on', async () => {
    checkAsync.mockClear(); notifyFn.mockClear(); confirmFn.mockClear();
    checkAsync.mockRejectedValueOnce(new Error('This voucher is already checked — it is waiting for approval.'));
    draw();
    const boxes = screen.getAllByLabelText('Select row') as HTMLInputElement[];
    fireEvent.click(boxes[1]!); // prepared — the one Check target
    fireEvent.click(screen.getByText('Check 1'));
    await waitFor(() => expect(notifyFn).toHaveBeenCalled());
    const said = JSON.stringify(notifyFn.mock.calls[0]![0]);
    expect(said).toMatch(/0 of 1 checked/);
    expect(said).toMatch(/PV-2609-002: This voucher is already checked/);
  });
});
