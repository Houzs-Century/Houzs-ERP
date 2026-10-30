/* EXECUTES migration 20261027T1100 (HC-0157 B) on real Postgres: department
   mailboxes typed "Sales" are linked to the Org Chart's "Sales Department";
   owned and ambiguous rows are left for an admin. */
import { readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
let sql: Sql;

const migration = () =>
  readFileSync(new URL('../src/db/migrations-pg/20261027T1100_mail_department_link.sql', import.meta.url), 'utf8');

describePg('mail department link (migration 20261027T1100)', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
    if (parsed.pathname !== '/houzs_test') throw new Error('PG integration tests require the disposable houzs_test database');
    sql = postgres(url, { max: 1, onnotice: () => undefined });
    await sql.unsafe(`
      DROP TABLE IF EXISTS public.email_addresses, public.departments CASCADE;
      CREATE TABLE public.departments (id serial PRIMARY KEY, name text NOT NULL UNIQUE);
      CREATE TABLE public.email_addresses (id text PRIMARY KEY, address text NOT NULL, assigned_user_id integer, assigned_dept text, active integer NOT NULL DEFAULT 1);
      INSERT INTO public.departments (id, name) VALUES (1, 'Sales Department'), (2, 'Operation Department'), (10, 'Finance Department'), (11, 'HR Department'), (5, 'Management');
      INSERT INTO public.email_addresses (id, address, assigned_user_id, assigned_dept) VALUES
        ('a', 'sales@x', NULL, 'Sales'),
        ('b', 'finance@x', NULL, ' finance '),
        ('c', 'marketing@x', NULL, 'Marketing'),
        ('d', 'ops@x', NULL, 'Department'),
        ('e', 'me@x', 7, 'Sales'),
        ('f', 'none@x', NULL, NULL);
    `);
  });
  afterAll(async () => {
    await sql?.unsafe('DROP TABLE IF EXISTS public.email_addresses, public.departments CASCADE');
    await sql?.end();
  });

  test('links each unowned mailbox to the one department containing its name, and is safe to run twice', async () => {
    await sql.unsafe(migration());
    await sql.unsafe(migration());
    const rows = await sql<Array<{ id: string; department_id: number | null }>>`
      SELECT id, department_id FROM public.email_addresses ORDER BY id`;
    expect(rows.map((r) => [r.id, r.department_id])).toEqual([
      ['a', 1],
      ['b', 10],
      ['c', null],
      ['d', null],
      ['e', null],
      ['f', null],
    ]);
  });

  test('a department removed later leaves its mailboxes unlinked', async () => {
    await sql`DELETE FROM public.departments WHERE id = 10`;
    const [row] = await sql<Array<{ department_id: number | null }>>`SELECT department_id FROM public.email_addresses WHERE id = 'b'`;
    expect(row!.department_id).toBeNull();
  });
});
