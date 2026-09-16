/* docs/bugs/0894 — the permission audit asks the policy, it does not restate it.
 *
 * backend/scripts/audit-permission-grants.mjs kept its own copies of the
 * position-name lists in services/positionPolicy.ts and services/pmsAccess.ts,
 * and they drifted: Managing Director (wildcard since 2026-09-07), Warehouse
 * Crew KL (restricted since 2026-09-01) and Calendar Viewer (restricted since 2026-08-26) printed
 * as FULL. The classifier now calls those modules; these cases pin both the
 * three names it got wrong and that the answer IS the policy's, so a future
 * rename in the policy moves the audit with it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPosition } from '../scripts/lib/position-classification.mjs';
import { isFleetPosition, positionGrantsWildcard, resolvePositionPolicy } from '../src/services/positionPolicy';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('classifyPosition answers with the enforcing code', () => {
  it('the three positions the copied lists got wrong', () => {
    expect(classifyPosition('Managing Director', 'Management').cohort).toBe('god');
    expect(classifyPosition('Warehouse Crew KL', 'Operation Department').cohort).toBe('restricted');
    expect(classifyPosition('Calendar Viewer', null).cohort).toBe('restricted');
  });

  it('Outsource Transporter is restricted like Driver / Helper, and is NOT fleet (unlinked → would fail closed)', () => {
    const k = classifyPosition('Outsource Transporter', 'Operation Department');
    expect(k.cohort).toBe('restricted');
    const policy = resolvePositionPolicy({ position_name: 'Outsource Transporter', department_name: 'Operation Department' });
    const driver = resolvePositionPolicy({ position_name: 'Driver', department_name: 'Operation Department' });
    expect(policy.pageAccess).toEqual(driver.pageAccess);
    expect(policy.scmConfigured).toBe(true);
    expect(isFleetPosition('Outsource Transporter')).toBe(false);
  });

  it('agrees with resolvePositionPolicy for the live position names', () => {
    const live: Array<[string, string | null]> = [
      ['Super Admin', 'Management'], ['Owner', null], ['Managing Director', 'Management'],
      ['IT Developer Executive', 'IT'], ['HR Manager', 'HR'], ['Finance Manager', 'Finance'],
      ['Operation Executive', 'Operation Department'], ['Logistic Admin', 'Operation Department'],
      ['Outsource Transporter', 'Operation Department'], ['Sales Director', 'Sales'],
      ['Sales Manager', 'Sales'], ['Sales Executive', 'Sales'], ['Driver', 'Operation Department'],
      ['Helper', 'Operation Department'], ['Warehouse Crew KL', 'Operation Department'],
      ['Storekeeper', 'Operation Department'], ['Calendar Viewer', null],
    ];
    for (const [pos, dept] of live) {
      const expected = positionGrantsWildcard(pos) ? 'god' : resolvePositionPolicy({ position_name: pos, department_name: dept }).cohort;
      expect(classifyPosition(pos, dept).cohort, pos).toBe(expected);
    }
  });

  it('carries the money and config flags the policy grants', () => {
    expect(classifyPosition('Finance Manager', 'Finance').flags).toContain('money-write');
    expect(classifyPosition('Sales Executive', 'Sales').flags).not.toContain('money-write');
    expect(classifyPosition('Managing Director', 'Management').flags).toEqual(expect.arrayContaining(['WILDCARD*', 'money-write', 'config-write']));
  });

  it('a user with no position is positionless, not full', () => {
    expect(classifyPosition(null, null).cohort).toBe('positionless');
    expect(classifyPosition('   ', 'Sales').cohort).toBe('positionless');
  });

  it('the audit script holds no copy of a position list any more', () => {
    const src = readFileSync(resolve(HERE, '../scripts/audit-permission-grants.mjs'), 'utf8');
    for (const name of ['GOD_POSITIONS', 'RESTRICTED_POSITIONS', 'MONEY_WRITE_POSITIONS', 'CONFIG_WRITE_POSITIONS', 'DIRECTOR_POSITION_NAMES', 'function policyCohort']) {
      expect(src.includes(name), name).toBe(false);
    }
    expect(src).toContain('import { classifyPosition } from "./lib/position-classification.mjs"');
  });

  it('neither diagnostic prints a person by name into the public Actions log (docs/bugs/0895)', () => {
    for (const script of ['audit-permission-grants.mjs', 'diag-role-permissions.mjs']) {
      const src = readFileSync(resolve(HERE, `../scripts/${script}`), 'utf8');
      expect(src, script).not.toMatch(/\bu\.name\b/);
      expect(src, script).not.toMatch(/user_name|AS person\b/);
    }
    const audit = readFileSync(resolve(HERE, '../scripts/audit-permission-grants.mjs'), 'utf8');
    expect(audit).not.toMatch(/lower\(p\.name\) IN \(/);
  });

  it('the workflow runs the script under tsx, which the TypeScript import needs', () => {
    const wf = readFileSync(resolve(HERE, '../../.github/workflows/diag-role-permissions.yml'), 'utf8');
    expect(wf).toContain('npx tsx scripts/audit-permission-grants.mjs');
    expect(wf).not.toMatch(/run: node scripts\/audit-permission-grants\.mjs/);
  });
});
