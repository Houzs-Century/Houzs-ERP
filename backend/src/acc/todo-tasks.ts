// ----------------------------------------------------------------------------
// acc/todo-tasks — the tasks and routines on Finance's To do (the owner's
// Claude Design redesign, batch 2, 2026-11-02; tables in migration
// 20261102T2100_acc_todo_tasks.sql). Pure: when a repeating task falls, which
// of its occurrences is waiting now, and how the page words it. The reads and
// writes live in scm/routes/accounting-todo-tasks.ts.
//
// The design's rules, kept:
//   · a one-off task waits until it is marked done, however far off its day;
//   · a repeating one shows its first occurrence not yet done — on the day for
//     a daily task, from 3 days before for the rest — and stays, overdue,
//     until it is done; each occurrence is done or moved on its own;
//   · a routine is a repeating task of Finance's, with what its button does.
// ----------------------------------------------------------------------------

export type TaskRepeat = 'none' | 'day' | 'week' | 'month' | 'year';
export type TaskAction = 'done' | 'voucher' | 'open' | 'checklist';
export type TaskLink = { type: string; no: string; name: string; to: string };

export type TodoTask = {
  id: string;
  kind: 'task' | 'routine';
  routineKey: string | null;
  title: string;
  groupKey: string;
  assigneeId: number | null;
  assigneeName: string | null;
  createdById: number | null;
  createdByName: string | null;
  dueDate: string;
  repeat: TaskRepeat;
  /** Daily: every day, Mon–Fri ('wk') or Mon–Sat ('ms'). */
  dayMode: 'all' | 'wk' | 'ms';
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  /** Monthly: '1'…'31' or 'last'. */
  monthDay: string | null;
  everyMonths: number;
  byDay: boolean;
  link: TaskLink | null;
  action: TaskAction;
  actionTo: string | null;
  amountSen: number | null;
  payee: string | null;
  isOff: boolean;
  createdAt: string;
};

export type TaskOccurrence = { occursOn: string; movedTo: string | null; doneAt: string | null; doneBy: string | null };

const DAY_MS = 86_400_000;
const dayNo = (ymd: string): number => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);
const ymdOf = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number): string => ymdOf(dayNo(ymd) + n);
/** 0 = Sunday … 6 = Saturday. */
const weekdayOf = (ymd: string): number => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const lastDayOf = (y: number, m1: number): number => new Date(Date.UTC(y, m1, 0)).getUTCDate();
const ymd = (y: number, m1: number, d: number): string =>
  `${String(y).padStart(4, '0')}-${String(m1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The days a task falls on, from its first day, within [from, to] (inclusive). */
export function occurrenceDays(t: Pick<TodoTask, 'dueDate' | 'repeat' | 'dayMode' | 'weekdays' | 'monthDay' | 'everyMonths'>, from: string, to: string): string[] {
  const start = t.dueDate;
  const lo = from > start ? from : start;
  if (lo > to) return [];
  if (t.repeat === 'none') return start >= from && start <= to ? [start] : [];
  const out: string[] = [];
  if (t.repeat === 'day' || t.repeat === 'week') {
    for (let n = dayNo(lo), end = dayNo(to); n <= end; n += 1) {
      const d = ymdOf(n);
      const wd = weekdayOf(d);
      const fits = t.repeat === 'week'
        ? t.weekdays.includes(wd)
        : t.dayMode === 'wk' ? wd >= 1 && wd <= 5 : t.dayMode === 'ms' ? wd >= 1 : true;
      if (fits) out.push(d);
    }
    return out;
  }
  const sy = Number(start.slice(0, 4));
  const sm = Number(start.slice(5, 7));
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  if (t.repeat === 'month') {
    const step = Math.max(1, t.everyMonths || 1);
    for (let i = 0; ; i += step) {
      const y = sy + Math.floor((sm - 1 + i) / 12);
      const m = ((sm - 1 + i) % 12) + 1;
      if (y > ty || (y === ty && m > tm)) break;
      const last = lastDayOf(y, m);
      /* No day named: the first day's own; a day past the month's end: its last. */
      const want = t.monthDay === 'last' ? last : Math.min(Number(t.monthDay ?? start.slice(8, 10)), last);
      const d = ymd(y, m, want);
      if (d >= lo && d <= to) out.push(d);
    }
    return out;
  }
  /* Yearly, on the first day's month and day (29 Feb falls on the 28th in other years). */
  const sd = Number(start.slice(8, 10));
  for (let y = sy; y <= ty; y += 1) {
    const d = ymd(y, sm, Math.min(sd, lastDayOf(y, sm)));
    if (d >= lo && d <= to) out.push(d);
  }
  return out;
}

/** How far ahead a repeating task shows: on the day for a daily one, 3 days before for the rest. */
export const leadDays = (t: Pick<TodoTask, 'repeat'>): number => (t.repeat === 'day' ? 0 : 3);

/** A repeating task's next occurrences are looked for this far ahead. */
const HORIZON_DAYS = 400;

export type PendingOccurrence = { occursOn: string; due: string };

/**
 * The occurrence of a task waiting now, or null: the first not yet done, by
 * the day it falls (moved or not). A one-off task waits whatever its day; a
 * repeating one only once its day is within leadDays.
 */
export function pendingOccurrence(t: TodoTask, occurrences: TaskOccurrence[], today: string): PendingOccurrence | null {
  if (t.isOff) return null;
  const byDay = new Map(occurrences.map((o) => [o.occursOn, o]));
  if (t.repeat === 'none') {
    const o = byDay.get(t.dueDate);
    return o?.doneAt ? null : { occursOn: t.dueDate, due: o?.movedTo ?? t.dueDate };
  }
  const days = occurrenceDays(t, t.dueDate, addDays(today, HORIZON_DAYS));
  /* An occurrence moved this time only is also looked for where it landed. */
  const open = days
    .map((d) => ({ occursOn: d, due: byDay.get(d)?.movedTo ?? d, done: !!byDay.get(d)?.doneAt }))
    .filter((x) => !x.done)
    .sort((a, b) => a.due.localeCompare(b.due));
  const first = open[0];
  if (!first) return null;
  return first.due <= addDays(today, leadDays(t)) ? { occursOn: first.occursOn, due: first.due } : null;
}

/** A weekday's short name, 0 = Sun (4 Jan 2026 was a Sunday). */
const weekdayName = (d: number): string =>
  new Date(Date.UTC(2026, 0, 4 + d)).toLocaleString('en-MY', { weekday: 'short', timeZone: 'UTC' });
const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
};

/** The design's words for a repeat: "Every weekday, Mon to Fri", "Every month on the 1st", "Every 3 months on the last day". */
export function repeatText(t: Pick<TodoTask, 'repeat' | 'dayMode' | 'weekdays' | 'monthDay' | 'everyMonths' | 'byDay' | 'dueDate'>): string {
  switch (t.repeat) {
    case 'day':
      return t.dayMode === 'wk' ? 'Every weekday, Mon to Fri' : t.dayMode === 'ms' ? 'Every day, Mon to Sat' : 'Every day';
    case 'week': {
      const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => t.weekdays.includes(d)).map(weekdayName);
      return days.length ? `Every ${days.join(', ')}` : 'Every week';
    }
    case 'month': {
      const every = t.everyMonths > 1 ? `Every ${t.everyMonths} months` : 'Every month';
      const day = t.monthDay === 'last' || t.monthDay == null ? 'last day' : ordinal(Number(t.monthDay));
      return day === 'last day' ? `${every}, last day` : `${every} ${t.byDay ? 'by' : 'on'} the ${day}`;
    }
    case 'year':
      return `Every year on ${t.dueDate.slice(5, 7)}/${t.dueDate.slice(8, 10)}`;
    default:
      return "Doesn't repeat";
  }
}

/** The label a routine's button carries. */
export const ROUTINE_ACTION_LABEL: Record<TaskAction, string> = {
  done: 'Mark done', voucher: 'Make voucher', open: 'Open', checklist: 'Open checklist',
};
