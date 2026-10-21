import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/* HC-0125 phase 1 — the hr_* tables, against a real server.
 *
 * The rules live in the table, not only in the route: a resigned employee has a
 * resigned date and nobody else does, Emp No is unique per company whatever its
 * case, one salary row per employee per date, and removing an employee takes
 * its salary history with it. A stubbed client cannot prove a CHECK or a
 * unique index, so this runs on CI's postgres:16 service (`npm run test:pg`);
 * SKIPPED, not failed, without TEST_DATABASE_URL. It also applies the migration
 * twice, the way a re-run of the deploy step would. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

const CO = 1;
let sql: Sql;

async function insertEmployee(empNo: string, extra: Record<string, unknown> = {}): Promise<number> {
  const row = { company_id: CO, emp_no: empNo, name: `Name ${empNo}`, ...extra };
  const [r] = await sql<Array<{ id: number }>>`INSERT INTO public.hr_employees ${sql(row)} RETURNING id`;
  return Number(r!.id);
}

describePg('hr_* tables (real postgres)', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
    }
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.unsafe(`
      DROP TABLE IF EXISTS public.hr_employee_salary_history, public.hr_employees, public.hr_public_holidays, public.hr_pay_rule_versions CASCADE;
      CREATE TABLE IF NOT EXISTS public.users (id serial PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS public.departments (id serial PRIMARY KEY);
    `);
    const migration = await migrationSql('_hr_employees.sql');
    await sql.unsafe(migration);
    await sql.unsafe(migration);
  });

  afterAll(async () => {
    await sql?.end();
  });

  test('a new employee gets the Hookka defaults', async () => {
    const id = await insertEmployee('EMP-001');
    const [r] = await sql`SELECT status, pay_mode, basic_salary_sen, working_hours_per_day::text AS h, working_days_per_month, ot_multiplier::text AS ot, payment_method, epf_enabled FROM public.hr_employees WHERE id = ${id}`;
    expect(r).toEqual({ status: 'ACTIVE', pay_mode: 'MONTHLY', basic_salary_sen: '0', h: '9.0', working_days_per_month: 26, ot: '1.50', payment_method: 'TRANSFER', epf_enabled: false });
  });

  test('Emp No is unique per company whatever its case, and free in another company', async () => {
    await insertEmployee('EMP-002');
    await expect(insertEmployee('emp-002')).rejects.toThrow(/uq_hr_employees_emp_no/);
    await expect(insertEmployee('EMP-002', { company_id: 2 })).resolves.toBeGreaterThan(0);
  });

  test('resigned has a resigned date, and only resigned', async () => {
    await expect(insertEmployee('EMP-003', { status: 'RESIGNED' })).rejects.toThrow(/hr_employees_resigned_on/);
    await expect(insertEmployee('EMP-004', { resigned_on: '2026-10-01' })).rejects.toThrow(/hr_employees_resigned_on/);
    await expect(insertEmployee('EMP-005', { status: 'RESIGNED', resigned_on: '2026-10-01' })).resolves.toBeGreaterThan(0);
  });

  test('pay limits are enforced by the table', async () => {
    await expect(insertEmployee('EMP-006', { basic_salary_sen: -1 })).rejects.toThrow();
    await expect(insertEmployee('EMP-007', { working_days_per_month: 32 })).rejects.toThrow();
    await expect(insertEmployee('EMP-008', { payment_method: 'CHEQUE' })).rejects.toThrow();
  });

  test('one salary row per employee per date; removing the employee removes its history', async () => {
    const id = await insertEmployee('EMP-009');
    await sql`INSERT INTO public.hr_employee_salary_history (company_id, employee_id, basic_salary_sen, effective_from) VALUES (${CO}, ${id}, 200000, '2026-01-01')`;
    await expect(
      sql`INSERT INTO public.hr_employee_salary_history (company_id, employee_id, basic_salary_sen, effective_from) VALUES (${CO}, ${id}, 210000, '2026-01-01')`,
    ).rejects.toThrow(/uq_hr_salary_history_date/);
    await sql`DELETE FROM public.hr_employees WHERE id = ${id}`;
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.hr_employee_salary_history WHERE employee_id = ${id}`;
    expect(n).toBe(0);
  });

  test('one public holiday per date, one pay-rule version per date, per company', async () => {
    await sql`INSERT INTO public.hr_public_holidays (company_id, holiday_date, name) VALUES (${CO}, '2026-12-25', 'Christmas Day')`;
    await expect(sql`INSERT INTO public.hr_public_holidays (company_id, holiday_date) VALUES (${CO}, '2026-12-25')`).rejects.toThrow();
    await sql`INSERT INTO public.hr_pay_rule_versions (company_id, effective_from, rules) VALUES (${CO}, '2026-11-01', '{}'::jsonb)`;
    await expect(sql`INSERT INTO public.hr_pay_rule_versions (company_id, effective_from, rules) VALUES (${CO}, '2026-11-01', '{}'::jsonb)`).rejects.toThrow(/uq_hr_pay_rule_versions_date/);
    await expect(sql`INSERT INTO public.hr_pay_rule_versions (company_id, effective_from, rules) VALUES (2, '2026-11-01', '{}'::jsonb)`).resolves.toBeDefined();
  });
});
