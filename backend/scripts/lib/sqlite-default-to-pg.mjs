// Translate a SQLite column DEFAULT (as returned by `PRAGMA table_info`.dflt_value)
// into a Postgres DEFAULT clause — or refuse, loudly.
//
// WHY THIS EXISTS AS ITS OWN MODULE
// ---------------------------------
// `scripts/load-d1-dump-to-pg.mjs` rebuilds every table from `PRAGMA table_info`.
// It read `dflt_value` and emitted nothing for it, so the D1 -> Supabase cutover
// carried across every constraint that makes an INSERT *fail* (NOT NULL) and
// dropped every one that makes it *succeed* (DEFAULT). That single omission
// caused four separate repair episodes over a month — see
// `docs/pg-migration-dropped-defaults-coe.md`:
//
//   1. 2026-06-13  `a370a614`  seed script patched, misdiagnosed as a seed bug
//   2. 2026-06-14  mig `0011`  sales_reps.is_admin / commission_min_rate NOT NULL
//                              with no default -> Sales Team + org chart 500'd
//   3. 2026-06-14  mig `0012`  the systematic sweep, 12 columns / 7 tables
//      2026-06-26  mig `0054`  is_active DEFAULT 1 on 4 more tables
//   4. 2026-07-13  mig `0098`  the SILENT variant, found a month later: 77
//                              nullable creation-stamp columns quietly writing
//                              NULL, surfacing as "-" in the ASSR Timeline
//
// The translation lives here rather than inline in the loader so it is a pure,
// dependency-free function with no side effects, and can therefore be exercised
// on its own (`scripts/check-sqlite-defaults.mjs`). Same reasoning, same shape,
// as `scripts/lib/split-sql.mjs`.
//
// THE RULE THIS MODULE IS BUILT AROUND
// ------------------------------------
// A wrong DEFAULT silently writes wrong data, which is strictly worse than the
// missing-DEFAULT bug it replaces: the missing one produced a 23502 or a visible
// NULL, both of which got noticed. So this function translates ONLY the forms it
// can translate with certainty and returns a skip + reason for everything else.
// The loader prints those reasons and counts them. "I don't know" is a supported
// answer here; guessing is not.
//
// ONE translation of SQLite date/time syntax, not two
// ---------------------------------------------------
// The app already owns that translation: `rewriteDialect()` in
// `src/db/d1-compat.ts` rewrites `datetime('now', ...)` / `date('now', ...)` for
// all ~685 D1-shim call sites. This module CALLS it rather than re-implementing
// it, so a fix to the date rules can never apply to queries and miss schema
// defaults. That import is why the loader must run under a Node that can execute
// TypeScript with transforms (see the throw below) — the alternative was a second
// copy of the rules, which is the thing that rots.

let rewriteDialect;
try {
  ({ rewriteDialect } = await import("../../src/db/d1-compat.ts"));
} catch (cause) {
  throw new Error(
    [
      "sqlite-default-to-pg.mjs could not load backend/src/db/d1-compat.ts.",
      "",
      "This module deliberately keeps NO copy of the SQLite -> Postgres date",
      "rules; it calls the app's own rewriteDialect() so the two cannot drift.",
      "Run node with TypeScript transforms enabled, from backend/:",
      "",
      "  node --experimental-transform-types scripts/load-d1-dump-to-pg.mjs",
      "",
      "Node 22.7+ / 24. Plain strip-only type stripping is NOT enough: it",
      "rejects d1-compat.ts's constructor parameter properties.",
      "",
      `Original error: ${cause?.message ?? cause}`,
    ].join("\n"),
    { cause },
  );
}

// A bare numeric literal: 0, 1, -1.5, 1e3. SQLite and Postgres agree on all of
// these, so they pass through unchanged into a numeric column.
const NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
// SQLite accepts hex integer literals (0x10). Postgres only learned them in 16,
// and the target here is Supabase, so convert to decimal rather than gamble.
const HEX_LITERAL = /^0[xX][0-9a-fA-F]+$/;
// A complete single-quoted SQL string literal, '' being the escaped quote.
// Anchored, so 'a' || 'b' does NOT match and falls through to the skip path.
const STRING_LITERAL = /^'(?:[^']|'')*'$/;
// datetime('now' [, 'modifier'...]) / date('now' [, 'modifier'...]) and NOTHING
// else — every argument must be a plain string literal. This is what rejects the
// dynamic form `datetime('now', '-' || ? || ' hours')` before it reaches
// rewriteDialect, which would silently drop the offset.
const NOW_CALL =
  /^(datetime|date)\s*\(\s*'now'\s*((?:,\s*'(?:[^']|'')*'\s*)*)\)$/i;

/** Postgres text literal from a raw JS string. */
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

const carried = (clause) => ({ clause, reason: null });
const skipped = (reason) => ({ clause: null, reason });

/**
 * Drop redundant wrapping parentheses. SQLite's pragma normally strips the ones
 * from `DEFAULT (datetime('now'))` already, but `DEFAULT ((0))` and older
 * sqlite builds do not, and an unstripped wrapper would fail every literal test
 * below and be skipped for no reason.
 */
function stripOuterParens(s) {
  let out = s.trim();
  for (;;) {
    if (!out.startsWith("(") || !out.endsWith(")")) return out;
    let depth = 0;
    let inStr = false;
    let wrapsWhole = true;
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (c === "'") {
        if (inStr && out[i + 1] === "'") {
          i++;
          continue;
        }
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        // Closed the leading "(" before the end -> the parens are part of an
        // expression like (a)+(b), not a wrapper.
        if (depth === 0 && i !== out.length - 1) {
          wrapsWhole = false;
          break;
        }
      }
    }
    if (!wrapsWhole || depth !== 0) return out;
    out = out.slice(1, -1).trim();
  }
}

/**
 * Translate a SQLite "now" expression through the app's rewriteDialect(), then
 * refuse the result unless it is provably complete.
 *
 * rewriteDialect is lenient by design — it is a best-effort rewriter for query
 * text, and an unrecognised date modifier is simply not emitted (see the last
 * case in scripts/test-dialect.ts: "dynamic — will drop offset, flag it"). That
 * is tolerable for a WHERE clause a human is reading; it is NOT tolerable for a
 * column default, where a dropped `-30 days` would stamp every future row with
 * the wrong value forever. So the output is gated on three checks before it is
 * accepted, and skipped with a reason otherwise.
 */
function nowExpressionDefault(expr, pgType) {
  if (pgType !== "text") {
    return skipped(
      `SQLite date/time default on a ${pgType} column — the loader stores stamps as text, so the translation would change the column's meaning`,
    );
  }
  const m = expr.match(NOW_CALL);
  if (!m) return skipped(`unsupported date/time default expression \`${expr}\``);

  const modifiers = (m[2].match(/'(?:[^']|'')*'/g) || []).length;
  const out = rewriteDialect(expr);

  // (1) nothing SQLite-shaped may survive into the DDL
  if (/\b(?:datetime|date|strftime|julianday)\s*\(/i.test(out) || out.includes("'now'")) {
    return skipped(
      `rewriteDialect left SQLite syntax in its output \`${out}\` — not carried`,
    );
  }
  // (2) every modifier must have produced an interval; a missing one means
  //     rewriteDialect did not understand it and dropped it silently
  const intervals = (out.match(/interval '/g) || []).length;
  if (intervals !== modifiers) {
    return skipped(
      `rewriteDialect turned ${intervals} of ${modifiers} date modifier(s) into intervals — the remainder would be silently dropped`,
    );
  }
  // (3) a translation that produced nothing is not a translation
  if (!out.trim() || out.trim() === expr.trim()) {
    return skipped(`rewriteDialect returned the input unchanged for \`${expr}\``);
  }
  return carried(`default ${out}`);
}

/**
 * @param {string} rawDefault  PRAGMA table_info.dflt_value, exactly as SQLite
 *                             returned it. Callers must not pass null/undefined
 *                             — "no default" is not this function's business.
 * @param {string} pgType      The Postgres type the loader chose for the column
 *                             ("text" | "bigint" | "double precision" | "bytea").
 * @returns {{clause: string|null, reason: string|null}}
 *          `clause` is a ready-to-append `default ...` fragment, or null with a
 *          human-readable `reason` the caller MUST surface.
 */
export function sqliteDefaultToPg(rawDefault, pgType) {
  if (rawDefault === null || rawDefault === undefined) {
    return skipped("called with no default value (caller bug)");
  }
  const expr = stripOuterParens(String(rawDefault));
  const isText = pgType === "text";
  const isNumeric = pgType === "bigint" || pgType === "double precision";

  if (expr === "") return skipped("empty default expression");

  // NULL — explicit, and a no-op in Postgres, but carried so the emitted DDL
  // says exactly what the source schema said.
  if (/^null$/i.test(expr)) return carried("default null");

  // SQLite has no boolean type: TRUE/FALSE are literal 1/0 and land in an
  // INTEGER (-> bigint) column. mapType() never produces a Postgres boolean, so
  // there is no boolean target to translate to.
  if (/^(?:true|false)$/i.test(expr)) {
    const asInt = /^true$/i.test(expr) ? "1" : "0";
    if (isNumeric) return carried(`default ${asInt}`);
    if (isText) return carried(`default ${quote(asInt)}`);
    return skipped(`boolean default on a ${pgType} column`);
  }

  if (NUMERIC_LITERAL.test(expr)) {
    if (isNumeric) return carried(`default ${expr}`);
    // Postgres will NOT coerce an integer literal into a text column's default
    // ("column is of type text but default expression is of type integer"), and
    // SQLite's text affinity would have stored '0' anyway. Quote it.
    if (isText) return carried(`default ${quote(expr)}`);
    return skipped(`numeric default on a ${pgType} column`);
  }

  if (HEX_LITERAL.test(expr)) {
    const asDecimal = BigInt(expr).toString();
    if (isNumeric) return carried(`default ${asDecimal}`);
    if (isText) return carried(`default ${quote(asDecimal)}`);
    return skipped(`hex default on a ${pgType} column`);
  }

  if (STRING_LITERAL.test(expr)) {
    // Already SQL-escaped and quote-compatible: Postgres runs with
    // standard_conforming_strings on, so backslashes are literal in both.
    if (isText) return carried(`default ${expr}`);
    if (isNumeric) {
      const inner = expr.slice(1, -1).replace(/''/g, "'");
      if (NUMERIC_LITERAL.test(inner)) return carried(`default ${inner}`);
      return skipped(
        `non-numeric string default ${expr} on a ${pgType} column — SQLite would coerce it, Postgres will not`,
      );
    }
    return skipped(`string default on a ${pgType} column`);
  }

  // SQLite's CURRENT_TIMESTAMP / CURRENT_DATE are exactly datetime('now') and
  // date('now') (UTC, 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD'), so they are routed
  // through the SAME rewriteDialect call rather than getting their own rule.
  if (/^current_timestamp$/i.test(expr)) {
    return nowExpressionDefault("datetime('now')", pgType);
  }
  if (/^current_date$/i.test(expr)) {
    return nowExpressionDefault("date('now')", pgType);
  }
  // CURRENT_TIME ('HH:MM:SS') has no rewriteDialect rule, and inventing one here
  // would be the second translation this module exists to avoid. It appears
  // nowhere in the D1 schema; if it ever does, add time('now') to rewriteDialect.
  if (/^current_time$/i.test(expr)) {
    return skipped(
      "CURRENT_TIME has no rewriteDialect rule — add time('now') support to src/db/d1-compat.ts rather than translating it here",
    );
  }

  if (NOW_CALL.test(expr)) return nowExpressionDefault(expr, pgType);

  // strftime(fmt, 'now') — the ISO-stamp form, e.g. client_errors.created_at's
  // `strftime('%Y-%m-%dT%H:%M:%SZ','now')`. rewriteDialect DOES handle strftime,
  // and gets the format string exactly right, but it renders the value argument
  // as `('now')::timestamptz`. Postgres documents that the special literal 'now'
  // is resolved WHEN THE LITERAL IS READ and warns against using it in a column
  // default for precisely this reason: the default would freeze at the moment
  // CREATE TABLE ran and stamp every future row with the load's timestamp. That
  // is a silently-wrong default, which is worse than no default, so it is
  // refused here rather than translated.
  if (/^strftime\s*\(/i.test(expr)) {
    return skipped(
      "strftime() default — rewriteDialect renders SQLite's 'now' as ('now')::timestamptz, and Postgres resolves that literal when it is read, so the default would freeze at CREATE TABLE time and stamp every row with the load's timestamp. Restore this column with an explicit ALTER (see src/db/migrations-pg/0098_restore_timestamp_defaults.sql) or teach src/db/d1-compat.ts a strftime(fmt,'now') rule",
    );
  }

  // Anything else: another SQLite function, a column reference, a concatenation,
  // a blob literal, a CASE. Not guessed at.
  return skipped(`unrecognised default expression \`${expr}\``);
}

// Exported for the checker only.
export const __internals = { stripOuterParens, NOW_CALL };
