import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/* HC-0125 phase 5 — hr_trip_rows, hr_trip_rate_versions, hr_trip_missed_days,
 * hr_allowances, the new hr_payslips / hr_employees columns and the
 * UNPAID_LEAVE attendance status, against a real server: the trip kind
 * vocabulary, a trip month that is a real month, one rates version per day,
 * one missed-days count per driver per month, an allowance above RM 0 whose
 * range runs forwards, and a removed employee clearing the row it was matched
 * to.
 * Own schema; all five HR migrations twice. SKIPPED, not failed, without
 * TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));
const SCHEMA = 'hr_trip_test';

async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replaceAll('public.', `${SCHEMA}.`);
}

let sql: Sql;
let employeeId = 0;
const row = (extra: Record<string, unknown> = {}) => ({ company_id: 1, trip_month: '2026-09', source: 'SHEET', trip_date: '2026-09-02', kind: 'DO', ...extra });

describePg('hr trip pay tables (real postgres)', () => {
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
    const all = [
      await migrationSql('_hr_employees.sql'),
      await migrationSql('_hr_attendance.sql'),
      await migrationSql('_hr_working_hours.sql'),
      await migrationSql('_hr_payroll.sql'),
      await migrationSql('_hr_trip_pay.sql'),
    ];
    for (const m of [...all, ...all]) await sql.unsafe(m);
    const [e] = await sql<Array<{ id: string }>>`INSERT INTO hr_employees (company_id, emp_no, name, trip_names) VALUES (1, 'EMP-001', 'Mohd Zaimir', 'AMIR') RETURNING id`;
    employeeId = Number(e!.id);
  });

  afterAll(async () => {
    await sql?.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql?.end();
  });

  test('trip rows: known kinds and sources, a real month, no negative total', async () => {
    await sql`INSERT INTO hr_trip_rows ${sql(row({ local_total_sen: 700000, driver_1_name: 'AMIR', driver_1_employee_id: employeeId }))}`;
    await expect(sql`INSERT INTO hr_trip_rows ${sql(row({ kind: 'BONUS' }))}`).rejects.toThrow();
    await expect(sql`INSERT INTO hr_trip_rows ${sql(row({ source: 'EMAIL' }))}`).rejects.toThrow();
    await expect(sql`INSERT INTO hr_trip_rows ${sql(row({ trip_month: '2026-13' }))}`).rejects.toThrow();
    await expect(sql`INSERT INTO hr_trip_rows ${sql(row({ local_total_sen: -1 }))}`).rejects.toThrow();
  });

  test('one rates version per day; one missed-days count per driver per month', async () => {
    await sql`INSERT INTO hr_trip_rate_versions (company_id, effective_from, rates) VALUES (1, '2026-08-23', '{}'::jsonb)`;
    await expect(sql`INSERT INTO hr_trip_rate_versions (company_id, effective_from, rates) VALUES (1, '2026-08-23', '{}'::jsonb)`).rejects.toThrow(/uq_hr_trip_rate_versions_date/);
    await sql`INSERT INTO hr_trip_missed_days (company_id, employee_id, trip_month, missed_days) VALUES (1, ${employeeId}, '2026-09', 2)`;
    await expect(sql`INSERT INTO hr_trip_missed_days (company_id, employee_id, trip_month, missed_days) VALUES (1, ${employeeId}, '2026-09', 1)`).rejects.toThrow(/uq_hr_trip_missed_days/);
    await expect(sql`INSERT INTO hr_trip_missed_days (company_id, employee_id, trip_month, missed_days) VALUES (1, ${employeeId}, '2026-10', 40)`).rejects.toThrow();
  });

  test('allowances: known kinds, above RM 0, a range that runs forwards', async () => {
    await sql`INSERT INTO hr_allowances (company_id, employee_id, kind, amount_sen, from_period) VALUES (1, ${employeeId}, 'LEADERSHIP', 20000, '2026-10')`;
    await expect(sql`INSERT INTO hr_allowances (company_id, employee_id, kind, amount_sen, from_period) VALUES (1, ${employeeId}, 'BONUS', 100, '2026-10')`).rejects.toThrow();
    await expect(sql`INSERT INTO hr_allowances (company_id, employee_id, kind, amount_sen, from_period) VALUES (1, ${employeeId}, 'KPI', 0, '2026-10')`).rejects.toThrow();
    await expect(sql`INSERT INTO hr_allowances (company_id, employee_id, kind, amount_sen, from_period, until_period) VALUES (1, ${employeeId}, 'KPI', 100, '2026-10', '2026-09')`).rejects.toThrow(/ck_hr_allowances_range/);
  });

  test('attendance takes UNPAID_LEAVE; still refuses an unknown status', async () => {
    await sql`INSERT INTO hr_attendance (company_id, employee_id, work_date, status) VALUES (1, ${employeeId}, '2026-09-10', 'UNPAID_LEAVE')`;
    await expect(sql`INSERT INTO hr_attendance (company_id, employee_id, work_date, status) VALUES (1, ${employeeId}, '2026-09-11', 'HOLIDAY')`).rejects.toThrow(/hr_attendance_status_check/);
  });

  test('payslip trip columns default to 0; removing the employee clears the matched trip row', async () => {
    await sql`INSERT INTO hr_payslips (company_id, employee_id, period, emp_no, employee_name, pay_mode, pcb_status) VALUES (1, ${employeeId}, '2026-09', 'EMP-001', 'Mohd Zaimir', 'MONTHLY', 'COMPUTED')`;
    const [s] = await sql`SELECT commission_sen, trip_allowance_sen, backpay_sen FROM hr_payslips WHERE period = '2026-09'`;
    expect(s).toEqual({ commission_sen: '0', trip_allowance_sen: '0', backpay_sen: '0' });
    await sql`DELETE FROM hr_employees WHERE id = ${employeeId}`;
    const [r] = await sql`SELECT driver_1_employee_id, driver_1_name FROM hr_trip_rows WHERE local_total_sen = 700000`;
    expect(r).toEqual({ driver_1_employee_id: null, driver_1_name: 'AMIR' });
  });
});
