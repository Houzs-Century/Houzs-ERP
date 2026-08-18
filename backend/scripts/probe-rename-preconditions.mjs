#!/usr/bin/env node
/* Pre-flight for the Processing Date's name unification, read against the LIVE
   catalog. Writes nothing (the whole run is one READ ONLY transaction).

   SECTIONS A-E are migration 0284's pre-conditions and are what the MATCHES /
   DIFFERS verdict scores. SECTION F was added 2026-08-18 by the sweep that
   collapsed the remaining names, and asks the questions the NEXT removals need
   answered — target_date's live writers, the two surviving aliases' queues. F is
   printed and never scored, so a red run still means exactly one thing.

   WHY THIS EXISTS. 0284 renames scm.mfg_sales_orders.internal_expected_dd ->
   processing_date, the same on the consignment twin, sweeps every dependent
   view, and rewrites a stored jsonb key. Every one of those steps was verified
   against a PGlite replica BUILT FROM THIS REPO'S OWN SQL — which proves the
   migration is consistent with the source tree, and proves nothing at all about
   production. Prod is nine years of hand-applied history, two companies, a
   Supabase role set and a Hyperdrive role that "appears nowhere in this repo"
   (0191's words). The replica is a model of prod, not a copy of it.

   The failure this closes is specific and quiet. 0284 is guarded on the catalog
   at every step, which is what makes it idempotent — and also what makes it
   able to do NOTHING and still exit 0. If prod's consignment twin does not
   carry both names, step 1's collision guard simply does not fire; if a view
   lives outside the scm schema, the sweep does not reach it and the
   post-condition does not look for it. We want to know that BEFORE the window,
   not from a 500 during it.

   WHAT IT ASKS, and what 0284 expects the answer to be:

     A  scm.mfg_sales_orders             internal_expected_dd present,
                                         processing_date absent (0189 dropped it)
     B  scm.consignment_sales_orders     BOTH names present, and the legacy
                                         processing_date entirely NULL — step 1
                                         DROPs it, so a non-NULL value there is
                                         data about to be deleted
     C  every view / matview over either table, with owner and grants — 0189 ->
        0190 -> 0191 was a three-migration prod incident about exactly this ACL,
        and 0284's claim is that a RENAME (unlike a DROP+CREATE) keeps it. This
        prints the before picture the after can be diffed against.
     D  every OTHER dependent: indexes, constraints, triggers, generated
        columns, RLS policies, publications, and functions whose BODY names the
        column. Indexes/constraints/policies follow a rename by attnum. A
        function body is TEXT and does not.
     E  the two jsonb rewrites, counted: so_amendments.header_changes /
        old_header_snapshot and mfg_so_audit_log.field_changes carrying
        'internalExpectedDd' — including the rows whose SHAPE would make 0284
        skip them and then RAISE on its own post-condition.

   Read the last line. MATCHES = the replica told the truth, proceed. DIFFERS =
   something in prod is not what 0284 assumes; the body says which check.

   Exit codes: 0 MATCHES, 1 DIFFERS, 2 the probe itself could not read.

   Usage:  DATABASE_URL=... node scripts/probe-rename-preconditions.mjs
*/
import postgres from "postgres";
import {
  SO_HEADER_LEGACY_PAYLOAD_KEYS,
  SO_PROCESSING_DATE_COLUMN,
  SO_PROCESSING_DATE_LEGACY_COLUMNS,
  SO_PROCESSING_DATE_PAYLOAD_KEY,
} from "./lib/so-processing-date.mjs";

const MIGRATION = "0284_scm_processing_date_one_name.sql";
/* This probe is the ONE place entitled to say both spellings, because saying
   both IS its job — it reads the live catalog and compares. It still does not
   TYPE either: both come from lib/so-processing-date.mjs, which is where the
   retired name is recorded, so a future rename moves this comparison with it
   instead of leaving it comparing two names the database has never heard of. */
const [OLD_COL] = SO_PROCESSING_DATE_LEGACY_COLUMNS;
const NEW_COL = SO_PROCESSING_DATE_COLUMN;
const [OLD_KEY] = Object.keys(SO_HEADER_LEGACY_PAYLOAD_KEYS);
const NEW_KEY = SO_PROCESSING_DATE_PAYLOAD_KEY;
const BASE_TABLES = ["mfg_sales_orders", "consignment_sales_orders"];
/* 0191 copied the payment-totals view's grant set off this never-dropped
   sibling, because it is the only surviving record of what the grantee list was
   before 0189 recreated the view. Printing it alongside is how "the grants are
   right" becomes checkable instead of assertable. */
const GRANT_SIBLING = "suppliers_with_derived_category";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting (this probe reads prod, it cannot guess).");
  process.exit(2);
}

const say = (s = "") => console.log(s);

/* Every check appends here. The verdict is `checks.every(c => c.ok)` and
   nothing else, so the last line cannot drift away from the body above it. */
const checks = [];
const W = [50, 32, 38];
/* Truncates as well as pads. A label one character too long silently shoves the
   two comparison columns out of alignment, and a side-by-side that does not line
   up is the one thing this report cannot afford. */
const pad = (s, n) => {
  const t = String(s);
  if (t.length > n - 1) return t.slice(0, n - 2) + "… ";
  return t + " ".repeat(n - t.length);
};
function head() {
  say(`  ${pad("CHECK", W[0])}${pad("0284 EXPECTS", W[1])}${pad("PROD SAYS", W[2])}`);
  say(`  ${"-".repeat(W[0] + W[1] + W[2] + 8)}`);
}
function check(label, expect, actual, ok) {
  checks.push({ label, expect, actual, ok });
  say(`  ${pad(label, W[0])}${pad(expect, W[1])}${pad(actual, W[2])}${ok ? "OK" : "DIFFERS"}`);
}
/* Information the migration does not branch on — row counts, grant listings.
   Printed, never scored, so the verdict stays a statement about assumptions. */
const info = (s) => say(`      ${s}`);

/* Redact before printing: this string carries the prod password. */
function describeTarget(raw) {
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || 5432}${u.pathname} (user ${u.username || "?"})`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/* Prod is Supabase and must be TLS. The loopback exception is the repo's
   existing pattern (align-fabric-trackings.mjs and three siblings) and is what
   lets this script be run end-to-end against a local replica before it is
   pointed at prod — a probe nobody has executed is not a pre-flight. */
const sql = postgres(url, {
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
  prepare: false,
  max: 1,
});

/* Column names as SQL TEXT. postgres.js binds a bare `${string}` as a
   parameter, so `count(${OLD_COL})` would send `count($1)` and count a
   constant, not a column. Everywhere the two names are compared as VALUES
   (`a.attname = ${OLD_COL}`) the parameter is exactly right and is left alone. */
const OLD_FRAG = sql.unsafe(OLD_COL);
const NEW_FRAG = sql.unsafe(NEW_COL);

async function main() {
  say(`=== 0284 rename pre-flight — LIVE catalog vs what the migration expects ===`);
  say(`migration : ${MIGRATION}`);
  say(`target    : ${describeTarget(url)}`);
  say(`read at   : ${new Date().toISOString()}`);
  say(`mode      : READ ONLY transaction — this probe writes nothing`);
  say("");

  await sql.begin(async (q) => {
    /* Not decoration. A pre-flight that can write is a pre-flight nobody is
       allowed to run in the window it exists for. SET TRANSACTION READ ONLY is
       transaction-scoped, so it survives a transaction-pooling pgbouncer in a
       way a session-level GUC would not. */
    await q`SET TRANSACTION READ ONLY`;

    // ── 0. Has 0284 already landed? ─────────────────────────────────────────
    say(`--- 0. migration tracker ---------------------------------------------------`);
    const [tracker] = await q`SELECT to_regclass('_pg_migrations') IS NOT NULL AS present`;
    let applied = null;
    if (tracker.present) {
      const rows = await q`
        SELECT filename, applied_at FROM _pg_migrations
        WHERE filename LIKE '0284%' OR filename LIKE '0285%' ORDER BY filename`;
      applied = rows.find((r) => r.filename === MIGRATION) || null;
      if (rows.length === 0) info("no 0284/0285 rows in _pg_migrations");
      for (const r of rows) info(`applied  ${r.filename}  at ${r.applied_at?.toISOString?.() ?? r.applied_at}`);
    } else {
      info("_pg_migrations does not exist on this database");
    }
    say("");
    if (applied) {
      say(`  !! ${MIGRATION} is ALREADY APPLIED here. Everything below reads the`);
      say(`     world AFTER the rename, so the "0284 EXPECTS" column describes a`);
      say(`     pre-condition that is no longer meant to hold. This is a post-mortem,`);
      say(`     not a pre-flight.`);
      say("");
    }

    // ── A/B. The two base tables ────────────────────────────────────────────
    say(`--- A/B. base tables -------------------------------------------------------`);
    head();

    const cols = await q`
      SELECT c.relname, c.relkind, a.attname,
             format_type(a.atttypid, a.atttypmod) AS typ,
             a.attnum, a.attnotnull, a.attgenerated,
             pg_get_expr(d.adbin, d.adrelid) AS dflt
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'scm'
        AND c.relname = ANY(${BASE_TABLES})
        AND a.attname = ANY(${[OLD_COL, NEW_COL]})
      ORDER BY c.relname, a.attnum`;
    const rels = await q`
      SELECT c.relname, c.relkind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'scm' AND c.relname = ANY(${BASE_TABLES})`;
    const has = (t, cname) => cols.some((r) => r.relname === t && r.attname === cname);
    const colOf = (t, cname) => cols.find((r) => r.relname === t && r.attname === cname);
    const tableExists = (t) => rels.some((r) => r.relname === t);

    // A. mfg_sales_orders — step 2 renames it; step 5 RAISEs if it is not there after.
    check(
      "scm.mfg_sales_orders exists",
      "yes",
      tableExists("mfg_sales_orders") ? "yes" : "NO",
      tableExists("mfg_sales_orders"),
    );
    check(
      `  .${OLD_COL}`,
      "present",
      has("mfg_sales_orders", OLD_COL) ? `present (${colOf("mfg_sales_orders", OLD_COL).typ})` : "ABSENT",
      has("mfg_sales_orders", OLD_COL),
    );
    /* 0189 dropped this one. If it came back, step 2's NOT EXISTS guard makes
       the rename a silent no-op and step 5 then passes anyway, because a column
       called processing_date does exist — the wrong one. */
    check(
      `  .${NEW_COL} (0189 dropped it)`,
      "absent",
      has("mfg_sales_orders", NEW_COL) ? "PRESENT — rename would no-op" : "absent",
      !has("mfg_sales_orders", NEW_COL),
    );

    // B. consignment twin — the collision 0284 exists to clear.
    const coExists = tableExists("consignment_sales_orders");
    /* 0083 says the table is not guaranteed in every environment and every step
       of 0284 guards on to_regclass — so its absence would not FAIL the
       migration. It is still scored DIFFERS: prod runs the Consignment module,
       so "not there" would mean the consignment half of the rename silently did
       nothing and nobody would learn that from the migration's own output. */
    check(
      "scm.consignment_sales_orders exists",
      "yes (prod runs the module)",
      coExists ? "yes" : "no — whole CO half no-ops",
      coExists,
    );
    if (coExists) {
      check(
        `  .${OLD_COL} (the live one)`,
        "present",
        has("consignment_sales_orders", OLD_COL) ? "present" : "ABSENT",
        has("consignment_sales_orders", OLD_COL),
      );
      /* THE ONE THE TASK IS ABOUT. Step 1 drops the dead legacy column only
         while BOTH names are present. Absent here, step 1 is a no-op — which is
         harmless — but the interesting direction is the other one: if it is
         present and NOT dead, step 1 deletes live data. */
      check(
        `  .${NEW_COL} (dead legacy, mig 0153)`,
        "present — step 1 DROPs it",
        has("consignment_sales_orders", NEW_COL) ? "present" : "ABSENT — step 1 no-ops",
        has("consignment_sales_orders", NEW_COL),
      );
      if (!has("consignment_sales_orders", OLD_COL) && !has("consignment_sales_orders", NEW_COL)) {
        say(`      ^^ NEITHER name present: step 5's second post-condition RAISEs and`);
        say(`         rolls the ENTIRE migration back, including the mfg rename.`);
      }
    } else {
      info("skipping the consignment checks — to_regclass is NULL, every step guards on it");
    }
    say("");

    // The data behind those columns. A DROP of a column that is not empty is
    // not a cleanup.
    say(`--- B'. is the legacy consignment column actually dead? --------------------`);
    /* EVERY count below names only columns the catalog above proved are there.
       Counting one that is not is 42703, which fails the whole statement and
       aborts the READ ONLY transaction — so this probe would exit 2 ("could not
       read") on a database it can read perfectly well, and say nothing about
       the pre-conditions it exists to report. That is not hypothetical: once
       0284/0286 have landed, the LEGACY name is the one that is gone. */
    const coHasOld = coExists && has("consignment_sales_orders", OLD_COL);
    const coHasNew = coExists && has("consignment_sales_orders", NEW_COL);
    if (coHasOld && coHasNew) {
      const [n] = await q`
        SELECT count(*)::int AS total,
               count(${NEW_FRAG})::int AS legacy_set,
               count(${OLD_FRAG})::int AS live_set
        FROM scm.consignment_sales_orders`;
      info(`consignment rows: ${n.total}`);
      const w = Math.max(OLD_COL.length, NEW_COL.length);
      info(`  ${OLD_COL.padEnd(w)} non-NULL (the live date, kept):   ${n.live_set}`);
      info(`  ${NEW_COL.padEnd(w)} non-NULL (the dead one, DROPPED): ${n.legacy_set}`);
      check(
        "  legacy consignment values to be destroyed",
        "0 rows",
        `${n.legacy_set} row(s)`,
        n.legacy_set === 0,
      );
    } else if (coHasNew) {
      /* Not scored. Step 1 drops the legacy column only while BOTH names are
         present, so with one name there is nothing for it to destroy and no
         pre-condition left to hold — and a check invented here to pass would be
         evidence about a question this database can no longer be asked. */
      const [n] = await q`
        SELECT count(*)::int AS total, count(${NEW_FRAG})::int AS set_n
        FROM scm.consignment_sales_orders`;
      info(`only ${NEW_COL} is present, so the rename has already run here.`);
      info(`consignment rows: ${n.total}, ${n.set_n} carrying a Processing Date (counted on ${NEW_COL})`);
    } else {
      info("n/a — no legacy column to drop");
    }
    /* Same rule: report the column that IS there, and NAME which one was
       counted. Guarding on OLD_COL alone printed nothing at all after the
       rename, which reads as "no rows" rather than "asked the wrong name". */
    const mfgCol = !tableExists("mfg_sales_orders")
      ? null
      : has("mfg_sales_orders", OLD_COL) ? OLD_COL
      : has("mfg_sales_orders", NEW_COL) ? NEW_COL
      : null;
    if (mfgCol) {
      const [m] = await q`
        SELECT count(*)::int AS total, count(${sql.unsafe(mfgCol)})::int AS set_n
        FROM scm.mfg_sales_orders`;
      info(`mfg_sales_orders rows: ${m.total}, ${m.set_n} carrying a Processing Date (counted on ${mfgCol}, renamed not touched)`);
    } else if (tableExists("mfg_sales_orders")) {
      info(`mfg_sales_orders carries NEITHER ${OLD_COL} nor ${NEW_COL} — there is no Processing Date on it to count`);
    }
    say("");

    // ── C. Views and materialised views ─────────────────────────────────────
    say(`--- C. views / matviews over either table ----------------------------------`);

    /* Two lenses, deliberately. The sweep in step 3 targets ANY scm view with a
       COLUMN NAMED internal_expected_dd — it does not care what the view reads.
       The risk it cannot see is a view that reads the column under a different
       output name, or one that lives in another schema. So ask the catalog both
       ways and print the union. */
    const byName = await q`
      SELECT c.oid::int AS oid, n.nspname, c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind IN ('v','m') AND a.attname = ${OLD_COL}
      ORDER BY n.nspname, c.relname`;

    const byDep = await q`
      SELECT DISTINCT dep.oid::int AS oid, dn.nspname, dep.relname, dep.relkind,
             src.relname AS base_table, a.attname AS base_col
      FROM pg_depend d
      JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
      JOIN pg_class dep ON dep.oid = r.ev_class
      JOIN pg_namespace dn ON dn.oid = dep.relnamespace
      JOIN pg_class src ON src.oid = d.refobjid
      JOIN pg_namespace sn ON sn.oid = src.relnamespace
      JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = d.refobjsubid
      WHERE d.refclassid = 'pg_class'::regclass
        AND sn.nspname = 'scm'
        AND src.relname = ANY(${BASE_TABLES})
        AND a.attname = ANY(${[OLD_COL, NEW_COL]})
        AND dep.oid <> src.oid
      ORDER BY dn.nspname, dep.relname`;

    const viewOids = [...new Set([...byName.map((r) => r.oid), ...byDep.map((r) => r.oid)])];
    const aclRows = viewOids.length
      ? await q`
        SELECT c.oid::int AS oid, n.nspname, c.relname, c.relkind,
               pg_get_userbyid(c.relowner) AS owner,
               CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
               acl.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN LATERAL aclexplode(c.relacl) AS acl ON true
        WHERE c.oid::int = ANY(${viewOids})
        ORDER BY n.nspname, c.relname, grantee, acl.privilege_type`
      : [];
    const grantsFor = (oid) => {
      const byGrantee = new Map();
      let owner = "?";
      for (const r of aclRows.filter((x) => x.oid === oid)) {
        owner = r.owner;
        if (!r.grantee) continue;
        if (!byGrantee.has(r.grantee)) byGrantee.set(r.grantee, []);
        byGrantee.get(r.grantee).push(r.privilege_type);
      }
      const parts = [...byGrantee.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([g, p]) => `${g}=${p.sort().join(",")}`);
      return { owner, grants: parts.length ? parts.join("  ") : "(no explicit ACL — owner only)" };
    };

    if (viewOids.length === 0) {
      info("no view or materialised view anywhere reads or projects the column");
    }
    for (const oid of viewOids) {
      const named = byName.find((r) => r.oid === oid);
      const dep = byDep.find((r) => r.oid === oid);
      const meta = named || dep;
      /* Named from relkind, not assumed: a plain TABLE can carry a rewrite rule
         and would otherwise be printed as a "view" the sweep never touches. */
      const kind = meta.relkind === "m" ? "MATVIEW" : meta.relkind === "v" ? "view" : `relkind ${meta.relkind}`;
      const { owner, grants } = grantsFor(oid);
      const swept = meta.nspname === "scm" && !!named;
      say(`  ${meta.nspname}.${meta.relname}  [${kind}]`);
      info(`owner  : ${owner}`);
      info(`grants : ${grants}`);
      info(
        `column : ${named ? `projects a column literally named ${OLD_COL}` : `reads the base column but projects it under another name`}`,
      );
      if (dep) info(`reads  : scm.${dep.base_table}.${dep.base_col}`);
      info(
        `step 3 : ${
          swept
            ? "SWEPT — ALTER " + (meta.relkind === "m" ? "MATERIALIZED VIEW" : "VIEW") + " RENAME COLUMN"
            : meta.nspname !== "scm"
              ? "NOT SWEPT — the sweep filters nspname='scm', and so does step 5's leftover scan"
              : "not swept, and does not need to be — no column of that name to rename"
        }`,
      );
    }

    /* Step 3's sweep and step 5's leftover scan are both scm-only. Anything
       outside it is renamed by nobody and noticed by nobody. */
    const outsideScm = byName.filter((r) => r.nspname !== "scm");
    check(
      `views projecting ${OLD_COL} outside schema scm`,
      "none (sweep is scm-only)",
      outsideScm.length ? outsideScm.map((r) => `${r.nspname}.${r.relname}`).join(", ") : "none",
      outsideScm.length === 0,
    );

    /* The named view is the one 0189/0190/0191 was about, and step 5 asserts on
       it by name. If prod does not have it, step 5's third post-condition is
       skipped (guarded on to_regclass) and the sweep has nothing to prove. */
    const pt = byName.find((r) => r.nspname === "scm" && r.relname === "mfg_sales_orders_with_payment_totals");
    check(
      "scm.mfg_sales_orders_with_payment_totals",
      `projects ${OLD_COL}`,
      pt ? `projects ${OLD_COL}` : "NOT FOUND projecting it",
      !!pt,
    );

    // The grant reference 0191 used. Same owner + same SELECT grantees is the
    // "the ACL is intact" statement, and it is only meaningful printed together.
    const sibling = await q`
      SELECT c.oid::int AS oid, pg_get_userbyid(c.relowner) AS owner,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
             acl.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN LATERAL aclexplode(c.relacl) AS acl ON true
      WHERE n.nspname = 'scm' AND c.relname = ${GRANT_SIBLING}
      ORDER BY grantee, acl.privilege_type`;
    say("");
    say(`  grant reference — scm.${GRANT_SIBLING} (0191 copied its ACL onto the view above)`);
    if (sibling.length === 0) {
      info("NOT FOUND — 0191's reference object is gone; there is nothing left to compare against");
    } else {
      const sg = new Map();
      for (const r of sibling) {
        if (!r.grantee) continue;
        if (!sg.has(r.grantee)) sg.set(r.grantee, []);
        sg.get(r.grantee).push(r.privilege_type);
      }
      info(`owner  : ${sibling[0].owner}`);
      info(
        `grants : ${
          [...sg.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, p]) => `${g}=${p.sort().join(",")}`).join("  ") ||
          "(no explicit ACL — owner only)"
        }`,
      );
      const sibSelect = new Set([...sg.entries()].filter(([, p]) => p.includes("SELECT")).map(([g]) => g));
      if (pt) {
        const ptSelect = new Set(
          aclRows.filter((r) => r.oid === pt.oid && r.privilege_type === "SELECT").map((r) => r.grantee),
        );
        const missing = [...sibSelect].filter((g) => !ptSelect.has(g));
        check(
          "  view's SELECT grantees vs 0191's sibling",
          "identical",
          missing.length ? `missing ${missing.join(", ")}` : "identical",
          missing.length === 0,
        );
      }
    }
    say("");

    // ── D. Everything else that depends on the column ───────────────────────
    say(`--- D. other dependents ----------------------------------------------------`);

    const idx = await q`
      SELECT ic.relname AS index_name, tc.relname AS table_name, i.indisunique, i.indisprimary,
             pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_class tc ON tc.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = tc.relnamespace
      JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attname = ANY(${[OLD_COL, NEW_COL]})
      WHERE n.nspname = 'scm' AND tc.relname = ANY(${BASE_TABLES})
        AND a.attnum = ANY(i.indkey::smallint[])
      ORDER BY tc.relname, ic.relname`;
    info(`indexes on the column: ${idx.length}`);
    for (const r of idx) info(`  ${r.table_name}: ${r.index_name}${r.indisprimary ? " [PK]" : r.indisunique ? " [UNIQUE]" : ""}`);
    info("  (an index follows a column rename by attnum; 0284 leaves the index NAME alone on purpose)");

    const cons = await q`
      SELECT co.conname, co.contype, tc.relname AS table_name, pg_get_constraintdef(co.oid) AS def
      FROM pg_constraint co
      JOIN pg_class tc ON tc.oid = co.conrelid
      JOIN pg_namespace n ON n.oid = tc.relnamespace
      WHERE n.nspname = 'scm' AND tc.relname = ANY(${BASE_TABLES})
        AND (
          EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = tc.oid AND a.attname = ANY(${[OLD_COL, NEW_COL]})
              AND a.attnum = ANY(co.conkey)
          )
          OR pg_get_constraintdef(co.oid) ILIKE ${"%" + OLD_COL + "%"}
        )
      ORDER BY tc.relname, co.conname`;
    info(`constraints naming the column: ${cons.length}`);
    for (const r of cons) info(`  ${r.table_name}: ${r.conname} [${r.contype}] ${r.def}`);

    const trig = await q`
      SELECT t.tgname, tc.relname AS table_name, p.proname, tn.nspname AS fn_schema,
             t.tgattr::int[] AS cols
      FROM pg_trigger t
      JOIN pg_class tc ON tc.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = tc.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace tn ON tn.oid = p.pronamespace
      WHERE n.nspname = 'scm' AND tc.relname = ANY(${BASE_TABLES}) AND NOT t.tgisinternal
      ORDER BY tc.relname, t.tgname`;
    info(`triggers on the two tables: ${trig.length}`);
    for (const r of trig) info(`  ${r.table_name}: ${r.tgname} -> ${r.fn_schema}.${r.proname}${r.cols?.length ? ` UPDATE OF attnum ${r.cols.join(",")}` : ""}`);

    const gen = await q`
      SELECT tc.relname AS table_name, a.attname, pg_get_expr(d.adbin, d.adrelid) AS expr
      FROM pg_attribute a
      JOIN pg_class tc ON tc.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = tc.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = tc.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'scm' AND tc.relname = ANY(${BASE_TABLES})
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> ''
      ORDER BY tc.relname, a.attnum`;
    info(`generated columns on the two tables: ${gen.length}`);
    for (const r of gen) info(`  ${r.table_name}.${r.attname} := ${r.expr}`);

    const pol = await q`
      SELECT tc.relname AS table_name, pol.polname, tc.relrowsecurity,
             pg_get_expr(pol.polqual, pol.polrelid) AS qual,
             pg_get_expr(pol.polwithcheck, pol.polrelid) AS withcheck
      FROM pg_policy pol
      JOIN pg_class tc ON tc.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = tc.relnamespace
      WHERE n.nspname = 'scm' AND tc.relname = ANY(${BASE_TABLES})
      ORDER BY tc.relname, pol.polname`;
    const rlsOn = await q`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'scm' AND c.relname = ANY(${BASE_TABLES})`;
    for (const r of rlsOn) info(`RLS on ${r.relname}: ${r.relrowsecurity ? "ENABLED" : "disabled"}${r.relforcerowsecurity ? " (forced)" : ""}`);
    info(`policies on the two tables: ${pol.length}`);
    for (const r of pol) {
      const names = `${r.qual || ""} ${r.withcheck || ""}`;
      info(`  ${r.table_name}: ${r.polname}${names.includes(OLD_COL) ? "  <- names the column" : ""}`);
      if (names.includes(OLD_COL)) info(`     ${r.qual || ""} ${r.withcheck || ""}`);
    }

    /* Logical replication column lists (Supabase realtime lives here). PG15+. */
    let pubs = [];
    try {
      pubs = await q`
        SELECT p.pubname, c.relname
        FROM pg_publication_rel pr
        JOIN pg_publication p ON p.oid = pr.prpubid
        JOIN pg_class c ON c.oid = pr.prrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'scm' AND c.relname = ANY(${BASE_TABLES})
        ORDER BY p.pubname, c.relname`;
    } catch {
      pubs = [];
    }
    info(`publications covering the two tables: ${pubs.length}`);
    for (const r of pubs) info(`  ${r.pubname} -> ${r.relname}`);

    /* THE ONE THAT DOES NOT FOLLOW A RENAME. A view's rewrite rule and a
       policy's qual are parse trees stored by attnum; a function body is a
       string. 0284's note claims scm.apply_so_header_cas is safe because it
       builds its SET list from pg_attribute at call time — this is where that
       claim is either confirmed or contradicted, by the live body. */
    const fns = await q`
      SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
             (p.prosrc ILIKE ${"%" + OLD_COL + "%"}) AS names_col,
             (p.prosrc ILIKE ${"%" + OLD_KEY + "%"}) AS names_key
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND (p.prosrc ILIKE ${"%" + OLD_COL + "%"} OR p.prosrc ILIKE ${"%" + OLD_KEY + "%"})
      ORDER BY n.nspname, p.proname`;
    for (const r of fns) {
      info(`  ${r.nspname}.${r.proname}(${r.args})  names ${[r.names_col ? OLD_COL : null, r.names_key ? OLD_KEY : null].filter(Boolean).join(" + ")}`);
    }
    check(
      "function bodies naming the old column/key",
      "none (bodies are TEXT)",
      fns.length ? `${fns.length}: ${fns.map((r) => `${r.nspname}.${r.proname}`).join(", ")}` : "none",
      fns.length === 0,
    );

    /* Step 5's leftover scan is scm-only and relkind r/p/v/m only. Ask wider:
       any schema, plus foreign tables and standalone composite types, which the
       scan does not consider and which do not follow a rename. A hit inside scm
       on relkind r/p that is NOT one of the two base tables makes step 5 RAISE
       and rolls the whole migration back.

       relkind 'i' is EXCLUDED on purpose and this was got wrong first: an index
       over the column has a pg_attribute row carrying the column's name, so a
       naive scan reports every index as a stray. Indexes follow the rename by
       attnum — they are handled in the index bucket above, not here. */
    const anywhere = await q`
      SELECT n.nspname, c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE a.attname = ${OLD_COL}
        AND c.relkind IN ('r','p','v','m','f','c')
        AND n.nspname NOT IN ('pg_catalog','information_schema')
      ORDER BY n.nspname, c.relname`;
    say("");
    info(`relations anywhere carrying a column named ${OLD_COL}: ${anywhere.length}`);
    for (const r of anywhere) info(`  ${r.nspname}.${r.relname} [relkind ${r.relkind}]`);
    const strays = anywhere.filter(
      (r) =>
        !(r.nspname === "scm" && BASE_TABLES.includes(r.relname)) &&
        !(r.nspname === "scm" && (r.relkind === "v" || r.relkind === "m")),
    );
    check(
      `relations 0284 will neither rename nor tolerate`,
      "none",
      strays.length ? strays.map((r) => `${r.nspname}.${r.relname}[${r.relkind}]`).join(", ") : "none",
      strays.length === 0,
    );

    /* Catch-all: anything at all in pg_depend hanging off the column's attnum
       that the buckets above did not already name. This is the bucket that
       makes "any OTHER object" an honest claim rather than a list of the four
       kinds we happened to think of.

       An index depends on its column as classid = pg_class, NOT pg_index — a
       first draft excluded 'pg_index' and consequently reported both of the
       column's ordinary indexes as unknown dependents. So resolve pg_class
       objids to their relkind and let the already-reported kinds (index, view,
       matview, the table's own toast/sequence) drop out by kind, not by guess. */
    const otherDeps = await q`
      SELECT d.classid::regclass::text AS dep_kind, d.objid::int AS objid, d.deptype,
             src.relname AS base_table, a.attname AS base_col,
             dc.relkind AS dep_relkind,
             CASE WHEN dc.oid IS NOT NULL
                  THEN dn.nspname || '.' || dc.relname
                  ELSE NULL END AS dep_name
      FROM pg_depend d
      JOIN pg_class src ON src.oid = d.refobjid
      JOIN pg_namespace sn ON sn.oid = src.relnamespace
      JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = d.refobjsubid
      LEFT JOIN pg_class dc ON d.classid = 'pg_class'::regclass AND dc.oid = d.objid
      LEFT JOIN pg_namespace dn ON dn.oid = dc.relnamespace
      WHERE d.refclassid = 'pg_class'::regclass
        AND sn.nspname = 'scm' AND src.relname = ANY(${BASE_TABLES})
        AND a.attname = ANY(${[OLD_COL, NEW_COL]})
        AND d.classid::regclass::text NOT IN
            ('pg_rewrite','pg_constraint','pg_attrdef','pg_type','pg_trigger','pg_policy')
      ORDER BY 1, 2`;
    const KNOWN_RELKINDS = new Set(["i", "I", "v", "m", "t", "S"]);
    const unknownDeps = otherDeps.filter(
      (r) => !(r.dep_relkind && KNOWN_RELKINDS.has(r.dep_relkind)),
    );
    info(`pg_depend entries on the column: ${otherDeps.length} (${unknownDeps.length} not already reported above)`);
    for (const r of unknownDeps) {
      info(`  ${r.dep_kind} ${r.dep_name || `oid=${r.objid}`} [relkind ${r.dep_relkind ?? "-"}] deptype=${r.deptype} on ${r.base_table}.${r.base_col}`);
    }
    check(
      "unclassified catalog dependents",
      "none",
      unknownDeps.length ? `${unknownDeps.length} (see list)` : "none",
      unknownDeps.length === 0,
    );
    say("");

    // ── E. The jsonb key rewrites ───────────────────────────────────────────
    say(`--- E. stored jsonb payload keys -------------------------------------------`);

    const [amdT] = await q`SELECT to_regclass('scm.so_amendments') IS NOT NULL AS present`;
    if (!amdT.present) {
      info("scm.so_amendments does not exist — step 4 guards on to_regclass and skips");
    } else {
      /* `?` is safe on any jsonb, but the SHAPE decides whether step 4's UPDATE
         reaches the row: it deletes a key with `-`, which errors on a scalar,
         and it skips any row that already carries the new key — and then step 5
         RAISEs on that same row and rolls everything back. Count both. */
      const [a] = await q`
        SELECT count(*)::int AS rows_total,
               count(*) FILTER (WHERE header_changes ? ${OLD_KEY})::int AS hc_old,
               count(*) FILTER (WHERE old_header_snapshot ? ${OLD_KEY})::int AS oh_old,
               count(*) FILTER (WHERE header_changes ? ${OLD_KEY} AND header_changes ? ${NEW_KEY})::int AS hc_both,
               count(*) FILTER (WHERE old_header_snapshot ? ${OLD_KEY} AND old_header_snapshot ? ${NEW_KEY})::int AS oh_both,
               count(*) FILTER (WHERE header_changes IS NOT NULL AND jsonb_typeof(header_changes) <> 'object')::int AS hc_shape,
               count(*) FILTER (WHERE old_header_snapshot IS NOT NULL AND jsonb_typeof(old_header_snapshot) <> 'object')::int AS oh_shape
        FROM scm.so_amendments`;
      info(`scm.so_amendments rows: ${a.rows_total}`);
      info(`  header_changes      carrying '${OLD_KEY}': ${a.hc_old}   <- step 4 rewrites these`);
      info(`  old_header_snapshot carrying '${OLD_KEY}': ${a.oh_old}   <- step 4 rewrites these`);
      check(
        `so_amendments rows carrying BOTH keys`,
        "0 (step 4 skips them, step 5 RAISEs)",
        `${a.hc_both + a.oh_both}`,
        a.hc_both + a.oh_both === 0,
      );
      check(
        `so_amendments jsonb columns not an object`,
        "0",
        `${a.hc_shape + a.oh_shape}`,
        a.hc_shape + a.oh_shape === 0,
      );
    }

    const [logT] = await q`SELECT to_regclass('scm.mfg_so_audit_log') IS NOT NULL AS present`;
    if (!logT.present) {
      info("scm.mfg_so_audit_log does not exist — step 4 guards on to_regclass and skips");
    } else {
      /* Step 4 requires jsonb_typeof = 'array'; step 5's post-condition does
         NOT. A row holding the token in any other shape is therefore migrated
         by nobody and caught by nobody — it just keeps rendering the raw token
         `internalExpectedDd` where the operator expects "Processing date". */
      /* jsonb_build_array(jsonb_build_object(...)), NOT `@> ${JSON.stringify(...)}::jsonb`.
         postgres.js encodes an interpolated JS string INTO jsonb, so `$1::jsonb`
         arrives as the jsonb scalar "[{\"field\":...}]" rather than an array, and
         `@>` is then false for every row on earth. The first draft did exactly
         that and reported 0 against a replica holding a matching row — a count
         that is wrong in the safe-looking direction. Same shape exists at
         backend/scripts/audit-special-addon-prices.mjs:265,270; reported, not
         touched here. */
      const [l] = await q`
        SELECT count(*)::int AS rows_total,
               count(*) FILTER (
                 WHERE jsonb_typeof(field_changes) = 'array'
                   AND field_changes @> jsonb_build_array(jsonb_build_object('field', ${OLD_KEY}::text))
               )::int AS arr_old,
               count(*) FILTER (
                 WHERE field_changes IS NOT NULL
                   AND jsonb_typeof(field_changes) <> 'array'
                   AND field_changes::text LIKE ${"%" + OLD_KEY + "%"}
               )::int AS nonarr_old
        FROM scm.mfg_so_audit_log`;
      info(`scm.mfg_so_audit_log rows: ${l.rows_total}`);
      info(`  field_changes arrays carrying '${OLD_KEY}': ${l.arr_old}   <- step 4 rewrites these`);
      check(
        `audit rows holding '${OLD_KEY}' in a non-array field_changes`,
        "0 (step 4 only rewrites arrays)",
        `${l.nonarr_old}`,
        l.nonarr_old === 0,
      );
    }
    say("");

    // ── F. THE NEXT RETIREMENTS — not 0284's pre-conditions ─────────────────
    /* Added 2026-08-18 with the sweep that collapsed the Processing Date's
       seven names to one. 0284 is history; these are the questions the NEXT
       removal has to answer, and they are questions about PRODUCTION ROWS that
       no amount of reading source can settle.

       DELIBERATELY `info()`, NEVER `check()`. The MATCHES / DIFFERS verdict is a
       statement about what migration 0284 assumed, and folding a different
       migration's pre-conditions into it would make a red run mean two things.
       Read these numbers; do not read the verdict for them. */
    say(`--- F. pre-conditions for the NEXT name retirements -------------------------`);

    /* F1. target_date — the ERP source stopped naming it on 2026-08-18. The
       COLUMN is still there, and the question the drop needs answered is
       whether anything OUTSIDE this repository (the POS) still writes it.

       MEASURE THE ROW'S BIRTH, NOT ITS LAST EDIT. The obvious query — "carries a
       target_date AND updated_at is recent" — answers a DIFFERENT question:
       `updated_at` moves on ANY edit to the header, so an order created in 2025
       with a target_date and re-saved yesterday for an unrelated remark scores as
       a fresh write. The first draft of this section did exactly that and
       concluded "something still writes it" from 46 rows that may all be old.
       That is adjacent evidence, not evidence.

       `created_at` IS the discriminator, and only because of a fact about this
       column specifically: no ERP path has written it since PR #140, and the
       write it used to do was at CREATE. So a row BORN in the window and
       carrying one was given it by a producer that is not this repository.
       Both numbers are printed — the weak one labelled as weak — because a
       reader who only sees the strong one cannot tell it was chosen. */
    for (const t of BASE_TABLES) {
      if (!tableExists(t)) { info(`scm.${t}: table absent — nothing to say about target_date`); continue; }
      const [td] = await q`
        SELECT count(*)::int AS has_col
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'scm' AND c.relname = ${t}
          AND a.attname = 'target_date' AND a.attnum > 0 AND NOT a.attisdropped`;
      if (!td.has_col) { info(`scm.${t}.target_date: ALREADY GONE from the catalog`); continue; }
      const [r] = await q.unsafe(`
        SELECT count(*)::int AS rows_total,
               count(target_date)::int AS set_ever,
               count(*) FILTER (WHERE target_date IS NOT NULL
                                  AND created_at > now() - interval '90 days')::int AS born_90d,
               count(*) FILTER (WHERE target_date IS NOT NULL
                                  AND coalesce(updated_at, created_at) > now() - interval '90 days')::int AS touched_90d,
               coalesce(extract(epoch FROM (now() - max(created_at)
                       FILTER (WHERE target_date IS NOT NULL))) / 86400.0, -1)::numeric(10,2) AS newest_birth_days,
               coalesce(extract(epoch FROM (now() - min(created_at)
                       FILTER (WHERE target_date IS NOT NULL))) / 86400.0, -1)::numeric(10,2) AS oldest_birth_days
        FROM scm.${t}`);
      const born = Number(r.born_90d);
      info(`scm.${t}.target_date: ${r.set_ever} of ${r.rows_total} rows carry one`);
      info(`  THE ANSWER — rows CREATED in the last 90 days carrying one: ${born}`);
      info(`  newest such row was created ${Number(r.newest_birth_days) < 0 ? "n/a (none)" : r.newest_birth_days + " days ago"}; oldest ${Number(r.oldest_birth_days) < 0 ? "n/a" : r.oldest_birth_days + " days ago"}`);
      info(`  (weak, do not read as a writer: ${r.touched_90d} carry one AND were UPDATED in 90 days — updated_at moves on any edit)`);
      info(
        born > 0
          ? `  >> A PRODUCER OUTSIDE THIS REPO IS STILL WRITING IT. The column DROP must WAIT. The NAME retirement in the ERP source is unaffected — the ERP only offered a door to write it and never read the value.`
          : `  >> no row born with one in 90 days: the population is a frozen backlog, not a live producer. The column drop still needs its own migration, and should re-run this first.`,
      );
    }

    /* F2. internalExpectedDd — the stored-jsonb alias in
       SO_HEADER_LEGACY_PAYLOAD_KEYS. This is the EXACT statement quoted in that
       constant's doc comment, run rather than described. */
    const amendCls = await q`SELECT to_regclass('scm.so_amendments') IS NOT NULL AS present`;
    if (amendCls[0].present) {
      const [a] = await q`
        SELECT count(*)::int AS pending_total,
               count(*) FILTER (WHERE header_changes ? ${OLD_KEY})::int AS pending_old_key
        FROM scm.so_amendments
        WHERE status NOT IN ('SENT', 'REJECTED')`;
      info(`scm.so_amendments non-terminal rows: ${a.pending_total}, of which ${a.pending_old_key} still carry '${OLD_KEY}'`);
      info(
        Number(a.pending_old_key) > 0
          ? `  >> KEEP the '${OLD_KEY}' alias. Removing it makes those approvals write no date, silently.`
          : `  >> 0 today — but a client still sending the old spelling can queue a new one at any time. Confirm no deployed client sends it BEFORE trusting this number.`,
      );
    } else {
      info("scm.so_amendments absent on this database");
    }

    /* F3. internal_expected_dd — the INBOUND alias for the 2990 mirror. This can
       only show that company 2 is still delivering dates at all; whether 2990
       has redeployed off the old KEY is a fact about 2990's repository and its
       outbox, and cannot be read from here. Printed so the next person knows
       which half they still owe. */
    if (tableExists("mfg_sales_orders")) {
      const [m] = await q.unsafe(`
        SELECT count(*) FILTER (WHERE company_id = 2)::int AS co2_rows,
               count(*) FILTER (WHERE company_id = 2 AND ${NEW_COL} IS NOT NULL)::int AS co2_dated,
               count(*) FILTER (WHERE company_id = 2 AND ${NEW_COL} IS NOT NULL
                                  AND coalesce(updated_at, created_at) > now() - interval '30 days')::int AS co2_dated_30d
        FROM scm.mfg_sales_orders`);
      info(`company 2 SOs: ${m.co2_rows} rows, ${m.co2_dated} carry a Processing Date, ${m.co2_dated_30d} of those touched in the last 30 days`);
      info(`  >> this measures HALF the precondition. The other half — 2990 deployed off '${OLD_COL}' AND one full mirror re-delivery drained — lives in 2990's repo and its pg_cron outbox, and must be confirmed there.`);
    }

    /* F4. The legacy native Sales module's queued change requests live in D1
       (SQLite), not in this database, so this probe cannot reach them. Named
       rather than omitted: a pre-flight that silently skips a pre-condition is
       how a retirement ships on three answers out of four. */
    info(`sales_entry_change_requests: NOT MEASURABLE HERE — it is a D1/SQLite table, not Postgres.`);
    info(`  >> stage 2 of the native Sales module unification needs it; see SO_FORM_TEXT_FIELDS in backend/src/routes/sales.ts for the statement to run.`);
    say("");
  });

  // ── verdict ───────────────────────────────────────────────────────────────
  const bad = checks.filter((c) => !c.ok);
  say(`--- what disagrees ---------------------------------------------------------`);
  if (bad.length === 0) {
    info("nothing — every pre-condition 0284 assumes is true of this database");
  } else {
    for (const c of bad) info(`${c.label.trim()}  — expects "${c.expect}", prod says "${c.actual}"`);
  }
  say("");

  /* The one line the reader is promised. Names at most three, because a line
     that scrolls is a line nobody reads to the end of; the full list is in the
     block directly above. */
  const named = bad.slice(0, 3).map((c) => c.label.trim()).join("; ");
  const more = bad.length > 3 ? ` (+${bad.length - 3} more above)` : "";
  const verdict =
    bad.length === 0
      ? `MATCHES — the live catalog holds every one of the ${checks.length} pre-conditions 0284 assumes; it will do what the replica said it would.`
      : `DIFFERS — ${bad.length} of ${checks.length} pre-conditions do NOT hold on this database: ${named}${more}`;
  say(verdict);
  if (process.env.GITHUB_ACTIONS) {
    console.log(bad.length === 0 ? `::notice::${verdict}` : `::error::${verdict}`);
  }
  return bad.length === 0 ? 0 : 1;
}

let code = 2;
try {
  code = await main();
} catch (e) {
  console.error(`PROBE FAILED (nothing was read to completion): ${e.message}`);
  console.error(e.stack);
  code = 2;
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(code);
