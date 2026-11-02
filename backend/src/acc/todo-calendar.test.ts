// The To do's calendar (the owner's Claude Design redesign, batch 2): a task or
// routine shows on the day it falls or where it was moved, done ones stay but
// read done, and the next 7 days count what is still open.

import { describe, it, expect } from 'vitest';
import { lastOf, monthOrToday, nextSeven, taskEvents, type CalEvent } from './todo-calendar';
import type { TodoTask } from './todo-tasks';

const routine = (over: Partial<TodoTask> = {}): TodoTask => ({
  id: 'r1', kind: 'routine', routineKey: 'rent', title: 'Rent', groupKey: 'pay', assigneeId: null, assigneeName: null,
  createdById: null, createdByName: null, dueDate: '2026-11-01', repeat: 'month', dayMode: 'all', weekdays: [], monthDay: '1',
  everyMonths: 1, byDay: false, link: null, action: 'voucher', actionTo: null, amountSen: 480000, payee: 'MK Properties',
  isOff: false, createdAt: '', ...over,
});

describe('the month a task falls in', () => {
  it('a routine falls on its day each month, with its amount', () => {
    const ev = taskEvents([routine()], {}, '2026-12', { id: 7 });
    expect(ev.map((e) => [e.day, e.kind, e.label, e.amountSen, e.done])).toEqual([['2026-12-01', 'routine', 'Rent · MK Properties', 480000, false]]);
  });

  it('moved into the month it shows here; moved out it does not; done it reads done', () => {
    const occ = {
      r1: [
        { occursOn: '2026-12-01', movedTo: '2026-11-28', doneAt: null, doneBy: null },
        { occursOn: '2026-11-01', movedTo: null, doneAt: '2026-11-01T02:00:00Z', doneBy: 'Mei Ling' },
      ],
    };
    const nov = taskEvents([routine()], occ, '2026-11', { id: 7 });
    expect(nov.map((e) => [e.day, e.task?.occursOn, e.done, e.detail])).toEqual([
      ['2026-11-01', '2026-11-01', true, 'Routine · every month on the 1st'],
      ['2026-11-28', '2026-12-01', false, 'Routine · every month on the 1st · moved from 2026/12/01'],
    ]);
    expect(taskEvents([routine()], occ, '2026-12', { id: 7 })).toEqual([]);
  });

  it('a task says whose it is; switched off it is gone', () => {
    const t = routine({ id: 't1', kind: 'task', routineKey: null, title: 'Call Kian', repeat: 'none', dueDate: '2026-11-04', assigneeId: 9, assigneeName: 'Daniel', amountSen: null, payee: null });
    expect(taskEvents([t], {}, '2026-11', { id: 7 })[0]).toMatchObject({ kind: 'task', detail: 'Asked of Daniel', task: { mine: false } });
    expect(taskEvents([t], {}, '2026-11', { id: 9 })[0]).toMatchObject({ detail: 'Your task', task: { mine: true } });
    expect(taskEvents([{ ...t, isOff: true }], {}, '2026-11', { id: 9 })).toEqual([]);
  });
});

describe('the next 7 days', () => {
  it('counts what is open by kind, today through 6 days on', () => {
    const e = (day: string, kind: CalEvent['kind'], amountSen: number | null, done = false): CalEvent =>
      ({ key: `${kind}:${day}:${amountSen}`, day, kind, label: '', short: '', detail: '', amountSen, done, to: null, task: null });
    expect(nextSeven([
      e('2026-11-02', 'pay', 100), e('2026-11-08', 'pay', 50), e('2026-11-09', 'pay', 999), e('2026-11-03', 'in', 70),
      e('2026-11-05', 'task', null), e('2026-11-04', 'routine', 10, true), e('2026-11-01', 'pay', 5),
    ], '2026-11-02')).toEqual([
      { kind: 'pay', label: 'Payments due', count: 2, amountSen: 150 },
      { kind: 'in', label: 'Money due in', count: 1, amountSen: 70 },
      { kind: 'task', label: 'Tasks', count: 1, amountSen: 0 },
    ]);
  });

  it('a month is YYYY-MM, else this one; its last day', () => {
    expect(monthOrToday('2026-13', '2026-11-02')).toBe('2026-11');
    expect(monthOrToday('2027-02', '2026-11-02')).toBe('2027-02');
    expect(lastOf('2027-02')).toBe('2027-02-28');
    expect(lastOf('2026-12')).toBe('2026-12-31');
  });
});
