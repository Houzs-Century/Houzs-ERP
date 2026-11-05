// Not yet billed in the owner's redesign (Finance › Money in, batch 5): the
// four cards (Over 12 months absolute, the rest following the list), the age
// chips counting under the search, the age tags, and the DO / SO numbers that
// open their documents.

import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { fmtDate } from '../../vendor/shared/format';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: fetchMock }));
// Pull-to-refresh needs the app's toast provider; the page under test does not.
vi.mock('../../components/PullToRefresh', () => ({ PullToRefresh: ({ children }: { children: ReactNode }) => <>{children}</> }));

import { UnbilledDeliveriesV2 } from './UnbilledDeliveriesV2';

const row = (n: number, age: number, unbilled: number, extra: Record<string, unknown> = {}) => ({
  delivery_order_id: `do-${n}`, do_number: `HC-DO-26-00${n}`, do_date: todayMyt(-age), age_days: age,
  bucket: 'b', bucket_label: 'b', status: 'DELIVERED', so_doc_no: `HC-SO-26-00${n}`,
  debtor_code: `300-C00${n}`, debtor_name: `Customer ${n}`, phone: null, salesperson: 'Mei Ling',
  delivered_sen: unbilled * 2, invoiced_sen: unbilled, returned_sen: 0, unbilled_sen: unbilled,
  lines_total: 5, lines_pending: 2, partly_invoiced: false, ...extra,
});

const ROWS = [
  row(1, 400, 50000),
  row(2, 120, 30000, { partly_invoiced: true, debtor_name: 'Teresa Goh' }),
  row(3, 45, 20000),
  row(4, 10, 10000),
];

const renderAt = (url = '/scm/unbilled-deliveries') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}><UnbilledDeliveriesV2 /></MemoryRouter>
    </QueryClientProvider>,
  );
};

/** A figure card by its label (the chip of the same name is a button). */
const card = (label: string): HTMLElement => {
  const el = screen.getAllByText(label).find((n) => n.closest('button') == null);
  return el?.closest('div') as HTMLElement;
};
const chipTexts = () => within(screen.getByRole('group', { name: 'Age' })).getAllByRole('button').map((b) => b.textContent);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    as_of: todayMyt(),
    rows: ROWS,
    buckets: [],
    // Deliberately not the sum of the rows: the card reads the server's absolute figure.
    totals: { rows: 4, unbilled_sen: 110000, over_365: { rows: 7, unbilled_sen: 999900 }, partly_invoiced: { rows: 1, unbilled_sen: 30000 } },
  });
});

describe('Not yet billed', () => {
  test('header, and the four cards on the default Aged 31+ filter', async () => {
    renderAt();
    expect(await screen.findByRole('link', { name: 'HC-DO-26-001' })).toBeTruthy();
    // The phone's own heading and the desktop header both say it (CSS picks one).
    expect(screen.getAllByRole('heading', { name: 'Not yet billed' })).toHaveLength(2);
    expect(screen.getByText('Finance · Money in')).toBeTruthy();

    // Over 12 months: the server's absolute count and money, whatever the filter.
    expect(within(card('Over 12 months')).getByText('7')).toBeTruthy();
    expect(within(card('Over 12 months')).getByText('RM 9,999.00 not billed')).toBeTruthy();
    // The rest follow the rows on screen: 3 deliveries aged 31+.
    expect(within(card('Not billed')).getByText('RM 1,000.00')).toBeTruthy();
    expect(within(card('Not billed')).getByText('Scoped to the filter · 3 deliveries')).toBeTruthy();
    expect(within(card('Partly billed')).getByText('1')).toBeTruthy();
    expect(within(card('Partly billed')).getByText('Invoiced in part, the rest not')).toBeTruthy();
    expect(within(card('Oldest')).getByText('400 days')).toBeTruthy();
    expect(within(card('Oldest')).getByText(`Delivered ${fmtDate(todayMyt(-400))}`)).toBeTruthy();
  });

  test('the age chips count, Aged 31+ on by default', async () => {
    renderAt();
    await screen.findByRole('link', { name: 'HC-DO-26-001' });
    expect(chipTexts()).toEqual(['All ages4', 'Aged 31+3', 'Over 90 days2', 'Over 12 months1']);
    expect(screen.getByRole('button', { name: /^Aged 31\+/ }).getAttribute('aria-pressed')).toBe('true');
    // The newest delivery is billing lag, not on screen until All ages.
    expect(screen.queryByRole('link', { name: 'HC-DO-26-004' })).toBeNull();
  });

  test('the counts follow the search; Over 12 months does not move', async () => {
    renderAt('/scm/unbilled-deliveries?q=Teresa');
    await screen.findByRole('link', { name: 'HC-DO-26-002' });
    expect(chipTexts()).toEqual(['All ages1', 'Aged 31+1', 'Over 90 days1', 'Over 12 months0']);
    expect(within(card('Over 12 months')).getByText('7')).toBeTruthy();
    expect(within(card('Not billed')).getByText('Scoped to the filter · 1 delivery')).toBeTruthy();
  });

  test('ages are tags; the DO and SO numbers open their documents; a part-billed DO says how much', async () => {
    renderAt('/scm/unbilled-deliveries?age=all');
    const doLink = await screen.findByRole('link', { name: 'HC-DO-26-002' });
    expect(doLink.getAttribute('href')).toBe('/scm/delivery-orders/do-2');
    expect(screen.getByRole('link', { name: 'HC-SO-26-002' }).getAttribute('href')).toBe('/scm/sales-orders/HC-SO-26-002');
    const tr = doLink.closest('tr') as HTMLTableRowElement;
    expect(within(tr).getByText('120 days')).toBeTruthy();
    expect(within(tr).getByText('2 of 5 lines')).toBeTruthy();
  });

  test('the design’s money columns show; Phone and DO Status wait in Columns', async () => {
    renderAt();
    await screen.findByRole('link', { name: 'HC-DO-26-001' });
    // Headers are title-cased by the table.
    expect(screen.getByRole('columnheader', { name: /Delivered Value/ })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /Already Billed/ })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: /Phone/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: /DO Status/ })).toBeNull();
  });

  test('an empty filter says so in the design’s words', async () => {
    renderAt('/scm/unbilled-deliveries?age=over365&q=nobody');
    expect((await screen.findAllByText('Nothing delivered and unbilled in this filter.')).length).toBeGreaterThan(0);
  });

  test('while the report loads the cards show a dash, not RM 0.00', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderAt();
    expect(within(card('Not billed')).getByText('—')).toBeTruthy();
    expect(within(card('Not billed')).getByText('Loading…')).toBeTruthy();
  });
});
