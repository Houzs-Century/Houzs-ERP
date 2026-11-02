// The To do's tasks and routines (the owner's Claude Design redesign, batch 2):
// when a repeating task falls, which occurrence waits now, how a repeat reads,
// and how tasks land on the page — mine, waiting on others, done today.

import { describe, it, expect } from 'vitest';
import { occurrenceDays, pendingOccurrence, repeatText, type TodoTask } from './todo-tasks';
import { buildFinanceTodo, raiseJobs, type TodoFacts, type TodoViewer } from './finance-todo';

const task = (over: Partial<TodoTask> = {}): TodoTask => ({
  id: 't1', kind: 'task', routineKey: null, title: 'Call Kian Furniture about the October statement', groupKey: 'pay',
  assigneeId: 7, assigneeName: 'Mei Ling', createdById: 7, createdByName: 'Mei Ling',
  dueDate: '2026-11-02', repeat: 'none', dayMode: 'all', weekdays: [], monthDay: null, everyMonths: 1, byDay: false,
  link: null, action: 'done', actionTo: null, amountSen: null, payee: null, isOff: false, createdAt: '2026-11-01T02:00:00Z',
  ...over,
});

describe('when a task falls', () => {
  it('weekdays only, Mon to Sat, chosen weekdays', () => {
    expect(occurrenceDays(task({ repeat: 'day', dayMode: 'wk' }), '2026-11-06', '2026-11-10')).toEqual(['2026-11-06', '2026-11-09', '2026-11-10']);
    expect(occurrenceDays(task({ repeat: 'day', dayMode: 'ms' }), '2026-11-07', '2026-11-09')).toEqual(['2026-11-07', '2026-11-09']);
    expect(occurrenceDays(task({ repeat: 'week', weekdays: [1, 5] }), '2026-11-02', '2026-11-13')).toEqual(['2026-11-02', '2026-11-06', '2026-11-09', '2026-11-13']);
  });

  it('monthly on a day, on the last day, every N months — a short month takes its last day', () => {
    expect(occurrenceDays(task({ dueDate: '2026-11-30', repeat: 'month', monthDay: '31' }), '2026-11-01', '2027-03-31'))
      .toEqual(['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31']);
    expect(occurrenceDays(task({ dueDate: '2026-11-30', repeat: 'month', monthDay: 'last' }), '2026-11-01', '2027-02-28'))
      .toEqual(['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
    expect(occurrenceDays(task({ dueDate: '2026-11-15', repeat: 'month', monthDay: '15', everyMonths: 3 }), '2026-11-01', '2027-06-30'))
      .toEqual(['2026-11-15', '2027-02-15', '2027-05-15']);
  });

  it('never before its first day; yearly on its own day', () => {
    expect(occurrenceDays(task({ dueDate: '2026-11-07', repeat: 'month', monthDay: '7' }), '2026-10-01', '2026-11-30')).toEqual(['2026-11-07']);
    expect(occurrenceDays(task({ dueDate: '2026-03-31', repeat: 'year' }), '2026-01-01', '2028-12-31')).toEqual(['2026-03-31', '2027-03-31', '2028-03-31']);
  });
});

describe('which occurrence waits now', () => {
  it('a one-off task waits however far off, until it is done', () => {
    expect(pendingOccurrence(task({ dueDate: '2026-12-25' }), [], '2026-11-02')).toEqual({ occursOn: '2026-12-25', due: '2026-12-25' });
    expect(pendingOccurrence(task(), [{ occursOn: '2026-11-02', movedTo: null, doneAt: '2026-11-02T03:00:00Z', doneBy: 'Mei Ling' }], '2026-11-02')).toBeNull();
  });

  it('a monthly routine shows from 3 days before, stays overdue until done, then the next one comes', () => {
    const rent = task({ kind: 'routine', dueDate: '2026-12-01', repeat: 'month', monthDay: '1' });
    expect(pendingOccurrence(rent, [], '2026-11-27')).toBeNull();
    expect(pendingOccurrence(rent, [], '2026-11-28')).toEqual({ occursOn: '2026-12-01', due: '2026-12-01' });
    expect(pendingOccurrence(rent, [], '2026-12-20')).toEqual({ occursOn: '2026-12-01', due: '2026-12-01' });
    const paid = [{ occursOn: '2026-12-01', movedTo: null, doneAt: '2026-12-01T02:00:00Z', doneBy: 'Mei Ling' }];
    expect(pendingOccurrence(rent, paid, '2026-12-20')).toBeNull();
    expect(pendingOccurrence(rent, paid, '2026-12-29')).toEqual({ occursOn: '2027-01-01', due: '2027-01-01' });
  });

  it('a daily task shows on its day only; one moved this time waits for its new day', () => {
    const daily = task({ repeat: 'day', dueDate: '2026-11-02' });
    const done = (d: string) => ({ occursOn: d, movedTo: null, doneAt: `${d}T09:00:00Z`, doneBy: 'Mei Ling' });
    expect(pendingOccurrence(daily, [done('2026-11-02')], '2026-11-02')).toBeNull();
    const moved = [{ occursOn: '2026-11-02', movedTo: '2026-11-05', doneAt: null, doneBy: null }];
    expect(pendingOccurrence(daily, moved, '2026-11-02')).toBeNull();
    expect(pendingOccurrence(daily, [...moved, done('2026-11-03'), done('2026-11-04')], '2026-11-05')?.occursOn).toBe('2026-11-02');
  });

  it('switched off, nothing waits', () => {
    expect(pendingOccurrence(task({ isOff: true }), [], '2026-11-02')).toBeNull();
  });
});

describe('how a repeat reads', () => {
  it('in the design\'s words', () => {
    expect(repeatText(task({ repeat: 'day', dayMode: 'wk' }))).toBe('Every weekday, Mon to Fri');
    expect(repeatText(task({ repeat: 'week', weekdays: [5, 1] }))).toBe('Every Mon, Fri');
    expect(repeatText(task({ repeat: 'month', monthDay: '1' }))).toBe('Every month on the 1st');
    expect(repeatText(task({ repeat: 'month', monthDay: '15', byDay: true }))).toBe('Every month by the 15th');
    expect(repeatText(task({ repeat: 'month', monthDay: 'last', everyMonths: 2 }))).toBe('Every 2 months, last day');
    expect(repeatText(task())).toBe("Doesn't repeat");
  });
});

const facts = (over: Partial<TodoFacts>): TodoFacts => ({
  today: '2026-11-02', acquirers: [], lastReportTo: {}, keyedCardDays: {}, cardRows: [], bankAccounts: [], lastStatementTo: {},
  bankLines: [], lockedLastMonth: [], requests: [], vouchers: [], transfers: [], overdue: [], money: null, done: [], problems: [],
  tasks: [], occurrences: {}, remarkCounts: {}, rulesOff: [], groups: [], ...over,
});
const MEI: TodoViewer = { id: 7, name: 'Mei Ling', finance: true, checker: true, approver: true, checkerNames: [], approverNames: [] };
const DANIEL: TodoViewer = { ...MEI, id: 9, name: 'Daniel' };

describe('tasks on the page', () => {
  it('mine when given to me, waiting on whoever it was given to for the one who asked, nobody else\'s business', () => {
    const asked = task({ id: 't2', assigneeId: 9, assigneeName: 'Daniel', title: 'Get the October statement from Ah Seng Transport', dueDate: '2026-11-03' });
    const f = facts({ tasks: [task(), asked], remarkCounts: { t2: 1 } });
    const mei = raiseJobs(f, MEI);
    expect(mei.mine.map((j) => [j.rule, j.title, j.detail, j.action.label])).toEqual([
      ['task', 'Call Kian Furniture about the October statement', 'Added by you', 'Mark done'],
    ]);
    expect(mei.others[0]).toMatchObject({ who: 'Daniel', detail: 'You asked · due 2026/11/03', task: { id: 't2', remarkCount: 1, due: '2026-11-03' } });
    const daniel = raiseJobs(f, DANIEL);
    expect(daniel.mine.map((j) => j.detail)).toEqual(['From Mei Ling']);
    expect(daniel.others).toEqual([]);
    expect(raiseJobs(f, { ...MEI, id: 11, name: 'Nico' }).mine).toEqual([]);
  });

  it('a routine is Finance\'s, with its button; done today shows who did it and can be reopened', () => {
    const rent = task({ id: 'r1', kind: 'routine', title: 'Rent', groupKey: 'pay', dueDate: '2026-11-01', repeat: 'month', monthDay: '1', action: 'voucher', assigneeId: null, createdById: null });
    const f = facts({
      tasks: [rent, task({ id: 't3', title: 'Send Venture the November sublet invoice' })],
      occurrences: { t3: [{ occursOn: '2026-11-02', movedTo: null, doneAt: '2026-11-02T02:15:00Z', doneBy: 'Daniel' }] },
    });
    const page = buildFinanceTodo(f, MEI);
    expect(page.mine.map((j) => [j.rule, j.title, j.detail, j.action.label, j.action.to, j.task?.due])).toEqual([
      ['routine', 'Rent', 'Every month on the 1st', 'Make voucher', '/scm/payment-vouchers/new', '2026-11-01'],
    ]);
    expect(page.done).toEqual([{ key: 'task:t3:2026-11-02', text: 'Daniel marked done · Send Venture the November sublet invoice', je: null, at: '10:15', task: { id: 't3', occursOn: '2026-11-02' } }]);
  });

  it('a rule switched off raises nothing, tasks still come; Finance\'s own groups ride along', () => {
    const f = facts({
      transfers: [{ amountSen: 100, paidOn: '2026-11-01' }], rulesOff: ['transfers'],
      tasks: [task({ groupKey: 'g-tax' })], groups: [{ id: 'g-tax', label: 'Tax & e-invoice' }],
    });
    const page = buildFinanceTodo(f, MEI);
    expect(page.mine.map((j) => [j.rule, j.group])).toEqual([['task', 'g-tax']]);
    expect(page.groups).toEqual([{ id: 'g-tax', label: 'Tax & e-invoice' }]);
    expect(page.viewer).toEqual({ id: 7, name: 'Mei Ling' });
  });
});
