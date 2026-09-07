/* 批量tick yes (the owner, 2026-09-02: 这个批量的功能肯定需要). What is pinned:
     • EVERY row ticks (since 2026-09-03 a tick also means "include in the
       batch print", which applies to any voucher — a POSTED one most of
       all); each approval button still counts only the rows ITS yes
       applies to;
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
    { id: 'adv', pv_number: 'PV-2609-005', payee_name: 'Prepaid Co', status: 'POSTED', voucher_date: '2026-09-01', total_sen: 300000, currency: 'MYR', exchange_rate: 1, submitted_at: '2026-09-02T01:00:00Z', checked_at: '2026-09-02T02:00:00Z', approved_at: '2026-09-02T03:00:00Z', advance_remaining_sen: 214374 },
    /* Prepared like 'prep' but dated two months EARLIER — the batch-order case (docs/bugs/0653). */
    { id: 'prep-early', pv_number: '2990-Draft-2607-009', payee_name: 'Earlier Prepared Co', status: 'DRAFT', voucher_date: '2026-07-05', total_sen: 5000, currency: 'MYR', exchange_rate: 1, submitted_at: '2026-09-02T01:00:00Z', checked_at: null, approved_at: null },
  ] }, isLoading: false, error: null }),
  useCancelPaymentVoucher: () => ({ mutate: vi.fn(), isPending: false }),
  useSubmitPaymentVoucher: () => ({ mutateAsync: prepareAsync, isPending: false }),
  useCheckPaymentVoucher: () => ({ mutateAsync: checkAsync, isPending: false }),
  useApprovePaymentVoucher: () => ({ mutateAsync: approveAsync, isPending: false }),
  /* Batch-print fetches — never called here (no test clicks Print), stubbed
     because this factory replaces the WHOLE module. */
  fetchPvPrintDetail: vi.fn(),
  fetchPvPrintBundle: vi.fn(),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));
const notifyFn = vi.fn((_a: unknown) => undefined);
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => notifyFn }));

import { PaymentVouchers } from './PaymentVouchers';

const draw = () => render(<MemoryRouter><PaymentVouchers /></MemoryRouter>);

describe('批量 tick yes', () => {
  test('EVERY row ticks — a POSTED voucher joins the batch print, and only Print applies to it', () => {
    draw();
    const boxes = screen.getAllByLabelText('Select row') as HTMLInputElement[];
    expect(boxes).toHaveLength(6);
    /* Row order mirrors the data: raw / prepared / checked / posted / prepaid /
       earlier prepared. All tickable since a tick now also means "include in
       the batch print" (owner 2026-09-03: 可选多张 pv + document). */
    expect(boxes.map((b) => b.disabled)).toEqual([false, false, false, false, false, false]);

    fireEvent.click(boxes[3]!); // posted — printable, not approvable
    expect(screen.getByText('Print 1 + files')).toBeTruthy();
    expect(screen.getByText('Save PDF')).toBeTruthy();
    /* The files toggle (owner 2026-09-04: 批量那边也要有这个选) — default ON;
       unticking flips the button to vouchers-only. */
    fireEvent.click(screen.getByLabelText("Include each voucher's attached files"));
    expect(screen.getByText('Print 1')).toBeTruthy();
    expect(screen.queryByText('Print 1 + files')).toBeNull();
    fireEvent.click(screen.getByLabelText("Include each voucher's attached files"));
    expect(screen.getByText('Print 1 + files')).toBeTruthy();
    expect(screen.queryByText(/^Prepare \d/)).toBeNull();
    expect(screen.queryByText(/^Check \d/)).toBeNull();
    expect(screen.queryByText(/Approve & post \d/)).toBeNull();

    /* And the tick lives in the CHECKBOX alone (owner: 我一点就直接tick 了)
       — clicking the row itself must tick nothing. */
    fireEvent.click(screen.getByText('Raw Draft Co'));
    expect(screen.getByText('1 ticked')).toBeTruthy();
    expect(screen.queryByText('2 ticked')).toBeNull();
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

describe('an advance not yet knocked off (owner 2026-09-06)', () => {
  test('the row wears the open amount beside its pill, and the Advance open chip keeps only such rows', () => {
    render(<MemoryRouter><PaymentVouchers /></MemoryRouter>);
    expect(screen.getByText(/预付未冲 MYR 2,143\.74/)).toBeTruthy();
    fireEvent.click(screen.getByText('Advance open'));
    expect(screen.getByText('PV-2609-005')).toBeTruthy();
    expect(screen.queryByText('PV-2609-004')).toBeNull();
    expect(screen.queryByText('PV-2609-001')).toBeNull();
  });
});

describe('the batch runs in voucher-date order (docs/bugs/0653)', () => {
  test('ticked newest-first, Check still stamps the older voucher first — the formal number follows the date, not the mouse', async () => {
    checkAsync.mockClear(); confirmFn.mockClear(); notifyFn.mockClear();
    draw();
    const boxes = screen.getAllByLabelText('Select row') as HTMLInputElement[];
    fireEvent.click(boxes[1]!); // prepared, dated 2026-09-01 — ticked FIRST
    fireEvent.click(boxes[5]!); // earlier prepared, dated 2026-07-05 — ticked second
    expect(screen.getByText('Check 2')).toBeTruthy();
    fireEvent.click(screen.getByText('Check 2'));
    await waitFor(() => expect(checkAsync).toHaveBeenCalledTimes(2));
    expect(checkAsync.mock.calls.map((c) => c[0])).toEqual(['prep-early', 'prep']);
  });
});
