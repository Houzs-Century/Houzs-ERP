// Outstanding in the owner's redesign (Finance › Money in, batch 5): the cards
// in the design's order, the summary's notes kept on them, the list's status
// and due tags, the sand tint on an invoice still owed, and the view held in
// the URL (?mod=&mode=&from=&to=). The PO chasing card has its own file
// (Outstanding.poLines.test.tsx).

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { fmtDate } from '../../vendor/shared/format';

/* One fixed instant, midday in Malaysia, set before the module-level dates below
   are worked out: TODAY / TEN_DAYS_AGO were read once at import while the page
   reads todayMyt() at render, so a run that crossed MYT midnight compared two
   different days and failed. */
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T04:00:00Z'));
});
afterAll(() => { vi.useRealTimers(); });

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  summary: {} as Record<string, unknown>,
  summaryLoading: false,
  rowsCalls: [] as Array<{ module: string; opts: { mode?: string; from?: string; to?: string } }>,
}));

vi.mock('../../vendor/scm/lib/outstanding-queries', () => ({
  useOutstanding: (module: string, opts: { mode?: string; from?: string; to?: string }) => {
    state.rowsCalls.push({ module, opts });
    return { data: { rows: state.rows[module] ?? [] }, isLoading: false, error: null };
  },
  useOutstandingSummary: () => (state.summaryLoading
    ? { data: undefined, isLoading: true, error: null }
    : { data: { summary: state.summary }, isLoading: false, error: null }),
  useOutstandingPoLines: () => ({ data: { rows: [] }, isLoading: false, error: null }),
}));

import { Outstanding } from './Outstanding';

const TODAY = todayMyt();
const TEN_DAYS_AGO = todayMyt(-10);
const IN_25_DAYS = todayMyt(25);

const SI_ROWS = [
  { id: 'si-1', invoice_number: 'HC-SI-2610-001', invoice_date: todayMyt(-40), due_date: TEN_DAYS_AGO, debtor_name: 'Teresa Goh',
    total_sen: 100000, paid_sen: 0, so_deposit_applied_sen: 0, outstanding_sen: 100000, status: 'SENT', is_outstanding: true },
  { id: 'si-2', invoice_number: 'HC-SI-2610-002', invoice_date: todayMyt(-5), due_date: IN_25_DAYS, debtor_name: 'Daniel Ooi',
    total_sen: 50000, paid_sen: 20000, so_deposit_applied_sen: 0, outstanding_sen: 30000, status: 'PARTIALLY_PAID', is_outstanding: true },
];

let search = '';
function UrlProbe() {
  search = useLocation().search;
  return null;
}

const renderAt = (url = '/scm/outstanding') =>
  render(<MemoryRouter initialEntries={[url]}><Outstanding /><UrlProbe /></MemoryRouter>);

const lastRowsCall = () => state.rowsCalls[state.rowsCalls.length - 1];
const rangeButton = () => screen.getByRole('button', { name: /^Document dates:/ });

beforeEach(() => {
  state.rows = { si: SI_ROWS };
  state.summary = {
    si: { count: 2, total_sen: 150000, total_outstanding_sen: 130000, deposit_applied: false, deposit_note: 'Deposits not subtracted.' },
    so: { count: 3, total_sen: 1234500, total_outstanding_sen: 0 },
    do: { count: 1, total_sen: 0, total_outstanding_sen: 0 },
    po: { count: 0, total_sen: 0, total_outstanding_sen: 0 },
    grn: { count: 5, total_sen: 0, total_outstanding_sen: 0 },
    pi: { count: 1, total_sen: 80000, total_outstanding_sen: 25000 },
    pr: { count: 2, total_sen: 0, total_outstanding_sen: 0 },
  };
  state.summaryLoading = false;
  state.rowsCalls = [];
  search = '';
});

describe('Outstanding — the cards', () => {
  test('one card per module in the design order, then PO chasing; SI is picked first', () => {
    renderAt();
    expect(screen.getByRole('heading', { name: 'Outstanding' })).toBeTruthy();
    expect(screen.getByText('Finance · Money in')).toBeTruthy();
    const labels = ['SI · Sales invoices', 'SO · Sales orders', 'DO · Deliveries', 'PO · Purchase orders',
      'GRN · Goods received', 'PI · Purchase invoices', 'PR · Purchase returns', 'PO chasing'];
    const nodes = labels.map((l) => screen.getByText(l));
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: /SI · Sales invoices/ }).getAttribute('aria-pressed')).toBe('true');
  });

  test('money modules show RM, the others count documents; the SI ceiling says "at most"', () => {
    renderAt();
    const si = screen.getByRole('button', { name: /SI · Sales invoices/ });
    expect(within(si).getByText('at most RM 1,300.00')).toBeTruthy();
    expect(si.getAttribute('title')).toBe('Deposits not subtracted.');
    expect(within(screen.getByRole('button', { name: /SO · Sales orders/ })).getByText('RM 12,345.00')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /DO · Deliveries/ })).getByText('1 document')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /GRN · Goods received/ })).getByText('5 documents')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /PI · Purchase invoices/ })).getByText('RM 250.00')).toBeTruthy();
    // The summary sums no refund, so PR counts documents rather than invent a total.
    expect(within(screen.getByRole('button', { name: /PR · Purchase returns/ })).getByText('2 documents')).toBeTruthy();
  });

  test('a module the server could not read prints a dash and says so — never a zero', () => {
    state.summary.si = { count: 0, total_sen: 0, total_outstanding_sen: 0, unavailable: true, deposit_note: 'The orders could not be read.' };
    renderAt();
    const si = screen.getByRole('button', { name: /SI · Sales invoices/ });
    expect(within(si).getByText('Could not read')).toBeTruthy();
    expect(within(si).getByText('—')).toBeTruthy();
  });

  test('while the summary loads every module card shows a dash, not 0', () => {
    state.summaryLoading = true;
    renderAt();
    const so = screen.getByRole('button', { name: /SO · Sales orders/ });
    expect(within(so).getByText('—')).toBeTruthy();
    expect(within(so).getByText('Loading…')).toBeTruthy();
  });
});

describe('Outstanding — the sales invoice list', () => {
  test('opens on Sales invoices, Outstanding, the last 12 months', () => {
    renderAt();
    expect(screen.getByText('Sales invoices')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Outstanding' }).getAttribute('aria-pressed')).toBe('true');
    expect(lastRowsCall()).toEqual({ module: 'si', opts: { mode: 'outstanding', from: todayMyt(-365), to: TODAY } });
    expect(rangeButton().textContent).toContain('Last 12 months');
    expect(rangeButton().textContent).toContain(`${fmtDate(todayMyt(-365))} – ${fmtDate(TODAY)}`);
  });

  test('statuses are tags in the ERP’s words; a passed due date on an open invoice says how late', () => {
    renderAt();
    expect(screen.getByText('Submitted')).toBeTruthy();
    expect(screen.getByText('Partially Paid')).toBeTruthy();
    expect(screen.getByText(`${fmtDate(TEN_DAYS_AGO)} · 10d late`)).toBeTruthy();
    expect(screen.getByText(fmtDate(IN_25_DAYS))).toBeTruthy();
    // The credit notes knocked off each invoice show beside its deposit (headers are title-cased).
    expect(screen.getByRole('columnheader', { name: /Credit Notes/ })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /SO Deposit/ })).toBeTruthy();
  });

  /* A customer's credit note knocked off it (owner 2026-11-03: 「要」): its own
     column, out of the outstanding already, and the invoice reads part paid. */
  test('a credit note knocked off an invoice reads in its own column and makes it part paid', () => {
    state.rows = { si: [{ ...SI_ROWS[0], credit_notes_sen: 25_000, outstanding_sen: 75_000 }] };
    renderAt();
    const row = screen.getByRole('link', { name: 'HC-SI-2610-001' }).closest('tr') as HTMLTableRowElement;
    expect(within(row).getByText('RM 250.00')).toBeTruthy();
    expect(within(row).getByText('RM 750.00')).toBeTruthy();
    expect(within(row).getByText('Submitted').className).toContain('toneInfo');
  });

  test('a cancelled invoice: struck number, no amounts, never late, out of the totals', () => {
    state.rows = { si: [SI_ROWS[1], { ...SI_ROWS[0], status: 'CANCELLED', is_outstanding: false }] };
    renderAt('/scm/outstanding?mode=all');
    const link = screen.getByRole('link', { name: 'HC-SI-2610-001' });
    expect(link.className).toContain('dt-cancel-strike');
    const row = link.closest('tr') as HTMLTableRowElement;
    expect(row.className).toContain('dt-row-cancelled');
    expect(within(row).getByText('Cancelled')).toBeTruthy();
    expect(within(row).queryByText('RM 1,000.00')).toBeNull();
    expect(within(row).getByText(fmtDate(TEN_DAYS_AGO))).toBeTruthy();
    // Footer: only the part-paid invoice's RM 500.00 total counts.
    const foot = row.closest('table')?.querySelector('tfoot') as HTMLElement;
    expect(within(foot).getByText('RM 500.00')).toBeTruthy();
  });

  test('an invoice still owed wears the sand tint; its number opens it', () => {
    renderAt();
    const link = screen.getByRole('link', { name: 'HC-SI-2610-001' });
    expect(link.getAttribute('href')).toBe('/scm/sales-invoices/si-1');
    expect((link.closest('tr') as HTMLTableRowElement).style.background).toBe('var(--open-bg)');
  });

  test('a closed invoice is not tinted', () => {
    state.rows = { si: [{ ...SI_ROWS[0], paid_sen: 100000, outstanding_sen: 0, status: 'PAID', is_outstanding: false }] };
    renderAt('/scm/outstanding?mode=completed');
    const row = screen.getByRole('link', { name: 'HC-SI-2610-001' }).closest('tr') as HTMLTableRowElement;
    expect(row.style.background).toBe('');
    expect(within(row).getByText('Paid')).toBeTruthy();
  });
});

describe('Outstanding — the view lives in the URL', () => {
  test('?mod=&mode=&from=&to= opens that list, that filter and those dates', () => {
    renderAt('/scm/outstanding?mod=pi&mode=completed&from=2026-01-01&to=2026-03-31');
    expect(screen.getByText('Purchase invoices')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Completed' }).getAttribute('aria-pressed')).toBe('true');
    expect(lastRowsCall()).toEqual({ module: 'pi', opts: { mode: 'completed', from: '2026-01-01', to: '2026-03-31' } });
    expect(rangeButton().textContent).toContain('2026/01/01 – 2026/03/31');
    expect(screen.getByText('Nothing completed in these dates.')).toBeTruthy();
  });

  test('To do’s link to the SI outstanding list lands there', () => {
    renderAt('/scm/outstanding?mod=si&mode=outstanding');
    expect(screen.getByRole('button', { name: /SI · Sales invoices/ }).getAttribute('aria-pressed')).toBe('true');
    expect(lastRowsCall().opts.mode).toBe('outstanding');
  });

  test('a card, a chip and the dates write the URL; All dates sends no dates at all', () => {
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /SO · Sales orders/ }));
    expect(search).toContain('mod=so');
    expect(screen.getByText('Nothing outstanding in these dates.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    expect(search).toContain('mode=completed');

    fireEvent.click(rangeButton());
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'All dates' }));
    expect(search).toContain('from=&to=');
    expect(lastRowsCall()).toEqual({ module: 'so', opts: { mode: 'completed', from: '', to: '' } });

    // Back to the default window: the URL forgets the dates again.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Last 12 months' }));
    expect(search).not.toContain('from=');
    expect(lastRowsCall().opts).toEqual({ mode: 'completed', from: todayMyt(-365), to: TODAY });
  });

  test('a date in the URL that is not a day is an open end, not a server error', () => {
    renderAt('/scm/outstanding?from=garbage&to=2026-03-31');
    expect(lastRowsCall().opts).toEqual({ mode: 'outstanding', from: '', to: '2026-03-31' });
    expect(rangeButton().textContent).toContain('check the dates');
  });
});
