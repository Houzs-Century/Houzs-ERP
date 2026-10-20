/* The screen that settles a fair link a person has to decide.
 *
 * What these cases pin is mostly what the screen REFUSES to do: it never offers
 * a fair at a place the order does not record, it never offers one that was not
 * running on the order's own date, and it keeps the three reasons apart instead
 * of showing one undifferentiated pile — "waiting for the fair" needs nobody,
 * "pick one" needs a person, and they must not look the same.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  FairCheckRow,
  FairOption,
  FairPendingRow,
  FairOptionsResponse,
} from '../../vendor/scm/lib/fair-options-queries';

const ROWS: FairPendingRow[] = [
  { doc_no: 'HC-SO-2609-064', so_date: '2026-09-13', venue: 'MID VALLEY', branding: null, project_id: null, fair_match: 'AMBIGUOUS', status: 'CONFIRMED', local_total_sen: 355860, salesperson_id: 's1' },
  { doc_no: 'HC-SO-2609-065', so_date: '2026-09-13', venue: 'SUNWAY PYRAMID CONVENTION CENTRE', branding: null, project_id: null, fair_match: 'PENDING', status: 'CONFIRMED', local_total_sen: 658800, salesperson_id: 's2' },
  { doc_no: 'HC-SO-2609-063', so_date: '2026-09-12', venue: 'MID VALLEY', branding: 'DUNLOPILLO', project_id: null, fair_match: 'UNMATCHED', status: 'CONFIRMED', local_total_sen: 544000, salesperson_id: 's3' },
  /* Listed since 2026-10-19 (「没有 assign 到 fair 的就列出来」): an explicit No
     fair, and an order keyed before the picker that carries no verdict at all. */
  { doc_no: 'HC-SO-2609-222', so_date: '2026-09-27', venue: 'SUNWAY CARNIVAL', branding: 'DUNLOPILLO', project_id: null, fair_match: 'NO_FAIR', status: 'CONFIRMED', local_total_sen: 500000, salesperson_id: 's4' },
  { doc_no: 'HC-SO-2609-009', so_date: '2026-09-09', venue: 'PAVILION BUKIT JALIL', branding: 'BEDFRAME', project_id: null, fair_match: null, status: 'CONFIRMED', local_total_sen: 180000, salesperson_id: 's5' },
];

const OPTIONS: FairOptionsResponse = {
  date: '2026-09-13',
  running: [
    {
      key: 'mid valley|rex|2026-09-11|2026-09-13', venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13', projectIds: [340, 341],
      booths: [{ projectId: 340, brand: 'AKEMI' }, { projectId: 341, brand: 'ZANOTTI' }],
    },
  ],
  earlier: [],
  venues: [],
};

const assign = vi.fn();
const transferMutate = vi.hoisted(() => vi.fn());
const openIntent = vi.hoisted(() => vi.fn());
vi.mock('../../lib/workspaceTabs', async (orig) => ({
  ...(await orig<typeof import('../../lib/workspaceTabs')>()),
  markWorkspaceOpenIntent: openIntent,
}));
const checks = vi.hoisted(() => ({ rows: [] as unknown[], error: false }));
const who = vi.hoisted(() => ({ perms: new Set<string>(['scm.finance.accounting']), role: '' }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role_name: who.role, position_name: null, email: 'x@houzs.test' }, can: (p: string) => who.perms.has('*') || who.perms.has(p) }),
}));

vi.mock('../../vendor/scm/lib/fair-options-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/fair-options-queries')>()),
  useFairPending: () => ({ data: ROWS, isLoading: false, isError: false }),
  useFairOptions: () => ({ data: OPTIONS, isLoading: false, isError: false }),
  useAssignFair: () => ({ mutate: assign, isPending: false }),
  useFairChecks: () => ({ data: checks.rows, isLoading: false, isError: checks.error }),
  useFairTransfer: () => ({ mutate: transferMutate, isPending: false }),
}));

import { FairPending } from './FairPending';
import { boothChoices } from '../../vendor/scm/lib/fair-booth-choices';

const show = () => render(<MemoryRouter><FairPending /></MemoryRouter>);

describe('FairPending', () => {
  it('keeps the reasons apart — they are different jobs', () => {
    show();
    expect(screen.getByText('Pick one (1)')).toBeTruthy();
    expect(screen.getByText('Brand has no booth (1)')).toBeTruthy();
    expect(screen.getByText('Waiting for the fair (1)')).toBeTruthy();
    expect(screen.getByText('Marked No fair (1)')).toBeTruthy();
    expect(screen.getByText('Keyed before the fair picker (1)')).toBeTruthy();
    expect(screen.getByText('5 orders not yet attributed to a fair.')).toBeTruthy();
  });

  it('never files an order with no verdict as waiting for the fair', () => {
    /* A NULL verdict used to fall into "Waiting for the fair", which says nobody
       needs to act — wrong for an order nothing ever tried to link. */
    show();
    const waiting = screen.getByText('Waiting for the fair (1)').closest('section') as HTMLElement;
    expect(waiting.textContent).not.toContain('HC-SO-2609-009');
    const before = screen.getByText('Keyed before the fair picker (1)').closest('section') as HTMLElement;
    expect(before.textContent).toContain('HC-SO-2609-009');
  });

  it('offers each brand booth at the order’s own place, named by its brand, with no id', () => {
    /* Owner 2026-10-20: 「我要 link fair 时无法知道 brand」 — and 「地点照样要显示」. */
    show();
    const sel = screen.getByLabelText('Fair for HC-SO-2609-064') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.text)).toEqual([
      '— choose a fair —',
      'AKEMI — MID VALLEY — REX (09/11 - 09/13)',
      'ZANOTTI — MID VALLEY — REX (09/11 - 09/13)',
    ]);
  });

  it('lines every group up in the same columns', () => {
    show();
    for (const title of ['Pick one (1)', 'Waiting for the fair (1)']) {
      const group = screen.getByText(title).closest('section') as HTMLElement;
      expect(within(group).getAllByRole('columnheader').map((h) => h.textContent))
        .toEqual(['SO No.', 'SO date', 'Venue', 'Brand', 'Amount', 'Fair', '']);
    }
  });

  it('the SO number opens the order in its own tab of the strip', () => {
    /* Owner 2026-10-20: 「这里可以直接点开 so 看那张 so」. */
    show();
    const link = screen.getByRole('link', { name: 'HC-SO-2609-064' });
    expect(link.getAttribute('href')).toBe('/scm/sales-orders/HC-SO-2609-064');
    fireEvent.click(link);
    expect(openIntent).toHaveBeenCalledWith(true);
  });

  it('offers NOTHING for an order whose place has no fair that day', () => {
    /* The Sunway order is the real 2026-09-13 case: a venue whose last fair
       ended on the 6th. Offering the MID VALLEY row here would be inventing an
       attribution, so the control is disabled and says why. */
    show();
    const sel = screen.getByLabelText('Fair for HC-SO-2609-065') as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
    expect([...sel.options].map((o) => o.text)).toEqual(['No fair at that place on that date']);
  });

  it('links only the picked project, and only once a pick exists', () => {
    show();
    const buttons = screen.getAllByRole('button', { name: 'Link' });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Fair for HC-SO-2609-064'), { target: { value: '341' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    expect(assign).toHaveBeenCalledWith({ docNo: 'HC-SO-2609-064', projectId: 341 });
  });
});

describe('FairPending — linked orders to check (owner 2026-10-19)', () => {
  const VENUE_DIFFERS: FairCheckRow = {
    doc_no: 'HC-SO-2610-167', so_date: '2026-09-13', venue: 'MID VALLEY', branding: 'AKEMI', project_id: 2228, fair_match: 'PICKED',
    status: 'CONFIRMED', local_total_sen: 420000, salesperson_id: 's1', check: 'VENUE_DIFFERS',
    note: 'Slip venue: MID VALLEY — placed at: SUNWAY CARNIVAL MALL (09/25 - 09/29). Reason: MID VALLEY has REX (09/11 - 09/13) in PMS — re-link if it was sold there.',
  };
  const NEEDS_ATTENDING: FairCheckRow = {
    doc_no: 'HC-SO-2610-300', so_date: '2026-10-19', venue: 'MID VALLEY', branding: 'AKEMI', project_id: 340, fair_match: 'PICKED',
    status: 'DRAFT', local_total_sen: 250000, salesperson_id: 's2', check: 'NEEDS_ATTENDING',
    note: 'Jason is not on Sales Attending for AKEMI @ MID VALLEY (10/15 - 10/18). The draft cannot be confirmed until PMS adds them.',
  };
  afterEach(() => { checks.rows = []; checks.error = false; });

  it('lists 要查 with its sentence and the fairs at the order’s own venue to re-link to', () => {
    checks.rows = [VENUE_DIFFERS];
    show();
    const group = screen.getByText('To check — venue differs (1)').closest('section') as HTMLElement;
    expect(group.textContent).toContain(VENUE_DIFFERS.note);
    fireEvent.change(screen.getByLabelText('Fair for HC-SO-2610-167'), { target: { value: '341' } });
    fireEvent.click(within(group).getByRole('button', { name: 'Link' }));
    expect(assign).toHaveBeenCalledWith({ docNo: 'HC-SO-2610-167', projectId: 341 });
  });

  it('fills in the order’s own brand booth, first in the list — nothing is linked until Link is pressed', () => {
    /* Owner 2026-10-20: preselect the same-brand booth nearest the order date
       (「可以」); the person still presses Link. */
    assign.mockClear();
    checks.rows = [VENUE_DIFFERS];
    show();
    const sel = screen.getByLabelText('Fair for HC-SO-2610-167') as HTMLSelectElement;
    expect(sel.value).toBe('340');
    expect([...sel.options].map((o) => o.text)[1]).toBe('AKEMI — MID VALLEY — REX (09/11 - 09/13)');
    expect(assign).not.toHaveBeenCalled();
    const group = screen.getByText('To check — venue differs (1)').closest('section') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Link' }));
    expect(assign).toHaveBeenCalledWith({ docNo: 'HC-SO-2610-167', projectId: 340 });
  });

  it('lists 等加人 with who is missing, and nothing to pick', () => {
    checks.rows = [NEEDS_ATTENDING];
    show();
    const group = screen.getByText('Waiting for Sales Attending (1)').closest('section') as HTMLElement;
    expect(group.textContent).toContain(NEEDS_ATTENDING.note);
    expect(within(group).queryByRole('button')).toBeNull();
    expect(within(group).getByRole('link', { name: 'HC-SO-2610-300' }).getAttribute('href')).toBe('/scm/sales-orders/HC-SO-2610-300');
  });

  it('a check list that failed to load says so', () => {
    checks.error = true;
    show();
    expect(screen.getByText('Couldn’t load the linked orders to check — try again.')).toBeTruthy();
  });
});

describe('FairPending — who may re-assign (owner 2026-10-16: Finance and PMS)', () => {
  afterEach(() => { who.perms = new Set(['scm.finance.accounting']); who.role = ''; });

  it('anyone else sees the list but cannot link, and is told why', () => {
    who.perms = new Set(['scm.access', 'scm.sales.orders']);
    show();
    expect(screen.getByText('Only Finance or PMS can re-assign a fair here. Every change is in the order’s History.')).toBeTruthy();
    expect((screen.getByLabelText('Fair for HC-SO-2609-064') as HTMLSelectElement).disabled).toBe(true);
  });

  it('a BD role (PMS) may link', () => {
    who.perms = new Set(['scm.access']);
    who.role = 'BD Executive';
    show();
    expect((screen.getByLabelText('Fair for HC-SO-2609-064') as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByText(/Only Finance or PMS/)).toBeNull();
  });
});

describe('boothChoices — which booths a row offers, in what order, and which is filled in', () => {
  const at = (o: Partial<FairOption> & Pick<FairOption, 'key' | 'startDate' | 'endDate' | 'booths'>): FairOption => ({
    venue: 'MID VALLEY', organizer: 'REX', projectIds: (o.booths ?? []).map((b) => b.projectId), ...o,
  });
  const REX = at({ key: 'rex', startDate: '2026-09-11', endDate: '2026-09-13', booths: [{ projectId: 340, brand: 'AKEMI' }, { projectId: 342, brand: 'ERGOTEX' }, { projectId: 2250, brand: 'ERGOTEX' }] });
  const BIGHOME = at({ key: 'bighome', organizer: 'BIGHOME', startDate: '2026-08-28', endDate: '2026-08-31', booths: [{ projectId: 300, brand: 'AKEMI' }, { projectId: 301, brand: 'ZANOTTI' }] });
  const ELSEWHERE = at({ key: 'ioi', venue: 'IOIGECC', startDate: '2026-09-12', endDate: '2026-09-14', booths: [{ projectId: 900, brand: 'AKEMI' }] });

  it('the order’s brand first, nearest its date first, and that booth filled in', () => {
    const { choices, suggested } = boothChoices([BIGHOME, REX, ELSEWHERE], { venue: ' mid  valley', branding: 'akemi', so_date: '2026-09-14' });
    expect(choices.map((c) => c.projectId)).toEqual([340, 300, 342, 301]);
    expect(choices.map((c) => c.sameBrand)).toEqual([true, true, false, false]);
    expect(suggested).toBe(340);
  });

  it('two records of one booth show once, as the lowest id; another venue is never offered', () => {
    const { choices } = boothChoices([REX, ELSEWHERE], { venue: 'MID VALLEY', branding: null, so_date: '2026-09-13' });
    expect(choices.map((c) => c.label)).toEqual([
      'AKEMI — MID VALLEY — REX (09/11 - 09/13)',
      'ERGOTEX — MID VALLEY — REX (09/11 - 09/13)',
    ]);
  });

  it('no brand on the order, or its brand has no booth there: nothing is filled in', () => {
    expect(boothChoices([REX], { venue: 'MID VALLEY', branding: null, so_date: '2026-09-13' }).suggested).toBeNull();
    expect(boothChoices([REX], { venue: 'MID VALLEY', branding: 'DUNLOPILLO', so_date: '2026-09-13' }).suggested).toBeNull();
  });

  it('a response from before booths existed still offers every project, as No brand, unmerged', () => {
    const old = { key: 'rex', venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13', projectIds: [340, 341] };
    const { choices, suggested } = boothChoices([old], { venue: 'MID VALLEY', branding: 'AKEMI', so_date: '2026-09-13' });
    expect(choices.map((c) => [c.projectId, c.label])).toEqual([
      [340, 'No brand — MID VALLEY — REX (09/11 - 09/13)'],
      [341, 'No brand — MID VALLEY — REX (09/11 - 09/13)'],
    ]);
    expect(suggested).toBeNull();
  });
});

describe('FairPending — report says another fair (owner 2026-10-20)', () => {
  const toIoigecc = { projectId: 307, label: 'AKEMI — IOIGECC — HOMELOVE (10/09 - 10/11)', reportDate: '2026-10-10' };
  const LINKED_ELSEWHERE: FairCheckRow = {
    doc_no: 'HC-SO-2610-167', so_date: '2026-10-12', venue: 'IOI MALL PUTRAJAYA', branding: 'AKEMI', project_id: 343, fair_match: 'PICKED',
    status: 'CONFIRMED', local_total_sen: 338800, salesperson_id: 's1', check: 'REPORT_ELSEWHERE', target: toIoigecc,
    note: 'The evening report of AKEMI — IOIGECC — HOMELOVE (10/09 - 10/11) lists it on 10/10; the order is under AKEMI — IOI MALL PUTRAJAYA — MALL MGT (09/16 - 09/20).',
  };
  /* The unlinked HC-SO-2609-065 (waiting for the fair) is in a report: it moves up. */
  const UNLINKED: FairCheckRow = { ...ROWS[1]!, check: 'REPORT_ELSEWHERE', target: toIoigecc, note: 'The evening report … lists it; the order has no event.' };
  const TWO_REPORTS: FairCheckRow = { ...LINKED_ELSEWHERE, doc_no: 'HC-SO-2610-200', target: null, note: 'The evening reports of A and B both list it.' };
  afterEach(() => { checks.rows = []; transferMutate.mockReset(); });

  it('lists them first, once, with where the report puts each', () => {
    checks.rows = [LINKED_ELSEWHERE, UNLINKED, TWO_REPORTS];
    show();
    const group = screen.getByText('Report says another fair (3)').closest('section') as HTMLElement;
    expect(group.textContent).toContain('AKEMI — IOIGECC — HOMELOVE (10/09 - 10/11) · 2026/10/10');
    expect(group.textContent).toContain('Two reports list it — pick on the order');
    /* Moved up out of "Waiting for the fair", not listed twice. */
    expect(screen.queryByText('Waiting for the fair (1)')).toBeNull();
    /* Still unattributed until it moves: the count is unchanged. */
    expect(screen.getByText('5 orders not yet attributed to a fair.')).toBeTruthy();
  });

  it('transfers all at one click, or the ticked ones — never one two reports dispute', () => {
    checks.rows = [LINKED_ELSEWHERE, UNLINKED, TWO_REPORTS];
    show();
    const group = screen.getByText('Report says another fair (3)').closest('section') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Transfer all (2)' }));
    expect(transferMutate.mock.calls[0]![0]).toEqual([
      { docNo: 'HC-SO-2610-167', projectId: 307 },
      { docNo: 'HC-SO-2609-065', projectId: 307 },
    ]);
    expect(within(group).queryByLabelText('Tick HC-SO-2610-200')).toBeNull();
    fireEvent.click(within(group).getByLabelText('Tick HC-SO-2610-167'));
    fireEvent.click(within(group).getByRole('button', { name: 'Transfer ticked (1)' }));
    expect(transferMutate.mock.calls[1]![0]).toEqual([{ docNo: 'HC-SO-2610-167', projectId: 307 }]);
  });
});
