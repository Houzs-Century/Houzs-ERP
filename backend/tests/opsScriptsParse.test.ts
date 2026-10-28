import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/* ---------------------------------------------------------------------------
   EVERY OPS SCRIPT MUST AT LEAST PARSE.

   On 2026-08-24 an edit to check-autocount-outbox-health.mjs dropped one
   character — `const notice = (msg) =>` became `(msg) =` — and the file shipped
   to main. Nothing caught it: these scripts are run by workflow_dispatch, not
   imported by any test, so the first thing that noticed was the workflow
   failing with `ReferenceError: msg is not defined` while an operator was
   waiting on the report to diagnose a live sync problem.

   `node --check` is the cheapest possible guard and it is exactly the class of
   defect that got through. It does NOT claim the script is correct — only that
   it is syntactically a program, which is the floor a scheduled job needs
   before its exit code can mean anything.
   ------------------------------------------------------------------------ */
const SCRIPTS_DIR = join(process.cwd(), 'scripts');

const scripts = readdirSync(SCRIPTS_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .sort();

describe('ops scripts parse', () => {
  test('there are scripts to check (a passing empty suite proves nothing)', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  test.each(scripts)('%s parses', (file) => {
    const r = spawnSync(process.execPath, ['--check', join(SCRIPTS_DIR, file)], {
      encoding: 'utf8',
    });
    expect(r.stderr, `${file} does not parse:\n${r.stderr}`).toBe('');
    expect(r.status).toBe(0);
  });
});
