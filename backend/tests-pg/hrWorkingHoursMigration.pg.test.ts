import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/* HC-0125 phase 3 — hr_working_hours and hr_hour_deductions, against a real
 * server. The hard rules live in the table: hours are more than 0 and at most
 * a day, sources are AUTO or MANUAL, one dock per employee per day, and
 * removing an attendance day removes its hours. Its own schema (the pg suite
 * shares one database); all three HR migrations applied twice. SKIPPED, not
 * failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));
const SCHEMA = 'hr_wh_test';

async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replaceAll('public.', `${SCHEMA}.`);
}

let sql: Sql;
let employeeId = 0;
let attendanceId = 0;

describePg('hr_working_hours + hr_hour_deductions (real postgres)', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
    }
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.users (id serial PRIMARY KEY);
      CREATE TABLE ${SCHEMA}.departments (id serial PRIMARY KEY);
      SET search_path TO ${SCHEMA};
    `);
    const all = [await migrationSql('_hr_employees.sql'), await migrationSql('_hr_attendance.sql'), await migrationSql('_hr_working_hours.sql')];
    for (const m of [...all, ...all]) await sql.unsafe(m);
    const [e] = await sql<Array<{ id: string }>>`INSERT INTO hr_employees (company_id, emp_no, name) VALUES (1, 'EMP-001', 'Ali') RETURNING id`;
    employeeId = Number(e!.id);
    const [a] = await sql<Array<{ id: string }>>`INSERT INTO hr_attendance (company_id, employee_id, work_date) VALUES (1, ${employeeId}, '2026-10-22') RETURNING id`;
    attendanceId = Number(a!.id);
  });

  afterAll(async () => {
    await sql?.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql?.end();
  });

  test('hours are more than 0 and at most 24, source AUTO or MANUAL', async () => {
    const row = (hours: number, source = 'AUTO') => ({ company_id: 1, attendance_id: attendanceId, employee_id: employeeId, work_date: '2026-10-22', hours, source });
    await sql`INSERT INTO hr_working_hours ${sql(row(10.5))}`;
    await expect(sql`INSERT INTO hr_working_hours ${sql(row(0))}`).rejects.toThrow();
    await expect(sql`INSERT INTO hr_working_hours ${sql(row(24.5))}`).rejects.toThrow();
    await expect(sql`INSERT INTO hr_working_hours ${sql(row(1, 'GUESS'))}`).rejects.toThrow();
  });

  test('one dock per employee per day', async () => {
    await sql`INSERT INTO hr_hour_deductions (company_id, employee_id, work_date, hours, source) VALUES (1, ${employeeId}, '2026-10-22', 1.5, 'AUTO')`;
    await expect(sql`INSERT INTO hr_hour_deductions (company_id, employee_id, work_date, hours) VALUES (1, ${employeeId}, '2026-10-22', 2)`).rejects.toThrow(/uq_hr_hour_deductions_day/);
  });

  test('removing the attendance day removes its hours, not the dock', async () => {
    await sql`DELETE FROM hr_attendance WHERE id = ${attendanceId}`;
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM hr_working_hours WHERE attendance_id = ${attendanceId}`;
    expect(n).toBe(0);
    const [{ d }] = await sql<Array<{ d: number }>>`SELECT count(*)::int AS d FROM hr_hour_deductions WHERE employee_id = ${employeeId}`;
    expect(d).toBe(1);
  });
});
