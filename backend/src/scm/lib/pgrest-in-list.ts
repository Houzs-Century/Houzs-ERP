// ----------------------------------------------------------------------------
// ONE HOME for PostgREST's `in.(…)` value list — how we WRITE one, and how it is
// READ back.
//
// WHY THIS FILE EXISTS. `@supabase/postgrest-js` 2.108.2 builds the list like
// this (dist/index.cjs, verbatim):
//
//   const PostgrestReservedCharsRegexp = new RegExp("[,()]");
//   in(column, values) {
//     const cleanedValues = Array.from(new Set(values)).map((s) => {
//       if (typeof s === "string" && PostgrestReservedCharsRegexp.test(s)) return `"${s}"`;
//       else return `${s}`;
//     }).join(",");
//     this.url.searchParams.append(column, `in.(${cleanedValues})`);
//
// It QUOTES and it never ESCAPES. PostgREST's own grammar
// (docs.postgrest.org/en/v12/references/api/url_grammar.html) says the opposite
// is required: *"If the value filtered by the `in` operator has a double quote
// (`"`), you can escape it using a backslash `"\""`. A backslash itself can be
// used with a double backslash `"\\"`."*
//
// So a value carrying a `"` produces a filter whose quoted string closes early,
// and the first `)` after that closes the whole `in.(` list — every value after
// it in the same batch is dropped. The request still answers 200. Measured on
// production 2026-09-10 (run 34457477642): TWO item codes in company 1's open
// demand carry an inch mark —
//
//   DUNLOPILLO GENERASI 5" MATT (S)      batch 1, position 29 of 50
//   DUNLOPILLO GENERASI 5" MATT (SS)     batch 3, position 24 of 50
//
// — and of the 38 item codes whose supplier bindings the MRP engine failed to
// attach, 33 sat in one of those two batches and 31 sat AFTER the inch-marked
// value in it. Not one code positioned after such a value kept its suppliers.
// Every other batch lost nothing. See docs/bugs/0780.
//
// WHAT THE SERIALISER GUARANTEES. For a list containing no `"` and no `\` it is
// BYTE-IDENTICAL to what `.in()` builds today — same de-duplication, same
// quoting rule, same order, same separator — which is what makes adopting it a
// no-op for every read that works now. `pgrestInList.parity.test.ts` pins that
// against the REAL client rather than against a copy of its source.
//
// USE IT AS: `q.filter(column, 'in', pgrestInList(values))`. `.filter()` appends
// `${operator}.${value}` verbatim (dist/index.cjs), so the payload below carries
// its own parentheses.
// ----------------------------------------------------------------------------

/** What a PostgREST filter list can carry — same union `chunkIn` accepts. */
export type InValue = string | number;

/* The library's own rule, restated so the parity test can assert against it
   rather than against a second opinion. `"` and `\` are ADDED here: PostgREST
   treats both as structural inside a quoted value, and a value carrying either
   is precisely what the library cannot express. */
const RESERVED = /[,()]/;
const NEEDS_ESCAPE = /["\\]/;

/**
 * The `(…)` payload for `filter(column, 'in', …)`, quoted and escaped the way
 * PostgREST documents.
 *
 * De-duplicates first, preserving first-appearance order, because that is what
 * `.in()` does and the two must agree byte for byte where both are correct.
 */
export function pgrestInList(values: readonly InValue[]): string {
  const body = [...new Set(values)]
    .map((v) => {
      if (typeof v !== 'string') return `${v}`;
      if (!RESERVED.test(v) && !NEEDS_ESCAPE.test(v)) return v;
      return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    })
    .join(',');
  return `(${body})`;
}

/**
 * Read a `(…)` payload back into the values it names — PostgREST's side of the
 * grammar, and the inverse of `pgrestInList` for every list that one can build.
 *
 * IT ALSO REPRODUCES THE FAILURE, deliberately, because a parser that quietly
 * repaired a malformed list would make the fake in `supplier-bindings.test.ts`
 * pass against the bug it exists to catch:
 *
 *   · a bare (unquoted) run ends at the next `,` or `)`, so a stray `)` inside
 *     one TERMINATES the list and everything after it is never read;
 *   · a closing `"` does not end the value — scanning continues as bare — which
 *     is what turns `"…5" MATT (S)"` into one garbled value plus an early close.
 *
 * That is the OBSERVED behaviour, not a guess about the parser: production run
 * 34457477642 shows values before such a token intact, values after it gone,
 * and the request answering 200 throughout. Anything past the terminating `)` is
 * ignored here for the same reason — the codes it named came back with nothing.
 */
export function parsePgrestInList(payload: string): string[] {
  if (!payload.startsWith('(')) return [];
  if (payload === '()') return [];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 1; i < payload.length; i += 1) {
    const ch = payload[i]!;
    if (quoted) {
      if (ch === '\\' && i + 1 < payload.length) { cur += payload[i + 1]!; i += 1; continue; }
      if (ch === '"') { quoted = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    if (ch === ')') { out.push(cur); return out; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Apply an `in` predicate on `column` for `values` to a PostgREST builder,
 * ESCAPING via `pgrestInList` only when a value carries `"` or `\` — the two
 * characters `.in()` cannot serialise (it quotes `[,()]` but never escapes; see
 * the header). For every list without one it calls `.in()` unchanged, so the
 * query string is BYTE-IDENTICAL to what the raw `.in()` builds today. That is
 * the property that lets this replace `.in('code' | 'item_code', …)` at a call
 * site with no behaviour change and no test-fake churn: a fake that only
 * implements `.in` keeps working, because a clean list never reaches `.filter`.
 * The escape path is reached only by a value the raw `.in()` would silently drop
 * from the middle of the list, so adopting it can only ADD codes back to a short
 * read (or a short write's WHERE), never remove one.
 *
 * Returns the builder, so it composes exactly where `.in()` sat:
 *
 *   pgrestIn(sb.from('mfg_products').select('code'), 'code', codes)
 *     .eq('company_id', id)
 *
 * WHY A HELPER, NOT THE INLINE TERNARY docs/bugs/0780 and 0815 each hand-wrote:
 * those two fixed the reads their incidents named and left the rest. The sweep
 * that closed the remaining ~50 by-code reads/writes (docs/bugs/0819) routes
 * every one through here, so the rule has ONE home and the next by-code read
 * cannot get the escape condition subtly wrong.
 */
export function pgrestIn<Q>(builder: Q, column: string, values: readonly InValue[]): Q {
  const needsEscape = values.some((v) => typeof v === 'string' && NEEDS_ESCAPE.test(v));
  const b = builder as {
    in(column: string, values: readonly InValue[]): Q;
    filter(column: string, operator: string, value: string): Q;
  };
  return needsEscape ? b.filter(column, 'in', pgrestInList(values)) : b.in(column, values);
}
