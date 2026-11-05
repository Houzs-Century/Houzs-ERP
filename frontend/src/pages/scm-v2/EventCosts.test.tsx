/* The Event costs report (owner 2026-09-30; the redesign, batch 6 §5.11):
   each event starting in the months, what was booked on it from the ledger,
   cost vs other; the shared range read in whole months; four tiles; the
   filter to events with money; a row opening to its accounts and entries;
   Excel from the rows as shown and the CSV under the header's ⋯. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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

const read = vi.fn();
vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventCosts: (from: string, to: string) => { read(from, to); return { data: REPORT, isLoading: false, isError: false, error: null }; },
}));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../vendor/scm/lib/report-sheet-pdf', () => ({ generateReportPdf: vi.fn() }));

import { EventCostsTab, eventCostsCsv, eventCostsSheet } from './EventCosts';

const draw = (search = '?tab=events&from=2026-09-01&to=2026-09-30') => render(
  <MemoryRouter initialEntries={[`/scm/accounting${search}`]}><EventCostsTab /></MemoryRouter>,
);
const events = () => within(within(screen.getByRole('region', { name: 'Events' })).getAllByRole('table')[0]!);

beforeEach(() => {
  read.mockClear();
  xlsx.mockClear();
  window.sessionStorage.removeItem('fin-report-range');
});

describe('Event costs', () => {
  test('every event with its cost and other, the tiles, the total; a row opens to its accounts and entries; the money filter', () => {
    draw();
    expect(read).toHaveBeenLastCalledWith('2026-09-01', '2026-09-30');
    const t = events();
    expect(t.getByText(/HOMELOVE @ SETIA SPICE/)).toBeTruthy();
    expect(t.getByText(/MLE @ PWCC/)).toBeTruthy();
    expect(t.getByText('cancelled')).toBeTruthy();
    const tiles = within(screen.getByRole('group', { name: 'Totals' }));
    expect(tiles.getByText('Events')).toBeTruthy();
    expect(tiles.getByText('1 with money booked')).toBeTruthy();
    expect(tiles.getByText('12,000.00')).toBeTruthy();
    expect(tiles.getByText('3,000.00')).toBeTruthy();
    /* The total row: cost and other kept apart. */
    const total = t.getAllByText('12,000.00').map((e) => e.closest('tr')!).find((tr) => tr.textContent.includes('3,000.00') && !tr.textContent.includes('SETIA'));
    expect(total).toBeTruthy();

    const row = t.getByText(/HOMELOVE @ SETIA SPICE/).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Expand row' }));
    const lines = within(screen.getByRole('table', { name: /^Entries on .*SETIA SPICE/ }));
    expect(lines.getByText('JE-2609-0012')).toBeTruthy();
    expect(lines.getByText('HC-API-2609-003')).toBeTruthy();
    /* Accounts print code over name (the house rule for an account). */
    expect(screen.getAllByText('RENTAL DEPOSIT').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('switch', { name: 'Only events with money booked' }));
    expect(screen.queryByText(/MLE @ PWCC/)).toBeNull();
    expect(tiles.getByText('1 with money booked')).toBeTruthy();
  });

  test('the shared range reads in whole months; the find box narrows by name', () => {
    draw('?tab=events&from=2026-08-15&to=2026-09-10');
    expect(read).toHaveBeenLastCalledWith('2026-08-01', '2026-09-30');
    fireEvent.change(screen.getByLabelText('Find an event'), { target: { value: 'pwcc' } });
    expect(events().queryByText(/SETIA SPICE/)).toBeNull();
    expect(events().getByText(/MLE @ PWCC/)).toBeTruthy();
  });

  test('Excel draws the events as shown, an opened event with its entries', async () => {
    draw();
    const row = events().getByText(/HOMELOVE @ SETIA SPICE/).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Expand row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, file] = xlsx.mock.calls[0] as [{ title: string; tables: Array<{ rows: Array<{ kind: string; label: string }> }> }, string];
    expect(sheet.title).toBe('Event costs');
    expect(sheet.tables[0]!.rows.map((r) => r.kind)).toEqual(['category', 'row', 'row', 'category', 'total']);
    expect(file).toBe('event-costs-2026-09-2026-09.xlsx');
    /* The CSV moved under the ⋯. */
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'CSV' })).toBeTruthy();
  });

  test('the sheet keeps cost and other apart on an entry', () => {
    const sheet = eventCostsSheet(REPORT.events, new Set(['336']), 'Sep 2026', REPORT.totals);
    const rows = sheet.tables[0]!.rows;
    expect(rows[1]!.cells.slice(3)).toEqual([1_200_000, null]);
    expect(rows[2]!.cells.slice(3)).toEqual([null, 300_000]);
    expect(rows.at(-1)).toMatchObject({ kind: 'total', cells: [null, null, null, 1_200_000, 300_000] });
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
