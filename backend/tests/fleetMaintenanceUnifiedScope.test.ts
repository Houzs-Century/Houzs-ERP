/* ONE TRANSPORT COMPANY, ONE FLEET, ONE SET OF MAINTENANCE RECORDS.
 *
 * Owner, 2026-09-02, asked which way to settle it:
 *   「共用的，因为 TMS 是共用的。这个东西 TMS 就像我们的运输公司一样」
 *
 * What was wrong. `GET /fleet-maintenance/dashboard` read the maintenance tables
 * with NO company predicate while TWELVE by-id handlers on those same tables
 * called `scopeToCompany`. So the dashboard listed a row that PATCH/DELETE then
 * answered 404 for — on screen, not openable, no explanation.
 *
 * The file's own `company-scope-file:` marker had said the module was a unified
 * fleet all along, and migs 0202 / 0203 / 0204 / 0238 each state that
 * `company_id` is "STAMPED on insert for provenance but NOT used to scope
 * reads". The marker even predicted this failure in words. The note was right
 * and the code had drifted from it: a marker that states the intent is not a
 * marker that enforces it. This file is the enforcement.
 *
 * WHY A SOURCE SCAN AND NOT A ROUTE TEST. The defect is not what one handler
 * answers — it is TWO handlers on one table disagreeing. That is a property of
 * the file, and a route test would need a fixture per handler to say it.
 *
 * WHAT THIS DOES NOT SAY. It does not say company_id must not be WRITTEN: the
 * migrations require it stamped on insert for provenance, so `company_id:
 * activeCompanyId(c)` on a create is correct and is left alone. It constrains
 * READS and by-id WRITES only.
 *
 * Traced in docs/bugs/0620.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILE = join(__dirname, '..', 'src', 'scm', 'routes', 'fleet-maintenance.ts');

/** The maintenance records the 2026-09-02 ruling covers. */
const SHARED_TABLES = [
  'lorry_compliance_documents',
  'lorry_compliance_attachments',
  'lorry_maintenance_plans',
  'lorry_breakdown_cases',
  'lorry_work_orders',
  'lorry_work_order_parts',
  'lorry_components',
];

/** The ONE exception, and it is per-company by migration 0241. Workshops is the
 *  repair-shop MASTER, not a maintenance record; the ruling was about the
 *  records and did not reach it. */
const PER_COMPANY_TABLES = ['workshops'];

const source = () => readFileSync(FILE, 'utf8');

/** Every `scopeToCompany(...)` call with the table it names, ignoring comments. */
function scopedTables(text: string): string[] {
  const body = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of body.matchAll(/scopeToCompany\(\s*([\s\S]{0,240}?)\)\s*(?:\.|,\s*c\))/g)) {
    const seg = m[1] ?? '';
    const t = /\.from\(\s*["']([a-z_]+)["']/.exec(seg);
    if (t?.[1]) out.push(t[1]);
  }
  return out;
}

describe('fleet maintenance is one shared fleet', () => {
  it('the matcher ran over the real file', () => {
    const text = source();
    expect(text.length).toBeGreaterThan(10_000);
    /* If the module stops using the helper entirely the matcher would report a
       clean run over nothing, so pin that it still finds the exception. */
    expect(text).toContain('scopeToCompany');
  });

  it('the matcher is not dead — it still recognises the call shape', () => {
    expect(scopedTables('await scopeToCompany(sb.from("lorry_work_orders").update(p).eq("id", x), c).select("id")'))
      .toEqual(['lorry_work_orders']);
    expect(scopedTables('const q = sb.from("workshops").select("*");\nawait scopeToCompany(q, c).order("name")'))
      .toEqual([]); // a pre-built query names no table inline — see the note below
  });

  it('no maintenance record is company-scoped — the dashboard reads them all', () => {
    const offenders = [...new Set(scopedTables(source()))].filter((t) => SHARED_TABLES.includes(t));
    expect(
      offenders,
      `these are shared across companies (owner 2026-09-02, TMS is one transport company): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('workshops stays per-company — mig 0241, and the ruling did not reach it', () => {
    /* Named by its own handler rather than by the helper call, because the
       workshops list builds its query first and passes the variable. */
    const body = source().replace(/\/\*[\s\S]*?\*\//g, '');
    expect(body).toContain('scopeToCompany(q, c).order("name")');
    expect(PER_COMPANY_TABLES).toContain('workshops');
  });

  it('company_id is still STAMPED on insert — provenance, which the migrations require', () => {
    const body = source().replace(/\/\*[\s\S]*?\*\//g, '');
    /* Unscoping reads must not be read as "drop the column". */
    expect(body).toContain('company_id: activeCompanyId(c) ?? null');
  });
});
