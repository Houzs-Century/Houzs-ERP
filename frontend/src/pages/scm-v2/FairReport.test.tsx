/* The Sales report (fair report) in the owner's Claude Design (batch 6 step 14):
   the stage tabs a reader may open (a Sales Director the Sales Orders only),
   the tiles from the stage's own summary, an SO number opening the order's
   quick view and a double-click the order itself; the P&L without a fair
   picked — every fair with orders in the period, a click opening its own P&L
   with All fairs to go back, the overhead's card spelled out; a fair with no
   order in the dates offering its own dates; Excel drawing the stage as shown;
   and an address from before the shared range opening on the range it meant.
   The server half is backend/tests/fairPnl.route.test.ts. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  FairFilters, FairPnlFairRow, FairPnlResponse, FairPnlSummary, FairSoResponse, FairStage,
} from '../../vendor/scm/lib/fair-report-queries';

const access = vi.hoisted(() => ({ stages: ['so', 'do', 'invoice', 'pnl'] as string[], management: true }));
vi.mock('../../auth/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: { id: 1, name: 'Owner' }, can: () => true }),
}));
vi.mock('../../auth/salesAccess', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fairAllowedStages: () => access.stages,
  isFairManagementUser: () => access.management,
}));

const dims = (o: Partial<Record<string, unknown>> = {}) => ({
  venue: 'MID VALLEY', venue_id: null, state: 'Kuala Lumpur', project_id: 1, project: 'KL Fair',
  project_start_date: '2026-07-03', project_end_date: '2026-07-06', salesperson_id: 'sp-1', salesperson: 'Ethan', branding: 'AKEMI', ...o,
});
const cats = { mattress_sofa_cost_sen: 20000, bedframe_cost_sen: 10000, accessories_cost_sen: 0, others_cost_sen: 0, service_cost_sen: 0 };
const tender = { Cash: 10000, Merchant: 0, Installment: 0, Online: 0 };

const SO: FairSoResponse = {
  stage: 'so',
  rows: [
    {
      ...dims(), so_date: '2026-07-04', so_no: 'SO-1', order_form: 'OF-1', amount_sen: 100000, selling_sen: 90000, service_rev_sen: 10000,
      cost_by_category: cats, total_so_cost_sen: 30000, goods_cost_sen: 30000, margin_pct: 66.7, balance_sen: 90000, paid_total_sen: 10000,
      deposit_sen: 10000, payment_methods: ['Cash'], deposit_by_tender: tender, below_deposit: true,
    },
    {
      ...dims({ salesperson_id: 'sp-2', salesperson: 'Mayson' }), so_date: '2026-07-05', so_no: 'SO-2', order_form: 'OF-2', amount_sen: 50000,
      selling_sen: 50000, service_rev_sen: 0, cost_by_category: cats, total_so_cost_sen: 20000, goods_cost_sen: 20000, margin_pct: 60,
      balance_sen: 0, paid_total_sen: 50000, deposit_sen: 0, payment_methods: ['Online'], deposit_by_tender: { ...tender, Cash: 0, Online: 50000 }, below_deposit: false,
    },
  ],
  summary: {
    orders: 2, total_amount_sen: 150000, total_selling_sen: 140000, total_service_rev_sen: 10000, total_so_cost_sen: 50000, total_goods_cost_sen: 50000,
    total_margin_sen: 90000, margin_pct: 64.3, total_balance_sen: 90000, below_deposit_count: 1, tender_totals: tender,
  },
  filters: { stage: 'so', venue: null, state: null, project: null, branding: null, salesperson: null, month: null, date_from: '2026-07-01', date_to: '2026-07-31' },
  meta: { access_tier: 'management' },
};

const summary = (o: Partial<FairPnlSummary>): FairPnlSummary => ({
  orders: 0, delivered_orders: 0, invoiced_orders: 0, total_revenue_sen: 0, total_product_rev_sen: 0, total_service_rev_sen: 0,
  total_so_cost_sen: 0, total_do_cost_sen: 0, total_si_cost_sen: 0, total_cogs_sen: 0, gross_profit_sen: 0, gross_margin_pct: null,
  overheads: { transport_sen: 0, merchandise_sen: 0, commission_sen: 0, commission_pct: 0, commission_is_boost: false, total_overhead_sen: 0 },
  net_profit_sen: 0, net_margin_pct: null, ...o,
});
const KL_SUMMARY = summary({
  orders: 2, total_revenue_sen: 150000, total_cogs_sen: 75000, gross_profit_sen: 75000, gross_margin_pct: 50,
  overheads: { transport_sen: 7500, merchandise_sen: 3000, commission_sen: 22500, commission_pct: 15, commission_is_boost: true, total_overhead_sen: 33000 },
  net_profit_sen: 42000, net_margin_pct: 28,
});
const FAIRS: FairPnlFairRow[] = [
  { project_id: 3, project: 'Penang Fair', project_start_date: '2026-07-18', project_end_date: '2026-07-27', venue: 'Spice Arena', brand: 'NOCARD', rate_present: false,
    summary: summary({ orders: 1, total_revenue_sen: 200000, total_cogs_sen: 120000, gross_profit_sen: 80000, gross_margin_pct: 40, net_profit_sen: 80000, net_margin_pct: 40 }) },
  { project_id: 1, project: 'KL Fair', project_start_date: '2026-07-03', project_end_date: '2026-07-06', venue: 'MID VALLEY', brand: 'AKEMI', rate_present: true, summary: KL_SUMMARY },
];
const pnlBase = (project: number | null): Pick<FairPnlResponse, 'stage' | 'filters'> => ({
  stage: 'pnl',
  filters: { stage: 'pnl', venue: null, state: null, project, branding: null, salesperson: null, month: null, date_from: '2026-07-01', date_to: '2026-07-31' },
});
const EVERY: FairPnlResponse = {
  ...pnlBase(null), rows: [], summary: summary({}), fairs: FAIRS, no_fair: { orders: 1, revenue_sen: 30000 },
  meta: { access_tier: 'management', needs_project: true, brand: null, rate_present: false, rate: null, fair: null },
};
const KL: FairPnlResponse = {
  ...pnlBase(1),
  rows: [
    { ...dims(), so_date: '2026-07-04', so_no: 'SO-1', order_form: 'OF-1', revenue_sen: 100000, product_rev_sen: 90000, service_rev_sen: 10000, so_cost_sen: 50000,
      do_cost_sen: 52000, si_cost_sen: 54000, effective_cost_sen: 54000, effective_cost_stage: 'invoice', gross_profit_sen: 46000, margin_pct: 46 },
    { ...dims(), so_date: '2026-07-05', so_no: 'SO-2', order_form: 'OF-2', revenue_sen: 50000, product_rev_sen: 50000, service_rev_sen: 0, so_cost_sen: 20000,
      do_cost_sen: 21000, si_cost_sen: null, effective_cost_sen: 21000, effective_cost_stage: 'do', gross_profit_sen: 29000, margin_pct: 58 },
  ],
  summary: KL_SUMMARY,
  meta: {
    access_tier: 'management', needs_project: false, brand: 'AKEMI', rate_present: true,
    rate: { transport_pct: 5, merchandise_pct: 2, commission_normal_pct: 10, commission_boost_pct: 15, boost_min_gp_pct: 40, boost_min_sales: 1000 },
    fair: { project_id: 1, project: 'KL Fair', project_start_date: '2026-07-03', project_end_date: '2026-07-06' },
  },
};
const JUNE_FAIR: FairPnlResponse = {
  ...pnlBase(4), rows: [], summary: summary({}),
  meta: {
    access_tier: 'management', needs_project: false, brand: 'AKEMI', rate_present: true, rate: KL.meta.rate,
    fair: { project_id: 4, project: 'Johor Fair', project_start_date: '2026-06-01', project_end_date: '2026-06-05' },
  },
};

const asked = vi.hoisted(() => ({ calls: [] as Array<{ stage: string; filters: Record<string, unknown>; enabled: boolean }> }));
vi.mock('../../vendor/scm/lib/fair-report-queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFairReport: (stage: FairStage, filters: FairFilters, enabled: boolean) => {
    asked.calls.push({ stage, filters: { ...filters }, enabled });
    const data = !enabled ? undefined
      : stage === 'so' ? SO
        : stage === 'pnl' ? (filters.project == null ? EVERY : filters.project === 1 ? KL : JUNE_FAIR)
          : undefined;
    return { data, isLoading: enabled && !data, isError: false, error: null };
  },
  useFairReportDetail: () => ({ data: undefined, isLoading: false, isError: false }),
  useCostingGapListing: (enabled: boolean) => ({
    data: enabled ? { rows: [{ doc_no: 'SO-9', so_date: '2026-07-09', item_code: 'MAT-X', description: 'Mattress X', item_group: 'MATTRESS', qty: 1, debtor_name: 'Tan', venue: 'MID VALLEY', branding: 'AKEMI', status: 'CONFIRMED' }] } : undefined,
    isLoading: false, isError: false, error: null,
  }),
}));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));

const { SalesReport, legacyRange } = await import('./FairReport');

const where = { pathname: '', search: '' };
function Probe() {
  const l = useLocation();
  where.pathname = l.pathname;
  where.search = l.search;
  return null;
}
const draw = (query = 'from=2026-07-01&to=2026-07-31') => render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter initialEntries={[`/reports/fair-report?${query}`]}>
      <SalesReport />
      <Probe />
    </MemoryRouter>
  </QueryClientProvider>,
);
const params = () => new URLSearchParams(where.search);
const tiles = () => screen.getByRole('group', { name: 'Sales report figures' });
const rowOf = (text: string) => screen.getByText(text).closest('tr')!;

beforeEach(() => {
  access.stages = ['so', 'do', 'invoice', 'pnl'];
  access.management = true;
  asked.calls = [];
  xlsx.mockClear();
});

describe('the Sales report', () => {
  test('opens on Sales Orders in the range: the tiles from the summary, an SO number opens the quick view, a double-click the order', () => {
    draw();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Sales Orders', 'Delivery Orders', 'Invoices', 'P&L', 'Costing Gaps']);
    expect(asked.calls.at(-1)).toMatchObject({ stage: 'so', enabled: true, filters: { dateFrom: '2026-07-01', dateTo: '2026-07-31' } });
    expect(tiles().textContent).toContain('Total orders2Confirmed, matching the filters');
    expect(tiles().textContent).toContain('Revenue1,500.0064.3% margin · goods only');
    expect(tiles().textContent).toContain('Outstanding900.001 below deposit');
    expect(tiles().textContent).toContain('Paid600.00Deposits collected');
    expect(screen.getByRole('heading', { name: 'Sales Orders' })).toBeTruthy();
    expect(screen.getByText('2 rows')).toBeTruthy();
    expect(within(rowOf('SO-1')).getByText('Below deposit')).toBeTruthy();
    expect(within(rowOf('SO-1')).getByText('2026/07/04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'SO-1' }));
    expect(params().get('so')).toBe('SO-1');
    fireEvent.doubleClick(rowOf('SO-2'));
    expect(where.pathname).toBe('/scm/sales-orders/SO-2');
  });

  test('a Sales Director has the Sales Orders only, and no Costing Gaps', () => {
    access.stages = ['so'];
    access.management = false;
    draw('from=2026-07-01&to=2026-07-31&stage=pnl');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Sales Orders']);
    expect(asked.calls.every((c) => c.stage === 'so')).toBe(true);
  });

  test('the P&L shows every fair with orders in the period, before any is picked; a click opens the fair\'s own P&L', () => {
    draw('from=2026-07-01&to=2026-07-31&stage=pnl');
    expect(asked.calls.at(-1)).toMatchObject({ stage: 'pnl', filters: { project: undefined } });
    expect(screen.getByRole('heading', { name: 'P&L · every fair' })).toBeTruthy();
    expect(screen.getByText('2 fairs · click a fair to open its P&L')).toBeTruthy();
    expect(tiles().textContent).toContain('Fairs2With orders in July 2026');
    expect(tiles().textContent).toContain('Fair revenue3,500.003 confirmed orders');
    expect(tiles().textContent).toContain('Gross profit1,550.0044.3% · COGS 1,950.00');
    expect(tiles().textContent).toContain('Net profit1,220.0034.9% net margin · after 330.00 overhead');
    const kl = rowOf('KL Fair');
    expect(within(kl).getByText('MID VALLEY')).toBeTruthy();
    expect(within(kl).getByText('2026/07/03 – 2026/07/06')).toBeTruthy();
    expect(within(kl).getByText('330.00')).toBeTruthy();
    expect(within(kl).getByText('28.0%')).toBeTruthy();
    /* A fair with no card shows a dash for its overhead, and says so below. */
    expect(screen.getByText(/No cost-rate card for this fair’s brand, so the overhead is a dash and net profit equals gross profit: Penang Fair\./)).toBeTruthy();
    expect(screen.getByText(/1 order in the period carries no fair \(300\.00\)/)).toBeTruthy();
    /* No column groups on the every-fair view. */
    expect(screen.queryByRole('button', { name: /Three-way cost/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'KL Fair' }));
    expect(params().get('project')).toBe('1');
    expect(screen.getByRole('heading', { name: 'P&L · KL Fair' })).toBeTruthy();
    expect(screen.getByText('2026/07/03 – 2026/07/06 · 2 orders')).toBeTruthy();
    expect(tiles().textContent).toContain('Overhead330.00Transport 5% + merchandise 2% + commission 15% · boost');
    expect(tiles().textContent).toContain('Net profit420.0028.0% net margin');
    expect(within(rowOf('SO-1')).getByText('SI')).toBeTruthy();
    expect(within(rowOf('SO-2')).getByText('DO')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Three-way cost/ }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'All fairs' }));
    expect(params().get('project')).toBeNull();
    expect(screen.getByRole('heading', { name: 'P&L · every fair' })).toBeTruthy();
  });

  test('a fair with no order in the dates names its own dates and offers them', () => {
    draw('from=2026-07-01&to=2026-07-31&stage=pnl&project=4');
    expect(screen.getByRole('status').textContent).toContain('No order of Johor Fair falls in July 2026. The fair ran 2026/06/01 – 2026/06/05.');
    expect(screen.queryByRole('group', { name: 'Sales report figures' })).toBeNull();
    expect(screen.getByText('2026/06/01 – 2026/06/05 · 0 orders')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use the fair’s dates' }));
    expect(params().get('from')).toBe('2026-06-01');
    expect(params().get('to')).toBe('2026-06-05');
  });

  test('Excel draws the stage as shown — a column group turned off stays off — titled for the paper head', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Cost by category/ }));
    expect(params().get('hide')).toBe('catcost');
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, file] = xlsx.mock.calls[0]! as [{ title: string; meta: Array<{ label: string; value: string }>; tables: Array<{ columns: Array<{ label: string }>; rows: Array<{ label: string; kind: string }> }> }, string];
    expect(file).toBe('sales-report-so-2026-07-01-to-2026-07-31.xlsx');
    expect(sheet.title).toBe('Sales report · Sales Orders');
    expect(sheet.meta).toEqual([{ label: 'Period', value: 'July 2026' }, { label: 'Filters', value: 'Every fair' }]);
    const heads = sheet.tables[0]!.columns.map((c) => c.label);
    expect(heads).toContain('Total SO Cost');
    expect(heads).not.toContain('Mattress / Sofa');
    expect(heads).toContain('Cash');
    expect(sheet.tables[0]!.rows.map((r) => r.label)).toEqual(['SO-1', 'SO-2', 'Total · 2 orders']);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'CSV' })).toBeTruthy();
  });

  test('Costing Gaps lists the order lines with no cost, whatever the dates', () => {
    draw('from=2026-07-01&to=2026-07-31&stage=gaps');
    expect(screen.getByRole('heading', { name: 'Costing Gaps' })).toBeTruthy();
    expect(within(rowOf('MAT-X')).getByText('Mattress X')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Sales report figures' })).toBeNull();
  });

  test('an address from before the shared range opens on the range it meant', async () => {
    draw('month=2026-06&stage=so');
    await waitFor(() => expect(params().get('from')).toBe('2026-06-01'));
    expect(params().get('to')).toBe('2026-06-30');
    expect(params().has('month')).toBe(false);
    expect(params().get('stage')).toBe('so');
  });
});

describe('legacyRange', () => {
  test('a month, dates, both AND-ed, or nothing to say', () => {
    expect(legacyRange(new URLSearchParams('month=2026-02'))).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(legacyRange(new URLSearchParams('date_from=2026-03-05&date_to=2026-03-09'))).toEqual({ from: '2026-03-05', to: '2026-03-09' });
    expect(legacyRange(new URLSearchParams('month=2026-03&date_from=2026-03-10'))).toEqual({ from: '2026-03-10', to: '2026-03-31' });
    expect(legacyRange(new URLSearchParams('date_from=2026-03-05'))).toBeNull();
    expect(legacyRange(new URLSearchParams('from=2026-01-01&to=2026-01-31&month=2026-02'))).toBeNull();
  });
});
