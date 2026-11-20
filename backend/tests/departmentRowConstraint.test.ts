// Every value the Chart of Accounts' Department column offers must be one the
// database's CHECK on scm.accounts.department_row accepts — the fake database
// does not enforce checks, so a new row could pass every suite and be refused in
// production (as acc_bank_match_reason was on 2026-11-17). This reads the newest
// migration that sets the check and the code's list (scm/lib/department-rows.ts).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DEPARTMENT_ROWS } from '../src/scm/lib/department-rows';

const MIGRATIONS = new URL('../src/db/migrations-pg/', import.meta.url);

describe('scm.accounts.department_row', () => {
  test("the migration's CHECK carries exactly the code's values, in its order", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const setting = files.filter((f) => /department_row IS NULL OR department_row IN \(/.test(readFileSync(new URL(f, MIGRATIONS), 'utf8')));
    const latest = setting.at(-1);
    expect(latest, 'no migration sets the department_row CHECK').toBeTruthy();
    const sql = readFileSync(new URL(latest!, MIGRATIONS), 'utf8');
    const list = /department_row IS NULL OR department_row IN \(([^)]*)\)/.exec(sql)![1]!;
    expect([...list.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...DEPARTMENT_ROWS]);
  });

  test('every value the migration writes is one the CHECK accepts', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && /department_row = '/.test(readFileSync(new URL(f, MIGRATIONS), 'utf8')));
    const written = new Set(files.flatMap((f) => [...readFileSync(new URL(f, MIGRATIONS), 'utf8').matchAll(/department_row = '([^']+)'/g)].map((m) => m[1]!)));
    expect(written.size).toBeGreaterThan(0);
    for (const v of written) expect(DEPARTMENT_ROWS).toContain(v);
  });
});
