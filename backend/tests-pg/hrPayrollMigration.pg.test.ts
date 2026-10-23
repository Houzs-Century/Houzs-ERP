import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/* HC-0125 phase 4 — hr_payslips, hr_advances, hr_penalties, hr_penalty_lines,
 * against a real server: one slip per employee per month, a period that is a
 * real month, the status and PCB vocabularies, an advance and a penalty line
 * above RM 0, a penalty number unique per company, and a removed slip
 * releasing its penalty line. Own schema; all four HR migrations twice.
 * SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));
const SCHEMA = 'hr_pay_test';

async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replaceAll('public.', `${SCHEMA}.`);
}

let sql: Sql;
let employeeId = 0;
const slip = (period: string, extra: Record<string, unknown> = {}) => ({ company_id: 1, employee_id: employeeId, period, emp_no: 'EMP-001', employee_name: 'Ali', pay_mode: 'MONTHLY', pcb_status: 'COMPUTED', ...extra });

describePg('hr payroll tables (real postgres)', () => {
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
    ];
    for (const m of [...all, ...all]) await sql.unsafe(m);
    const [e] = await sql<Array<{ id: string }>>`INSERT INTO hr_employees (company_id, emp_no, name) VALUES (1, 'EMP-001', 'Ali') RETURNING id`;
    employeeId = Number(e!.id);
  });

  afterAll(async () => {
    await sql?.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql?.end();
  });

  test('one slip per employee per month; the period is a real month; vocabularies hold', async () => {
    await sql`INSERT INTO hr_payslips ${sql(slip('2026-10'))}`;
    await expect(sql`INSERT INTO hr_payslips ${sql(slip('2026-10'))}`).rejects.toThrow(/uq_hr_payslips_period/);
    await expect(sql`INSERT INTO hr_payslips ${sql(slip('2026-13'))}`).rejects.toThrow();
    await expect(sql`INSERT INTO hr_payslips ${sql(slip('2026-09', { status: 'CANCELLED' }))}`).rejects.toThrow();
    await expect(sql`INSERT INTO hr_payslips ${sql(slip('2026-08', { pcb_status: 'GUESS' }))}`).rejects.toThrow();
  });

  test('an advance is above RM 0', async () => {
    await expect(sql`INSERT INTO hr_advances (company_id, employee_id, advance_date, amount_sen) VALUES (1, ${employeeId}, '2026-10-10', 0)`).rejects.toThrow();
    await sql`INSERT INTO hr_advances (company_id, employee_id, advance_date, amount_sen) VALUES (1, ${employeeId}, '2026-10-10', 20000)`;
  });

  test('penalty numbers are unique per company; removing a slip releases its line', async () => {
    const [p] = await sql<Array<{ id: string }>>`INSERT INTO hr_penalties (company_id, penalty_no, penalty_date, reason) VALUES (1, 'PN-2610-001', '2026-10-20', 'damage') RETURNING id`;
    await expect(sql`INSERT INTO hr_penalties (company_id, penalty_no, penalty_date, reason) VALUES (1, 'PN-2610-001', '2026-10-21', 'x')`).rejects.toThrow(/uq_hr_penalties_no/);
    const [s] = await sql<Array<{ id: string }>>`SELECT id FROM hr_payslips WHERE period = '2026-10'`;
    await sql`INSERT INTO hr_penalty_lines (company_id, penalty_id, employee_id, amount_sen, payroll_period, payslip_id, posted_at) VALUES (1, ${p!.id}, ${employeeId}, 5000, '2026-10', ${s!.id}, now())`;
    await expect(sql`INSERT INTO hr_penalty_lines (company_id, penalty_id, employee_id, amount_sen) VALUES (1, ${p!.id}, ${employeeId}, 0)`).rejects.toThrow();
    await sql`DELETE FROM hr_payslips WHERE id = ${s!.id}`;
    const [l] = await sql`SELECT payslip_id FROM hr_penalty_lines WHERE penalty_id = ${p!.id}`;
    expect(l).toEqual({ payslip_id: null });
  });
});
