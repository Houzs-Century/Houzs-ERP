// Every TRIP_JOB_TYPES value must be one the hr_trip_rows_job_type_check CHECK
// accepts. The fake database does not enforce checks, so a job type added to the
// code can pass every suite and then 500 the trip-pay sync in production — which
// is exactly what SUPPLIER_HOOKKA did on 2026-11-26: #6091 added it to
// TRIP_JOB_TYPES but not to this CHECK, so "Read Delivery Planning" (and the
// nightly sync) failed with `violates check constraint hr_trip_rows_job_type_check`
// for every month with a Hookka pickup. This reads the newest migration that adds
// the CHECK and the code's list, and holds the two together.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { TRIP_JOB_TYPES } from '../src/scm/shared/hr-trip-pay';

const MIGRATIONS = new URL('../src/db/migrations-pg/', import.meta.url);
const withoutComments = (sql: string) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

describe('hr_trip_rows.job_type CHECK', () => {
  test('accepts every TRIP_JOB_TYPES value (the code must not outrun the DB check)', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const setting = files.filter((f) => /ADD CONSTRAINT hr_trip_rows_job_type_check/.test(withoutComments(readFileSync(new URL(f, MIGRATIONS), 'utf8'))));
    const latest = setting.at(-1);
    expect(latest, 'no migration adds the hr_trip_rows_job_type_check CHECK').toBeTruthy();
    const sql = withoutComments(readFileSync(new URL(latest!, MIGRATIONS), 'utf8'));
    const m = /ADD CONSTRAINT hr_trip_rows_job_type_check[\s\S]*?ARRAY\[([\s\S]*?)\]/.exec(sql);
    expect(m, 'could not read the job_type values from the CHECK').toBeTruthy();
    const allowed = new Set([...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
    for (const jt of TRIP_JOB_TYPES) expect(allowed, `job_type ${jt} is in TRIP_JOB_TYPES but the DB CHECK rejects it`).toContain(jt);
  });
});
