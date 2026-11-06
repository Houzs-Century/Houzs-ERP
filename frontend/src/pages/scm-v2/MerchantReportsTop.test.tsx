/* The report's money card (owner 2026-11-06: 做，改四格): what the acquirer's report
   takes off beyond the lines' own fee, AEON's subvention fee, is a figure of its own, and
   the last figure is what the acquirer really pays, the same amount the bank match reads. */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ReportHead } from './MerchantReportsTop';
import type { SettlementBatch } from './settlement-queries';

/* 20261105_000458030287527.csv as production holds it. */
const AEON = {
  id: 367, acquirer_code: 'AEON', file_name: '20261105_000458030287527.csv', period_from: '2026-11-05', period_to: '2026-11-05',
  row_count: 1, gross_sen: 399_000, fee_sen: 4_788, net_sen: 394_212, stated_net_sen: 378_364,
  adjustment_sen: 15_848, adjustment_je_no: null, received_on: null, received_sen: 0, outstanding_sen: 378_364,
  created_at: '2026-11-06T04:26:00Z', uploaded_by: null,
} as unknown as SettlementBatch;
const COUNTS = { 'to-confirm': 0, 'to-choose': 1, 'no-sale': 0, done: 0, 'set-aside': 0 };

const money = (batch: SettlementBatch): string => {
  render(<ReportHead batch={batch} counts={COUNTS} />);
  return screen.getByLabelText("The report's money").textContent;
};

describe('the report\'s money', () => {
  test('AEON: gross, fee, subvention fee, and the net AEON really pays', () => {
    expect(money(AEON)).toMatch(/^GrossRM 3,990\.00.*−FeeRM 47\.88.*−Subvention feeRM 158\.483\.97%.*=Net to be paid outRM 3,783\.64/);
  });

  test('no charge beyond the lines: three figures, as ever, and the lines\' net', () => {
    const text = money({ ...AEON, acquirer_code: 'MBB', net_sen: 394_212, stated_net_sen: null, adjustment_sen: 0 });
    expect(text).toMatch(/^GrossRM 3,990\.00.*−FeeRM 47\.88.*=Net to be paid outRM 3,942\.12/);
    expect(text).not.toContain('Subvention fee');
  });

  test('a report that pays more than its lines: a rebate, added', () => {
    expect(money({ ...AEON, stated_net_sen: 400_000, adjustment_sen: -5_788 })).toMatch(/−FeeRM 47\.88.*\+RebateRM 57\.88.*=Net to be paid outRM 4,000\.00/);
  });

  test('another acquirer\'s charge is not called a subvention fee', () => {
    const text = money({ ...AEON, acquirer_code: 'MBB' });
    expect(text).toContain('Other chargeRM 158.48');
    expect(text).not.toContain('Subvention fee');
  });

  test('once paid it reads what came in, not the lines', () => {
    expect(money({ ...AEON, received_on: '2026-11-06', received_sen: 378_364, outstanding_sen: 0 })).toMatch(/=Net · paid outRM 3,783\.64In the bank/);
  });
});
