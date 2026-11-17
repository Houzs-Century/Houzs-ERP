// Merchant Recon's 「2990 的单」 (owner 2026-11-17: 2990's AEON swipes on Houzs's
// terminal, 「houzs 那边的报表要确定这些和refund给2990 contra 掉」): offered on an open
// card line, it asks before booking, says where the money goes, and shows what
// was booked or why not.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { SettlementRow, SoldByResult } from './settlement-queries';

const sold: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; data: SoldByResult | undefined } = { mutate: vi.fn(), isPending: false, data: undefined };

vi.mock('./settlement-queries', () => ({
  useOtherCompanies: () => ({
    data: { companies: [
      { companyId: 2, code: '2990', name: "2990's Home", accountCode: '350-0070', accountName: 'LOAN TO RELATED PARTY - 2990 HOME SDN BHD', usable: true },
      { companyId: 3, code: 'CONTS', name: 'The Conts', accountCode: '350-0010', accountName: null, usable: false },
    ] },
  }),
  useSoldBy: () => sold,
}));

import { SoldByButtons, SoldByTag } from './SoldByOtherCompany';

const R21077: SettlementRow = {
  id: 11, line_no: 1, txn_date: '2026-10-30', ref: 'R21077', gross_sen: 399000, fee_sen: 4788, net_sen: 394212,
  bucket: 'NEEDS_CONFIRM', match_reason: null, confirmed_at: null, posted_je_no: null, notes: null,
  linked: [], candidates: [], comboHints: [], clue: null, channel: null, sold_by_company_id: null,
};

beforeEach(() => {
  sold.mutate = vi.fn();
  sold.isPending = false;
  sold.data = undefined;
});

describe('「2990 的单」 on a Merchant Recon line', () => {
  test('is offered on an open card line, for each company with an account that can take it', () => {
    render(<SoldByButtons row={R21077} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['2990 的单']);
  });

  test('is not offered on a confirmed line, a QR line, a set-aside line or a line holding this company\'s sale', () => {
    const { container, rerender } = render(<SoldByButtons row={{ ...R21077, confirmed_at: '2026-11-17T10:00:00Z' }} />);
    expect(container.textContent).toBe('');
    rerender(<SoldByButtons row={{ ...R21077, channel: 'QR' }} />);
    expect(container.textContent).toBe('');
    rerender(<SoldByButtons row={{ ...R21077, bucket: 'IGNORED' }} />);
    expect(container.textContent).toBe('');
    rerender(<SoldByButtons row={{ ...R21077, linked: [{ settlement_row_id: 11, payment_source: 'SOPAY', payment_id: 'p1', doc_no: 'HC-SO-2610-340', amount_sen: 399000 }] }} />);
    expect(container.textContent).toBe('');
  });

  test('asks first, saying where the money goes, then books with the order typed', () => {
    render(<SoldByButtons row={R21077} />);
    fireEvent.click(screen.getByRole('button', { name: '2990 的单' }));
    const ask = screen.getByTestId('sold-by-confirm');
    expect(ask.textContent).toContain("Book this line as 2990's Home’s sale?");
    expect(ask.textContent).toContain('350-0070 LOAN TO RELATED PARTY - 2990 HOME SDN BHD');
    fireEvent.change(screen.getByLabelText("2990's order"), { target: { value: ' 2990-SO-2611-017 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book as 2990 的单' }));
    expect(sold.mutate).toHaveBeenCalledWith({ rowId: 11, companyId: 2, note: '2990-SO-2611-017' }, expect.anything());
  });

  test('says what was booked', () => {
    sold.data = { ok: true, status: 'confirmed', jeNo: 'JE-2610-3001', owedSen: 383519, chargeShareSen: 10693, accountCode: '350-0070', soldBy: '2990' };
    render(<SoldByButtons row={R21077} />);
    fireEvent.click(screen.getByRole('button', { name: '2990 的单' }));
    expect(screen.getByTestId('sold-by-confirm').textContent).toContain('Booked JE-2610-3001: RM 3,835.19 owed to 2990 on 350-0070.');
  });

  test('shows the server\'s refusal in its own words', () => {
    sold.mutate = vi.fn((_vars, opts: { onError: (e: unknown) => void }) => opts.onError({ body: JSON.stringify({ error: 'linked', message: 'This line is matched to one of this company\'s own sales.' }) }));
    render(<SoldByButtons row={R21077} />);
    fireEvent.click(screen.getByRole('button', { name: '2990 的单' }));
    fireEvent.click(screen.getByRole('button', { name: 'Book as 2990 的单' }));
    expect(screen.getByRole('alert').textContent).toBe('This line is matched to one of this company\'s own sales.');
  });

  test('a booked line says whose sale it is', () => {
    render(<SoldByTag companyId={2} />);
    expect(screen.getByText('2990 的单').getAttribute('title')).toBe("2990's Home's sale, owed to it on 350-0070");
  });
});
