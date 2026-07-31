// ----------------------------------------------------------------------------
// The lockstep alarm for the oversell retro-cost.
//
// scm/lib/oversell-retrocost.ts holds planUncostedRetrocost, the PURE in-memory
// mirror of scm.fn_reconcile_uncosted_out. Its header has said "KEEP THE TWO IN
// LOCKSTEP" in capitals since migration 0154, and it was still missed:
// migration 0230 narrowed the SQL's eligibility and left the TypeScript
// untouched, so oversell-retrocost.test.ts went on passing while asserting
// behaviour production no longer had. A comment cannot enforce that. This can.
//
// It lives in tests/ rather than beside the module because it has to read the
// migration tree, and backend/tsconfig.json compiles src/ against
// @cloudflare/workers-types (precedent: tests/migrationRetirements.test.ts).
// The SQL comes in through Vite's eager raw glob, not node:fs: these run in the
// Workers pool, where a Windows path round-trips through fileURLToPath as
// "/C:/..." and readdir fails.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import {
  planUncostedRetrocost,
  type RetroLot,
  type RetroOutMovement,
} from '../src/scm/lib/oversell-retrocost';

const CUTOFF = '2026-07-15T12:00:00.000Z';
const out = (o: Partial<RetroOutMovement> & { movementId: string; qty: number }): RetroOutMovement => ({
  doId: `do-${o.movementId}`,
  createdAt: '2026-07-10T00:00:00.000Z',
  isDropship: false,
  doStatus: 'SIGNED',
  alreadyConsumedQty: 0,
  alreadyCostedSen: 0,
  ...o,
});
const lot = (lotId: string, qtyRemaining: number, unitCostSen: number): RetroLot =>
  ({ lotId, receivedAt: '2026-07-15T00:00:00.000Z', qtyRemaining, unitCostSen });

/* Every *.sql in the live migration tree, as text, resolved at build time. */
const MIGRATIONS = import.meta.glob('../src/db/migrations-pg/*.sql', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

describe('planUncostedRetrocost stays in lockstep with fn_reconcile_uncosted_out', () => {

  /* Every eligibility guard the SQL applies, paired with the model line that
     mirrors it. A guard with no counterpart is a DRIFT, not an omission. */
  const GUARDS: Array<{ sql: string; model: string }> = [
    { sql: "m.movement_type   = 'OUT'", model: 'callers only pass OUT movements' },
    { sql: 'm.created_at       < p_before_ts', model: 'm.createdAt < cutoffTs' },
    { sql: 'COALESCE(d.is_dropship, FALSE) = FALSE', model: '!m.isDropship' },
    { sql: "UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'", model: "doStatus !== 'CANCELLED'" },
    { sql: 'di.committed_batch_strict = TRUE', model: '!m.strictBatchCommitted' },
    { sql: 'ORDER BY m.created_at ASC, m.id ASC', model: 'sort by createdAt then movementId' },
  ];

  /* By CONTENT, never by migration number: parallel PRs renumber files
     routinely, and a number-pinned read would resolve to nothing and pass
     vacuously. The LAST file (filename order = apply order) that redefines the
     function is the one production ends up running. */
  function newestUncostedOutSql(): string {
    let found: string | null = null;
    for (const path of Object.keys(MIGRATIONS).sort()) {
      const body = MIGRATIONS[path] ?? '';
      if (/CREATE OR REPLACE FUNCTION\s+scm\.fn_reconcile_uncosted_out/i.test(body)) found = body;
    }
    if (!found) throw new Error('no migration defines scm.fn_reconcile_uncosted_out');
    // The function body only — a later function in the same file must not count.
    const start = found.search(/CREATE OR REPLACE FUNCTION\s+scm\.fn_reconcile_uncosted_out/i);
    const end = found.indexOf('$fn$ LANGUAGE plpgsql', start);
    return found.slice(start, end < 0 ? undefined : end);
  }

  test('the migration tree is actually visible to this test', () => {
    // A vacuous pass is the failure mode a lockstep alarm can least afford.
    expect(Object.keys(MIGRATIONS).length).toBeGreaterThan(100);
  });

  test('every SQL guard has a counterpart in the pure model', () => {
    const sql = newestUncostedOutSql();
    for (const g of GUARDS) {
      expect(sql, `SQL lost the guard mirrored by "${g.model}"`).toContain(g.sql);
    }
  });

  test('the SQL grew NO guard this model does not implement', () => {
    const sql = newestUncostedOutSql();
    /* The WHERE block of the driving FOR loop, i.e. the eligibility test. Count
       its top-level predicates: the SQL indents them at 7 spaces before AND. */
    const where = sql.slice(sql.indexOf('WHERE m.movement_type'), sql.indexOf('ORDER BY m.created_at'));
    const topLevel = [...where.matchAll(/^ {7}AND /gm)].length;
    expect(
      topLevel,
      'fn_reconcile_uncosted_out gained or lost a top-level predicate. Mirror it in '
      + 'planUncostedRetrocost, add it to GUARDS above, then update this count.',
    ).toBe(7);
  });

  test('the model actually applies the 0230 strict-batch exclusion', () => {
    const strict = out({ movementId: 'm-sofa', qty: 2, alreadyConsumedQty: 0, strictBatchCommitted: true });
    const plain = out({ movementId: 'm-mat', qty: 2, alreadyConsumedQty: 0, strictBatchCommitted: false });
    const lots = [lot('l1', 10, 700)];

    expect(planUncostedRetrocost([strict], lots, CUTOFF).lines).toEqual([]);
    // ...and the non-strict one is STILL repaired, which is the whole of FIX 1:
    // a bound mattress keeps the fallback it had before 0230 existed.
    expect(planUncostedRetrocost([plain], lots, CUTOFF).lines.map((l) => l.retroQty)).toEqual([2]);
  });

  test('an undefined strictBatchCommitted (every pre-0230 caller) stays eligible', () => {
    const legacy = out({ movementId: 'm-old', qty: 1, alreadyConsumedQty: 0 });
    expect(planUncostedRetrocost([legacy], [lot('l1', 5, 100)], CUTOFF).totalRetroQty).toBe(1);
  });
});
