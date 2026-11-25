// The Finance report shell (the owner's Claude Design, batch 6 §4): the report
// list — the design's groups and order, today's sidebar gates, the open report
// lit, hover / tap / pin — the header ("Finance · Reports", the report's name,
// its grey line, its actions), the shared date range in the address and the
// Excel / PDF / Print buttons. The P&Ls are one entry with a picker across the
// top of each (owner 2026-11-25).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  /* Page access as a flat set: the Finance group and its Reports entries open,
     Books and Forecasting closed — Trial balance, Journal entries, General
     ledger, Forecast P&L and the Dashboard leave the list with their sidebar
     entries; the Sales report keeps its own cohort gate. */
  access: new Set<string>(['scm.finance', 'scm.finance.reports']),
}));
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    can: () => false,
    pageAccess: (k: string) => (auth.access.has(k) ? 'full' : 'none'),
  }),
}));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
const pdf = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../../vendor/scm/lib/report-sheet-pdf', () => ({ generateReportPdf: (...a: unknown[]) => pdf(...a) }));

import { ACCOUNTING_TAB_TITLES } from '../accounting-tabs';
import { PNL_CHOICES, REPORT_CATALOG, REPORT_GROUPS, isPnlReport, pnlChoiceOf, reportHref, reportOfAccountingTab } from '../reports-catalog';
import { REPORT_RANGE_PRESETS, presetLabel } from '../../../lib/dateRangePresets';
import { classifyBrowserStorageKey } from '../../../lib/browserStorageRegistry';
import { ReportShell } from './ReportShell';
import { REPORT_LOOK } from './reportListLook';
import { InPlaceOfReport, ReportExports, ReportHeaderActions, useReportSubtitle } from './reportParts';
import { FinanceDateRange } from './FinanceDateRange';
import { useReportRange } from './useReportRange';

const Where = () => {
  const l = useLocation();
  return <output aria-label="address">{`${l.pathname}${l.search}`}</output>;
};

/* jsdom has no PointerEvent: a mouse event that says which pointer it is. */
const pointer = (el: Element, type: 'pointerover' | 'pointerout', pointerType: string) => {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'pointerType', { value: pointerType });
  fireEvent(el, ev);
};

const at = (url: string, ui: React.ReactNode) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="*" element={<>{ui}<Where /></>} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  auth.access = new Set(['scm.finance', 'scm.finance.reports']);
  window.localStorage.removeItem('fin-reports-rail-pinned');
  window.sessionStorage.removeItem('fin-report-range');
  xlsx.mockClear();
  pdf.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('the report catalog', () => {
  test('every report under the design’s groups, in the design’s order; a tab is named as its Accounting tab', () => {
    expect(REPORT_GROUPS.map((g) => g.label)).toEqual([
      'Statements', 'Who owes whom', 'Sales & collection', 'Events & logistics', 'Card money', 'Plan', 'Books', 'Audit',
    ]);
    expect(REPORT_CATALOG.map((r) => r.id)).toEqual([
      'pnl', 'performance', 'departments', 'forecast', 'bs', 'rp', 'tb', 'ar', 'ap', 'collection', 'fair', 'products', 'changes', 'changesum', 'sotodo',
      'events', 'commission', 'logistics', 'charges', 'dashboard', 'je', 'gl', 'corrections',
    ]);
    /* The P&L entry's picker (owner 2026-11-25): a category, then Overall or Department; the Department P&L on its basis. */
    expect(PNL_CHOICES.map((c) => `${c.category}/${c.part}: ${c.report}${c.dbasis ? `?dbasis=${c.dbasis}` : ''}`)).toEqual([
      'actual/overall: pnl', 'actual/department: departments?dbasis=actual',
      'performance/overall: performance', 'performance/department: departments?dbasis=performance',
      'forecast/overall: forecast',
    ]);
    expect(REPORT_CATALOG.filter((r) => isPnlReport(r.id)).map((r) => `${r.id}:${r.group}`))
      .toEqual(['pnl:statements', 'performance:statements', 'departments:statements', 'forecast:statements']);
    for (const r of REPORT_CATALOG) {
      if (r.tab) expect(r.label).toBe(ACCOUNTING_TAB_TITLES[r.tab]);
      expect(REPORT_LOOK[r.id].desc.length).toBeGreaterThan(10);
    }
  });

  test('Journal entries, the General ledger and the Trial balance are reports only from the list', () => {
    expect(reportOfAccountingTab('pnl', false)?.id).toBe('pnl');
    expect(reportOfAccountingTab('tb', false)).toBeNull();
    expect(reportOfAccountingTab('tb', true)?.id).toBe('tb');
    expect(reportOfAccountingTab('je', true)?.id).toBe('je');
    expect(reportOfAccountingTab('close', true)).toBeNull();
    expect(reportOfAccountingTab('coa', false)).toBeNull();
  });

  test('a link carries its tab, in=reports for a Books page, and the range in use', () => {
    const byId = (id: string) => REPORT_CATALOG.find((r) => r.id === id)!;
    expect(reportHref(byId('pnl'), { from: '2026-10-01', to: '2026-10-29' })).toBe('/scm/accounting?tab=pnl&from=2026-10-01&to=2026-10-29');
    expect(reportHref(byId('gl'), null)).toBe('/scm/accounting?tab=gl&in=reports');
    expect(reportHref(byId('fair'), { from: '2026-10-01', to: '' })).toBe('/reports/fair-report');
  });

  test('the reports’ date presets are the design’s seven, from the one presets module', () => {
    expect(REPORT_RANGE_PRESETS.map(presetLabel)).toEqual([
      'This month', 'Last month', 'This quarter', 'Last quarter', 'Year to date', 'Last 12 months', 'Last year',
    ]);
  });

  test('what the reports remember in the browser is registered', () => {
    expect(classifyBrowserStorageKey('fin-reports-rail-pinned', 'localStorage')?.classification).toBe('DEVICE_PREF');
    expect(classifyBrowserStorageKey('fin-report-range', 'sessionStorage')?.classification).toBe('TRANSIENT');
  });
});

describe('the report list', () => {
  test('shows each report its sidebar entry shows, under its group, the open one lit', () => {
    at('/scm/accounting?tab=bs', <ReportShell report="bs"><p>body</p></ReportShell>);
    const nav = screen.getByRole('navigation', { name: 'Reports' });
    const statements = within(nav).getByRole('group', { name: 'Statements' });
    expect(within(statements).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'P&L', ACCOUNTING_TAB_TITLES.bs, ACCOUNTING_TAB_TITLES.rp,
    ]);
    /* Books and Forecasting are closed to this reader, and the Sales report keeps its cohort gate. */
    expect(within(nav).queryByRole('group', { name: 'Books' })).toBeNull();
    expect(within(nav).queryByRole('group', { name: 'Plan' })).toBeNull();
    expect(within(nav).queryByText('Sales report · fairs')).toBeNull();
    expect(within(nav).getByRole('group', { name: 'Audit' }).textContent).toContain('Corrections');
    const lit = within(nav).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(lit.map((a) => a.getAttribute('aria-label') ?? a.textContent)).toEqual([ACCOUNTING_TAB_TITLES.bs, ACCOUNTING_TAB_TITLES.bs]);
    /* A name's description shows on hover. */
    expect(within(statements).getByText(ACCOUNTING_TAB_TITLES.bs).closest('a')!.getAttribute('title')).toMatch(/% of total assets/);
    /* A report that is not a P&L has no P&L picker. */
    expect(screen.queryByRole('navigation', { name: 'Choose a P&L' })).toBeNull();
  });

  test('Books pages open from the list with in=reports, and every link carries the range in use', () => {
    auth.access = new Set(['scm.finance', 'scm.finance.reports', 'scm.finance.books']);
    at('/scm/accounting?tab=pnl&from=2026-09-01&to=2026-09-30', <ReportShell report="pnl"><p>body</p></ReportShell>);
    const books = within(screen.getByRole('navigation', { name: 'Reports' })).getByRole('group', { name: 'Books' });
    expect(within(books).getByText(ACCOUNTING_TAB_TITLES.gl).closest('a')!.getAttribute('href'))
      .toBe('/scm/accounting?tab=gl&in=reports&from=2026-09-01&to=2026-09-30');
    /* The strip's icon and the full list's name open the same address. */
    expect(screen.getAllByRole('link', { name: ACCOUNTING_TAB_TITLES.tb }).map((a) => a.getAttribute('href'))).toEqual([
      '/scm/accounting?tab=tb&in=reports&from=2026-09-01&to=2026-09-30',
      '/scm/accounting?tab=tb&in=reports&from=2026-09-01&to=2026-09-30',
    ]);
  });

  test('with no dates in the address, the links carry the range picked earlier in the tab — never the bare default', () => {
    at('/scm/accounting?tab=pnl', <ReportShell report="pnl"><p>body</p></ReportShell>);
    expect(screen.getAllByRole('link', { name: ACCOUNTING_TAB_TITLES.bs })[0]!.getAttribute('href')).toBe('/scm/accounting?tab=bs');
    window.sessionStorage.setItem('fin-report-range', JSON.stringify({ from: '2026-07-01', to: '2026-09-30' }));
    at('/scm/accounting?tab=ar', <ReportShell report="ar"><p>body</p></ReportShell>);
    expect(screen.getAllByRole('link', { name: ACCOUNTING_TAB_TITLES.bs }).at(-1)!.getAttribute('href'))
      .toBe('/scm/accounting?tab=bs&from=2026-07-01&to=2026-09-30');
  });

  test('pointing opens the full list after 90 ms; it closes 200 ms after the pointer leaves', () => {
    vi.useFakeTimers();
    at('/scm/accounting?tab=pnl', <ReportShell report="pnl"><p>body</p></ReportShell>);
    const nav = screen.getByRole('navigation', { name: 'Reports' });
    const toggle = screen.getByRole('button', { name: 'Choose a report' });
    pointer(nav, 'pointerover', 'mouse');
    act(() => { vi.advanceTimersByTime(80); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => { vi.advanceTimersByTime(20); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    pointer(nav, 'pointerout', 'mouse');
    act(() => { vi.advanceTimersByTime(150); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => { vi.advanceTimersByTime(60); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('a touch does not open it; the list icon does, and Esc closes it', () => {
    at('/scm/accounting?tab=pnl', <ReportShell report="pnl"><p>body</p></ReportShell>);
    const nav = screen.getByRole('navigation', { name: 'Reports' });
    const toggle = screen.getByRole('button', { name: 'Choose a report' });
    expect(toggle.getAttribute('title')).toBe('Reports · point here to open the list');
    pointer(nav, 'pointerover', 'touch');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('the pin keeps the list open, remembered on this device', () => {
    at('/scm/accounting?tab=pnl', <ReportShell report="pnl"><p>body</p></ReportShell>);
    fireEvent.click(screen.getByRole('button', { name: 'Keep the list open' }));
    expect(window.localStorage.getItem('fin-reports-rail-pinned')).toBe('1');
    expect(screen.getByRole('button', { name: 'Unpin the list' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('navigation', { name: 'Reports' }).closest('[data-report]')!.className).toMatch(/shellPinned/);
  });

  test('a reader who may open one report has no list to choose from', () => {
    auth.access = new Set(['scm.finance', 'scm.finance.books']);
    at('/scm/accounting?tab=bs', <ReportShell report="bs"><p>body</p></ReportShell>);
    /* Books only: the three Books pages are the reader's reports, so the list stays. */
    expect(screen.getByRole('navigation', { name: 'Reports' })).toBeTruthy();
    auth.access = new Set(['scm.finance']);
    at('/scm/accounting?tab=bs', <ReportShell report="bs"><p>alone</p></ReportShell>);
    expect(screen.getByText('alone')).toBeTruthy();
    expect(screen.getAllByRole('navigation', { name: 'Reports' })).toHaveLength(1);
  });
});

describe('the P&Ls as one entry: Actual | Performance | Forecast, then Overall | Department (owner 2026-11-25)', () => {
  const ALL = ['scm.finance', 'scm.finance.reports', 'scm.finance.forecast'];
  const picker = () => screen.getByRole('navigation', { name: 'Choose a P&L' });
  const track = (name: string) => within(picker()).getByRole('group', { name });
  const names = (el: HTMLElement) => within(el).getAllByRole('link').map((a) => a.textContent);
  const lit = (el: HTMLElement) => within(el).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent);
  const href = (el: HTMLElement, name: string) => within(el).getByRole('link', { name }).getAttribute('href');

  test('the list shows one P&L where the four were, lit on any of them; Logistics cost and the Product changes P&L are entries of their own', () => {
    auth.access = new Set(ALL);
    at('/scm/accounting?tab=departments&dbasis=actual&from=2026-09-01&to=2026-09-30', <ReportShell report="departments"><p>body</p></ReportShell>);
    const nav = screen.getByRole('navigation', { name: 'Reports' });
    const shown = within(nav).getAllByRole('link').map((a) => a.getAttribute('aria-label') ?? a.textContent);
    for (const gone of ['Department P&L', 'Performance P&L', 'Forecast P&L']) expect(shown).not.toContain(gone);
    /* Once in the strip, once in the full list. */
    const entry = within(nav).getAllByRole('link', { name: 'P&L' });
    expect(entry).toHaveLength(2);
    for (const a of entry) {
      expect(a.getAttribute('href')).toBe('/scm/accounting?tab=pnl&from=2026-09-01&to=2026-09-30');
      expect(a.getAttribute('aria-current')).toBe('page');
    }
    expect(entry[1]!.getAttribute('title')).toMatch(/^Every P&L in one place/);
    expect(names(within(nav).getByRole('group', { name: 'Statements' }))).toEqual(['P&L', ACCOUNTING_TAB_TITLES.bs, ACCOUNTING_TAB_TITLES.rp]);
    expect(names(within(nav).getByRole('group', { name: 'Sales & collection' }))).toContain(ACCOUNTING_TAB_TITLES.changesum);
    expect(names(within(nav).getByRole('group', { name: 'Events & logistics' }))).toContain(ACCOUNTING_TAB_TITLES.logistics);
    expect(names(within(nav).getByRole('group', { name: 'Plan' }))).toEqual(['Dashboard']);
  });

  test('Actual › Overall: the three categories, then Overall | Department, each at its own address with the range in use', () => {
    auth.access = new Set(ALL);
    at('/scm/accounting?tab=pnl&from=2026-09-01&to=2026-09-30', <ReportShell report="pnl"><p>body</p></ReportShell>);
    const cats = track('P&L category');
    const parts = track('Overall or by department');
    expect(names(cats)).toEqual(['Actual', 'Performance', 'Forecast']);
    expect(lit(cats)).toEqual(['Actual']);
    expect(names(parts)).toEqual(['Overall', 'Department']);
    expect(lit(parts)).toEqual(['Overall']);
    /* A category opens the part the reader is on: here Overall. */
    expect(href(cats, 'Performance')).toBe('/scm/accounting?tab=performance&from=2026-09-01&to=2026-09-30');
    expect(href(cats, 'Forecast')).toBe('/scm/forecast?from=2026-09-01&to=2026-09-30');
    expect(href(parts, 'Department')).toBe('/scm/accounting?tab=departments&dbasis=actual&from=2026-09-01&to=2026-09-30');
    expect(within(cats).getByRole('link', { name: 'Actual' }).getAttribute('title')).toMatch(/sales invoice/);
    expect(within(cats).getByRole('link', { name: 'Performance' }).getAttribute('title')).toMatch(/sales order/);
  });

  test('on a Department P&L its basis lights its category; the other basis keeps the department and its view', () => {
    auth.access = new Set(ALL);
    at('/scm/accounting?tab=departments&dbasis=actual&dv=exhibition&dm=months&from=2026-09-01&to=2026-09-30', <ReportShell report="departments"><p>body</p></ReportShell>);
    const cats = track('P&L category');
    const parts = track('Overall or by department');
    expect(lit(cats)).toEqual(['Actual']);
    expect(lit(parts)).toEqual(['Department']);
    expect(href(cats, 'Performance')).toBe('/scm/accounting?tab=departments&dbasis=performance&dv=exhibition&dm=months&from=2026-09-01&to=2026-09-30');
    /* The Forecast has no departments yet: its Overall. */
    expect(href(cats, 'Forecast')).toBe('/scm/forecast?from=2026-09-01&to=2026-09-30');
    expect(href(parts, 'Overall')).toBe('/scm/accounting?tab=pnl&from=2026-09-01&to=2026-09-30');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ACCOUNTING_TAB_TITLES.departments);
  });

  test('an old Department P&L link (no basis) is Performance › Department, as the page reads it', () => {
    at('/scm/accounting?tab=departments', <ReportShell report="departments"><p>body</p></ReportShell>);
    expect(lit(track('P&L category'))).toEqual(['Performance']);
    expect(lit(track('Overall or by department'))).toEqual(['Department']);
    expect(href(track('P&L category'), 'Actual')).toBe('/scm/accounting?tab=departments&dbasis=actual');
    expect(pnlChoiceOf('departments', null)).toMatchObject({ category: 'performance', part: 'department' });
    expect(pnlChoiceOf('departments', 'actual')).toMatchObject({ category: 'actual', part: 'department' });
    expect(pnlChoiceOf('changesum', null)).toBeNull();
    for (const tab of ['pnl', 'departments', 'performance'] as const) expect(isPnlReport(reportOfAccountingTab(tab, false)!.id), tab).toBe(true);
  });

  test('on the Forecast P&L: Forecast lit, and no second track while its departments are not built', () => {
    auth.access = new Set(ALL);
    at('/scm/forecast', <ReportShell report="forecast"><p>body</p></ReportShell>);
    expect(lit(track('P&L category'))).toEqual(['Forecast']);
    expect(within(picker()).queryByRole('group', { name: 'Overall or by department' })).toBeNull();
    expect(href(track('P&L category'), 'Actual')).toBe('/scm/accounting?tab=pnl');
  });

  test('with no dates in the address the choices carry the range picked earlier in the tab, never the bare default', () => {
    at('/scm/accounting?tab=pnl', <ReportShell report="pnl"><p>body</p></ReportShell>);
    expect(href(track('P&L category'), 'Performance')).toBe('/scm/accounting?tab=performance');
    cleanup();
    window.sessionStorage.setItem('fin-report-range', JSON.stringify({ from: '2026-07-01', to: '2026-09-30' }));
    at('/scm/accounting?tab=performance', <ReportShell report="performance"><p>body</p></ReportShell>);
    expect(href(track('P&L category'), 'Actual')).toBe('/scm/accounting?tab=pnl&from=2026-07-01&to=2026-09-30');
  });

  test('a reader is offered only the P&Ls they may open; a report that is not a P&L has no picker', () => {
    /* No Forecast right: two categories. */
    at('/scm/accounting?tab=pnl', <ReportShell report="pnl"><p>body</p></ReportShell>);
    expect(names(track('P&L category'))).toEqual(['Actual', 'Performance']);
    cleanup();
    at('/scm/accounting?tab=logistics', <ReportShell report="logistics"><p>body</p></ReportShell>);
    expect(screen.queryByRole('navigation', { name: 'Choose a P&L' })).toBeNull();
    cleanup();
    /* The Forecast P&L and the Dashboard alone: the P&L entry opens the Forecast P&L, and there is nothing to pick. */
    auth.access = new Set(['scm.finance', 'scm.finance.forecast']);
    at('/scm/forecast', <ReportShell report="forecast"><p>body</p></ReportShell>);
    const nav = screen.getByRole('navigation', { name: 'Reports' });
    expect(within(nav).getAllByRole('link', { name: 'P&L' }).map((a) => a.getAttribute('href'))).toEqual(['/scm/forecast', '/scm/forecast']);
    expect(screen.queryByRole('navigation', { name: 'Choose a P&L' })).toBeNull();
  });

  test('on a narrow screen a track scrolls sideways to keep the open choice in view', () => {
    auth.access = new Set(ALL);
    /* A track shows 0–200 px; Forecast, the last category, sits at 380–460 px, the other open choices at -90 – -40 px. */
    const box = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const r = this.getAttribute('aria-current') !== 'page' ? { left: 0, right: 200 }
        : this.textContent === 'Forecast' ? { left: 380, right: 460 } : { left: -90, right: -40 };
      return { ...r, top: 0, bottom: 26, width: r.right - r.left, height: 26, x: r.left, y: 0, toJSON: () => r } as DOMRect;
    });
    const tree = (report: 'forecast' | 'pnl') => (
      <MemoryRouter initialEntries={['/scm/forecast']}>
        <Routes><Route path="*" element={<ReportShell report={report}><p>body</p></ReportShell>} /></Routes>
      </MemoryRouter>
    );
    try {
      const { rerender } = render(tree('forecast'));
      const cats = track('P&L category');
      expect(cats.scrollLeft).toBe(260);
      /* The same picker, Actual now open: back left by its 90 px; a re-render that opens nothing new moves nothing. */
      rerender(tree('pnl'));
      expect(cats.scrollLeft).toBe(170);
      rerender(tree('pnl'));
      expect(cats.scrollLeft).toBe(170);
    } finally {
      box.mockRestore();
    }
  });

  test('the picker steps aside with the header buttons while the Layout editor stands in for the report', async () => {
    const Report = () => (
      <>
        <p>the statement</p>
        <InPlaceOfReport><section aria-label="Layout · P&L">the editor</section></InPlaceOfReport>
      </>
    );
    at('/scm/accounting?tab=pnl', <ReportShell report="pnl"><Report /></ReportShell>);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Layout · P&L' })).toBeTruthy());
    expect(picker().parentElement!.className).toMatch(/asideNow/);
  });
});

describe('the header and the shared pieces', () => {
  const Body = ({ text }: { text: string | null }) => {
    useReportSubtitle(text);
    return <ReportHeaderActions><button type="button">Mine</button></ReportHeaderActions>;
  };

  test('“Finance · Reports” over the report’s name; a report sets its grey line and puts its buttons in the header', async () => {
    at('/reports/fair-report', <ReportShell report="fair" actions={<button type="button">Up front</button>}><Body text="2026/10/01 – 2026/10/29" /></ReportShell>);
    expect(screen.getByText('Finance · Reports')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sales report');
    await waitFor(() => expect(screen.getByText('2026/10/01 – 2026/10/29')).toBeTruthy());
    const header = screen.getByRole('heading', { level: 1 }).closest('.sticky') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'Up front' })).toBeTruthy();
    await waitFor(() => expect(within(header).getByRole('button', { name: 'Mine' })).toBeTruthy());
  });

  test('the report opened last is remembered for the sidebar’s Reports entry; a Books page opened from the list leaves it', () => {
    window.sessionStorage.removeItem('fin-reports-last');
    const first = at('/scm/accounting?tab=ar', <ReportShell report="ar"><Body text={null} /></ReportShell>);
    expect(window.sessionStorage.getItem('fin-reports-last')).toBe('/scm/accounting?tab=ar');
    expect(classifyBrowserStorageKey('fin-reports-last', 'sessionStorage')?.classification).toBe('TRANSIENT');
    first.unmount();
    at('/scm/accounting?tab=tb&in=reports', <ReportShell report="tb"><Body text={null} /></ReportShell>);
    expect(window.sessionStorage.getItem('fin-reports-last')).toBe('/scm/accounting?tab=ar');
  });

  test('a report that draws its own header gets the list only', () => {
    at('/scm/accounting?tab=je&in=reports', <ReportShell report="je" ownHeader><Body text="ignored" /></ReportShell>);
    expect(screen.getByRole('navigation', { name: 'Reports' })).toBeTruthy();
    expect(screen.queryByText('Finance · Reports')).toBeNull();
    /* No header to lend: its buttons stand where they are. */
    expect(screen.getByRole('button', { name: 'Mine' })).toBeTruthy();
  });

  test('drawn without a shell, a report’s buttons stand where they are', () => {
    render(<MemoryRouter><Body text="ignored" /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Mine' })).toBeTruthy();
  });

  test('a part in place of the report (the Layout editor) sets the report and its header buttons aside until it closes', async () => {
    const Report = ({ editing }: { editing: boolean }) => (
      <>
        <Body text="2026/10/01 – 2026/10/29" />
        <p>the statement</p>
        {editing && <InPlaceOfReport><section aria-label="Layout · P&L">the editor</section></InPlaceOfReport>}
      </>
    );
    const { rerender } = at('/scm/accounting?tab=pnl', <ReportShell report="pnl"><Report editing={false} /></ReportShell>);
    const header = screen.getByRole('heading', { level: 1 }).closest('.sticky') as HTMLElement;
    await waitFor(() => expect(within(header).getByRole('button', { name: 'Mine' })).toBeTruthy());
    const body = screen.getByText('the statement').closest('[data-report-body]')!;
    expect(body.className).not.toMatch(/asideNow/);

    rerender(<MemoryRouter initialEntries={['/scm/accounting?tab=pnl']}><Routes><Route path="*" element={<ReportShell report="pnl"><Report editing /></ReportShell>} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Layout · P&L' })).toBeTruthy());
    /* The editor draws outside the report's box: the report is hidden, not unmounted. */
    expect(screen.getByRole('region', { name: 'Layout · P&L' }).closest('[data-report-body]')).toBeNull();
    expect(screen.getByText('the statement').closest('[data-report-body]')!.className).toMatch(/asideNow/);
    expect(within(header).getByRole('button', { name: 'Mine' }).closest('div')!.className).toMatch(/asideNow/);
    /* Still "Finance · Reports" over the report's name. */
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('P&L');

    rerender(<MemoryRouter initialEntries={['/scm/accounting?tab=pnl']}><Routes><Route path="*" element={<ReportShell report="pnl"><Report editing={false} /></ReportShell>} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Layout · P&L' })).toBeNull());
    expect(screen.getByText('the statement').closest('[data-report-body]')!.className).not.toMatch(/asideNow/);
  });

  test('drawn without a shell, a part in place of the report renders where it stands', () => {
    render(<InPlaceOfReport><p>the editor</p></InPlaceOfReport>);
    expect(screen.getByText('the editor')).toBeTruthy();
  });

  test('Excel makes the .xlsx, PDF opens the preview, Print prints that same PDF; Layout only where offered', async () => {
    const sheet = { title: 'P&L', subtitle: 's', meta: [], tables: [] };
    const onLayout = vi.fn();
    const { rerender } = render(<ReportExports sheet={() => sheet} fileBase="pnl-2026-10-01-to-2026-10-29" />);
    expect(screen.queryByRole('button', { name: 'Layout' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledWith(sheet, 'pnl-2026-10-01-to-2026-10-29.xlsx'));
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(pdf).toHaveBeenCalledWith(sheet, { fileName: 'pnl-2026-10-01-to-2026-10-29.pdf', action: 'preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(pdf).toHaveBeenCalledWith(sheet, { fileName: 'pnl-2026-10-01-to-2026-10-29.pdf', action: 'print' }));
    rerender(<ReportExports sheet={() => null} fileBase="x" onLayout={onLayout} layoutOn />);
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    expect(onLayout).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Layout' }).getAttribute('aria-pressed')).toBe('true');
    /* Nothing to export: nothing is built. */
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await Promise.resolve();
    expect(xlsx).toHaveBeenCalledTimes(1);
  });
});

describe('the shared date range', () => {
  const Show = () => {
    const r = useReportRange();
    return <span data-testid="range">{`${r.from}|${r.to}|${r.source}|${r.usable}`}</span>;
  };

  test('reads the address; with none, the tab’s last range; with neither, This month', () => {
    at('/scm/accounting?tab=pnl&from=2026-09-01&to=2026-09-30', <Show />);
    expect(screen.getByTestId('range').textContent).toBe('2026-09-01|2026-09-30|url|true');
    window.sessionStorage.setItem('fin-report-range', JSON.stringify({ from: '2026-07-01', to: '2026-07-31' }));
    at('/scm/accounting?tab=bs', <Show />);
    expect(screen.getAllByTestId('range').at(-1)!.textContent).toBe('2026-07-01|2026-07-31|saved|true');
    window.sessionStorage.removeItem('fin-report-range');
    at('/scm/accounting?tab=rp', <Show />);
    expect(screen.getAllByTestId('range').at(-1)!.textContent).toMatch(/^\d{4}-\d{2}-01\|\d{4}-\d{2}-\d{2}\|default\|true$/);
  });

  test('a preset writes the address and is remembered for the next report', () => {
    at('/scm/accounting?tab=pnl&from=2026-09-01&to=2026-09-30', <><FinanceDateRange /><Show /></>);
    const trigger = screen.getByRole('button', { name: /^Report dates: 2026\/09\/01 – 2026\/09\/30/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Last year' }));
    expect(screen.getByLabelText('address').textContent).toMatch(/^\/scm\/accounting\?tab=pnl&from=\d{4}-01-01&to=\d{4}-12-31$/);
    expect(JSON.parse(window.sessionStorage.getItem('fin-report-range')!)).toMatchObject({ from: expect.stringMatching(/-01-01$/), to: expect.stringMatching(/-12-31$/) });
  });

  test('a reversed range is kept in the address but never remembered, and reads as unusable', () => {
    at('/scm/accounting?tab=pnl&from=2026-10-29&to=2026-10-01', <Show />);
    expect(screen.getByTestId('range').textContent).toBe('2026-10-29|2026-10-01|url|false');
    expect(window.sessionStorage.getItem('fin-report-range')).toBeNull();
  });
});
