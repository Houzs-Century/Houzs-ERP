import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/* HC-0125 phase 2 — hr_punch_sites and hr_attendance, against a real server.
 *
 * The table holds the punch clock's hard rules: one row per employee per work
 * date (a double tap cannot make two days), a clock-out never before its
 * clock-in and never without one, the status and source vocabularies, and a
 * site radius HR cannot set to nonsense. Runs in its own schema because the
 * pg suite shares one database (see hrEmployeesMigration.pg.test.ts); applies
 * both migrations twice, the way a re-run deploy would. SKIPPED, not failed,
 * without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));
const SCHEMA = 'hr_att_test';

async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replaceAll('public.', `${SCHEMA}.`);
}

let sql: Sql;
let employeeId = 0;
let siteId = 0;

async function insertDay(extra: Record<string, unknown>): Promise<void> {
  const row = { company_id: 1, employee_id: employeeId, work_date: '2026-10-22', ...extra };
  await sql`INSERT INTO hr_attendance ${sql(row)}`;
}

describePg('hr_attendance + hr_punch_sites (real postgres)', () => {
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
    const employees = await migrationSql('_hr_employees.sql');
    const attendance = await migrationSql('_hr_attendance.sql');
    for (const m of [employees, attendance, employees, attendance]) await sql.unsafe(m);
    const [e] = await sql<Array<{ id: string }>>`INSERT INTO hr_employees (company_id, emp_no, name) VALUES (1, 'EMP-001', 'Ali') RETURNING id`;
    employeeId = Number(e!.id);
    const [s] = await sql<Array<{ id: string }>>`INSERT INTO hr_punch_sites (company_id, name, lat, lng) VALUES (1, 'KL WAREHOUSE', 3.0738, 101.5183) RETURNING id`;
    siteId = Number(s!.id);
  });

  afterAll(async () => {
    await sql?.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql?.end();
  });

  test('a site defaults to a 200 m radius and refuses a silly one', async () => {
    const [s] = await sql`SELECT radius_m, active FROM hr_punch_sites WHERE id = ${siteId}`;
    expect(s).toEqual({ radius_m: 200, active: true });
    await expect(sql`INSERT INTO hr_punch_sites (company_id, name, lat, lng, radius_m) VALUES (1, 'X', 3, 101, 5)`).rejects.toThrow();
    await expect(sql`INSERT INTO hr_punch_sites (company_id, name, lat, lng) VALUES (1, 'X', 95, 101)`).rejects.toThrow();
  });

  test('one day per employee per work date', async () => {
    await insertDay({ clock_in_at: '2026-10-22T00:02:00Z', in_source: 'PHONE', in_geo: 'IN', in_site_id: siteId });
    await expect(insertDay({ clock_in_at: '2026-10-22T00:03:00Z' })).rejects.toThrow(/uq_hr_attendance_day/);
  });

  test('a clock-out after midnight is allowed; before the clock-in, or without one, is not', async () => {
    await sql`UPDATE hr_attendance SET clock_out_at = '2026-10-22T17:30:00Z' WHERE employee_id = ${employeeId} AND work_date = '2026-10-22'`;
    await expect(insertDay({ work_date: '2026-10-21', clock_in_at: '2026-10-21T10:00:00Z', clock_out_at: '2026-10-21T09:00:00Z' })).rejects.toThrow(/hr_attendance_out_after_in/);
    await expect(insertDay({ work_date: '2026-10-20', clock_out_at: '2026-10-20T10:00:00Z' })).rejects.toThrow(/hr_attendance_out_after_in/);
  });

  test('status, source and location vocabularies are enforced', async () => {
    await expect(insertDay({ work_date: '2026-10-19', status: 'LATE' })).rejects.toThrow();
    await expect(insertDay({ work_date: '2026-10-18', clock_in_at: '2026-10-18T00:00:00Z', in_source: 'WEB' })).rejects.toThrow();
    await expect(insertDay({ work_date: '2026-10-17', clock_in_at: '2026-10-17T00:00:00Z', in_geo: 'MAYBE' })).rejects.toThrow();
    await insertDay({ work_date: '2026-10-16', status: 'MEDICAL_LEAVE' });
  });

  test('removing a site keeps the punch and clears its link', async () => {
    await sql`DELETE FROM hr_punch_sites WHERE id = ${siteId}`;
    const [r] = await sql`SELECT in_site_id, clock_in_at IS NOT NULL AS has_in FROM hr_attendance WHERE employee_id = ${employeeId} AND work_date = '2026-10-22'`;
    expect(r).toEqual({ in_site_id: null, has_in: true });
  });
});
