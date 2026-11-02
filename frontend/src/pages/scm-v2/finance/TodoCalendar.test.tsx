// The To do's Calendar (the owner's Claude Design redesign, batch 2): the month
// grid shows what falls on each day, a day's list opens beside it with what to
// do, and a task dragged to another day is moved there this time only.
// authed-fetch is mocked at the module seam; the rules are pinned in backend
// acc/todo-calendar.test.ts.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));

import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import { TodoCalendar } from './TodoCalendar';
import type { CalEvent, TodoCalendarPage } from './finance-todo-queries';

const mockedFetch = vi.mocked(authedFetch);

const ev = (over: Partial<CalEvent>): CalEvent => ({
  key: 'k', day: '2026-11-02', kind: 'task', label: 'L', short: 'S', detail: '', amountSen: null, done: false, to: null, task: null, ...over,
});

const PAGE: TodoCalendarPage = {
  month: '2026-11', today: '2026-11-02',
  events: [
    ev({ key: 'bill:1', day: '2026-11-05', kind: 'pay', label: 'Kian Furniture · pay bill', short: 'Kian bill', detail: 'HCAPI-2611-001 · not paid', amountSen: 1_929_000, to: '/scm/ap-invoices?open=1' }),
    ev({ key: 'task:t1:2026-11-02', day: '2026-11-02', kind: 'task', label: 'Call Kian Furniture', short: 'Call Kian', detail: 'Your task',
      task: { id: 't1', occursOn: '2026-11-02', kind: 'task', action: 'done', link: null, mine: true } }),
    ev({ key: 'task:r1:2026-11-07', day: '2026-11-07', kind: 'routine', label: 'Salaries', short: 'Salaries', detail: 'Routine · every month on the 7th', to: '/scm/payment-vouchers',
      task: { id: 'r1', occursOn: '2026-11-07', kind: 'routine', action: 'open', link: null, mine: true } }),
  ],
  next7: [{ kind: 'pay', label: 'Payments due', count: 1, amountSen: 1_929_000 }, { kind: 'routine', label: 'Routines', count: 1, amountSen: 0 }],
  problems: [],
};

const renderCal = (onOpenTask = vi.fn()) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><TodoCalendar today="2026-11-02" onOpenTask={onOpenTask} /></MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => { mockedFetch.mockReset(); mockedFetch.mockResolvedValue(PAGE); });

describe('TodoCalendar', () => {
  test('reads the month, puts each thing on its day, and lists today with what to do', async () => {
    const onOpenTask = vi.fn();
    renderCal(onOpenTask);
    expect(await screen.findByText('Kian bill')).toBeTruthy();
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/todo/calendar?month=2026-11');
    const day = screen.getByLabelText('Chosen day');
    expect(within(day).getByText('today')).toBeTruthy();
    expect(within(day).getByRole('button', { name: 'Mark done' })).toBeTruthy();
    fireEvent.click(within(day).getByRole('button', { name: 'Call Kian Furniture' }));
    expect(onOpenTask).toHaveBeenCalledWith({ id: 't1', occursOn: '2026-11-02', due: '2026-11-02' });
    const next = screen.getByLabelText('Next 7 days');
    expect(within(next).getByText('Payments due')).toBeTruthy();
    expect(within(next).getByText('RM 19,290.00')).toBeTruthy();
  });

  test('choosing a day shows its list; a bill opens its own document', async () => {
    renderCal();
    await screen.findByText('Kian bill');
    fireEvent.click(screen.getByRole('button', { name: '2026/11/05' }));
    const day = screen.getByLabelText('Chosen day');
    expect(within(day).getByText('Kian Furniture · pay bill')).toBeTruthy();
    expect(within(day).getByRole('button', { name: 'Open' })).toBeTruthy();
  });

  test('a task dragged to another day is moved there this time only', async () => {
    renderCal();
    const chip = await screen.findByText('Call Kian');
    fireEvent.dragStart(chip, { dataTransfer: { effectAllowed: '' } });
    const target = screen.getByRole('button', { name: '2026/11/09' });
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/accounting/todo/tasks/t1/move', expect.objectContaining({ method: 'POST' })));
    const [, init] = mockedFetch.mock.calls.find(([p]) => p === '/accounting/todo/tasks/t1/move')!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ occursOn: '2026-11-02', to: '2026-11-09' });
  });

  test('the next month is one click away', async () => {
    renderCal();
    await screen.findByText('Kian bill');
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/accounting/todo/calendar?month=2026-12'));
  });
});
