/* The Payment listing (owner 2026-11-08: 「每天要过账的listing，就算pv号码，名字，
   description, purpose，包含bank account number 这些」, 「我能自己filter 吗？」).
   Pinned: it opens on what is not posted yet (Prepared and Checked) dated up to
   today; the stages are asked of the server, the payee and the account paid from
   narrow what came back; the summary and the footer total the ringgit (a voucher
   in another currency at its rate, its own amount shown under it); no stage asks
   nothing; Print prints the listing's own columns, the rows on screen, and says
   what it was cut to. The server's side is pinned in backend/tests/pvListing.test.ts. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string; pv_number: string; stage: string };
const { asks, printed, ROWS } = vi.hoisted(() => {
  const at = (id: string, pv_number: string, stage: string, over: Record<string, unknown>): Row => ({
    id, pv_number, stage, status: 'DRAFT', currency: 'MYR', exchange_rate: 1, credit_account_code: '310-0010', supplier: null,
    notes: null, purpose_text: '', pay_bank: null, pay_account_no: null, pay_account_name: null, ...over,
  });
  return {
    asks: [] as Array<{ from: string; to: string; stages: string[] }>,
    printed: [] as Array<{ view: { keys: string[]; matrix: { body: unknown[][] }; rows: readonly Row[] }; opts: { subtitle: string; action?: string } }>,
    ROWS: [
      at('a', 'HC-Draft-2611-002', 'PREPARED', { voucher_date: '2026-11-02', payee_name: 'MK PROPERTIES', total_sen: 150_000, notes: 'Booth deposit IOI City', purpose_text: 'HC-PRQ-2611-004 Booth deposit', pay_bank: 'MAYBANK', pay_account_no: '5140 1234 5678', pay_account_name: 'MK PROPERTIES SDN BHD' }),
      at('b', 'HC-HPV-2611-001', 'CHECKED', { voucher_date: '2026-11-03', payee_name: 'TNB', total_sen: 32_050, notes: 'Electricity October', purpose_text: 'ELECTRICITY', credit_account_code: '310-0020' }),
      at('c', 'HC-HPV-2611-002', 'CHECKED', { voucher_date: '2026-11-04', payee_name: 'FOSHAN CHAIRS', total_sen: 100_000, currency: 'RMB', exchange_rate: 0.65, pay_bank: 'BANK OF CHINA', pay_account_no: '6217 0000' }),
      at('d', 'HC-HPV-2610-009', 'POSTED', { status: 'POSTED', voucher_date: '2026-10-05', payee_name: 'OLD CO', total_sen: 5_000 }),
    ],
  };
});
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  usePaymentListing: (q: { from: string; to: string; stages: string[] }) => {
    asks.push(q);
    return { data: { vouchers: ROWS.filter((r) => q.stages.includes(r.stage)), from: q.from || null, to: q.to, stages: q.stages }, isLoading: false, isError: false, error: null };
  },
}));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  useAccounts: () => ({ data: { accounts: [{ account_code: '310-0010', account_name: 'MAYBANK' }, { account_code: '310-0020', account_name: 'HONG LEONG BANK' }] } }),
}));
vi.mock('../../vendor/scm/lib/payment-listing-pdf', () => ({
  generatePaymentListingPdf: async (view: (typeof printed)[number]['view'], opts: (typeof printed)[number]['opts']) => { printed.push({ view, opts }); },
}));

import { PaymentListing, listingSubtitle } from './PaymentListing';
import { todayMyt } from '../../vendor/scm/lib/dates';

const draw = () => render(<MemoryRouter><PaymentListing /></MemoryRouter>);
const summary = () => screen.getByText(/voucher(s)? · RM/).textContent;
afterEach(() => { asks.length = 0; printed.length = 0; });

describe('the Payment listing', () => {
  test('opens on Prepared and Checked dated up to today, a line each with its bank, the ringgit totalled', () => {
    draw();
    expect(asks.at(-1)).toEqual({ from: '', to: todayMyt(), stages: ['PREPARED', 'CHECKED'] });
    for (const no of ['HC-Draft-2611-002', 'HC-HPV-2611-001', 'HC-HPV-2611-002']) expect(screen.getByText(no)).toBeTruthy();
    expect(screen.queryByText('HC-HPV-2610-009')).toBeNull();
    const row = screen.getByText('HC-Draft-2611-002').closest('tr')!;
    for (const cell of ['MK PROPERTIES', 'Booth deposit IOI City', 'HC-PRQ-2611-004 Booth deposit', 'MAYBANK', '5140 1234 5678', '1,500.00', 'Prepared']) {
      expect(within(row).getByText(cell)).toBeTruthy();
    }
    /* RMB 1,000 at 0.65 leaves the bank as RM 650; its own amount stands under it. */
    const foreign = screen.getByText('HC-HPV-2611-002').closest('tr')!;
    expect(within(foreign).getByText('650.00')).toBeTruthy();
    expect(within(foreign).getByText(/RMB/)).toBeTruthy();
    expect(summary()).toBe('3 vouchers · RM 2,470.50 · Prepared 1 · Checked 2');
  });

  test('the stages are asked of the server; the payee and the account paid from narrow what came back', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Approved' }));
    expect(asks.at(-1)!.stages).toEqual(['PREPARED', 'CHECKED', 'POSTED']);
    expect(screen.getByText('HC-HPV-2610-009')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Payee'), { target: { value: 'tnb' } });
    expect(screen.getByText('HC-HPV-2611-001')).toBeTruthy();
    expect(screen.queryByText('HC-Draft-2611-002')).toBeNull();
    expect(summary()).toBe('1 voucher · RM 320.50 · Checked 1');
    fireEvent.change(screen.getByLabelText('Payee'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Pay from'), { target: { value: '310-0020' } });
    expect(screen.getByText('HC-HPV-2611-001')).toBeTruthy();
    expect(screen.queryByText('HC-HPV-2611-002')).toBeNull();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026/11/01' } });
  });

  test('no stage asks nothing and says so', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Prepared' }));
    fireEvent.click(screen.getByRole('button', { name: 'Checked' }));
    expect(asks.at(-1)!.stages).toEqual([]);
    expect(screen.getAllByText('Pick at least one stage.').length).toBeGreaterThan(0);
  });

  test('Print prints the listing\'s own columns and the rows on screen, and says what it was cut to', async () => {
    draw();
    fireEvent.change(screen.getByLabelText('Pay from'), { target: { value: '310-0010' } });
    fireEvent.click(screen.getByRole('button', { name: /Print/ }));
    await vi.waitFor(() => expect(printed).toHaveLength(1));
    const { view, opts } = printed[0]!;
    expect(view.keys).toEqual(['pv_number', 'voucher_date', 'payee', 'description', 'purpose', 'bank', 'accountNo', 'amount', 'stage']);
    expect(view.rows.map((r) => r.pv_number)).toEqual(['HC-Draft-2611-002', 'HC-HPV-2611-002']);
    expect(view.matrix.body[0]).toEqual(['HC-Draft-2611-002', '2026-11-02', 'MK PROPERTIES', 'Booth deposit IOI City', 'HC-PRQ-2611-004 Booth deposit', 'MAYBANK', '5140 1234 5678', 1500, 'Prepared']);
    expect(opts.action).toBe('print');
    expect(opts.subtitle).toContain('at Prepared and Checked.');
    expect(opts.subtitle).toContain('Pay from: 310-0010 · MAYBANK.');
  });
});

describe('the sentence on top of the printed listing', () => {
  test('the days, the stages and the filters, in words', () => {
    expect(listingSubtitle({ from: '', to: '2026-11-08', stages: ['PREPARED', 'CHECKED'], payee: '', payFrom: '' }))
      .toBe('Vouchers dated up to 2026/11/08, at Prepared and Checked. All amounts in RM; a voucher in another currency shows its own amount under the ringgit.');
    expect(listingSubtitle({ from: '2026-11-01', to: '2026-11-08', stages: ['DRAFT', 'PREPARED', 'POSTED'], payee: ' tnb ', payFrom: '310-0020 · HONG LEONG BANK' }))
      .toBe('Vouchers dated 2026/11/01 to 2026/11/08, at Draft, Prepared and Approved. Payee: tnb. Pay from: 310-0020 · HONG LEONG BANK. All amounts in RM; a voucher in another currency shows its own amount under the ringgit.');
  });
});
