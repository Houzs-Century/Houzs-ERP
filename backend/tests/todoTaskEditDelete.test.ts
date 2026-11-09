/* A To do task can be changed and deleted (owner 2026-11-09: 「这个我set 的task 不能
   edit 资料，不能delete？」 → the proposal → 可以). Whoever asked for the task — or an
   Owner / IT Admin (the `*` holder) — may change its words, day, repeat, person,
   group and link, or delete it. Delete switches the task off (the To do's own rule:
   nothing is deleted), so its done days and remarks stay; every change and the
   delete leave a line in the task's thread that nobody can rewrite. A routine keeps
   its own rules (Setup › To do rules). Real handlers, fake PostgREST, fake D1 for
   the people who work Finance. */

import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  readTodoTaskFacts, todoRemarkEditHandler, todoTaskDeleteHandler, todoTaskGetHandler, todoTaskPatchHandler,
} from '../src/scm/routes/accounting-todo-tasks';

const CO = 1;
const ID = 'a0000000-0000-4000-8000-000000000001';
const ROUTINE_ID = 'a0000000-0000-4000-8000-000000000002';
const SITI = { id: 22, name: 'Siti Rafidah', perms: ['scm.payment_voucher.create'] };
const MIKA = { id: 21, name: 'Mika', perms: ['scm.payment_voucher.create'] };
const CHEW = { id: 7, name: 'Chew', perms: ['*'] };
const NICO = { id: 30, name: 'Nico', perms: ['scm.payment_voucher.post'] };

const TASK: Row = {
  id: ID, company_id: CO, kind: 'task', routine_key: null, title: 'Repay - Mitsubishi RM 1,893 Forklift', group_key: 'pay',
  assignee_id: 21, assignee_name: 'Mika', created_by_id: 22, created_by_name: 'Siti Rafidah',
  due_date: '2026-11-11', repeat: 'month', day_mode: 'all', weekdays: [], month_day: '11', every_months: 1, by_day: false,
  link: null, action: 'done', action_to: null, amount_sen: null, payee: null, is_off: false,
  created_at: '2026-11-04T09:53:00Z', updated_at: '2026-11-04T09:53:00Z',
};
const ROUTINE: Row = {
  ...TASK, id: ROUTINE_ID, kind: 'routine', routine_key: 'rent', title: 'Rent', assignee_id: null, assignee_name: null,
  created_by_id: null, created_by_name: null, due_date: '2026-12-01', month_day: '1', action: 'voucher',
};

/* The people who work Finance here (financePeople reads roles, then users, from D1). */
const fakeD1 = () => ({
  prepare: (sqlText: string) => {
    const roles = [{ id: 3, permissions: JSON.stringify(['scm.payment_voucher.create']) }];
    const users = [{ id: 21, name: 'Mika', email: 'mika@x' }, { id: 22, name: 'Siti Rafidah', email: 'siti@x' }];
    const all = async () => ({ results: /FROM roles/.test(sqlText) ? roles : users });
    return { all, bind: () => ({ all }) };
  },
});

type Sb = ReturnType<typeof fakeSb>;
const world = (): Sb => fakeSb({
  acc_todo_tasks: [{ ...TASK }, { ...ROUTINE }],
  acc_todo_occurrences: [{ task_id: ID, company_id: CO, occurs_on: '2026-11-11', moved_to: null, done_at: '2026-11-11T02:00:00Z', done_by: 'Mika', updated_at: '2026-11-11T02:00:00Z' }],
  acc_todo_remarks: [{ id: 1, task_id: ID, company_id: CO, author_id: 22, author_name: 'Siti Rafidah', body: 'Auto Debit - HLBB BANK', tag: null, occurs_on: null, history: [], edited_at: null, created_at: '2026-11-04T09:53:00Z' }],
  acc_todo_settings: [],
}, {}, [], ['acc_todo_remarks']);

const call = async (sb: Sb, who: { id: number; name: string; perms: string[] }, method: string, path: string, body?: unknown) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { id: who.id, name: who.name, permissions_set: new Set(who.perms) } as never);
    await next();
  });
  app.get('/todo/tasks/:id', todoTaskGetHandler as never);
  app.patch('/todo/tasks/:id', todoTaskPatchHandler as never);
  app.delete('/todo/tasks/:id', todoTaskDeleteHandler as never);
  app.patch('/todo/remarks/:id', todoRemarkEditHandler as never);
  const res = await app.request(path, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  }, { DB: fakeD1() } as never);
  return { status: res.status, body: await res.json() as Record<string, any> };
};
const task = (sb: Sb) => sb.tables.acc_todo_tasks!.find((t) => t.id === ID)!;
const remarks = (sb: Sb) => sb.tables.acc_todo_remarks!.filter((r) => r.task_id === ID);

/* What the Edit form sends: the whole task. */
const EDIT = {
  title: 'Repay - Mitsubishi RM 1,893 Forklift (HLBB)', dueDate: '2026-11-15', repeat: 'month', monthDay: '15', everyMonths: 1,
  assigneeId: 22, groupKey: 'misc', link: { type: 'Payment voucher', no: 'HC-HPV-2611-001', name: 'MITSUBISHI', to: '/scm/payment-vouchers/abc' },
};

let sb: Sb;
beforeEach(() => { sb = world(); });

describe('Edit a task', () => {
  test('whoever asked changes its words, day, repeat, person, group and link', async () => {
    const r = await call(sb, SITI, 'PATCH', `/todo/tasks/${ID}`, EDIT);
    expect(r.status).toBe(200);
    expect(task(sb)).toMatchObject({
      title: 'Repay - Mitsubishi RM 1,893 Forklift (HLBB)', due_date: '2026-11-15', repeat: 'month', month_day: '15', every_months: 1,
      assignee_id: 22, assignee_name: 'Siti Rafidah', group_key: 'misc', is_off: false,
      created_by_id: 22, created_by_name: 'Siti Rafidah',
    });
    expect(task(sb).link).toMatchObject({ no: 'HC-HPV-2611-001', to: '/scm/payment-vouchers/abc' });
    expect(r.body.task.title).toBe('Repay - Mitsubishi RM 1,893 Forklift (HLBB)');
  });

  test('the thread says who changed what, from what to what', async () => {
    await call(sb, SITI, 'PATCH', `/todo/tasks/${ID}`, EDIT);
    const line = remarks(sb).find((x) => x.tag === 'edit')!;
    expect(line).toMatchObject({ author_id: 22, author_name: 'Siti Rafidah' });
    expect(line.body.split('\n')).toEqual([
      'Task: Repay - Mitsubishi RM 1,893 Forklift → Repay - Mitsubishi RM 1,893 Forklift (HLBB)',
      'Due: 2026/11/11 → 2026/11/15',
      'Repeat: Every month on the 11th → Every month on the 15th',
      'Assigned to: Mika → Siti Rafidah',
      'Group: Payments → Others',
      'Linked to: — → HC-HPV-2611-001',
    ]);
  });

  test('only what changed is said; the same again writes nothing', async () => {
    await call(sb, SITI, 'PATCH', `/todo/tasks/${ID}`, { title: TASK.title, dueDate: '2026-11-11', repeat: 'month', monthDay: '11', everyMonths: 1, assigneeId: 21, groupKey: 'pay', link: null });
    expect(remarks(sb).filter((x) => x.tag === 'edit')).toHaveLength(0);
    expect(task(sb).updated_at).toBe('2026-11-04T09:53:00Z');
    await call(sb, SITI, 'PATCH', `/todo/tasks/${ID}`, { assigneeId: 22 });
    expect(remarks(sb).filter((x) => x.tag === 'edit').map((x) => x.body)).toEqual(['Assigned to: Mika → Siti Rafidah']);
  });

  test('an Owner / IT Admin (*) may change someone else\'s task', async () => {
    expect((await call(sb, CHEW, 'PATCH', `/todo/tasks/${ID}`, { dueDate: '2026-11-12', repeat: 'month', monthDay: '12', everyMonths: 1 })).status).toBe(200);
    expect(task(sb).due_date).toBe('2026-11-12');
    expect(remarks(sb).find((x) => x.tag === 'edit')!.author_name).toBe('Chew');
  });

  test.each([
    ['the person it was given to', MIKA],
    ['someone else in Finance', NICO],
  ])('%s may not: refused, nothing changes', async (_who, who) => {
    const r = await call(sb, who, 'PATCH', `/todo/tasks/${ID}`, EDIT);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_yours');
    expect(task(sb).title).toBe(TASK.title);
    expect(remarks(sb)).toHaveLength(1);
  });

  test('it can only be given to someone who works Finance here', async () => {
    const r = await call(sb, SITI, 'PATCH', `/todo/tasks/${ID}`, { assigneeId: 999 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_assignee');
    expect(task(sb).assignee_id).toBe(21);
  });

  test('a bad day, repeat or group is refused before anything is written', async () => {
    for (const body of [{ dueDate: '11/11/2026' }, { repeat: 'week', weekdays: [] }, { groupKey: 'nope' }]) {
      const r = await call(sb, SITI, 'PATCH', `/todo/tasks/${ID}`, body);
      expect(r.status).toBe(400);
    }
    expect(task(sb)).toMatchObject({ due_date: '2026-11-11', repeat: 'month', group_key: 'pay' });
    expect(remarks(sb)).toHaveLength(1);
  });

  test('the line that records a change cannot be rewritten, not even by whoever made it', async () => {
    await call(sb, SITI, 'PATCH', `/todo/tasks/${ID}`, { assigneeId: 22 });
    const line = remarks(sb).find((x) => x.tag === 'edit')!;
    const r = await call(sb, SITI, 'PATCH', `/todo/remarks/${line.id}`, { text: 'Nothing changed' });
    expect(r.status).toBe(409);
    expect(line.body).toBe('Assigned to: Mika → Siti Rafidah');
  });

  test('the To do\'s remark count stays the people\'s remarks: a change line is not one', async () => {
    await call(sb, SITI, 'PATCH', `/todo/tasks/${ID}`, { assigneeId: 22 });
    const facts = await readTodoTaskFacts(sb, CO);
    expect(facts.ok && facts.value.remarkCounts[ID]).toBe(1);
  });

  test('a routine keeps its own rules: anyone in Finance sets its amount', async () => {
    const r = await call(sb, NICO, 'PATCH', `/todo/tasks/${ROUTINE_ID}`, { amountSen: 120_000 });
    expect(r.status).toBe(200);
    expect(sb.tables.acc_todo_tasks!.find((t) => t.id === ROUTINE_ID)!.amount_sen).toBe(120_000);
  });

  test('the task says who may change it', async () => {
    expect((await call(sb, SITI, 'GET', `/todo/tasks/${ID}`)).body.mayEdit).toBe(true);
    expect((await call(sb, CHEW, 'GET', `/todo/tasks/${ID}`)).body.mayEdit).toBe(true);
    expect((await call(sb, MIKA, 'GET', `/todo/tasks/${ID}`)).body.mayEdit).toBe(false);
    expect((await call(sb, SITI, 'GET', `/todo/tasks/${ROUTINE_ID}`)).body.mayEdit).toBe(false);
  });
});

describe('Delete a task', () => {
  test('whoever asked deletes it: off the To do, its done days and remarks stay, the thread says who', async () => {
    const r = await call(sb, SITI, 'DELETE', `/todo/tasks/${ID}`);
    expect(r.status).toBe(200);
    expect(task(sb).is_off).toBe(true);
    expect(sb.tables.acc_todo_occurrences).toHaveLength(1);
    expect(remarks(sb).map((x) => x.tag)).toEqual([null, 'deleted']);
    expect(remarks(sb)[1]).toMatchObject({ author_id: 22, author_name: 'Siti Rafidah' });
  });

  test('an Owner / IT Admin (*) may delete someone else\'s task', async () => {
    expect((await call(sb, CHEW, 'DELETE', `/todo/tasks/${ID}`)).status).toBe(200);
    expect(task(sb).is_off).toBe(true);
  });

  test('the person it was given to may not', async () => {
    const r = await call(sb, MIKA, 'DELETE', `/todo/tasks/${ID}`);
    expect(r.status).toBe(403);
    expect(task(sb).is_off).toBe(false);
  });

  test('a routine is switched off under Setup › To do rules, not deleted here', async () => {
    const r = await call(sb, CHEW, 'DELETE', `/todo/tasks/${ROUTINE_ID}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('routine');
    expect(sb.tables.acc_todo_tasks!.find((t) => t.id === ROUTINE_ID)!.is_off).toBe(false);
  });

  test('a deleted task takes no more changes, and reads as deleted', async () => {
    await call(sb, SITI, 'DELETE', `/todo/tasks/${ID}`);
    const again = await call(sb, SITI, 'PATCH', `/todo/tasks/${ID}`, EDIT);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('deleted');
    const read = await call(sb, SITI, 'GET', `/todo/tasks/${ID}`);
    expect(read.body.task.isOff).toBe(true);
    expect(read.body.mayEdit).toBe(false);
    expect((await call(sb, SITI, 'DELETE', `/todo/tasks/${ID}`)).status).toBe(200);
    expect(remarks(sb).filter((x) => x.tag === 'deleted')).toHaveLength(1);
  });
});
