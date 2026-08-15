#!/usr/bin/env node
// Renumber sales orders, closing the hole a test-row cleanup leaves behind.
//
// Owner 2026-08-15, after 18 test orders were deleted out of the middle of
// 2990's August sequence: "把真单号码改下来 make sure no 空洞出现."
//
// WHY THIS IS NOT AN UPDATE STATEMENT. scm.mfg_sales_orders.doc_no is the
// PRIMARY KEY, and every foreign key pointing at it is ON UPDATE NO ACTION
// (2990s-full-schema.sql :1652-1768) — not CASCADE. Postgres will simply refuse
// `UPDATE ... SET doc_no = ...` while any child row references it. So a rename
// is three moves inside one transaction:
//
//   1. INSERT a copy of the row under the NEW doc_no
//   2. repoint every referencing row from the old number to the new one
//   3. DELETE the old row
//
// Step 3 is the dangerous one and it is why step 2 is verified before it runs.
// FIVE of the seven child tables are ON DELETE CASCADE (the other two are SET
// NULL — `git grep 'REFERENCES "public"."mfg_sales_orders"'`), so a row this
// script failed to repoint would be silently DESTROYED by the delete rather
// than left behind as a visible orphan. The transaction therefore re-scans for
// the old number after step 2 and ABORTS the whole thing if a single row still
// carries it.
//
// AND THE WRITER IS NOT THE WITNESS. After the transactions commit, a SECOND
// connection re-reads every renamed order and asserts its SHAPE — the header
// fields and the child-row counts captured before the move, not merely that a
// row exists. The session that performed the write is the worst possible judge
// of whether it landed.
//
// WHAT COUNTS AS A REFERENCE IS MEASURED, NOT LISTED. Hand-maintained table
// lists rot — and the references that matter most here are the ones with NO
// foreign key (scm.pwp_codes.source_doc_no / redeemed_doc_no are plain text,
// documented at 2990s-full-schema.sql :1220), which is exactly the class a
// human list forgets. So the script SCANS: every base table in scm + public is
// checked with `to_jsonb(t.*)::text LIKE '%docno%'`, and every text column of
// every table that matches is then counted exactly. That scan is also the
// after-proof in step 3 and the final verdict.
//
// EXACT vs MENTION. A column whose whole value IS the doc number gets rewritten.
// A column that merely CONTAINS it inside a longer string (a remark, an R2
// object key like `slips/2990-SO-2608-037.pdf`) is REPORTED and left alone —
// rewriting free text is not a rename, and the report is what stops that
// becoming a silent surprise. Read the MENTION lines before applying.
//
// DRY-RUN by default. APPLY=1 additionally requires CONFIRM to repeat the pair
// list exactly — a destructive prod write should never ride on one typed field.
//
// Usage:
//   PAIRS="2990-SO-2608-037:2990-SO-2608-019,2990-SO-2608-038:2990-SO-2608-020" \
//     [APPLY=1 CONFIRM="<same string>"] node scripts/renumber-sales-orders.mjs
//
// RE-RUN: safe. A pair whose source is already gone and whose target already
// exists is reported as "already done" and skipped, so a half-finished run can
// simply be run again.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
const PAIRS_RAW = (process.env.PAIRS ?? "").trim();
const CONFIRM = (process.env.CONFIRM ?? "").trim();
const APPLY = process.env.APPLY === "1";
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
if (!PAIRS_RAW) { console.error('need PAIRS, e.g. "2990-SO-2608-037:2990-SO-2608-019"'); process.exit(2); }

const DOC_RE = /^[A-Za-z0-9-]+$/;
const PAIRS = PAIRS_RAW.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
  const [from, to] = s.split(":").map((x) => (x ?? "").trim());
  if (!from || !to || !DOC_RE.test(from) || !DOC_RE.test(to)) {
    console.error(`bad pair "${s}" — expected FROM:TO with plain doc numbers`);
    process.exit(2);
  }
  return { from, to };
});

const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const out = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const PARENT = { schema: "scm", table: "mfg_sales_orders" };

class Refused extends Error {}
const refuse = (m) => { throw new Refused(m); };

/* Every base table we might have to touch. Scanned rather than listed, because
   the references without a foreign key are the ones a list forgets. */
async function allTables() {
  return await db`
    SELECT table_schema AS schema, table_name AS table
      FROM information_schema.tables
     WHERE table_schema IN ('scm', 'public') AND table_type = 'BASE TABLE'
     ORDER BY table_schema, table_name`;
}

/* Text columns we are allowed to write. Generated columns are excluded: an
   UPDATE against one is an error, not a rename. */
async function textCols(schema, table) {
  const rows = await db`
    SELECT column_name AS col
      FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table}
       AND data_type IN ('text', 'character varying', 'character')
       AND is_generated = 'NEVER'
     ORDER BY ordinal_position`;
  return rows.map((r) => r.col);
}

/* Which tables carry this doc number ANYWHERE in any column. One query per
   table over the whole row as jsonb — cheaper than one per column, and it
   cannot miss a column nobody thought of. */
async function tablesMentioning(tables, docNo, exec = db) {
  const hits = [];
  for (const t of tables) {
    try {
      const [r] = await exec.unsafe(
        `SELECT count(*)::int AS n FROM ${t.schema}.${t.table} x WHERE to_jsonb(x.*)::text LIKE $1`,
        [`%${docNo}%`],
      );
      if (r.n > 0) hits.push({ ...t, n: r.n });
    } catch {
      /* a view-backed or unreadable relation is not a reference we can rewrite;
         it is reported by its absence from the plan, never as a silent zero. */
      hits.push({ ...t, n: -1 });
    }
  }
  return hits;
}

/* For one table, split every text column into exact matches (rewritable) and
   mentions inside a longer string (reported, never rewritten). */
async function columnBreakdown(schema, table, docNo, exec = db) {
  const cols = await textCols(schema, table);
  if (!cols.length) return { exact: [], mention: [] };
  const parts = cols.map((c, i) =>
    `count(*) FILTER (WHERE "${c}" = $1) AS e${i}, ` +
    `count(*) FILTER (WHERE "${c}" LIKE $2 AND "${c}" <> $1) AS m${i}`);
  const [row] = await exec.unsafe(
    `SELECT ${parts.join(", ")} FROM ${schema}.${table}`, [docNo, `%${docNo}%`]);
  const exact = [];
  const mention = [];
  cols.forEach((c, i) => {
    const e = Number(row[`e${i}`] ?? 0);
    const m = Number(row[`m${i}`] ?? 0);
    if (e > 0) exact.push({ col: c, n: e });
    if (m > 0) mention.push({ col: c, n: m });
  });
  return { exact, mention };
}

async function main() {
  out(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; pairs: ${PAIRS.map((p) => `${p.from}->${p.to}`).join(", ")}`);
  if (APPLY && CONFIRM !== PAIRS_RAW) {
    refuse(`CONFIRM must repeat PAIRS exactly to apply.\n  PAIRS  ="${PAIRS_RAW}"\n  CONFIRM="${CONFIRM || "(empty)"}"`);
  }

  const froms = PAIRS.map((p) => p.from);
  const tos = PAIRS.map((p) => p.to);
  if (new Set(froms).size !== froms.length) refuse("a source doc number is listed twice");
  if (new Set(tos).size !== tos.length) refuse("a target doc number is listed twice");
  for (const t of tos) if (froms.includes(t)) refuse(`${t} is both a source and a target — chain renames are not supported in one run`);

  const tables = await allTables();
  out(`scanning ${tables.length} base table(s) in scm + public`);

  // ── Preconditions, per pair ───────────────────────────────────────────────
  const todo = [];
  for (const p of PAIRS) {
    /* The SHAPE is captured here, before anything moves, because it is what the
       fresh-connection check at the end asserts. A row count would pass while
       every field on it was wrong. */
    const [src] = await db`
      SELECT doc_no, status, company_id, debtor_name, so_date, local_total_centi,
             (SELECT count(*)::int FROM scm.mfg_sales_order_items    i WHERE i.doc_no    = s.doc_no) AS items,
             (SELECT count(*)::int FROM scm.mfg_sales_order_payments y WHERE y.so_doc_no = s.doc_no) AS payments
        FROM scm.mfg_sales_orders s WHERE doc_no = ${p.from}`;
    const [dst] = await db`SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no = ${p.to}`;
    if (!src && dst) { out(`SKIP  ${p.from} -> ${p.to}: already done (source gone, target present)`); continue; }
    if (!src) refuse(`${p.from} does not exist`);
    if (dst) refuse(`${p.to} is already taken — renaming ${p.from} onto it would collide`);
    p.shape = {
      status: src.status, company_id: String(src.company_id), debtor_name: src.debtor_name,
      so_date: String(src.so_date), local_total_centi: String(src.local_total_centi),
      items: src.items, payments: src.payments,
    };
    out(`PLAN  ${p.from} -> ${p.to}  (status=${src.status}, company_id=${src.company_id}, ` +
        `customer=${src.debtor_name}, items=${src.items}, payments=${src.payments})`);
    todo.push(p);
  }
  if (!todo.length) { out("Nothing to do."); return; }

  // ── What actually references each source number ───────────────────────────
  const plan = new Map();
  for (const p of todo) {
    const hits = await tablesMentioning(tables, p.from);
    const unreadable = hits.filter((h) => h.n < 0);
    if (unreadable.length) {
      refuse(`could not scan ${unreadable.length} relation(s) (${unreadable.map((u) => `${u.schema}.${u.table}`).join(", ")}). ` +
        `A rename cannot be proven complete against a table it cannot read.`);
    }
    const cols = [];
    out(`REFS  ${p.from}: found in ${hits.length} table(s)`);
    for (const h of hits) {
      const { exact, mention } = await columnBreakdown(h.schema, h.table, p.from);
      for (const e of exact) {
        const isParentPk = h.schema === PARENT.schema && h.table === PARENT.table && e.col === "doc_no";
        out(`  EXACT   ${h.schema}.${h.table}.${e.col} rows=${e.n}${isParentPk ? "  (the order itself — handled by copy+delete)" : ""}`);
        if (!isParentPk) cols.push({ schema: h.schema, table: h.table, col: e.col, n: e.n });
      }
      for (const m of mention) {
        out(`  MENTION ${h.schema}.${h.table}.${m.col} rows=${m.n} — inside a longer string, LEFT ALONE. Read this line.`);
      }
      if (!exact.length && !mention.length) {
        out(`  ?       ${h.schema}.${h.table}: row matched but no text column did (jsonb/array column) — REFUSING, it cannot be rewritten safely`);
        refuse(`${h.schema}.${h.table} carries ${p.from} in a non-text column. Rewriting it is not something this script can do safely.`);
      }
    }
    plan.set(p.from, cols);
  }

  if (!APPLY) {
    out(`DRY-RUN complete. Nothing was written.`);
    out(`To apply: APPLY=1 and CONFIRM="${PAIRS_RAW}"`);
    return;
  }

  // ── Apply: copy, repoint, verify, delete — one transaction per pair ───────
  for (const p of todo) {
    await db.begin(async (tx) => {
      /* 1. Copy the row under the new number. jsonb_populate_record keeps every
            column without this script having to know what they are, so a column
            added by a later migration comes along automatically. */
      const ins = await tx.unsafe(
        `INSERT INTO ${PARENT.schema}.${PARENT.table}
         SELECT (jsonb_populate_record(NULL::${PARENT.schema}.${PARENT.table},
                   to_jsonb(x) || jsonb_build_object('doc_no', $2::text))).*
           FROM ${PARENT.schema}.${PARENT.table} x WHERE x.doc_no = $1`,
        [p.from, p.to]);
      if (ins.count !== 1) throw new Error(`copy of ${p.from} inserted ${ins.count} rows — rolled back`);
      out(`Copied  ${p.from} -> ${p.to}`);

      /* 2. Repoint every exact reference. */
      let moved = 0;
      for (const c of plan.get(p.from)) {
        const r = await tx.unsafe(
          `UPDATE ${c.schema}.${c.table} SET "${c.col}" = $2 WHERE "${c.col}" = $1`, [p.from, p.to]);
        out(`Moved   ${c.schema}.${c.table}.${c.col} rows=${r.count}`);
        moved += r.count;
      }
      out(`Moved   ${moved} referencing row(s) in total`);

      /* 3. PROVE nothing still points at the old number BEFORE deleting it.
            Five of the seven child tables are ON DELETE CASCADE: anything still
            referencing the old doc_no would be destroyed by the delete, not
            orphaned. */
      const stillThere = await tablesMentioning(tables, p.from, tx);
      const leftovers = stillThere.filter((h) =>
        !(h.schema === PARENT.schema && h.table === PARENT.table));
      if (leftovers.length) {
        throw new Error(
          `after repointing, ${p.from} is STILL referenced by ` +
          `${leftovers.map((l) => `${l.schema}.${l.table}(${l.n})`).join(", ")} — ` +
          `deleting now would CASCADE-DESTROY those rows. Rolled back, nothing changed.`);
      }
      out(`Proved  no row outside ${PARENT.schema}.${PARENT.table} still references ${p.from}`);

      /* 4. Drop the old row. */
      const del = await tx.unsafe(
        `DELETE FROM ${PARENT.schema}.${PARENT.table} WHERE doc_no = $1`, [p.from]);
      if (del.count !== 1) throw new Error(`expected to delete exactly 1 old row, deleted ${del.count} — rolled back`);
      out(`Deleted ${p.from}`);
    });
    out(`DONE    ${p.from} -> ${p.to}`);
  }

  // ── After-proof on a FRESH connection ─────────────────────────────────────
  /* A new client, not the one that wrote. The writing session has seen its own
     uncommitted work all along and is the worst available witness that anything
     landed; and what is asserted is the SHAPE captured before the move, because
     "one row exists" is true of a row with every field wrong. */
  const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const bad = [];
  try {
    for (const p of todo) {
      const [now] = await verify`
        SELECT status, company_id, debtor_name, so_date, local_total_centi,
               (SELECT count(*)::int FROM scm.mfg_sales_order_items    i WHERE i.doc_no    = s.doc_no) AS items,
               (SELECT count(*)::int FROM scm.mfg_sales_order_payments y WHERE y.so_doc_no = s.doc_no) AS payments
          FROM scm.mfg_sales_orders s WHERE doc_no = ${p.to}`;
      const [old] = await verify`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE doc_no = ${p.from}`;
      const left = await tablesMentioning(tables, p.from, verify);

      if (!now) { bad.push(`${p.to} is NOT PRESENT on a fresh read`); continue; }
      const got = {
        status: now.status, company_id: String(now.company_id), debtor_name: now.debtor_name,
        so_date: String(now.so_date), local_total_centi: String(now.local_total_centi),
        items: now.items, payments: now.payments,
      };
      const diffs = Object.keys(p.shape).filter((k) => String(p.shape[k]) !== String(got[k]))
        .map((k) => `${k}: was ${p.shape[k]}, now ${got[k]}`);
      if (diffs.length) bad.push(`${p.to} shape changed — ${diffs.join("; ")}`);
      if (old.n !== 0) bad.push(`${p.from} is STILL PRESENT (${old.n} row)`);
      if (left.length) bad.push(`${p.from} still referenced by ${left.map((l) => `${l.schema}.${l.table}`).join(", ")}`);

      out(`VERIFY  ${p.from} -> ${p.to} | old gone: ${old.n === 0 ? "yes" : "NO"} | ` +
          `references to old: ${left.length ? left.map((l) => l.table).join(",") : "none"} | ` +
          `shape: ${diffs.length ? "MISMATCH" : "identical"} ` +
          `(status=${got.status}, customer=${got.debtor_name}, items=${got.items}, payments=${got.payments}, total_centi=${got.local_total_centi})`);
    }
  } finally {
    await verify.end();
  }
  if (bad.length) {
    out(`VERIFY FAILED — the writes are COMMITTED and a fresh read disagrees with them:`);
    for (const b of bad) out(`  ${b}`);
    throw new Error(`fresh-connection verification found ${bad.length} problem(s); the rename is NOT safe to trust`);
  }
  out(`VERIFY  all ${todo.length} rename(s) confirmed on a second connection: old number gone, new number carries the same shape.`);

  const prefix = todo[0].to.replace(/\d+$/, "");
  const rows = await db.unsafe(
    `SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE $1 ORDER BY doc_no`, [`${prefix}%`]);
  const nums = rows.map((r) => parseInt(r.doc_no.slice(prefix.length), 10)).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = [];
  for (let n = 1; n < (nums[nums.length - 1] ?? 0); n++) if (!nums.includes(n)) gaps.push(String(n).padStart(3, "0"));
  out(`NUMBERING ${prefix}: ${nums.length} order(s), highest ${String(nums[nums.length - 1] ?? 0).padStart(3, "0")}`);
  out(`NUMBERING gaps below the highest: ${gaps.length ? gaps.join(", ") : "none"}`);
  out(`NUMBERING next mint would be ${prefix}${String((nums[nums.length - 1] ?? 0) + 1).padStart(3, "0")} (max+1, scm/lib/doc-no.ts)`);
}

main().then(() => db.end()).catch(async (e) => {
  if (e instanceof Refused) {
    console.log(`\nREFUSED: ${e.message}`);
    console.log("Nothing was written. This is a verdict, not a failure.");
    await db.end();
    return;
  }
  console.error("RENUMBER_FAIL:", e.message);
  await db.end();
  process.exit(1);
});
