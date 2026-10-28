import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/* ── A delivery order may only take goods off ITS OWN company's rack ─────────
 *
 * `stockOutDoLinesFromRacks` consumes the physical rack ledger when a DO is
 * dispatched. The rack it consumes from can be named by the caller — the DO
 * line's `rackId` lands in `delivery_order_items.rack_id` straight off the
 * request body — and the helper already RECEIVES the order's `companyId`,
 * because it stamps it onto the movement rows it writes.
 *
 * It was using that companyId to STAMP and never to FILTER. The client is
 * SERVICE-ROLE and mig 0061 enabled RLS with zero policies, so the predicate a
 * statement carries is the whole tenant boundary: a rack uuid from the other
 * company's warehouse resolved, its placements were decremented or deleted, and
 * a STOCK_OUT stamped with THIS company's id was written against THEIR bay.
 *
 * Both columns are NOT NULL in production — `warehouse_rack_items.company_id`
 * by mig 0083, `warehouse_racks.company_id` by mig 0089 — so filtering on them
 * cannot silently drop a legitimate row.
 *
 * The `companyId` parameter is nullable, and a null must NOT become
 * `.eq('company_id', null)` (a malformed filter, not "no company"), so the guard
 * goes through `scopeToCompanyIdOrOpen` (scm/lib/companyScope.ts). That is why
 * this test asks for the IDENTIFIER rather than a literal `.eq(` — the stamp
 * (`companyCol`) and the filter are two different spellings of the same id.
 *
 * Source scan, for the reason permissionDivergence.test.ts and
 * soMaintenanceGate.test.ts are source scans: the helper is not exported and
 * rendering it would need a PostgREST double. What must not drift is WHICH
 * PREDICATES its statements carry, which is what the source says.
 *
 * LIGHT project (no cloudflare:test, no env.DB) so it runs inside
 * `npm run test:light`, which backend-typecheck runs — a REQUIRED context. */

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '..', 'src', 'scm', 'routes', 'delivery-orders-mfg.ts');
const SRC = readFileSync(FILE, 'utf8');

/** The body of `stockOutDoLinesFromRacks`, from its declaration to the start of
 *  the next top-level declaration. A slice that ran short would drop statements
 *  (false GREEN), so the end anchor is asserted rather than assumed. */
function stockOutBody(src: string): string {
  const start = src.indexOf('async function stockOutDoLinesFromRacks(');
  expect(start, 'stockOutDoLinesFromRacks not found — did it move or get renamed?').toBeGreaterThan(-1);
  const end = src.indexOf('\nasync function refreshRackStatusInline(', start);
  expect(end, 'refreshRackStatusInline no longer follows it — re-anchor this slice').toBeGreaterThan(start);
  return src.slice(start, end);
}

const BODY = stockOutBody(SRC);

const RACK_TABLES = ['warehouse_racks', 'warehouse_rack_items'];

/** Every `from('<table>')` chain in the body, sliced to its whole statement. */
function statements(body: string, table: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const marker = new RegExp(`from\\('${table}'\\)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = marker.exec(body)) !== null) {
    const from =
      Math.max(body.lastIndexOf(';', m.index), body.lastIndexOf('{', m.index), body.lastIndexOf('}', m.index)) + 1;
    const to = body.indexOf(';', m.index);
    out.push({
      text: body.slice(from, to === -1 ? body.length : to),
      // line within the FILE, so a failure points somewhere you can open
      line: SRC.slice(0, SRC.indexOf('async function stockOutDoLinesFromRacks(') + m.index).split('\n').length,
    });
  }
  return out;
}

describe('DO rack stock-out is bounded to the order\'s own company', () => {
  test('the scan found the rack statements (a zero here would be a false green)', () => {
    const total = RACK_TABLES.flatMap((t) => statements(BODY, t)).length;
    expect(total).toBeGreaterThanOrEqual(4);
  });

  for (const table of RACK_TABLES) {
    test(`every ${table} statement in the helper carries company_id`, () => {
      const offenders = statements(BODY, table)
        .filter((s) => !/company_id|companyCol|scopeToCompanyIdOrOpen/.test(s.text))
        .map((s) => `delivery-orders-mfg.ts:~${s.line}`);
      expect(offenders).toEqual([]);
    });
  }

  test('the caller-named rack is resolved with the company filter, not just by id', () => {
    // The explicit-pick branch is the one a request body can steer. Named on its
    // own because it is the only door an outsider controls.
    const explicit = statements(BODY, 'warehouse_racks').filter((s) => /explicitRackId/.test(s.text));
    expect(explicit.length).toBeGreaterThanOrEqual(1);
    for (const s of explicit) {
      expect(/company_id|companyCol|scopeToCompanyIdOrOpen/.test(s.text), `delivery-orders-mfg.ts:~${s.line}`).toBe(true);
    }
  });
});
