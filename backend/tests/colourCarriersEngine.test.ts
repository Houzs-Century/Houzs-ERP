import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by the census and the retire script
import { CARRIERS, COLOUR_KEYS, countCarrier, baseCol, isSelfCarrier } from '../scripts/lib/colour-carriers.mjs';

/* THE COUNTING ENGINE MOVED, AND THIS PROVES IT DID NOT CHANGE ON THE WAY.

   resolveCarriers() and countCarrier() used to be private functions inside
   scripts/census-fabric-colour.mjs. retire-non-fabric-rows.mjs has to ask the
   same question of the same carriers before it deactivates a row, and a second
   hand-written per-kind SQL switch is exactly the drift that left the GRN arm
   unswept in #1964. So the engine moved into lib/colour-carriers.mjs and both
   tools import it.

   A move like that is only safe if the SQL is provably identical, and neither
   the census nor the retire script can be run here — they need a real Postgres.
   So the queries are pinned instead: a recording stub stands in for the
   postgres.js client, and every carrier kind's SQL and BOUND PARAMETERS are
   asserted against what the census emitted before the move.

   Whitespace is normalised before comparing, deliberately. Re-indenting a
   template literal is not a behaviour change; changing a predicate is, and that
   still fails. Pinning the exact newlines would only make the test brittle
   about the thing that does not matter. */

/** Stands in for `sql`, recording what would have been sent. */
function recorder() {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const stub = {
    unsafe: (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return Promise.resolve([{ n: 0 }]);
    },
  };
  return { stub, calls };
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Fire one carrier at the stub and hand back the single recorded query. */
async function emit(carrier: Record<string, unknown>, code: string, company = 1) {
  const { stub, calls } = recorder();
  await countCarrier(stub, carrier, code, company);
  expect(calls).toHaveLength(1);
  return { text: flat(calls[0].text), params: calls[0].params };
}

const withCo = (kind: string, table: string, col: string) => ({ kind, table, col, hasCompany: true });
const noCo = (kind: string, table: string, col: string) => ({ kind, table, col, hasCompany: false });

describe('countCarrier emits exactly the SQL the census always emitted', () => {
  test('col — a plain text column holding the code', async () => {
    const q = await emit(withCo('col', 'scm.fabric_trackings', 'fabric_code'), 'SOFA 5535');
    expect(q.text).toBe(
      "SELECT COUNT(*)::int AS n FROM scm.fabric_trackings WHERE company_id = 1 AND fabric_code = $1",
    );
    expect(q.params).toEqual(['SOFA 5535']);
  });

  test('variants — every colour alias, OR-ed, not just fabricCode', async () => {
    const q = await emit(withCo('variants', 'scm.mfg_sales_order_items', 'variants'), 'SOFA 5535');
    const where = (COLOUR_KEYS as string[]).map((k) => `variants->>'${k}' = $1`).join(' OR ');
    expect(q.text).toBe(
      `SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items WHERE company_id = 1 AND (${where})`,
    );
    // Matching only fabricCode is how an arm reports clean while still dirty.
    expect((COLOUR_KEYS as string[]).length).toBeGreaterThan(1);
    expect(COLOUR_KEYS).toContain('fabricCode');
    expect(COLOUR_KEYS).toContain('fabricColor');
    expect(q.params).toEqual(['SOFA 5535']);
  });

  test('vkey — the pipe-joined stock bucket, lowercased and LIKE-escaped', async () => {
    const q = await emit(withCo('vkey', 'scm.inventory_lots', 'variant_key'), 'XQ#18_A');
    expect(q.text).toBe(
      "SELECT COUNT(*)::int AS n FROM scm.inventory_lots WHERE company_id = 1 AND "
      + "('|' || COALESCE(variant_key, '') || '|') LIKE ('%|fabriccode=' || $1 || '|%') ESCAPE '\\'",
    );
    // lowercased, because the key materialises the code lowercased; and the
    // underscore escaped, because '_' is a legal fabric-code character and a
    // raw LIKE would match anything in that position.
    expect(q.params).toEqual(['xq#18\\_a']);
  });

  test('text — printed description2, matched on non-alphanumeric boundaries', async () => {
    const q = await emit(withCo('text', 'scm.mfg_sales_order_items', 'description2'), 'CG-002');
    expect(q.text).toBe(
      "SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items WHERE company_id = 1 AND "
      + "COALESCE(description2, '') ~ $1",
    );
    expect(q.params).toEqual(['(^|[^A-Za-z0-9])CG\\-002([^A-Za-z0-9]|$)']);
  });

  test('jsonarr — the model whitelist, as array elements not substrings', async () => {
    const q = await emit(withCo('jsonarr', 'scm.product_models', "allowed_options->'fabrics'"), 'CG-002');
    expect(q.text).toBe(
      "SELECT COUNT(*)::int AS n FROM scm.product_models WHERE company_id = 1 AND "
      + "jsonb_typeof(allowed_options->'fabrics') = 'array' AND EXISTS "
      + "(SELECT 1 FROM jsonb_array_elements_text(allowed_options->'fabrics') e WHERE e = $1)",
    );
    expect(q.params).toEqual(['CG-002']);
  });

  test('blob — a whole jsonb document searched as text', async () => {
    const q = await emit(withCo('blob', 'scm.so_revisions', 'snapshot'), 'SOFA 5535');
    expect(q.text).toBe(
      "SELECT COUNT(*)::int AS n FROM scm.so_revisions WHERE company_id = 1 AND "
      + "COALESCE(snapshot::text, '') LIKE ('%' || $1 || '%') ESCAPE '\\'",
    );
    expect(q.params).toEqual(['SOFA 5535']);
  });

  test('a carrier without company_id drops the predicate entirely', async () => {
    const q = await emit(noCo('col', 'scm.fabric_colours', 'colour_id'), 'CG-002');
    // No company_id, so this counts across ALL companies — the callers say so
    // out loud rather than pretending the number is scoped.
    expect(q.text).toBe("SELECT COUNT(*)::int AS n FROM scm.fabric_colours WHERE colour_id = $1");
  });

  test('the company id reaches the SQL, and a different one changes it', async () => {
    const q = await emit(withCo('col', 'scm.fabric_trackings', 'fabric_code'), 'SOFA 5535', 2);
    expect(q.text).toContain('company_id = 2');
  });

  test('an unknown kind throws rather than counting nothing', () => {
    const { stub } = recorder();
    expect(() => countCarrier(stub, { kind: 'wat', table: 't', col: 'c', hasCompany: true }, 'X', 1))
      .toThrow(/unknown kind wat/);
  });
});

describe('the carrier list and its helpers', () => {
  test('every carrier kind in the list is one countCarrier implements', () => {
    const known = new Set(['variants', 'vkey', 'text', 'jsonarr', 'col', 'blob']);
    for (const c of CARRIERS as Array<{ kind: string }>) expect(known).toContain(c.kind);
  });

  test('baseCol strips the jsonb path so the column-exists check can work', () => {
    expect(baseCol({ col: "allowed_options->'fabrics'" })).toBe('allowed_options');
    expect(baseCol({ col: 'variants' })).toBe('variants');
    expect(baseCol({ col: 'committed_variant_key' })).toBe('committed_variant_key');
  });

  test('isSelfCarrier names exactly one carrier — the fabric master row itself', () => {
    const self = (CARRIERS as Array<Record<string, unknown>>).filter(isSelfCarrier);
    expect(self).toHaveLength(1);
    expect(self[0]).toMatchObject({ table: 'scm.fabric_trackings', col: 'fabric_code', live: true });
  });

  test('the selling mirror is NOT excluded — retiring a cost row leaves it live', () => {
    // retire-non-fabric-rows.mjs refuses on scm.fabric_colours deliberately:
    // the mirror keeps the code offerable on POS, and that is a second half
    // somebody has to do with the colour tooling.
    const mirror = (CARRIERS as Array<Record<string, unknown>>)
      .find((c) => c.table === 'scm.fabric_colours' && c.col === 'colour_id');
    expect(mirror).toBeTruthy();
    expect(isSelfCarrier(mirror)).toBe(false);
  });
});
