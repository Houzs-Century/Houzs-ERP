/* Part-time sales pay (owner 2026-10-14). Pinned: the sheet lists everyone
   who logged into the POS or sold at the event with their days, arrival times
   and sales; the figures preview from the rates as the owner types; one WiFi
   tick at a time; the owner saves what is ticked; HR sees Confirm on a saved
   row and nothing to key; a confirmed row shows its request, stage and the
   bank slip on the voucher that paid it. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PartTimeSheet, SheetLine } from '../../vendor/scm/lib/part-time-pay-queries';

let sheet: PartTimeSheet;
const saved = vi.fn();
const confirmed = vi.fn();
const removed = vi.fn();
const opened = vi.fn();
vi.mock('../../vendor/scm/lib/part-time-pay-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/part-time-pay-queries')>()),
  usePartTimeEvents: () => ({ data: { events: [{ id: 348, code: null, name: 'Kuala Lumpur [ZANOTTI] REX @ MITEC', startDate: '2026-10-13', endDate: '2026-10-15', status: 'confirmed', archived: false, venue: 'MITEC', brand: null, organizer: null, boothNo: null }] } }),
  usePartTimeSheet: () => ({ data: sheet, isLoading: false, isError: false, error: null }),
  useSavePartTimeSheet: () => ({ mutateAsync: (b: unknown) => { saved(b); return Promise.resolve({ ok: true, rows: [] }); }, isPending: false }),
  useRemovePartTimeRow: () => ({ mutateAsync: (id: string) => { removed(id); return Promise.resolve({ ok: true }); }, isPending: false }),
  useConfirmPartTimeRow: () => ({ mutateAsync: (id: string) => { confirmed(id); return Promise.resolve({ ok: true, request: { id: 'req-1', requestNo: 'HC-PRQ-2610-009' } }); }, isPending: false }),
  fetchPartTimeSlipUrl: (rowId: string, fileId: string) => { opened(rowId, fileId); return Promise.resolve({ url: 'blob:slip', contentType: 'application/pdf' }); },
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => () => Promise.resolve(true) }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => () => undefined }));

import { PartTimePay } from './PartTimePay';

const AINA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const line = (over: Partial<SheetLine>): SheetLine => ({
  staffId: AINA, staffName: 'Aina', staffCode: 'PT01',
  days: [
    { date: '2026-10-13', firstLoginAt: '2026-10-12T23:30:00.000Z', lastLogoutAt: '2026-10-13T14:00:00.000Z', logins: 1, orders: 1 },
    { date: '2026-10-14', firstLoginAt: '2026-10-14T01:05:00.000Z', lastLogoutAt: null, logins: 2, orders: 1 },
    { date: '2026-10-15', firstLoginAt: '2026-10-15T01:00:00.000Z', lastLogoutAt: null, logins: 1, orders: 0 },
  ],
  suggestedDays: 3, salesSen: 500_000, orderCount: 2, saved: null, salesChanged: false,
  ...over,
});

beforeEach(() => {
  saved.mockReset(); confirmed.mockReset(); removed.mockReset(); opened.mockReset();
  window.open = vi.fn();
  sheet = {
    event: { id: 348, code: null, name: 'Kuala Lumpur [ZANOTTI] REX @ MITEC', startDate: '2026-10-13', endDate: '2026-10-15', status: 'confirmed', archived: false, venue: 'MITEC', brand: null, organizer: null, boothNo: null },
    rates: { commissionBps: 200, dayRateSen: 12_000, wifiSen: 2_000 },
    purpose: 'Part-time sales — Kuala Lumpur [ZANOTTI] REX @ MITEC (2026-10-13 to 2026-10-15)',
    lines: [line({}), line({ staffId: BEN, staffName: 'Ben', staffCode: 'PT02', days: [{ date: '2026-10-14', firstLoginAt: '2026-10-14T01:00:00.000Z', lastLogoutAt: null, logins: 1, orders: 0 }], suggestedDays: 1, salesSen: 0, orderCount: 0 })],
    canRequest: true,
    canConfirm: false,
  };
});

const draw = () => render(<MemoryRouter initialEntries={['/scm/hr/part-time-pay?event=348']}><PartTimePay /></MemoryRouter>);
const row = (id: string) => within(screen.getByTestId(`row-${id}`));

describe('Part-time pay sheet', () => {
  test('lists the salespeople with their days, arrival times and sales; the figures preview from the rates', () => {
    draw();
    expect(screen.getByText(/2% of sales · RM 120\.00 a day · WiFi RM 20\.00/)).toBeTruthy();
    expect(screen.getByText(/On the voucher and the receipt: Part-time sales — Kuala Lumpur/)).toBeTruthy();
    const aina = row(AINA);
    expect(aina.getByText('Aina')).toBeTruthy();
    expect(aina.getByText('3 days')).toBeTruthy();
    const days = within(aina.getByRole('list', { name: "Aina's days" })).getAllByRole('listitem');
    expect(days).toHaveLength(3);
    expect(days[0].textContent).toMatch(/2026\/10\/13 · in \d{1,2}:\d{2}.*· out \d{1,2}:\d{2}.*· 1 order/);
    expect(aina.getByText('RM 5,000.00')).toBeTruthy();
    /* 3 × 120 and 2% of 5,000 preview before anything is saved. */
    expect(aina.getByText('RM 360.00')).toBeTruthy();
    expect(aina.getByText('RM 100.00')).toBeTruthy();
    expect(aina.getByText('RM 460.00')).toBeTruthy();
    expect(aina.getByText('Not on the sheet')).toBeTruthy();
    const ben = row(BEN);
    expect(ben.getByText('1 day')).toBeTruthy();
    expect(ben.getAllByText('RM 0.00').length).toBeGreaterThan(0);
  });

  test('the owner ticks who goes on the sheet, keys days, WiFi (one at a time) and the bank, and saves', async () => {
    draw();
    const aina = row(AINA);
    const ben = row(BEN);
    fireEvent.click(aina.getByLabelText('Put Aina on the sheet'));
    fireEvent.click(ben.getByLabelText('Put Ben on the sheet'));
    fireEvent.change(aina.getByLabelText('Aina days paid'), { target: { value: '2' } });
    fireEvent.click(ben.getByLabelText('WiFi allowance to Ben'));
    fireEvent.click(aina.getByLabelText('WiFi allowance to Aina'));
    expect((ben.getByLabelText('WiFi allowance to Ben') as HTMLInputElement).checked).toBe(false);
    expect((aina.getByLabelText('WiFi allowance to Aina') as HTMLInputElement).checked).toBe(true);
    /* 2 × 120 + 100 + 20 */
    expect(aina.getByText('RM 360.00')).toBeTruthy();
    fireEvent.change(aina.getByLabelText('Aina bank'), { target: { value: 'Maybank' } });
    fireEvent.change(aina.getByLabelText('Aina account no'), { target: { value: '1234567890' } });
    fireEvent.change(aina.getByLabelText('Aina account name'), { target: { value: 'AINA BINTI AHMAD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sheet' }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(saved.mock.calls[0][0]).toEqual({
      projectId: 348,
      rows: [
        { staffId: AINA, days: 2, wifi: true, bankName: 'Maybank', bankAccountNo: '1234567890', bankAccountName: 'AINA BINTI AHMAD', note: null },
        { staffId: BEN, days: 1, wifi: false, bankName: null, bankAccountNo: null, bankAccountName: null, note: null },
      ],
    });
  });

  test('HR sees a saved row waiting, confirms it, keys nothing; a stale row cannot be confirmed', async () => {
    sheet.canRequest = false;
    sheet.canConfirm = true;
    const savedRow = {
      id: 'row-1', status: 'DRAFT' as const, days: 3, sales_sen: 500_000, commission_bps: 200, commission_sen: 10_000, day_rate_sen: 12_000, salary_sen: 36_000, wifi_sen: 2_000, total_sen: 48_000,
      bank_name: 'Maybank', bank_account_no: '1234567890', bank_account_name: 'AINA BINTI AHMAD', note: null, request_id: null, requested_by_name: 'Ummu', confirmed_by: null, confirmed_at: null,
      breakdown: '3 days × RM 120.00 = RM 360.00; sales RM 5,000.00 × 2% = RM 100.00; WiFi RM 20.00. Total RM 480.00.', answer: null,
    };
    sheet.lines = [line({ saved: savedRow }), line({ staffId: BEN, staffName: 'Ben', saved: { ...savedRow, id: 'row-2', wifi_sen: 0, total_sen: 46_000 }, salesChanged: true, salesSen: 550_000 })];
    draw();
    const aina = row(AINA);
    expect(aina.getByText(/Keyed by Ummu, waiting for HR/)).toBeTruthy();
    expect(aina.queryByLabelText('Aina days paid')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save sheet' })).toBeNull();
    fireEvent.click(aina.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(confirmed).toHaveBeenCalledWith('row-1'));
    const ben = row(BEN);
    expect(ben.getByText(/changed since saved \(RM 5,000\.00\) — save again/)).toBeTruthy();
    expect((ben.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('a confirmed row shows its request, the stage and the bank slip; the owner cannot change it', async () => {
    sheet.lines = [line({
      saved: {
        id: 'row-1', status: 'CONFIRMED', days: 3, sales_sen: 500_000, commission_bps: 200, commission_sen: 10_000, day_rate_sen: 12_000, salary_sen: 36_000, wifi_sen: 2_000, total_sen: 48_000,
        bank_name: 'Maybank', bank_account_no: '1234567890', bank_account_name: 'AINA BINTI AHMAD', note: null, request_id: 'req-1', requested_by_name: 'Ummu', confirmed_by: 'Mei Ling', confirmed_at: '2026-10-16T02:00:00.000Z',
        breakdown: '3 days × RM 120.00 = RM 360.00; sales RM 5,000.00 × 2% = RM 100.00; WiFi RM 20.00. Total RM 480.00.',
        answer: {
          id: 'req-1', requestNo: 'HC-PRQ-2610-009', status: 'VOUCHERED', stage: 'PAID', financeNote: null,
          voucher: { id: 'pv-1', pvNumber: 'HCMPV-2610-004', status: 'POSTED', approvedAt: '2026-10-17T02:00:00.000Z', postedAt: '2026-10-17T02:00:00.000Z', bankConfirmed: false },
          invoice: null,
          slips: [{ id: 'f-1', fileName: 'bank-slip.pdf', mime: 'application/pdf', sizeBytes: 1200, createdAt: '2026-10-17T02:05:00.000Z' }],
        },
      },
    })];
    draw();
    const aina = row(AINA);
    expect(aina.getByText(/Confirmed by Mei Ling/)).toBeTruthy();
    expect(aina.getByText('HC-PRQ-2610-009').getAttribute('href')).toBe('/scm/payment-requests?open=req-1');
    expect(aina.getByText('Paid · 已付 · HCMPV-2610-004')).toBeTruthy();
    expect(aina.getByText('RM 480.00')).toBeTruthy();
    expect(aina.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(aina.queryByRole('button', { name: 'Remove' })).toBeNull();
    fireEvent.click(aina.getByRole('button', { name: 'Bank slip · bank-slip.pdf' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith('row-1', 'f-1'));
    expect(window.open).toHaveBeenCalledWith('blob:slip', '_blank', 'noopener');
  });
});
