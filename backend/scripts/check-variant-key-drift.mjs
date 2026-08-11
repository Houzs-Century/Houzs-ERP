// Read-only measurement of the variant-key quote drift. Answers ONE question:
// if `norm()` in scm/shared/variant-key.ts started folding curly quotes to
// straight ones, how much stock would move, and would that CLOSE drift or
// CREATE it?
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW
//
// The answer lives only in production, and CLAUDE.md's standing rule is that the
// owner is not a database console. Actions already holds secrets.DATABASE_URL
// for the deploy, so the count runs there and nobody handles the credential.
//
// THE TRAP THIS IS MEASURING (docs/inventory-ledger-divergence-coe.md, and the
// 2026-08-05 handoff §2.2). Five sofa SKUs read NEGATIVE on-hand because goods
// were received under one variant key and shipped under another: a curly right
// quote (U+2019 / U+201D) where the other side used a straight inch mark.
// `norm` is `String(v).trim().toLowerCase()` — it touches no quote glyphs, so
// `24"` and `24”` are two different stock buckets.
//
// Normalising quotes inside `norm()` stops NEW drift. But the computed key
// changes for every existing value containing one, which MOVES stock into a
// different bucket — closing the old drift while potentially opening fresh
// drift against rows that are already correct. So: measure first, then decide
// whether the code change ships WITH a data migration or not at all. Do not
// ship the one-line norm() change on its own.
//
// WHAT IS REPORTED, per table carrying a variant_key column:
//   1. rows / distinct keys containing a curly quote  -> the blast radius
//   2. MERGE GROUPS: normalised keys that today map to MORE THAN ONE raw key
//      -> these are the buckets that would fuse. Each one is either a drift
//      being healed or a fusion being caused; they are indistinguishable from
//      the count alone, which is why the raw keys are printed.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — a red job would read as "the check broke", and the answer
// IS the output. Only an unreachable database or a query error exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

/* The glyphs `norm()` leaves alone. Straight `"` and `'` are the canonical
   forms the key builder already produces; these four are what arrives from a
   form, a paste out of Word, or an iOS keyboard with smart quotes on. */
const CURLY = ["‘", "’", "“", "”"];
const CURLY_CLASS = "[‘’“”]";

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  /* Discover the tables instead of hardcoding them — a new variant-keyed table
     must not silently fall out of this measurement. BASE TABLE only: the views
     re-expose the same rows and would double-count. */
  const targets = await pg`
    SELECT c.table_schema, c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.column_name = 'variant_key'
       AND t.table_type = 'BASE TABLE'
       AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY c.table_schema, c.table_name`;

  if (targets.length === 0) {
    notice("No BASE TABLE carries a variant_key column. Nothing to measure.");
    process.exit(0);
  }

  notice(`Scanning ${targets.length} variant-keyed table(s) for curly quotes ${CURLY.join(" ")}`);

  let totalAffectedRows = 0;
  let totalMergeGroups = 0;

  for (const { table_schema, table_name } of targets) {
    /* Schema and table are escaped as SEPARATE identifiers — passing
       "schema.table" as one string quotes the dot into the name and the query
       looks for a table literally called `scm.inventory_lots`. */
    const rel = pg`${pg(table_schema)}.${pg(table_name)}`;

    const [counts] = await pg`
      SELECT count(*)::int                       AS affected_rows,
             count(DISTINCT variant_key)::int    AS affected_keys
        FROM ${rel}
       WHERE variant_key ~ ${CURLY_CLASS}`;

    totalAffectedRows += counts.affected_rows;

    /* The merge analysis. `translate` is the exact fold a quote-normalising
       norm() would perform. A normalised key holding more than one raw key is a
       pair of buckets that would become one. */
    const merges = await pg`
      SELECT translate(variant_key, ${CURLY.join("")}, '''''""')  AS normalised,
             count(DISTINCT variant_key)::int                     AS raw_key_count,
             count(*)::int                                        AS rows,
             array_agg(DISTINCT variant_key)                      AS raw_keys
        FROM ${rel}
       WHERE variant_key IS NOT NULL AND variant_key <> ''
       GROUP BY 1
      HAVING count(DISTINCT variant_key) > 1
       ORDER BY 3 DESC
       LIMIT 50`;

    totalMergeGroups += merges.length;

    if (counts.affected_rows === 0 && merges.length === 0) {
      notice(`${table_schema}.${table_name}: clean — no curly quotes, no merge groups.`);
      continue;
    }

    notice(
      `${table_schema}.${table_name}: ${counts.affected_rows} row(s) across ` +
        `${counts.affected_keys} key(s) contain a curly quote; ` +
        `${merges.length} bucket(s) would MERGE.`,
    );
    for (const m of merges) {
      notice(`  merge -> ${m.normalised}  (${m.rows} rows, ${m.raw_key_count} raw keys)`);
      for (const k of m.raw_keys) notice(`      from: ${k}`);
    }
  }

  notice("");
  notice(
    totalAffectedRows === 0 && totalMergeGroups === 0
      ? "VERDICT: no curly quotes and no merge groups anywhere. A quote-folding " +
          "norm() would move NO existing stock — it can ship on its own as a " +
          "go-forward guard, with no data migration."
      : `VERDICT: ${totalAffectedRows} affected row(s), ${totalMergeGroups} merge ` +
          "group(s). Read each merge group above before changing norm(): a group " +
          "whose raw keys are the SAME attributes in two glyphs is drift being " +
          "healed; a group whose raw keys are genuinely different attributes is " +
          "stock about to be fused wrongly. The code change needs a data " +
          "migration covering exactly these groups — do not ship norm() alone.",
  );
} finally {
  await pg.end({ timeout: 5 });
}
