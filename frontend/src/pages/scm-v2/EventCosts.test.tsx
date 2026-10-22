/* The Event costs tab (owner 2026-09-30): each event starting in the months,
   what was booked on it from the ledger, cost vs other; the filter to events
   with money, a row opening to its accounts and entries, and the CSV. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { EventCosts } from '../../vendor/scm/lib/event-queries';

const REPORT: EventCosts = {
  from: '2026-09-01', to: '2026-09-30',
  events: [
    {
      event: { id: 336, code: 'E-336', name: 'Pulau Pinang [AKEMI] HOMELOVE @ SETIA SPICE', startDate: '2026-09-04', endDate: '2026-09-06', status: 'confirmed', archived: false, venue: null, brand: 'AKEMI', organizer: 'HOMELOVE', boothNo: '1129-1132' },
      costSen: 1_200_000, otherSen: 300_000,
      accounts: [
        { accountCode: '200-D001', accountName: 'RENTAL DEPOSIT', accountType: 'ASSET', amountSen: 300_000 },
        { accountCode: '900-A001', accountName: 'RENTAL', accountType: 'EXPENSE', amountSen: 1_200_000 },
      ],
      lines: [
        { jeNo: 'JE-2609-0012', entryDate: '2026-09-02', sourceType: 'PV', sourceDocNo: 'HC-PV-2609-001', accountCode: '900-A001', notes: 'Booth rental — HC-PV-2609-001', amountSen: 1_200_000 },
        { jeNo: 'JE-2609-0040', entryDate: '2026-09-20', sourceType: 'API', sourceDocNo: 'HC-API-2609-003', accountCode: '200-D001', notes: 'Deposit', amountSen: 300_000 },
      ],
    },
    {
      event: { id: 348, code: 'E-348', name: 'Pulau Pinang [AKEMI] MLE @ PWCC', startDate: '2026-09-25', endDate: '2026-09-27', status: 'cancelled', archived: false, venue: null, brand: 'AKEMI', organizer: 'MLE', boothNo: 'F1' },
      costSen: 0, otherSen: 0, accounts: [], lines: [],
    },
  ],
  totals: { costSen: 1_200_000, otherSen: 300_000 },
};

vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventCosts: () => ({ data: REPORT, isLoading: false, isError: false, error: null }),
}));

import { EventCostsTab, eventCostsCsv } from './EventCosts';

describe('the Event costs tab', () => {
  test('lists every event with its cost and other; the filter keeps only events with money; a row opens to its accounts and entries', () => {
    render(<EventCostsTab />);
    const table = screen.getByRole('table');
    expect(within(table).getByText(/HOMELOVE @ SETIA SPICE/)).toBeTruthy();
    expect(within(table).getByText(/MLE @ PWCC/)).toBeTruthy();
    expect(within(table).getByText('cancelled')).toBeTruthy();
    /* Totals: cost and other kept apart. */
    const totalRow = within(table).getByText('Total').closest('tr')!;
    expect(totalRow.textContent).toContain('12,000.00');
    expect(totalRow.textContent).toContain('3,000.00');

    fireEvent.click(within(table).getByText(/HOMELOVE @ SETIA SPICE/));
    expect(screen.getByText('JE-2609-0012')).toBeTruthy();
    expect(screen.getByText('HC-API-2609-003')).toBeTruthy();
    /* Accounts print code over name (the house rule for an account). */
    expect(screen.getAllByText('RENTAL DEPOSIT').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText('Only events with money booked'));
    expect(screen.queryByText(/MLE @ PWCC/)).toBeNull();
    expect(screen.getByText(/1 with money booked/)).toBeTruthy();
  });

  test('the CSV carries each event, its entries under it, and the totals', () => {
    const csv = eventCostsCsv(REPORT);
    const rows = csv.trim().split('\n');
    expect(rows[0]).toBe('"Event","Dates","Status","Entry","Date","Document","Account","Notes","Cost","Other"');
    expect(rows[1]).toContain('"Pulau Pinang [AKEMI] HOMELOVE @ SETIA SPICE"');
    expect(rows[1]).toContain('"12,000.00","3,000.00"');
    /* The rental entry lands under Cost, the deposit under Other. */
    expect(rows[2]).toMatch(/"JE-2609-0012".*"900-A001".*"12,000.00",""$/);
    expect(rows[3]).toMatch(/"JE-2609-0040".*"200-D001".*"","3,000.00"$/);
    expect(rows.at(-1)).toBe('"Total","","","","","","","","12,000.00","3,000.00"');
  });
});
