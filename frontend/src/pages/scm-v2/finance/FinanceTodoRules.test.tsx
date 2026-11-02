// Setup › To do rules (the owner's Claude Design redesign, batch 2): switching
// a rule off sends the whole list of rules off; a new rule from a template is
// added with its number and group; a routine's amount is saved in sen.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../../vendor/scm/lib/mutation-error', () => ({ writeFailedAs: () => () => {} }));

import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import { FinanceTodoRulesPage } from './FinanceTodoRules';
import type { TodoSettings } from './finance-todo-queries';

const mockedFetch = vi.mocked(authedFetch);

const SETTINGS: TodoSettings = {
  rulesOff: ['transfers'],
  groups: [{ id: 'g-tax', label: 'Tax & e-invoice' }],
  customRules: [{ id: 'c-1', tpl: 'drafts', param: 3, group: 'other' }],
  routines: [{
    id: 'r1', kind: 'routine', routineKey: 'rent', title: 'Rent', groupKey: 'pay', assigneeId: null, assigneeName: null,
    createdById: null, createdByName: null, dueDate: '2026-12-01', repeat: 'month', dayMode: 'all', weekdays: [], monthDay: '1',
    everyMonths: 1, byDay: false, link: null, action: 'voucher', actionTo: null, amountSen: null, payee: null, isOff: false,
  }],
  mayEdit: true,
};

const renderPage = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><FinanceTodoRulesPage /></MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => { mockedFetch.mockReset(); mockedFetch.mockResolvedValue(SETTINGS); });

const bodyOf = (path: string) => {
  /* The write, not the read of the same path. */
  const call = mockedFetch.mock.calls.find(([p, init]) => p === path && init?.body !== undefined);
  return call ? JSON.parse(String(call[1]?.body)) as unknown : undefined;
};

describe('FinanceTodoRulesPage', () => {
  test('switching a rule on or off sends the rules that are off', async () => {
    renderPage();
    const rules = await screen.findByLabelText('Built-in rules');
    fireEvent.click(within(rules).getByRole('switch', { name: 'Merchant report missing on' }));
    await waitFor(() => expect(bodyOf('/accounting/todo/settings')).toEqual({ rulesOff: ['transfers', 'card-missing'] }));
    expect(within(rules).getByText('Yours')).toBeTruthy();
    expect(within(rules).getByText('Finance documents still in Draft after 3 days')).toBeTruthy();
  });

  test('a new rule from a template carries its number and group', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    const form = screen.getByLabelText('New rule');
    fireEvent.change(within(form).getByLabelText('Due within'), { target: { value: '14' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(bodyOf('/accounting/todo/rules')).toEqual({ tpl: 'bills', param: 14, group: 'pay' }));
  });

  test('a routine\'s amount is saved in sen when the field is left', async () => {
    renderPage();
    const amount = await screen.findByLabelText('Rent amount');
    fireEvent.change(amount, { target: { value: '4,800' } });
    fireEvent.blur(amount);
    await waitFor(() => expect(bodyOf('/accounting/todo/tasks/r1')).toEqual({ amountSen: 480000 }));
  });
});
