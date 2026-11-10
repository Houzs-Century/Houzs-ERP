/* The DO-return call and the SQL function it calls must agree, by name.
 *
 * Symptom (2026-11-10, 2990-DO-2611-016, CODY-(K), KL WAREHOUSE): the source-PO
 * planner found a dispatch rack but no PO. Cause, two faults in one call, either
 * enough on its own to make scm.fn_return_do_units_at_cost fail every time:
 *   1. #2447 renamed the route's argument to p_item_code; the function's parameter
 *      is p_product_code (CREATE OR REPLACE cannot rename it). PostgREST matches a
 *      function by its argument names, so the call was "function not found".
 *   2. The function body ordered by c.created_at; scm.inventory_lot_consumptions
 *      has consumed_at. plpgsql only checks that when the statement runs.
 * The route then fell back to a plain IN that minted a lot with no GRN and no PO.
 *
 * Neither is visible to typecheck, lint or a unit test with a fake database. This
 * reads the migration that production will run and pins both. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { returnAtCostArgs } from '../src/scm/lib/do-resync-return';

const DIR = join(__dirname, '../src/db/migrations-pg');

/** scm.inventory_lot_consumptions as production has it (information_schema,
 *  2026-11-10, Actions run 42778085508). The table's DDL is not in this repo. */
const CONSUMPTION_COLUMNS = new Set([
  'id', 'lot_id', 'warehouse_id', 'item_code', 'variant_key', 'qty_consumed', 'unit_cost_sen',
  'total_cost_sen', 'consumed_at', 'source_doc_type', 'source_doc_id', 'source_doc_no',
  'movement_id', 'created_by', 'company_id',
]);

/** The body of the LAST migration (pg-migrate's filename order) that defines it. */
function latestDefinition(fn: string): { file: string; params: string[]; body: string } {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const head = new RegExp(`CREATE OR REPLACE FUNCTION scm\\.${fn}\\s*\\(([^)]*)\\)`, 'i');
  for (const file of [...files].reverse()) {
    const sql = readFileSync(join(DIR, file), 'utf8');
    const m = head.exec(sql);
    if (!m) continue;
    const params = m[1].split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
    const rest = sql.slice(m.index);
    const end = rest.search(/\n\$(function)?\$( LANGUAGE plpgsql)?;/);
    return { file, params, body: end > 0 ? rest.slice(0, end) : rest };
  }
  throw new Error(`no migration defines scm.${fn}`);
}

describe('fn_return_do_units_at_cost: route call vs the function production runs', () => {
  const def = latestDefinition('fn_return_do_units_at_cost');

  test('the route sends exactly the function\'s parameter names', () => {
    const args = returnAtCostArgs('do-1', {
      warehouse_id: 'wh', item_code: 'CODY-(K)', variant_key: 'fabriccode=bf-01', batch_no: null, qty: 1, correction_seq: 1,
    }, 'u1');
    expect(Object.keys(args).sort()).toEqual([...def.params].sort());
    expect(args.p_product_code).toBe('CODY-(K)');
  });

  test('every consumption column the body names exists in production', () => {
    const used = [...def.body.matchAll(/\bc\.([a-z_]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((c) => !CONSUMPTION_COLUMNS.has(c))).toEqual([]);
    expect(def.body).toMatch(/ORDER BY c\.consumed_at DESC/);
  });
});
