// EVERY CODE THE READER ASKS FOR MUST REACH THE DATABASE.
//
// The owner, 2026-09-10, on HC-SO-013497: four sofa pieces of one model, same
// fabric, and the Supplier column disagrees line by line — `9058-1A(RHF)` and
// `9058-L(LHF)` offer HOOKKA INDUSTRIES, `9058-1NA` twice reads "— none —".
// Production held five identical bindings for all four codes (run 34454717897).
//
// The cause is not in this file's SQL predicate, it is in the URL it builds.
// `@supabase/postgrest-js` 2.108.2 serialises `.in()` by wrapping a value in
// double quotes when it holds one of `, ( )` and escaping NOTHING inside them.
// PostgREST requires `\"` and `\\` there. So an item code carrying an inch mark
// — `DUNLOPILLO GENERASI 5" MATT (S)`, and company 1's open demand carries two
// of them — closes its own quote early, the next `)` closes the whole `in.(`
// list, and every code AFTER it in that batch matches nothing while the request
// answers 200.
//
// Measured on production, run 34457477642: 38 item codes whose bindings the MRP
// engine did not attach; 33 of them in one of the two batches carrying an
// inch-marked code, 31 of those positioned AFTER it; every other batch lost
// nothing; and ZERO codes positioned after such a value kept their suppliers.
//
// THE HARNESS. The client is the REAL one — `createClient` from
// `@supabase/supabase-js`, the same call `src/db/supabase.ts` makes — so the
// filter under test is built by the library, not by a copy of its source. Only
// `fetch` is faked, and the fake reads the query string the way PostgREST does
// (`parsePgrestInList`, which reproduces the early close rather than repairing
// it — see its header for why that faithfulness is the point).
import { describe, expect, test } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { readMfgProductBindings } from './supplier-bindings';
import { parsePgrestInList } from './pgrest-in-list';

/* The two inch-marked codes are REAL: they are what production carries, and the
   bug only exists because a catalogue names mattresses by their depth. */
const INCH_CODE = 'DUNLOPILLO GENERASI 5" MATT (S)';

/* The reported document's four pieces, plus enough neighbours that the
   inch-marked code sits in the MIDDLE of the list rather than at its end —
   which is the whole shape: what is lost is what comes AFTER it. */
const CODES = [
  '9058-1A(RHF)',
  '9058-L(LHF)',
  INCH_CODE,
  '9058-1NA',
  '9058-1S',
  'LONG PILLOW',
] as const;

type Row = { item_code: string; is_main_supplier: boolean; supplier_id: string };

const ROWS: Row[] = CODES.map((code) => ({
  item_code: code,
  is_main_supplier: true,
  supplier_id: 'sup-h004',
}));

/** The query strings the reader actually put on the wire, in order. */
function clientThatHonoursPostgrestGrammar(seen: string[]) {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    const raw = url.searchParams.get('item_code') ?? '';
    seen.push(raw);
    /* PostgREST reads `in.(…)`; anything it cannot parse out of that list simply
       never becomes a predicate value, which is why the loss is silent. */
    const wanted = new Set(
      raw.startsWith('in.') ? parsePgrestInList(raw.slice('in.'.length)) : [],
    );
    const body = ROWS.filter((r) => wanted.has(r.item_code));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return createClient('http://postgrest.test', 'test-service-key', {
    global: { fetch: fetchImpl },
    db: { schema: 'scm' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

describe('readMfgProductBindings — the reader asks for every code it was given', () => {
  test('an item code carrying a double quote does not silently drop the codes after it', async () => {
    const seen: string[] = [];
    const sb = clientThatHonoursPostgrestGrammar(seen);

    const { data, error } = await readMfgProductBindings<Row>(sb, {
      codes: [...CODES],
      companyId: 1,
      select: 'item_code, is_main_supplier, supplier_id',
    });

    expect(error).toBeNull();
    /* Named individually, so a failure prints WHICH code lost its supplier
       instead of a bare length mismatch — the same reason mrpSofaSupplier's
       assertion is a mapped list. */
    expect([...data].map((r) => r.item_code).sort()).toEqual([...CODES].sort());
  });

  test('the filter it emits parses back to exactly the codes asked for', async () => {
    const seen: string[] = [];
    const sb = clientThatHonoursPostgrestGrammar(seen);
    await readMfgProductBindings<Row>(sb, {
      codes: [...CODES],
      companyId: 1,
      select: 'item_code',
    });
    expect(seen).toHaveLength(1);
    const emitted = seen[0]!;
    expect(emitted.startsWith('in.(')).toBe(true);
    expect(parsePgrestInList(emitted.slice('in.'.length))).toEqual([...CODES]);
  });

  test('an empty code list still reads nothing and asks nothing', async () => {
    const seen: string[] = [];
    const sb = clientThatHonoursPostgrestGrammar(seen);
    const { data, error } = await readMfgProductBindings<Row>(sb, {
      codes: [],
      companyId: 1,
      select: 'item_code',
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(seen).toEqual([]);
  });
});
