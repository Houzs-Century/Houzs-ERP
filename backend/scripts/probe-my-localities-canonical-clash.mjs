#!/usr/bin/env node
/* Read-only: can canonicalising a state name change the country a sales document
   derives?

   WHY THIS EXISTS. `deriveCountryFromState` used to have two copies — one in
   routes/mfg-sales-orders.ts, one in routes/consignment-orders.ts — and they had
   drifted: the SO canonicalised the state before the `scm.my_localities` lookup,
   the CO looked the raw string up. PR #2242 merges them onto the SO's body. That
   is only behaviour-preserving if no row makes the two lookups disagree.

   THE EXACT CONDITION. For an input S the CO reads `WHERE state = S` and the SO
   reads `WHERE state = canonicalizeMyState(S)`. They can only differ when
   canonicalising REWRITES the string — i.e. S is an ALIAS KEY such as 'JOHOR',
   'WP KUALA LUMPUR', 'PENANG' — and a locality row carries that raw spelling
   under a country the canonical spelling would not resolve to. Concretely: a row
   `state = 'JOHOR', country = 'Singapore'` makes the CO answer Singapore and the
   SO answer Malaysia.

   WHY A PROBE AND NOT A TEST. `backend/tests/salesDocDerive.test.ts` already
   asserts this over the SEEDED data by scanning src/db/migrations-pg. But
   `scm.my_localities` is writable at runtime — routes/localities.ts exposes
   POST / PATCH / DELETE with `state` and `country` as free-form strings
   (z.string().trim().min(1)), gated only by canWriteScmConfig. So an
   operator-created row is invisible to that scan, and CLAUDE.md's standing rule
   applies: a migration file describes intent, the running system is the fact.

   WHAT A CLEAN RESULT MEANS. Zero clash rows => merging the twins cannot change
   any derived country, for any input, against the data that is actually there.
   A non-zero result names the rows, and #2242 must not merge until they are
   understood — note that the SO's answer is the CORRECT one for a Malaysian
   state name, so the fix is likely the DATA, not the code.

   Writes nothing: SELECTs only, no DDL, no transaction. Exit 0 for every
   legitimate answer — including "clashes found", which is an answer, not a
   broken check. Non-zero only when the database cannot be read.

   RE-RUN: idempotent. It reads and prints; a second run does nothing different. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

/* canonical-state.ts is TypeScript and this is a plain .mjs on node 20, so it
   cannot be imported. The vocabulary is READ OUT OF THE SOURCE rather than
   re-typed here — a second hand-maintained copy of the alias list is the exact
   duplicated-list bug #2242 is about. `probeKey` is four string ops and is
   ported literally below; the assertion in loadVocabulary() refuses to report
   at all if the parse comes back empty, because a verdict computed over nothing
   must never read as a pass (CLAUDE.md). */
const HERE = dirname(fileURLToPath(import.meta.url));
const CANONICAL_STATE_TS = join(HERE, "../src/scm/lib/canonical-state.ts");

/** Literal port of probeKey() in canonical-state.ts. Keep in step with it. */
const probeKey = (raw) => raw.trim().toUpperCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();

function loadVocabulary() {
  const src = readFileSync(CANONICAL_STATE_TS, "utf8");
  const canonBlock = src.match(/const CANONICAL_STATES[\s\S]*?\]\)/)?.[0] ?? "";
  const aliasBlock = src.match(/const ALIAS_MAP[\s\S]*?\]\);/)?.[0] ?? "";
  const canonical = new Set([...canonBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const alias = new Map([...aliasBlock.matchAll(/\['([^']*)',\s*'([^']+)'\]/g)].map((m) => [m[1], m[2]]));
  if (canonical.size < 16 || alias.size === 0) {
    throw new Error(
      `parsed ${canonical.size} canonical states and ${alias.size} aliases out of ` +
        `canonical-state.ts — the file's shape changed and this probe cannot answer. ` +
        `Fix the parse; do NOT read an empty result as "no clashes".`,
    );
  }
  return { canonical, alias };
}

const { canonical: CANONICAL_STATES, alias: ALIAS_MAP } = loadVocabulary();

/** Literal port of canonicalizeMyState(), country hint omitted (as the routes call it). */
function canonicalizeMyState(input) {
  if (input === null || input === undefined) return null;
  const trimmed = input.trim();
  if (trimmed === "") return input;
  if (CANONICAL_STATES.has(trimmed)) return trimmed;
  return ALIAS_MAP.get(probeKey(trimmed)) ?? input;
}

async function main() {
  note(`vocabulary parsed: ${CANONICAL_STATES.size} canonical states, ${ALIAS_MAP.size} aliases`);
  const [tot] = await sql`SELECT count(*)::int AS n FROM scm.my_localities`;
  note(`scm.my_localities rows: ${tot.n}`);

  /* Guard the shape of the answer before trusting the answer. A predicate that
     matched nothing because the table was empty, or because the column was
     renamed, must not read as "no clashes". */
  if (tot.n === 0) {
    warn("my_localities is EMPTY — this probe can prove nothing. Stopping.");
    return;
  }

  const countries = await sql`
    SELECT coalesce(country, '(null)') AS country, count(*)::int AS n
      FROM scm.my_localities GROUP BY 1 ORDER BY 2 DESC`;
  note(`\n=== countries present ===`);
  for (const r of countries) note(`  ${r.country}: ${r.n}`);

  /* Every DISTINCT (state, country) actually stored. The clash test is applied
     in JS so it uses the same canonicalizeMyState the routes use, rather than a
     re-implementation in SQL that could drift from it. */
  const pairs = await sql`
    SELECT DISTINCT state, coalesce(country, '(null)') AS country
      FROM scm.my_localities
     WHERE state IS NOT NULL AND state <> ''`;
  note(`\ndistinct (state, country) pairs: ${pairs.length}`);

  const rewritten = [];
  for (const { state, country } of pairs) {
    const canon = canonicalizeMyState(state) ?? state;
    if (canon !== state) rewritten.push({ state, canon, country });
  }

  note(`\n=== states the canonicaliser REWRITES (the only ones that can diverge) ===`);
  if (rewritten.length === 0) {
    note("  none — every stored state name is canonicalisation-stable.");
  } else {
    for (const r of rewritten) note(`  '${r.state}' -> '${r.canon}'  (country ${r.country})`);
  }

  /* For each rewritten spelling, what would the two implementations answer?
     CO: country of the row matching the RAW string. SO: country of the row
     matching the CANONICAL string. Different => a real divergence. */
  const clashes = [];
  for (const r of rewritten) {
    const [canonRow] = await sql`
      SELECT country FROM scm.my_localities WHERE state = ${r.canon} LIMIT 1`;
    const coAnswer = r.country === "(null)" ? "Malaysia" : r.country;
    const soAnswer = canonRow?.country ?? "Malaysia";
    if (coAnswer !== soAnswer) clashes.push({ ...r, coAnswer, soAnswer });
  }

  note(`\n=== VERDICT ===`);
  if (clashes.length === 0) {
    note("  0 clash rows. Merging deriveCountryFromState cannot change any derived");
    note("  country against the data currently in the table.");
  } else {
    warn(`  ${clashes.length} CLASH ROW(S) — the twins disagree on these inputs:`);
    for (const c of clashes) {
      warn(`    state '${c.state}': CO(raw) -> ${c.coAnswer} | SO(canonical '${c.canon}') -> ${c.soAnswer}`);
    }
    warn("  #2242 must not merge until these are resolved. The SO's answer is the");
    warn("  correct one for a Malaysian state name, so suspect the DATA first.");
  }
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error(`probe failed to read the database: ${e.message}`);
    await sql.end();
    process.exit(1);
  });
