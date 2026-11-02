// ----------------------------------------------------------------------------
// acc/todo-calendar — the To do's month calendar (the owner's Claude Design
// redesign, Finance-1a-To-do, batch 2): what falls on each day — payments due,
// money due in, routines, tasks, and what went late — and the next 7 days.
// Pure; the reads are scm/routes/accounting-todo-calendar.ts.
//
// The design's kinds and rules, kept: a task or routine may be dragged to
// another day ("this time only"); a bill or invoice keeps the date its own
// document gives; a late item clears when the thing arrives.
// ----------------------------------------------------------------------------

import { fmtDate } from '../scm/shared/format';
import { addDays, occurrenceDays, repeatText, type TaskLink, type TaskOccurrence, type TodoTask } from './todo-tasks';

export type CalKind = 'pay' | 'in' | 'routine' | 'task' | 'late';

export type CalEvent = {
  key: string;
  /** Where it shows: the day it falls, or where it was moved. */
  day: string;
  kind: CalKind;
  label: string;
  /** The chip's few words. */
  short: string;
  detail: string;
  amountSen: number | null;
  done: boolean;
  /** Where its button goes (a bill, a voucher, a page). */
  to: string | null;
  /** A task or routine — the page can open, mark or move it. */
  task: { id: string; occursOn: string; kind: 'task' | 'routine'; action: TodoTask['action']; link: TaskLink | null; mine: boolean } | null;
  /** A supplier bill — dragged to another day, its planned payment date moves (step 7); its due date stays. */
  bill?: { kind: 'API' | 'PI'; id: string; no: string; due: string | null; planned: string | null };
};

export type CalendarPage = {
  month: string;
  today: string;
  events: CalEvent[];
  next7: Array<{ kind: CalKind; label: string; count: number; amountSen: number }>;
  problems: string[];
};

const firstOf = (month: string): string => `${month}-01`;
const lastOf = (month: string): string => addDays(`${addDays(`${month}-28`, 4).slice(0, 7)}-01`, -1);

/** The occurrences of tasks and routines that show in the month — moved ones where they landed. */
export function taskEvents(
  tasks: TodoTask[], occurrences: Record<string, TaskOccurrence[]>, month: string, viewer: { id: number | null },
): CalEvent[] {
  const from = firstOf(month);
  const to = lastOf(month);
  const out: CalEvent[] = [];
  for (const t of tasks) {
    if (t.isOff) continue;
    const touched = new Map((occurrences[t.id] ?? []).map((o) => [o.occursOn, o]));
    /* An occurrence moved INTO the month may fall outside it: look two months either side. */
    const days = new Set(occurrenceDays(t, addDays(from, -62), addDays(to, 62)));
    for (const o of touched.values()) if (o.movedTo) days.add(o.occursOn);
    for (const d of days) {
      const o = touched.get(d);
      const day = o?.movedTo ?? d;
      if (day < from || day > to) continue;
      const mine = t.kind === 'routine' || (viewer.id != null && t.assigneeId === viewer.id);
      const who = t.kind === 'routine' ? 'Routine' : mine ? 'Your task' : `Asked of ${t.assigneeName ?? '—'}`;
      const moved = o?.movedTo && o.movedTo !== d ? ` · moved from ${fmtDate(d)}` : '';
      out.push({
        key: `task:${t.id}:${d}`, day, kind: t.kind === 'routine' ? 'routine' : 'task',
        label: t.payee ? `${t.title} · ${t.payee}` : t.title, short: t.title,
        detail: `${who}${t.repeat !== 'none' ? ` · ${repeatText(t).toLowerCase()}` : ''}${moved}${t.link ? ` · ${t.link.no}` : ''}`,
        amountSen: t.kind === 'routine' ? t.amountSen : null, done: !!o?.doneAt, to: t.link?.to ?? t.actionTo,
        task: { id: t.id, occursOn: d, kind: t.kind, action: t.action, link: t.link, mine },
      });
    }
  }
  return out;
}

const KIND_LABEL: Record<CalKind, string> = { pay: 'Payments due', in: 'Money due in', routine: 'Routines', task: 'Tasks', late: 'Overdue' };

/** The next 7 days from today, by kind — what is still open. */
export function nextSeven(events: CalEvent[], today: string): CalendarPage['next7'] {
  const end = addDays(today, 6);
  const out: CalendarPage['next7'] = [];
  for (const kind of ['pay', 'in', 'routine', 'task'] as const) {
    const xs = events.filter((e) => e.kind === kind && !e.done && e.day >= today && e.day <= end);
    if (xs.length) out.push({ kind, label: KIND_LABEL[kind], count: xs.length, amountSen: xs.reduce((n, e) => n + (e.amountSen ?? 0), 0) });
  }
  return out;
}

/** The month as YYYY-MM, or the current one. */
export const monthOrToday = (raw: string | undefined, today: string): string => (/^\d{4}-(0[1-9]|1[0-2])$/.test(raw ?? '') ? raw! : today.slice(0, 7));
export { firstOf, lastOf };
