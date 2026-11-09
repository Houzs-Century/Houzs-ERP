// One task's drawer: Edit and Delete (owner 2026-11-09: 「这个我set 的task 不能edit
// 资料，不能delete？」 → 可以). Whoever asked for the task — or an Owner — sees Edit task
// and Delete; Edit opens the same form as Add task with the task as it is and sends
// the whole task; Delete asks first, then switches the task off. A change shows in
// the thread as "Changed" and cannot be rewritten. The server half is
// backend/tests/todoTaskEditDelete.test.ts. authed-fetch is mocked at the module seam.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));

import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import { TaskDrawer } from './TaskDrawers';
import type { TaskDetail, TodoTask } from './finance-todo-queries';

const mockedFetch = vi.mocked(authedFetch);
const onClose = vi.fn();

const TASK: TodoTask = {
  id: 't1', kind: 'task', routineKey: null, title: 'Repay - Mitsubishi RM 1,893 Forklift', groupKey: 'pay',
  assigneeId: 21, assigneeName: 'Mika', createdById: 22, createdByName: 'Siti Rafidah',
  dueDate: '2026-11-11', repeat: 'month', dayMode: 'all', weekdays: [], monthDay: '11', everyMonths: 1, byDay: false,
  link: null, action: 'done', actionTo: null, amountSen: null, payee: null, isOff: false,
};
const detail = (over: Partial<TaskDetail> = {}, task: Partial<TodoTask> = {}): TaskDetail => ({
  task: { ...TASK, ...task },
  occurrences: [],
  remarks: [{ id: 1, authorName: 'Siti Rafidah', body: 'Auto Debit - HLBB BANK', tag: null, occursOn: null, history: [], editedAt: null, createdAt: '2026-11-04T09:53:00Z', mine: true }],
  me: { id: 22, name: 'Siti Rafidah' },
  mayEdit: true,
  ...over,
});

const serve = (d: TaskDetail) => mockedFetch.mockImplementation(async (path: string, init?: RequestInit) => {
  if (path === '/accounting/todo/tasks/t1' && !init?.method) return d;
  if (path === '/accounting/todo/tasks/t1' && init?.method === 'PATCH') return { task: d.task };
  if (path === '/accounting/todo/tasks/t1' && init?.method === 'DELETE') return { ok: true };
  if (path === '/accounting/todo/people') return { people: [{ id: 21, name: 'Mika' }, { id: 22, name: 'Siti Rafidah' }], me: { id: 22, name: 'Siti Rafidah' } };
  if (path.startsWith('/accounting/todo/link-search')) return { results: [] };
  throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
});
const sent = (method: string) => mockedFetch.mock.calls.filter(([p, i]) => p === '/accounting/todo/tasks/t1' && (i as RequestInit | undefined)?.method === method);

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <TaskDrawer open target={{ id: 't1', occursOn: '2026-11-11', due: '2026-11-11' }} groups={[]} onClose={onClose} />
    </MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => { mockedFetch.mockReset(); onClose.mockReset(); });

describe('Edit and Delete show for whoever may use them', () => {
  test('whoever asked (or an Owner) sees Edit task and Delete', async () => {
    serve(detail());
    show();
    expect(await screen.findByRole('button', { name: 'Edit task' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  test('the person it was given to does not', async () => {
    serve(detail({ mayEdit: false, me: { id: 21, name: 'Mika' } }));
    show();
    await screen.findByText('Auto Debit - HLBB BANK');
    expect(screen.queryByRole('button', { name: 'Edit task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('Edit task', () => {
  test('opens the form with the task as it is; Save changes sends the whole task and goes back', async () => {
    serve(detail());
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit task' }));
    const title = await screen.findByLabelText('Task') as HTMLInputElement;
    expect(title.value).toBe('Repay - Mitsubishi RM 1,893 Forklift');
    expect((await screen.findByRole('button', { name: 'Mika' })).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Monthly' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '11' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Payments' }).getAttribute('aria-pressed')).toBe('true');
    /* An edit is not a remark: the form has no remark box. */
    expect(screen.queryByLabelText('Remark')).toBeNull();

    fireEvent.change(title, { target: { value: 'Repay - Mitsubishi RM 1,893 Forklift (HLBB)' } });
    fireEvent.click(screen.getByRole('button', { name: '15' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent('PATCH')).toHaveLength(1));
    expect(JSON.parse(String((sent('PATCH')[0]![1] as RequestInit).body))).toEqual({
      title: 'Repay - Mitsubishi RM 1,893 Forklift (HLBB)', assigneeId: 21, dueDate: '2026-11-11', groupKey: 'pay',
      repeat: 'month', monthDay: '15', everyMonths: 1, link: null,
    });
    expect(await screen.findByRole('button', { name: 'Edit task' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('Cancel goes back to the task and sends nothing', async () => {
    serve(detail());
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit task' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Edit task' })).toBeTruthy();
    expect(sent('PATCH')).toHaveLength(0);
  });
});

describe('Delete', () => {
  test('asks first; Keep it sends nothing', async () => {
    serve(detail());
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/Delete this task\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(sent('DELETE')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  test('Yes, delete switches it off and closes the drawer', async () => {
    serve(detail());
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(sent('DELETE')).toHaveLength(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('The thread', () => {
  test('a change reads as Changed, line by line, and cannot be edited', async () => {
    serve(detail({
      remarks: [{ id: 2, authorName: 'Siti Rafidah', body: 'Due: 2026/11/11 → 2026/11/15\nAssigned to: Mika → Siti Rafidah', tag: 'edit', occursOn: null, history: [], editedAt: null, createdAt: '2026-11-09T02:00:00Z', mine: true }],
    }));
    show();
    const line = (await screen.findByText(/Due: 2026\/11\/11 → 2026\/11\/15/)).closest('div[class]')!.parentElement as HTMLElement;
    expect(within(line).getByText('Changed')).toBeTruthy();
    expect(within(line).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  test('a deleted task says so, and offers neither Edit nor Mark done', async () => {
    serve(detail({ mayEdit: false }, { isOff: true }));
    show();
    expect(await screen.findByText(/This task was deleted/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit task' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark done/ })).toBeNull();
  });
});
