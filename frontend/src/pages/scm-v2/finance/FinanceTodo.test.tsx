// Finance's To do page (the owner's Claude Design redesign, Finance-1a-To-do,
// 2026-11-02): it draws what the server raised — the jobs in their groups with
// how long they waited, the money that can move today, the month's checklist —
// and says when part of it could not be read. authed-fetch is mocked at the
// module seam; the rules themselves are pinned in backend acc/finance-todo.test.ts.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));

import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import { FinanceTodoPage, ageTag, dueTag } from './FinanceTodo';
import type { FinanceTodo, TodoJob } from './finance-todo-queries';

const mockedFetch = vi.mocked(authedFetch);

const job = (over: Partial<TodoJob>): TodoJob => ({
  key: 'k', rule: 'requests', group: 'pay', sub: null, tone: 'out', icon: 'send', title: 'T', detail: 'D',
  amountSen: null, since: '2026-11-02', action: { label: 'Open', to: '/x', primary: false }, who: null, task: null, ...over,
});

const PAGE: FinanceTodo = {
  today: '2026-11-02',
  mine: [
    job({ key: 'bank-decide:310', rule: 'bank-decide', group: 'recon', sub: 'bank', tone: 'bank', icon: 'landmark', title: 'Decide 4 Hong Leong lines', since: '2026-10-28', amountSen: 1_234_500, action: { label: 'Match', to: '/scm/bank-recon', primary: false } }),
    job({ key: 'card-missing:PBB', rule: 'card-missing', group: 'recon', sub: 'merchant', tone: 'cards', icon: 'upload', title: 'Upload PBB merchant report', since: '2026-11-01', action: { label: 'Upload', to: '/scm/merchant-recon', primary: true } }),
    job({ key: 'requests', title: 'Turn 2 payment requests into vouchers', since: '2026-11-02', amountSen: 50_000, action: { label: 'Review', to: '/scm/payment-requests?filter=waiting', primary: true } }),
  ],
  others: [job({ key: 'pv-approve', rule: 'pv-approve', title: 'Approve 1 payment voucher', who: 'Nico' })],
  done: [{ key: 'd1', text: 'Confirmed 12 HLB merchant lines', je: 'HC-JE-2611-0001', at: '09:05' }],
  money: { bankCashSen: 28_428_915, awaitingSen: 1_358_000, onTheWaySen: 1_619_000 },
  checklist: { month: '2026-11', daysLeft: 28, items: [{ key: 'reports-in', label: 'Merchant reports in', value: '1 missing', state: 'open', to: '/scm/merchant-recon' }] },
  problems: [],
  groups: [],
  viewer: { id: 7, name: 'Mei Ling' },
};

const renderPage = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><FinanceTodoPage /></MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => { mockedFetch.mockReset(); });

describe('the waiting tag', () => {
  test('new today, then a calm day, a warning day, and late with a dot from the third', () => {
    expect(ageTag('2026-11-02', '2026-11-02')).toEqual({ text: 'New', tone: 'info', dot: false });
    expect(ageTag('2026-11-01', '2026-11-02')).toMatchObject({ text: 'Waiting 1 day', tone: 'calm' });
    expect(ageTag('2026-10-31', '2026-11-02')).toMatchObject({ text: 'Waiting 2 days', tone: 'warn' });
    expect(ageTag('2026-10-28', '2026-11-02')).toEqual({ text: 'Waiting 5 days', tone: 'late', dot: true });
    expect(ageTag(null, '2026-11-02')).toBeNull();
  });
});

describe('FinanceTodoPage', () => {
  test('reads GET /accounting/todo and draws the groups, merchant reports before bank statements', async () => {
    mockedFetch.mockResolvedValueOnce(PAGE);
    renderPage();
    const recon = await screen.findByLabelText('Merchant reports & bank statements');
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/todo');
    const titles = within(recon).getAllByText(/Upload PBB|Decide 4/).map((n) => n.textContent);
    expect(titles).toEqual(['Upload PBB merchant report', 'Decide 4 Hong Leong lines']);
    expect(within(recon).getByText('1 file to upload first')).toBeTruthy();
    expect(within(recon).getByText('Waiting 5 days')).toBeTruthy();
    expect(within(recon).getByRole('link', { name: /Upload/ }).getAttribute('href')).toBe('/scm/merchant-recon');
    const pay = screen.getByLabelText('Payments');
    expect(within(pay).getByText('New')).toBeTruthy();
    expect(within(pay).getByText('RM 500.00')).toBeTruthy();
  });

  test('others show who they wait for; done today keeps its entry number', async () => {
    mockedFetch.mockResolvedValueOnce(PAGE);
    renderPage();
    const others = await screen.findByLabelText('Waiting on others');
    expect(within(others).getByText('Nico')).toBeTruthy();
    const done = screen.getByLabelText('Done today');
    expect(within(done).getByText('HC-JE-2611-0001')).toBeTruthy();
    expect(screen.getByText('1 of 4 done today')).toBeTruthy();
  });

  test('can move today is bank and cash less what awaits approval; card money on its way is beside it, not in it', async () => {
    mockedFetch.mockResolvedValueOnce(PAGE);
    renderPage();
    const money = await screen.findByLabelText('Can move today');
    expect(within(money).getByText('RM 270,709.15')).toBeTruthy();
    expect(within(money).getByText('16,190.00')).toBeTruthy();
    expect(money.getAttribute('href')).toBe('/scm/daily-bank?view=board');
    const check = screen.getByLabelText('Month checklist');
    expect(within(check).getByText('November checklist')).toBeTruthy();
    expect(within(check).getByText('28 days left')).toBeTruthy();
    expect(within(check).getByRole('link', { name: 'Review November' }).getAttribute('href')).toBe('/scm/accounting?tab=close');
  });

  test('a section that could not be read is said, and nothing waiting is said plainly', async () => {
    mockedFetch.mockResolvedValueOnce({ ...PAGE, mine: [], others: [], problems: ['bank lines (timeout)'] });
    renderPage();
    expect(await screen.findByText(/Some of it could not be read, so it is not listed: bank lines \(timeout\)/)).toBeTruthy();
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
  });
});

describe('tasks and routines', () => {
  test('due tags: overdue is late with a dot, today a warning, a routine names its day', () => {
    expect(dueTag('2026-10-30', '2026-11-02', 'task')).toEqual({ text: 'Overdue 3 days', tone: 'late', dot: true });
    expect(dueTag('2026-11-02', '2026-11-02', 'task')).toMatchObject({ text: 'Due today', tone: 'warn' });
    expect(dueTag('2026-11-03', '2026-11-02', 'task')).toMatchObject({ text: 'Due tomorrow', tone: 'calm' });
    expect(dueTag('2026-11-07', '2026-11-02', 'routine')).toMatchObject({ text: 'Due 2026/11/07', tone: 'info' });
  });

  test('a task row says when it is due, its remarks and link; Mark done posts the occurrence; Add task opens the form', async () => {
    const t = job({
      key: 'task:t1:2026-11-02', rule: 'task', group: 'pay', tone: 'manual', icon: 'pen-line', title: 'Call Kian Furniture', since: null,
      detail: 'Added by you', action: { label: 'Mark done', to: '', primary: false },
      task: { id: 't1', occursOn: '2026-11-02', due: '2026-11-02', kind: 'task', action: 'done', remarkCount: 2, repeats: false, done: false,
        link: { type: 'AP invoice', no: 'HCAPI-2610-024', name: '', to: '/scm/ap-invoices?open=x' } },
    });
    /* Every read answers the page; the done POST only needs to succeed. */
    mockedFetch.mockResolvedValue({ ...PAGE, mine: [t], others: [], done: [] });
    renderPage();
    const pay = await screen.findByLabelText('Payments');
    expect(within(pay).getByText('Due today')).toBeTruthy();
    expect(within(pay).getByTitle('2 remarks')).toBeTruthy();
    expect(within(pay).getByRole('link', { name: /HCAPI-2610-024/ }).getAttribute('href')).toBe('/scm/ap-invoices?open=x');
    fireEvent.click(within(pay).getByRole('button', { name: /Mark done/ }));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/accounting/todo/tasks/t1/done', expect.objectContaining({ method: 'POST' })));
    const [, init] = mockedFetch.mock.calls.find(([p]) => p === '/accounting/todo/tasks/t1/done')!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ occursOn: '2026-11-02' });
    fireEvent.click(screen.getByRole('button', { name: /Add task/ }));
    expect(await screen.findByPlaceholderText(/Call Kian Furniture about the October statement/)).toBeTruthy();
  });
});
