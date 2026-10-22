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
  { doc_no: 'HC-SO-2609-064', so_date: '2026-09-13', venue: 'MID VALLEY', branding: null, project_id: null, fair_match: 'AMBIGUOUS', status: 'CONFIRMED', local_total_sen: 355860, salesperson_id: 's1', ref: null, customer_so_no: 'HC12064' },
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
/* Every fair, the server's list for Finance / PMS (owner 2026-10-21), and
   whether the page asked for it. */
const allFairs = vi.hoisted(() => ({ list: [] as unknown[], asked: [] as boolean[] }));
/* The orders put aside (owner 2026-10-21), and the put-aside write. */
const aside = vi.hoisted(() => ({ list: [] as unknown[], mutate: vi.fn() }));
const who = vi.hoisted(() => ({ perms: new Set<string>(['scm.finance.accounting']), role: '' }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role_name: who.role, position_name: null, email: 'x@houzs.test' }, can: (p: string) => who.perms.has('*') || who.perms.has(p) }),
}));
/* The staff roster the SO list names salespeople from; s5 is on no roster. */
const STAFF = vi.hoisted((): Record<string, string> => ({ s1: 'Alice', s2: 'Bob', s3: 'Chong', s4: 'Devi' }));
vi.mock('../../hooks/useStaffLookup', () => ({
  useStaffLookup: () => ({
    nameOf: (_agent: string | null, id: string | null | undefined, fallback = '—') => (id && STAFF[id]) || fallback,
  }),
}));

vi.mock('../../vendor/scm/lib/fair-options-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/fair-options-queries')>()),
  useFairPending: () => ({ data: ROWS, isLoading: false, isError: false }),
  useFairOptions: () => ({ data: OPTIONS, isLoading: false, isError: false }),
  useAllFairOptions: (enabled: boolean) => {
    allFairs.asked.push(enabled);
    return { data: enabled ? allFairs.list : undefined, isLoading: false, isError: false };
  },
  useAssignFair: () => ({ mutate: assign, isPending: false }),
  useFairChecks: () => ({ data: checks.rows, isLoading: false, isError: checks.error }),
  useFairTransfer: () => ({ mutate: transferMutate, isPending: false }),
  useFairPutAside: () => ({ data: aside.list, isLoading: false, isError: false }),
  usePutAside: () => ({ mutate: aside.mutate, isPending: false }),
}));

import { FairPending } from './FairPending';
import { allBoothChoices, boothChoices } from '../../vendor/scm/lib/fair-booth-choices';

const show = () => render(<MemoryRouter><FairPending /></MemoryRouter>);

/* The row's fair picker: a type-to-search list over every fair. */
const fairInput = (doc: string) => screen.getByLabelText(`Fair for ${doc}`) as HTMLInputElement;
/** Open a row's picker; the portalled list is the last <ul role="listbox">. */
function openFairs(doc: string): HTMLElement {
  fireEvent.focus(fairInput(doc));
  const lists = document.querySelectorAll('ul[role="listbox"]');
  return lists[lists.length - 1] as HTMLElement;
}
const optionTexts = (list: HTMLElement) => [...list.querySelectorAll('li[role="option"]')].map((li) => li.textContent);
const headingTexts = (list: HTMLElement) => [...list.querySelectorAll('li[role="presentation"]')].map((li) => li.textContent);
/** Pick an option by its label. Opening seeds the search with the current
 *  pick (house rule), so the search is emptied first to see every fair. */
function pickFair(doc: string, label: string) {
  const list = openFairs(doc);
  fireEvent.change(fairInput(doc), { target: { value: '' } });
  const li = [...list.querySelectorAll('li[role="option"]')].find((x) => x.textContent === label);
  if (!li) throw new Error(`no option "${label}"`);
  fireEvent.mouseDown(li);
}

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
    expect(optionTexts(openFairs('HC-SO-2609-064'))).toEqual([
      'AKEMI — MID VALLEY — REX (09/11 - 09/13)',
      'ZANOTTI — MID VALLEY — REX (09/11 - 09/13)',
    ]);
  });

  it('lines every group up in the same columns', () => {
    show();
    for (const title of ['Pick one (1)', 'Waiting for the fair (1)', 'Marked No fair (1)']) {
      const group = screen.getByText(title).closest('section') as HTMLElement;
      expect(within(group).getAllByRole('columnheader').map((h) => h.textContent))
        .toEqual(['SO No.', 'Ref No.', 'SO date', 'Salesperson', 'Venue', 'Brand', 'Amount', 'Fair', '']);
    }
  });

  it('every group shows who sold the order after its date, a dash when the roster has nobody', () => {
    /* Owner 2026-10-22: 「这里也帮我显示sales person」. */
    show();
    const pick = screen.getByText('HC-SO-2609-064').closest('tr') as HTMLTableRowElement;
    expect([...pick.cells].map((c) => c.textContent).slice(2, 5)).toEqual(['2026/09/13', 'Alice', 'MID VALLEY']);
    const keyedBefore = screen.getByText('HC-SO-2609-009').closest('tr') as HTMLTableRowElement;
    expect(keyedBefore.cells[3]!.textContent).toBe('—');
  });

  /* Owner 2026-10-21: 「做成好看的table 有线条的那种」, 「header 颜色…可以refer
     其他的table」 — the heading as the system's lists draw it, every cell ruled,
     the sentence in its order's box. */
  it('a boxed table: the system lists’ heading, ruled cells, the sentence inside its order’s box', () => {
    show();
    const group = screen.getByText('Pick one (1)').closest('section') as HTMLElement;
    const classes = (el: Element) => el.className.split(/\s+/);
    for (const h of within(group).getAllByRole('columnheader')) {
      expect(classes(h)).toEqual(expect.arrayContaining(['bg-surface-dim', 'font-semibold', 'text-ink', 'border-b-2']));
      expect(classes(h)).not.toContain('uppercase');
      expect((h as HTMLElement).style.textTransform).toBe('');
    }
    const row = screen.getByText('HC-SO-2609-064').closest('tr') as HTMLTableRowElement;
    for (const c of row.cells) expect(classes(c)).toEqual(expect.arrayContaining(['border-t', 'border-r', 'border-border']));
  });

  it('every group shows the order’s Ref No. beside its SO number, a dash when it has none', () => {
    /* Owner 2026-10-21: 「我这里也需要这个reference」 — the slip number the
       evening report lists, as the SO page shows it. */
    show();
    const pick = screen.getByText('HC-SO-2609-064').closest('tr') as HTMLTableRowElement;
    expect([...pick.cells].map((c) => c.textContent).slice(0, 2)).toEqual(['HC-SO-2609-064', 'HC12064']);
    const waiting = screen.getByText('HC-SO-2609-065').closest('tr') as HTMLTableRowElement;
    expect(waiting.cells[1]!.textContent).toBe('—');
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
    const input = fairInput('HC-SO-2609-065');
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('No fair at that place on that date');
  });

  it('links only the picked project, and only once a pick exists', () => {
    show();
    const buttons = screen.getAllByRole('button', { name: 'Link' });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    pickFair('HC-SO-2609-064', 'ZANOTTI — MID VALLEY — REX (09/11 - 09/13)');
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    expect(assign).toHaveBeenCalledWith({ docNo: 'HC-SO-2609-064', projectId: 341 });
  });

  it('Finance / PMS may pick EVERY fair: its own place first, then other dates, then other places — typing narrows', () => {
    /* Owner 2026-10-21: 「我这里link fair 要可以选完全部fair」 — HC-SO-2610-002's slip
       says PISA SPICE ARENA, PMS calls the fair SETIA SPICE CONVENTION CENTRE. */
    allFairs.list = [
      {
        key: 'setia spice|homedec|2026-10-02|2026-10-04', venue: 'SETIA SPICE CONVENTION CENTRE', organizer: 'HOMEDEC', startDate: '2026-10-02', endDate: '2026-10-04',
        projectIds: [2235], booths: [{ projectId: 2235, brand: 'AKEMI' }],
      },
      {
        key: 'mid valley|bighome|2026-08-28|2026-08-31', venue: 'MID VALLEY', organizer: 'BIGHOME', startDate: '2026-08-28', endDate: '2026-08-31',
        projectIds: [300], booths: [{ projectId: 300, brand: 'AKEMI' }],
      },
      /* Already offered at the order's own place: listed once. */
      OPTIONS.running[0],
    ];
    try {
      show();
      expect(allFairs.asked.length > 0 && allFairs.asked.every(Boolean)).toBe(true);
      const list = openFairs('HC-SO-2609-064');
      expect(headingTexts(list)).toEqual(['At this place', 'At this place — other dates', 'Other places']);
      expect(optionTexts(list)).toEqual([
        'AKEMI — MID VALLEY — REX (09/11 - 09/13)',
        'ZANOTTI — MID VALLEY — REX (09/11 - 09/13)',
        'AKEMI — MID VALLEY — BIGHOME (08/28 - 08/31)',
        'AKEMI — SETIA SPICE CONVENTION CENTRE — HOMEDEC (10/02 - 10/04)',
      ]);
      fireEvent.change(fairInput('HC-SO-2609-064'), { target: { value: 'setia' } });
      expect(optionTexts(list)).toEqual(['AKEMI — SETIA SPICE CONVENTION CENTRE — HOMEDEC (10/02 - 10/04)']);
      /* An order whose own place has nothing can still be linked. */
      const input = fairInput('HC-SO-2609-065');
      expect(input.disabled).toBe(false);
      expect(input.value).toBe('');
      pickFair('HC-SO-2609-065', 'AKEMI — SETIA SPICE CONVENTION CENTRE — HOMEDEC (10/02 - 10/04)');
      const row = input.closest('tr') as HTMLTableRowElement;
      fireEvent.click(within(row).getByRole('button', { name: 'Link' }));
      expect(assign).toHaveBeenCalledWith({ docNo: 'HC-SO-2609-065', projectId: 2235 });
    } finally {
      allFairs.list = [];
    }
  });

  it('anyone who may not link is not even sent the full list', () => {
    who.perms = new Set(['scm.access', 'scm.sales.orders']);
    allFairs.asked = [];
    try {
      show();
      expect(allFairs.asked.length > 0 && allFairs.asked.every((x) => !x)).toBe(true);
    } finally {
      who.perms = new Set(['scm.finance.accounting']);
    }
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
    note: 'Jason is not on Sales Attending for AKEMI @ MID VALLEY (10/15 - 10/18). PMS adds them in the project.',
  };
  afterEach(() => { checks.rows = []; checks.error = false; });

  it('lists 要查 with its sentence and the fairs at the order’s own venue to re-link to', () => {
    checks.rows = [VENUE_DIFFERS];
    show();
    const group = screen.getByText('To check — venue differs (1)').closest('section') as HTMLElement;
    expect(group.textContent).toContain(VENUE_DIFFERS.note);
    pickFair('HC-SO-2610-167', 'ZANOTTI — MID VALLEY — REX (09/11 - 09/13)');
    fireEvent.click(within(group).getByRole('button', { name: 'Link' }));
    expect(assign).toHaveBeenCalledWith({ docNo: 'HC-SO-2610-167', projectId: 341 });
  });

  it('fills in the order’s own brand booth, first in the list — nothing is linked until Link is pressed', () => {
    /* Owner 2026-10-20: preselect the same-brand booth nearest the order date
       (「可以」); the person still presses Link. */
    assign.mockClear();
    checks.rows = [VENUE_DIFFERS];
    show();
    expect(fairInput('HC-SO-2610-167').value).toBe('AKEMI — MID VALLEY — REX (09/11 - 09/13)');
    expect(optionTexts(openFairs('HC-SO-2610-167'))[0]).toBe('AKEMI — MID VALLEY — REX (09/11 - 09/13)');
    fireEvent.blur(fairInput('HC-SO-2610-167'));
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
    expect((screen.getByText('HC-SO-2610-300').closest('tr') as HTMLTableRowElement).cells[3]!.textContent).toBe('Bob');
    expect(within(group).queryByRole('button')).toBeNull();
    expect(within(group).getByRole('link', { name: 'HC-SO-2610-300' }).getAttribute('href')).toBe('/scm/sales-orders/HC-SO-2610-300');
  });

  it('a check list that failed to load says so', () => {
    checks.error = true;
    show();
    expect(screen.getByText('Couldn’t load the linked orders to check — try again.')).toBeTruthy();
  });
});

/* Owner 2026-10-21: 「还有一些我看了是 service 要 put aside 的」. */
describe('FairPending — put aside', () => {
  afterEach(() => { aside.list = []; aside.mutate.mockReset(); });

  it('each order to pick for can be put aside', () => {
    show();
    const row = screen.getByText('HC-SO-2609-064').closest('tr') as HTMLTableRowElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Put aside' }));
    expect(aside.mutate).toHaveBeenCalledWith({ docNo: 'HC-SO-2609-064', aside: true });
  });

  it('the put-aside orders wait folded at the bottom, each with who and when, and can be brought back', () => {
    aside.list = [{ ...ROWS[2]!, doc_no: 'HC-SO-2610-066', branding: 'SERVICE', fair_put_aside_at: '2026-10-21T09:00:00Z', fair_put_aside_by: 'Chew' }];
    show();
    const toggle = screen.getByRole('button', { name: 'Put aside (1)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('HC-SO-2610-066')).toBeNull();
    fireEvent.click(toggle);
    const row = screen.getByText('HC-SO-2610-066').closest('tr') as HTMLTableRowElement;
    expect(row.cells[3]!.textContent).toBe('Chong');
    expect(row.textContent).toContain('Chew · 2026/10/21');
    fireEvent.click(within(row).getByRole('button', { name: 'Bring back' }));
    expect(aside.mutate).toHaveBeenCalledWith({ docNo: 'HC-SO-2610-066', aside: false });
  });

  it('nothing put aside: no group at all', () => {
    show();
    expect(screen.queryByRole('button', { name: /Put aside \(/ })).toBeNull();
  });
});

describe('FairPending — who may re-assign (owner 2026-10-16: Finance and PMS)', () => {
  afterEach(() => { who.perms = new Set(['scm.finance.accounting']); who.role = ''; });

  it('anyone else sees the list but cannot link, and is told why', () => {
    who.perms = new Set(['scm.access', 'scm.sales.orders']);
    show();
    expect(screen.getByText('Only Finance or PMS can re-assign a fair here. Every change is in the order’s History.')).toBeTruthy();
    expect(fairInput('HC-SO-2609-064').disabled).toBe(true);
  });

  it('a BD role (PMS) may link', () => {
    who.perms = new Set(['scm.access']);
    who.role = 'BD Executive';
    show();
    expect(fairInput('HC-SO-2609-064').disabled).toBe(false);
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

  it('every fair: the order’s own place first, then nearest its date, its brand first among equals (owner 2026-10-21)', () => {
    const SETIA = at({ key: 'setia', venue: 'SETIA SPICE CONVENTION CENTRE', organizer: 'HOMEDEC', startDate: '2026-09-12', endDate: '2026-09-14', booths: [{ projectId: 2246, brand: 'ZANOTTI' }, { projectId: 2235, brand: 'AKEMI' }] });
    const FAR = at({ key: 'far', venue: 'KLCC', organizer: 'MLE', startDate: '2026-06-01', endDate: '2026-06-03', booths: [{ projectId: 50, brand: 'AKEMI' }] });
    const all = allBoothChoices([FAR, SETIA, BIGHOME, REX], { venue: 'MID VALLEY', branding: 'AKEMI', so_date: '2026-09-14' });
    expect(all.map((c) => [c.projectId, c.samePlace])).toEqual([
      [340, true], [342, true], [300, true], [301, true],
      [2235, false], [2246, false], [50, false],
    ]);
  });
});

describe('FairPending — report says another fair (owner 2026-10-20)', () => {
  const toIoigecc = {
    projectId: 307, title: '[AKEMI] HOMELOVE', detail: 'IOIGECC · 10/09 - 10/11',
    label: 'AKEMI — IOIGECC — HOMELOVE (10/09 - 10/11)', reportDate: '2026-10-10',
  };
  const mallMgt = { projectId: 343, title: '[AKEMI] MALL MGT', detail: 'IOI MALL PUTRAJAYA · 09/16 - 09/20' };
  const LINKED_ELSEWHERE: FairCheckRow = {
    doc_no: 'HC-SO-2610-167', so_date: '2026-10-12', venue: 'IOI MALL PUTRAJAYA', branding: 'AKEMI', project_id: 343, fair_match: 'PICKED',
    status: 'CONFIRMED', local_total_sen: 338800, salesperson_id: 's1', customer_so_no: 'HC13316', check: 'REPORT_ELSEWHERE', target: toIoigecc, current: mallMgt,
    note: 'The evening report of AKEMI — IOIGECC — HOMELOVE (10/09 - 10/11) lists it on 10/10; the order is under AKEMI — IOI MALL PUTRAJAYA — MALL MGT (09/16 - 09/20).',
  };
  /* The unlinked HC-SO-2609-065 (waiting for the fair) is in a report: it moves up. */
  const UNLINKED: FairCheckRow = { ...ROWS[1]!, check: 'REPORT_ELSEWHERE', target: toIoigecc, current: null, note: 'The evening report … lists it; the order has no event.' };
  const TWO_REPORTS: FairCheckRow = {
    ...LINKED_ELSEWHERE, doc_no: 'HC-SO-2610-200', target: null, note: 'The evening reports of A and B both list it.',
    candidates: [{ projectId: 307, title: '[AKEMI] HOMELOVE', detail: 'IOIGECC · 10/09 - 10/11' }, { projectId: 2228, title: '[AKEMI] MLE', detail: 'MVEC SOUTHKEY · 09/18 - 09/20' }],
  };
  afterEach(() => { checks.rows = []; transferMutate.mockReset(); });

  it('lists them first, once, with where the report puts each', () => {
    checks.rows = [LINKED_ELSEWHERE, UNLINKED, TWO_REPORTS];
    show();
    const group = screen.getByText('Report says another fair (3)').closest('section') as HTMLElement;
    expect(group.textContent).toContain('[AKEMI] HOMELOVEIOIGECC · 10/09 - 10/11 · reported 10/10');
    expect(group.textContent).toContain('Two reports list it — pick on the order');
    expect(group.textContent).toContain('[AKEMI] HOMELOVE (IOIGECC · 10/09 - 10/11) / [AKEMI] MLE (MVEC SOUTHKEY · 09/18 - 09/20)');
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

  /* Owner 2026-10-21: 这个表很乱 — one row per order, the tick on the left, where
     it is now beside where the report puts it, no sentence under each row. */
  it('one row per order: tick, SO No., Ref No., where it is now and where the report puts it', () => {
    checks.rows = [LINKED_ELSEWHERE, UNLINKED];
    show();
    const group = screen.getByText('Report says another fair (2)').closest('section') as HTMLElement;
    const heads = within(group).getAllByRole('columnheader');
    expect(heads.map((h) => h.textContent)).toEqual(['SO No.', 'Ref No.', 'SO date', 'Salesperson', 'Now under', 'Brand', 'Amount', 'Report says']);
    /* The tick sits first in the SO No. cell, ahead of the number. */
    expect(heads[0]!.querySelector('input[type="checkbox"]')).toBeTruthy();
    const body = group.querySelector('tbody') as HTMLTableSectionElement;
    expect(body.rows).toHaveLength(2);
    expect(group.textContent).not.toContain('The evening report');
    const linked = body.rows[0]!;
    expect(linked.cells[0]!.querySelector('input[aria-label="Tick HC-SO-2610-167"]')).toBeTruthy();
    expect([...linked.cells].map((c) => c.textContent)).toEqual([
      'HC-SO-2610-167', 'HC13316', '2026/10/12', 'Alice', '[AKEMI] MALL MGTIOI MALL PUTRAJAYA · 09/16 - 09/20', 'AKEMI', 'RM 3,388.00',
      '[AKEMI] HOMELOVEIOIGECC · 10/09 - 10/11 · reported 10/10',
    ]);
    expect(body.rows[1]!.cells[4]!.textContent).toBe('Not linkedSUNWAY PYRAMID CONVENTION CENTRE');
  });

  it('a server from before the two lines still names the fair on one line', () => {
    const { title: _t, detail: _d, ...oneLine } = toIoigecc;
    void _t; void _d;
    checks.rows = [{ ...LINKED_ELSEWHERE, target: oneLine, current: undefined }];
    show();
    const group = screen.getByText('Report says another fair (1)').closest('section') as HTMLElement;
    expect(group.textContent).toContain('AKEMI — IOIGECC — HOMELOVE (10/09 - 10/11) · reported 10/10');
  });
});
