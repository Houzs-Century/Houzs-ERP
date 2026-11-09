// ----------------------------------------------------------------------------
// finance-todo-queries — the Finance To do page (owner's Claude Design project
// "Finance 模块重新设计", Finance-1a-To-do, 2026-11-02 —「帮我读这个和做」).
// Every rule lives on the server (backend acc/finance-todo.ts, acc/todo-tasks.ts);
// this is transport only.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import { writeFailedAs } from '../../../vendor/scm/lib/mutation-error';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { FINANCE_TODO_COUNT_KEY } from '../../../hooks/useAmendmentApprovals';

/** The built-in rules that raise a job (the design's RULES table), and tasks / routines. */
export type TodoRule =
  | 'card-missing' | 'card-matched' | 'card-choose'
  | 'bank-missing' | 'bank-decide'
  | 'requests' | 'pv-check' | 'pv-approve'
  | 'transfers' | 'selfcheck' | 'overdue'
  | 'task' | 'routine';

/** One of the four piles — 'recon' | 'pay' | 'other' | 'misc' — or a group Finance added (its id). */
export type TodoGroup = string;

/** Which tile colour a job wears. */
export type TodoTone = 'cards' | 'bank' | 'out' | 'money' | 'err' | 'routine' | 'manual';

/** The lucide icon a job shows — the server names it, the page draws it. */
export type TodoIcon =
  | 'upload' | 'credit-card' | 'landmark' | 'send' | 'wallet' | 'receipt'
  | 'alert-triangle' | 'calendar-days' | 'pen-line' | 'file-text' | 'hand-coins';

export type TaskLink = { type: string; no: string; name: string; to: string };
export type TaskAction = 'done' | 'voucher' | 'open' | 'checklist';

export type TodoTaskRef = {
  id: string;
  occursOn: string;
  due: string;
  kind: 'task' | 'routine';
  action: TaskAction;
  remarkCount: number;
  link: TaskLink | null;
  repeats: boolean;
  done: boolean;
};

export type TodoJob = {
  key: string;
  rule: TodoRule;
  group: TodoGroup;
  /** Inside "Merchant reports & bank statements": which sub-head it sits under. */
  sub: 'merchant' | 'bank' | null;
  tone: TodoTone;
  icon: TodoIcon;
  title: string;
  detail: string;
  amountSen: number | null;
  /** The day the oldest thing in it began waiting (YYYY-MM-DD). */
  since: string | null;
  action: { label: string; to: string; primary: boolean };
  /** Waiting on others only: who it waits for. */
  who: string | null;
  /** A task or routine: which one, and the occurrence waiting. */
  task: TodoTaskRef | null;
};

export type TodoDone = { key: string; text: string; je: string | null; at: string; task?: { id: string; occursOn: string } | null };

/** `detail` explains the line on hover ("Debits equal credits"). */
export type TodoCheck = { key: string; label: string; value: string; state: 'ok' | 'open' | 'late'; to: string | null; detail?: string };

export type TodoGroupDef = { id: string; label: string };

export type FinanceTodo = {
  today: string;
  mine: TodoJob[];
  others: TodoJob[];
  done: TodoDone[];
  /** Null when the bank balances could not be read. */
  money: { bankCashSen: number; awaitingSen: number; onTheWaySen: number } | null;
  checklist: { month: string; daysLeft: number; items: TodoCheck[] };
  /** Reads that failed, by what they were for — said on the page, never shown as zero. */
  problems: string[];
  groups: TodoGroupDef[];
  viewer: { id: number | null; name: string };
};

export const FINANCE_TODO_KEY = ['finance-todo'] as const;
export const FINANCE_TODO_PATH = '/accounting/todo';

export function useFinanceTodo() {
  return useQuery({
    queryKey: FINANCE_TODO_KEY,
    queryFn: () => authedFetch<FinanceTodo>(FINANCE_TODO_PATH),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: retryUnlessClientError,
  });
}

/* ── Tasks ─────────────────────────────────────────────────────────────── */

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
  repeat: 'none' | 'day' | 'week' | 'month' | 'year';
  dayMode: 'all' | 'wk' | 'ms';
  weekdays: number[];
  monthDay: string | null;
  everyMonths: number;
  byDay: boolean;
  link: TaskLink | null;
  action: TaskAction;
  actionTo: string | null;
  amountSen: number | null;
  payee: string | null;
  isOff: boolean;
};

export type TaskRemark = {
  id: number;
  authorName: string;
  body: string;
  /* done / reopen: left by those buttons; edit / deleted: a change to the task or its delete
     (owner 2026-11-09), lines nobody can rewrite. */
  tag: 'done' | 'reopen' | 'edit' | 'deleted' | null;
  occursOn: string | null;
  history: Array<{ text: string; at: string }>;
  editedAt: string | null;
  createdAt: string;
  mine: boolean;
};

export type TaskDetail = {
  task: TodoTask;
  occurrences: Array<{ occursOn: string; movedTo: string | null; doneAt: string | null; doneBy: string | null }>;
  remarks: TaskRemark[];
  me: { id: number | null; name: string };
  /** Whether the viewer may change or delete it: whoever asked for it, or an Owner. */
  mayEdit?: boolean;
};

/** What Edit task sends: the whole task, as the form holds it (no remark — the change is the line). */
export type TaskEdit = Omit<NewTask, 'remark'>;

export type NewTask = {
  title: string;
  assigneeId: number | null;
  dueDate: string;
  groupKey: string;
  repeat: TodoTask['repeat'];
  dayMode?: TodoTask['dayMode'];
  weekdays?: number[];
  monthDay?: string;
  everyMonths?: number;
  link: TaskLink | null;
  remark: string;
};

const taskKey = (id: string) => ['finance-todo', 'task', id] as const;
const SETTINGS_KEY = ['finance-todo', 'settings'] as const;

/** After any write the page, its count and the open task read again. */
function useRefresh() {
  const qc = useQueryClient();
  return (taskId?: string) => {
    void qc.invalidateQueries({ queryKey: FINANCE_TODO_KEY });
    void qc.invalidateQueries({ queryKey: FINANCE_TODO_COUNT_KEY });
    if (taskId) void qc.invalidateQueries({ queryKey: taskKey(taskId) });
  };
}

export function useTodoPeople(enabled = true) {
  return useQuery({
    queryKey: ['finance-todo', 'people'] as const,
    queryFn: () => authedFetch<{ people: Array<{ id: number; name: string }>; me: { id: number | null; name: string } }>('/accounting/todo/people'),
    staleTime: 5 * 60_000,
    enabled,
    retry: retryUnlessClientError,
  });
}

export function useTodoTask(id: string | null) {
  return useQuery({
    queryKey: taskKey(id ?? ''),
    queryFn: () => authedFetch<TaskDetail>(`/accounting/todo/tasks/${encodeURIComponent(id ?? '')}`),
    enabled: !!id,
    retry: retryUnlessClientError,
  });
}

export function useCreateTask() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: NewTask) => authedFetch<{ task: TodoTask }>('/accounting/todo/tasks', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => refresh(),
    onError: writeFailedAs('Task not added'),
  });
}

export function useMarkTask() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, kind, occursOn, remark, to }: { id: string; kind: 'done' | 'reopen' | 'move'; occursOn: string; remark?: string; to?: string }) =>
      authedFetch<{ ok: true }>(`/accounting/todo/tasks/${encodeURIComponent(id)}/${kind}`, {
        method: 'POST', body: JSON.stringify({ occursOn, remark, to }),
      }),
    onSuccess: (_r, v) => refresh(v.id),
    onError: writeFailedAs('Task not changed'),
  });
}

export function useAddRemark() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      authedFetch<{ ok: true }>(`/accounting/todo/tasks/${encodeURIComponent(id)}/remarks`, { method: 'POST', body: JSON.stringify({ text }) }),
    onSuccess: (_r, v) => refresh(v.id),
    onError: writeFailedAs('Remark not added'),
  });
}

export function useEditRemark() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ remarkId, text }: { taskId: string; remarkId: number; text: string }) =>
      authedFetch<{ ok: true }>(`/accounting/todo/remarks/${remarkId}`, { method: 'PATCH', body: JSON.stringify({ text }) }),
    onSuccess: (_r, v) => refresh(v.taskId),
    onError: writeFailedAs('Remark not changed'),
  });
}

export function useUpdateTask() {
  const refresh = useRefresh();
  const qc = useQueryClient();
  return useMutation({
    /* A routine's switch, amount, payee or title (Setup › To do rules); a task's whole edit (Edit task). */
    mutationFn: ({ id, ...body }: { id: string; isOff?: boolean; amountSen?: number | null; payee?: string | null; title?: string } | ({ id: string } & TaskEdit)) =>
      authedFetch<{ task: TodoTask }>(`/accounting/todo/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (_r, v) => { refresh(v.id); void qc.invalidateQueries({ queryKey: SETTINGS_KEY }); },
    onError: writeFailedAs('Not saved'),
  });
}

/** Delete a task (owner 2026-11-09): it is switched off — its done days and remarks stay. */
export function useDeleteTask() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/accounting/todo/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => refresh(id),
    onError: writeFailedAs('Task not deleted'),
  });
}

export function useLinkSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['finance-todo', 'link-search', term] as const,
    queryFn: () => authedFetch<{ results: TaskLink[] }>(`/accounting/todo/link-search?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2 && !term.startsWith('/'),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

/* ── Setup › To do rules ───────────────────────────────────────────────── */

/** A rule Finance added from a template (Setup › To do rules › New rule). */
export type CustomRule = { id: string; tpl: 'bills' | 'drafts' | 'big'; param: number; group: string };

export type TodoSettings = { rulesOff: string[]; groups: TodoGroupDef[]; customRules: CustomRule[]; routines: TodoTask[]; mayEdit: boolean };

export function useTodoSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => authedFetch<TodoSettings>('/accounting/todo/settings'),
    retry: retryUnlessClientError,
  });
}

export function useSaveRulesOff() {
  const refresh = useRefresh();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rulesOff: string[]) => authedFetch<{ rulesOff: string[] }>('/accounting/todo/settings', { method: 'PUT', body: JSON.stringify({ rulesOff }) }),
    onSuccess: () => { refresh(); void qc.invalidateQueries({ queryKey: SETTINGS_KEY }); },
    onError: writeFailedAs('Rule not switched'),
  });
}

export function useAddRule() {
  const refresh = useRefresh();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<CustomRule, 'id'>) => authedFetch<{ rule: CustomRule }>('/accounting/todo/rules', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { refresh(); void qc.invalidateQueries({ queryKey: SETTINGS_KEY }); },
    onError: writeFailedAs('Rule not added'),
  });
}

export function useAddGroup() {
  const refresh = useRefresh();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => authedFetch<{ group: TodoGroupDef; groups: TodoGroupDef[] }>('/accounting/todo/groups', { method: 'POST', body: JSON.stringify({ label }) }),
    onSuccess: () => { refresh(); void qc.invalidateQueries({ queryKey: SETTINGS_KEY }); },
    onError: writeFailedAs('Group not added'),
  });
}

/* ── Calendar ──────────────────────────────────────────────────────────── */

export type CalKind = 'pay' | 'in' | 'routine' | 'task' | 'late';

export type CalEvent = {
  key: string;
  day: string;
  kind: CalKind;
  label: string;
  short: string;
  detail: string;
  amountSen: number | null;
  done: boolean;
  to: string | null;
  task: { id: string; occursOn: string; kind: 'task' | 'routine'; action: TaskAction; link: TaskLink | null; mine: boolean } | null;
  /** A supplier bill: dragged to another day, its planned payment date moves (step 7); its due date stays. */
  bill?: { kind: 'API' | 'PI'; id: string; no: string; due: string | null; planned: string | null };
};

export type TodoCalendarPage = {
  month: string;
  today: string;
  events: CalEvent[];
  next7: Array<{ kind: CalKind; label: string; count: number; amountSen: number }>;
  problems: string[];
};

export function useTodoCalendar(month: string) {
  return useQuery({
    /* Under the page's own key, so a done / moved task re-reads the calendar too. */
    queryKey: [...FINANCE_TODO_KEY, 'calendar', month] as const,
    queryFn: () => authedFetch<TodoCalendarPage>(`/accounting/todo/calendar?month=${encodeURIComponent(month)}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}
