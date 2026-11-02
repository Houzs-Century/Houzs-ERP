// ----------------------------------------------------------------------------
// accounting-todo-tasks — the tasks, routines, remarks and rule switches of
// Finance's To do (the owner's Claude Design redesign, batch 2, 2026-11-02;
// migration 20261102T2100_acc_todo_tasks.sql; rules in acc/todo-tasks.ts).
//
//   GET    /accounting/todo/people            who a task can be given to
//   GET    /accounting/todo/settings          rule switches, Finance's groups, the routines
//   PUT    /accounting/todo/settings          {rulesOff}
//   POST   /accounting/todo/groups            {label} — a group beside the four
//   POST   /accounting/todo/tasks             a task (optionally repeating, linked, with a first remark)
//   GET    /accounting/todo/tasks/:id         the task, its touched occurrences and its remarks
//   PATCH  /accounting/todo/tasks/:id         switch it off / on; a routine's amount, payee, title
//   POST   /accounting/todo/tasks/:id/done    {occursOn, remark?}
//   POST   /accounting/todo/tasks/:id/reopen  {occursOn}
//   POST   /accounting/todo/tasks/:id/move    {occursOn, to} — this time only
//   POST   /accounting/todo/tasks/:id/remarks {text}
//   PATCH  /accounting/todo/remarks/:id       {text} — the author's own; the earlier wording is kept
//   GET    /accounting/todo/link-search?q=    documents a task can be linked to
//
// Reads ride the /accounting area guard; every write is Finance's (prepares or
// posts vouchers). Nothing here posts to the books, and nothing is deleted — a
// task is switched off.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { paginateAll } from '../lib/paginate-all';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { parsePermissions } from '../../services/permissions';
import { BUILT_IN_GROUPS, BUILT_IN_RULES, type TodoGroupDef } from '../../acc/finance-todo';
import { occurrenceDays, type TaskLink, type TaskOccurrence, type TodoTask } from '../../acc/todo-tasks';

type Rows = Array<Record<string, any>>;

const TASK_COLS = 'id, kind, routine_key, title, group_key, assignee_id, assignee_name, created_by_id, created_by_name, due_date, repeat, day_mode, weekdays, month_day, every_months, by_day, link, action, action_to, amount_sen, payee, is_off, created_at';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const mayWork = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.create') || hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: 'forbidden', message: 'Only Finance can change To do.' };
const actor = (c: any): { id: number | null; name: string } => {
  const hu = c.get('houzsUser') as { id?: number; name?: string | null; email?: string } | undefined;
  const id = Number(hu?.id);
  return { id: Number.isFinite(id) && id > 0 ? id : null, name: String(hu?.name ?? hu?.email ?? 'unknown') };
};

const linkOf = (v: unknown): TaskLink | null => {
  if (!v || typeof v !== 'object') return null;
  const l = v as Record<string, unknown>;
  const to = String(l.to ?? '');
  if (!to.startsWith('/') || to.startsWith('//')) return null;
  return { type: String(l.type ?? 'Page').slice(0, 40), no: String(l.no ?? '').slice(0, 80), name: String(l.name ?? '').slice(0, 160), to: to.slice(0, 300) };
};

export const taskOf = (r: Record<string, any>): TodoTask => ({
  id: String(r.id),
  kind: r.kind === 'routine' ? 'routine' : 'task',
  routineKey: r.routine_key ?? null,
  title: String(r.title ?? ''),
  groupKey: String(r.group_key ?? 'misc'),
  assigneeId: r.assignee_id == null ? null : Number(r.assignee_id),
  assigneeName: r.assignee_name ?? null,
  createdById: r.created_by_id == null ? null : Number(r.created_by_id),
  createdByName: r.created_by_name ?? null,
  dueDate: String(r.due_date).slice(0, 10),
  repeat: r.repeat,
  dayMode: r.day_mode ?? 'all',
  weekdays: Array.isArray(r.weekdays) ? r.weekdays.map(Number) : [],
  monthDay: r.month_day ?? null,
  everyMonths: Number(r.every_months ?? 1),
  byDay: r.by_day === true,
  link: linkOf(r.link),
  action: r.action ?? 'done',
  actionTo: r.action_to ?? null,
  amountSen: r.amount_sen == null ? null : Number(r.amount_sen),
  payee: r.payee ?? null,
  isOff: r.is_off === true,
  createdAt: String(r.created_at ?? ''),
});

const occurrenceOf = (r: Record<string, any>): TaskOccurrence => ({
  occursOn: String(r.occurs_on).slice(0, 10),
  movedTo: r.moved_to ? String(r.moved_to).slice(0, 10) : null,
  doneAt: r.done_at ? String(r.done_at) : null,
  doneBy: r.done_by ?? null,
});

const groupsOf = (v: unknown): TodoGroupDef[] =>
  (Array.isArray(v) ? v : [])
    .map((g) => ({ id: String((g as Record<string, unknown>)?.id ?? ''), label: String((g as Record<string, unknown>)?.label ?? '') }))
    .filter((g) => g.id && g.label);

/* ── Reads for the page ─────────────────────────────────────────────────── */

export type TodoTaskFacts = {
  tasks: TodoTask[];
  occurrences: Record<string, TaskOccurrence[]>;
  remarkCounts: Record<string, number>;
  rulesOff: string[];
  groups: TodoGroupDef[];
};

/** The tasks, their touched occurrences, how many remarks each has, and the settings — for the To do. */
export async function readTodoTaskFacts(sb: any, companyId: number): Promise<{ ok: true; value: TodoTaskFacts } | { ok: false; what: string; reason: string }> {
  const [tasks, occ, remarks, settings] = await Promise.all([
    paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_todo_tasks').select(TASK_COLS).eq('company_id', companyId).order('created_at').range(lo, hi)),
    paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_todo_occurrences').select('task_id, occurs_on, moved_to, done_at, done_by')
      .eq('company_id', companyId).order('task_id').order('occurs_on').range(lo, hi)),
    paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_todo_remarks').select('id, task_id').eq('company_id', companyId).neq('body', '')
      .order('id').range(lo, hi)),
    sb.from('acc_todo_settings').select('rules_off, groups').eq('company_id', companyId).maybeSingle(),
  ]);
  const bad = [tasks, occ, remarks, settings].find((r) => r.error);
  if (bad) return { ok: false, what: 'tasks', reason: bad.error.message };
  const occurrences: Record<string, TaskOccurrence[]> = {};
  for (const r of (occ.data ?? []) as Rows) (occurrences[String(r.task_id)] ??= []).push(occurrenceOf(r));
  const remarkCounts: Record<string, number> = {};
  for (const r of (remarks.data ?? []) as Rows) remarkCounts[String(r.task_id)] = (remarkCounts[String(r.task_id)] ?? 0) + 1;
  const s = (settings.data ?? null) as Record<string, any> | null;
  return {
    ok: true,
    value: {
      tasks: ((tasks.data ?? []) as Rows).map(taskOf), occurrences, remarkCounts,
      rulesOff: Array.isArray(s?.rules_off) ? s.rules_off.map(String) : [], groups: groupsOf(s?.groups),
    },
  };
}

/* ── People ─────────────────────────────────────────────────────────────── */

const FINANCE_KEYS = ['*', 'scm.payment_voucher.create', 'scm.payment_voucher.post'];

/** Active people of the company whose role works Finance — who a task can be given to. */
export async function financePeople(env: any, companyId: number): Promise<Array<{ id: number; name: string }>> {
  const roles = await env.DB.prepare('SELECT id, permissions FROM roles').all();
  const roleIds = ((roles.results ?? []) as Array<{ id: number; permissions: string | null }>)
    .filter((r) => parsePermissions(r.permissions).some((p) => FINANCE_KEYS.includes(p)))
    .map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
  if (roleIds.length === 0) return [];
  const users = await env.DB.prepare(
    `SELECT u.id, u.name, u.email FROM users u
      WHERE LOWER(COALESCE(u.status, '')) = 'active' AND u.role_id IN (${roleIds.map(() => '?').join(',')})
        AND (EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id AND uc.company_id = ?)
             OR NOT EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id))
      ORDER BY LOWER(COALESCE(u.name, u.email))`,
  ).bind(...roleIds, companyId).all();
  return ((users.results ?? []) as Array<{ id: number; name: string | null; email: string | null }>)
    .map((u) => ({ id: Number(u.id), name: String(u.name ?? u.email ?? `#${u.id}`) }));
}

export const todoPeopleHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const me = actor(c);
  let people: Array<{ id: number; name: string }> = [];
  try { people = await financePeople(c.env, co.companyId); } catch (e) {
    return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
  /* The viewer can always give a task to themselves. */
  if (me.id != null && !people.some((p) => p.id === me.id)) people.unshift({ id: me.id, name: me.name });
  return c.json({ people, me });
};

/* ── Settings ───────────────────────────────────────────────────────────── */

async function loadSettings(sb: any, companyId: number): Promise<{ ok: true; rulesOff: string[]; groups: TodoGroupDef[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_todo_settings').select('rules_off, groups').eq('company_id', companyId).maybeSingle();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, rulesOff: Array.isArray(data?.rules_off) ? data.rules_off.map(String) : [], groups: groupsOf(data?.groups) };
}

export const todoSettingsGetHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const [s, routines] = await Promise.all([
    loadSettings(sb, co.companyId),
    sb.from('acc_todo_tasks').select(TASK_COLS).eq('company_id', co.companyId).eq('kind', 'routine').order('created_at'),
  ]);
  if (!s.ok) return c.json({ error: 'load_failed', reason: s.reason }, 500);
  if (routines.error) return c.json({ error: 'load_failed', reason: routines.error.message }, 500);
  return c.json({ rulesOff: s.rulesOff, groups: s.groups, routines: ((routines.data ?? []) as Rows).map(taskOf), mayEdit: mayWork(c) });
};

export const todoSettingsPutHandler = async (c: any): Promise<Response> => {
  if (!mayWork(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json().catch(() => ({})) as { rulesOff?: unknown };
  if (!Array.isArray(body.rulesOff)) return c.json({ error: 'bad_rules', message: 'Say which rules are off, as a list.' }, 400);
  const known = new Set<string>(BUILT_IN_RULES);
  const rulesOff = [...new Set(body.rulesOff.map(String))];
  const unknown = rulesOff.filter((r) => !known.has(r));
  if (unknown.length) return c.json({ error: 'bad_rules', message: `No such rule: ${unknown.join(', ')}.` }, 400);
  const { error } = await c.get('supabase').from('acc_todo_settings')
    .upsert({ company_id: co.companyId, rules_off: rulesOff, updated_by: actor(c).name, updated_at: new Date().toISOString() }, { onConflict: 'company_id' });
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ rulesOff });
};

export const todoGroupAddHandler = async (c: any): Promise<Response> => {
  if (!mayWork(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json().catch(() => ({})) as { label?: unknown };
  const label = String(body.label ?? '').trim().replace(/\s+/g, ' ');
  if (!label || label.length > 40) return c.json({ error: 'bad_label', message: 'Name the group in up to 40 characters.' }, 400);
  const sb = c.get('supabase');
  const s = await loadSettings(sb, co.companyId);
  if (!s.ok) return c.json({ error: 'load_failed', reason: s.reason }, 500);
  const existing = s.groups.find((g) => g.label.toLowerCase() === label.toLowerCase());
  if (existing) return c.json({ group: existing, groups: s.groups });
  const group = { id: `g-${Date.now().toString(36)}`, label };
  const groups = [...s.groups, group];
  const { error } = await sb.from('acc_todo_settings')
    .upsert({ company_id: co.companyId, groups, updated_by: actor(c).name, updated_at: new Date().toISOString() }, { onConflict: 'company_id' });
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ group, groups });
};

/* ── Tasks ──────────────────────────────────────────────────────────────── */

type Fields = Record<string, unknown>;

/** A task's repeat, as the form sends it, checked and put in the table's words. */
function readRepeat(b: Fields): { ok: true; row: Fields } | { ok: false; message: string } {
  const repeat = String(b.repeat ?? 'none');
  if (!['none', 'day', 'week', 'month', 'year'].includes(repeat)) return { ok: false, message: 'Repeat is one of: none, day, week, month, year.' };
  const row: Fields = { repeat, day_mode: 'all', weekdays: [], month_day: null, every_months: 1 };
  if (repeat === 'day') {
    const mode = String(b.dayMode ?? 'all');
    if (!['all', 'wk', 'ms'].includes(mode)) return { ok: false, message: 'A daily task runs every day, Mon to Fri, or Mon to Sat.' };
    row.day_mode = mode;
  }
  if (repeat === 'week') {
    const days = Array.isArray(b.weekdays) ? [...new Set(b.weekdays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    if (days.length === 0) return { ok: false, message: 'Pick the days of the week it repeats on.' };
    row.weekdays = days.sort();
  }
  if (repeat === 'month') {
    const md = String(b.monthDay ?? '');
    if (md !== 'last' && !(Number.isInteger(Number(md)) && Number(md) >= 1 && Number(md) <= 31)) return { ok: false, message: 'Pick the day of the month, or the last day.' };
    const every = Number(b.everyMonths ?? 1);
    if (!Number.isInteger(every) || every < 1 || every > 12) return { ok: false, message: 'Every 1 to 12 months.' };
    row.month_day = md === 'last' ? 'last' : String(Number(md));
    row.every_months = every;
  }
  return { ok: true, row };
}

export const todoTaskCreateHandler = async (c: any): Promise<Response> => {
  if (!mayWork(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const b = await c.req.json().catch(() => ({})) as Fields;
  const title = String(b.title ?? '').trim().replace(/\s+/g, ' ');
  if (!title || title.length > 200) return c.json({ error: 'bad_title', message: 'Say what the task is, in up to 200 characters.' }, 400);
  const dueDate = String(b.dueDate ?? '');
  if (!DAY.test(dueDate)) return c.json({ error: 'bad_due', message: 'Give the day it is due, as YYYY-MM-DD.' }, 400);
  const rep = readRepeat(b);
  if (!rep.ok) return c.json({ error: 'bad_repeat', message: rep.message }, 400);
  const sb = c.get('supabase');
  const s = await loadSettings(sb, co.companyId);
  if (!s.ok) return c.json({ error: 'load_failed', reason: s.reason }, 500);
  const groupKey = String(b.groupKey ?? 'misc');
  if (!(BUILT_IN_GROUPS as readonly string[]).includes(groupKey) && !s.groups.some((g) => g.id === groupKey)) {
    return c.json({ error: 'bad_group', message: 'Put it under one of the groups on the page.' }, 400);
  }
  const me = actor(c);
  /* Whoever it is given to must work Finance here — the viewer always may take it. */
  const assigneeId = b.assigneeId == null ? me.id : Number(b.assigneeId);
  let assigneeName = me.name;
  if (assigneeId !== me.id) {
    let people: Array<{ id: number; name: string }>;
    try { people = await financePeople(c.env, co.companyId); } catch (e) {
      return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
    }
    const who = people.find((p) => p.id === assigneeId);
    if (!who) return c.json({ error: 'bad_assignee', message: 'A task can be given to someone who works Finance here.' }, 400);
    assigneeName = who.name;
  }
  const link = b.link == null ? null : linkOf(b.link);
  if (b.link != null && !link) return c.json({ error: 'bad_link', message: 'A link is a page of this ERP (an address that starts with /).' }, 400);
  const { data, error } = await sb.from('acc_todo_tasks').insert({
    company_id: co.companyId, kind: 'task', title, group_key: groupKey, assignee_id: assigneeId, assignee_name: assigneeName,
    created_by_id: me.id, created_by_name: me.name, due_date: dueDate, ...rep.row, link,
  }).select(TASK_COLS).single();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  const remark = String(b.remark ?? '').trim();
  if (remark) {
    const r = await sb.from('acc_todo_remarks').insert({ task_id: data.id, company_id: co.companyId, author_id: me.id, author_name: me.name, body: remark.slice(0, 2000) });
    if (r.error) return c.json({ error: 'save_failed', reason: `the task is saved, its remark is not: ${r.error.message}` }, 500);
  }
  return c.json({ task: taskOf(data) }, 201);
};

/** One task of this company, or the response that says why not. */
async function loadTask(c: any, companyId: number): Promise<{ task: TodoTask } | { resp: Response }> {
  const id = String(c.req.param('id') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { resp: c.json({ error: 'not_found', message: 'No such task.' }, 404) };
  const { data, error } = await c.get('supabase').from('acc_todo_tasks').select(TASK_COLS).eq('company_id', companyId).eq('id', id).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'not_found', message: 'No such task.' }, 404) };
  return { task: taskOf(data) };
}

export const todoTaskGetHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadTask(c, co.companyId);
  if ('resp' in found) return found.resp;
  const sb = c.get('supabase');
  const [occ, remarks] = await Promise.all([
    sb.from('acc_todo_occurrences').select('task_id, occurs_on, moved_to, done_at, done_by').eq('company_id', co.companyId).eq('task_id', found.task.id).order('occurs_on'),
    sb.from('acc_todo_remarks').select('id, author_id, author_name, body, tag, occurs_on, history, edited_at, created_at')
      .eq('company_id', co.companyId).eq('task_id', found.task.id).order('id'),
  ]);
  if (occ.error || remarks.error) return c.json({ error: 'load_failed', reason: (occ.error ?? remarks.error).message }, 500);
  const me = actor(c);
  return c.json({
    task: found.task,
    occurrences: ((occ.data ?? []) as Rows).map(occurrenceOf),
    remarks: ((remarks.data ?? []) as Rows).map((r) => ({
      id: Number(r.id), authorName: String(r.author_name ?? ''), body: String(r.body ?? ''), tag: r.tag ?? null,
      occursOn: r.occurs_on ? String(r.occurs_on).slice(0, 10) : null, history: Array.isArray(r.history) ? r.history : [],
      editedAt: r.edited_at ?? null, createdAt: String(r.created_at), mine: me.id != null && Number(r.author_id) === me.id,
    })),
    me,
  });
};

export const todoTaskPatchHandler = async (c: any): Promise<Response> => {
  if (!mayWork(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadTask(c, co.companyId);
  if ('resp' in found) return found.resp;
  const b = await c.req.json().catch(() => ({})) as Fields;
  const patch: Fields = {};
  if ('isOff' in b) patch.is_off = b.isOff === true;
  if (found.task.kind === 'routine') {
    if ('amountSen' in b) {
      const n = b.amountSen == null || b.amountSen === '' ? null : Number(b.amountSen);
      if (n != null && (!Number.isSafeInteger(n) || n < 0)) return c.json({ error: 'bad_amount', message: 'The amount is whole sen, zero or more.' }, 400);
      patch.amount_sen = n;
    }
    if ('payee' in b) patch.payee = b.payee == null ? null : String(b.payee).trim().slice(0, 120) || null;
  }
  if ('title' in b) {
    const title = String(b.title ?? '').trim().replace(/\s+/g, ' ');
    if (!title || title.length > 200) return c.json({ error: 'bad_title', message: 'Say what it is, in up to 200 characters.' }, 400);
    patch.title = title;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing_to_change', message: 'Nothing to change.' }, 400);
  const { data, error } = await c.get('supabase').from('acc_todo_tasks').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('company_id', co.companyId).eq('id', found.task.id).select(TASK_COLS).single();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ task: taskOf(data) });
};

/** Whether `day` is a day this task falls on. */
const fallsOn = (t: TodoTask, day: string): boolean => DAY.test(day) && occurrenceDays(t, day, day).includes(day);

/** A task's occurrence is marked by whoever it was given to or whoever asked; a routine by anyone in Finance. */
const mayMark = (t: TodoTask, me: { id: number | null }): boolean =>
  t.kind === 'routine' || (me.id != null && (t.assigneeId === me.id || t.createdById === me.id));

async function occurrenceWrite(c: any, kind: 'done' | 'reopen' | 'move'): Promise<Response> {
  if (!mayWork(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadTask(c, co.companyId);
  if ('resp' in found) return found.resp;
  const t = found.task;
  const me = actor(c);
  if (!mayMark(t, me)) return c.json({ error: 'not_yours', message: `This task is ${t.assigneeName ?? 'someone else'}'s — they or whoever asked mark it.` }, 403);
  const b = await c.req.json().catch(() => ({})) as Fields;
  const occursOn = String(b.occursOn ?? '');
  if (!fallsOn(t, occursOn)) return c.json({ error: 'bad_occurrence', message: 'That is not a day this task falls on.' }, 400);
  const sb = c.get('supabase');
  const now = new Date().toISOString();
  const key = { task_id: t.id, company_id: co.companyId, occurs_on: occursOn };
  let row: Fields;
  if (kind === 'move') {
    const to = String(b.to ?? '');
    if (!DAY.test(to)) return c.json({ error: 'bad_day', message: 'Move it to a day, as YYYY-MM-DD.' }, 400);
    row = { ...key, moved_to: to === occursOn ? null : to, updated_at: now };
  } else {
    row = { ...key, done_at: kind === 'done' ? now : null, done_by: kind === 'done' ? me.name : null, updated_at: now };
  }
  const { error } = await sb.from('acc_todo_occurrences').upsert(row, { onConflict: 'task_id,occurs_on' });
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (kind !== 'move') {
    /* The thread says who marked it, and the words they gave with it. */
    const r = await sb.from('acc_todo_remarks').insert({
      task_id: t.id, company_id: co.companyId, author_id: me.id, author_name: me.name,
      body: String(b.remark ?? '').trim().slice(0, 2000), tag: kind, occurs_on: occursOn,
    });
    if (r.error) return c.json({ error: 'save_failed', reason: `marked, but its remark is not saved: ${r.error.message}` }, 500);
  }
  return c.json({ ok: true, occursOn, today: todayMyt() });
}

export const todoTaskDoneHandler = (c: any): Promise<Response> => occurrenceWrite(c, 'done');
export const todoTaskReopenHandler = (c: any): Promise<Response> => occurrenceWrite(c, 'reopen');
export const todoTaskMoveHandler = (c: any): Promise<Response> => occurrenceWrite(c, 'move');

export const todoRemarkAddHandler = async (c: any): Promise<Response> => {
  if (!mayWork(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadTask(c, co.companyId);
  if ('resp' in found) return found.resp;
  const b = await c.req.json().catch(() => ({})) as Fields;
  const text = String(b.text ?? '').trim();
  if (!text || text.length > 2000) return c.json({ error: 'bad_text', message: 'Write the remark, in up to 2,000 characters.' }, 400);
  const me = actor(c);
  const { error } = await c.get('supabase').from('acc_todo_remarks')
    .insert({ task_id: found.task.id, company_id: co.companyId, author_id: me.id, author_name: me.name, body: text });
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true }, 201);
};

export const todoRemarkEditHandler = async (c: any): Promise<Response> => {
  if (!mayWork(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'not_found', message: 'No such remark.' }, 404);
  const b = await c.req.json().catch(() => ({})) as Fields;
  const text = String(b.text ?? '').trim();
  if (!text || text.length > 2000) return c.json({ error: 'bad_text', message: 'Write the remark, in up to 2,000 characters.' }, 400);
  const sb = c.get('supabase');
  const { data: r, error: rErr } = await sb.from('acc_todo_remarks').select('id, author_id, body, history, edited_at, created_at')
    .eq('company_id', co.companyId).eq('id', id).maybeSingle();
  if (rErr) return c.json({ error: 'load_failed', reason: rErr.message }, 500);
  if (!r) return c.json({ error: 'not_found', message: 'No such remark.' }, 404);
  const me = actor(c);
  if (me.id == null || Number(r.author_id) !== me.id) return c.json({ error: 'not_yours', message: 'Only whoever wrote a remark can change it.' }, 403);
  if (text === String(r.body ?? '')) return c.json({ ok: true, unchanged: true });
  /* The earlier wording stays, with when it was written. */
  const history = [...(Array.isArray(r.history) ? r.history : []), { text: String(r.body ?? ''), at: String(r.edited_at ?? r.created_at) }];
  const now = new Date().toISOString();
  const { error } = await sb.from('acc_todo_remarks').update({ body: text, history, edited_at: now }).eq('company_id', co.companyId).eq('id', id);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true });
};

/* ── What a task can be linked to ───────────────────────────────────────── */

export const todoLinkSearchHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* Letters, digits and the separators document numbers use — nothing a filter could read as syntax. */
  const q = String(c.req.query('q') ?? '').replace(/[^A-Za-z0-9 .\-/&]/g, '').trim().slice(0, 40);
  if (q.length < 2) return c.json({ results: [] });
  const sb = c.get('supabase');
  const like = `%${q}%`;
  const [pv, api, so, si, sup] = await Promise.all([
    sb.from('payment_vouchers').select('id, pv_number, payee_name').eq('company_id', co.companyId).ilike('pv_number', like).order('pv_number', { ascending: false }).limit(5),
    sb.from('ap_invoices').select('id, invoice_number, supplier_invoice_ref, due_date').eq('company_id', co.companyId).ilike('invoice_number', like).order('invoice_number', { ascending: false }).limit(5),
    sb.from('mfg_sales_orders').select('doc_no, debtor_name').eq('company_id', co.companyId).ilike('doc_no', like).order('doc_no', { ascending: false }).limit(5),
    sb.from('sales_invoices').select('id, invoice_number, debtor_name').eq('company_id', co.companyId).ilike('invoice_number', like).order('invoice_number', { ascending: false }).limit(5),
    sb.from('suppliers').select('id, name, code').eq('company_id', co.companyId).ilike('name', like).order('name').limit(5),
  ]);
  const bad = [pv, api, so, si, sup].find((r) => r.error);
  if (bad) return c.json({ error: 'load_failed', reason: bad.error.message }, 500);
  const results: TaskLink[] = [
    ...((pv.data ?? []) as Rows).map((r) => ({ type: 'Payment voucher', no: String(r.pv_number ?? ''), name: String(r.payee_name ?? ''), to: `/scm/payment-vouchers/${r.id}` })),
    ...((api.data ?? []) as Rows).map((r) => ({ type: 'AP invoice', no: String(r.invoice_number ?? ''), name: String(r.supplier_invoice_ref ?? ''), to: `/scm/ap-invoices?open=${r.id}` })),
    ...((so.data ?? []) as Rows).map((r) => ({ type: 'Sales order', no: String(r.doc_no ?? ''), name: String(r.debtor_name ?? ''), to: `/scm/sales-orders/${encodeURIComponent(String(r.doc_no ?? ''))}` })),
    ...((si.data ?? []) as Rows).map((r) => ({ type: 'Sales invoice', no: String(r.invoice_number ?? ''), name: String(r.debtor_name ?? ''), to: `/scm/sales-invoices/${r.id}` })),
    ...((sup.data ?? []) as Rows).map((r) => ({ type: 'Supplier', no: String(r.name ?? ''), name: String(r.code ?? ''), to: `/scm/suppliers/${r.id}` })),
  ];
  return c.json({ results });
};
