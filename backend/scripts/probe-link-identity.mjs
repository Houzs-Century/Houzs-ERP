#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. DOES A LINK POINT AT THE SAME THING ON BOTH SIDES?
//
// THE BUG CLASS. On 2026-09-07 the delta sync wrote `purchase_order_items
// .so_item_id` on the strength of an AutoCount DtlKey PAIR and never compared
// the two rows' `item_code`. Nine sales-order lines were dedicated to a
// purchase-order line for a DIFFERENT BED, so a customer's REGAL now reads
// READY when a TRION arrives (isHardBoundLine, src/scm/lib/so-stock-
// allocation.ts). docs/bugs/0671-*.md has the trace; the named class is
// docs/bugs/0672-bug-class-key-without-identity-*.md.
//
// WHY THE EXISTING PROBE COULD NOT SEE IT. `probe-doc-link-matrix.mjs` counts
// each link FILLED and DANGLING. Both nine dedications were filled, and none
// dangled: they pointed at a real row that existed. A dangling count answers
// "is the foreign key valid", which is a different question from "are the two
// rows the same product". This file asks the second one.
//
// FOUR QUESTIONS, in order of how loud a wrong answer is:
//
//   1  ITEM DISAGREEMENT — for every line->line link in scm, how many rows
//      point at a parent whose `item_code` is a different product.
//   2  THE SWAP SIGNATURE — of those, how many sit in a document where the
//      children's item codes are a PERMUTATION of their parents'. A perfect
//      swap on a document is the fingerprint of POSITIONAL pairing (zip by
//      row order), not of two independent errors.
//   3  THE AUTOCOUNT LINE KEY IS NOT UNIQUE — 0273 and 0280 index
//      `linked_ac_dtlkey` NON-uniquely on six line tables. Every lane that
//      builds a Map keyed by DtlKey silently keeps ONE row per key, so a
//      duplicated key makes the lane a coin flip. Counted per table, and
//      counted again ACROSS companies, where a collision is certainly wrong
//      because each company has its own AutoCount book. The BENIGN case (one
//      book line becoming a sofa's several compartment lines) is separated
//      from a real collision by the MODEL and by the DOCUMENT — never by the
//      item code, which differs in both cases; see the MODEL helper below.
//   4  THE SOFA COLOUR — the same permutation test on the colour carried in
//      `variants`, because an exact colour swap between two lines of one
//      document is this class wearing different clothes.
//
// EVERY LINE->LINE CHAIN IN `scm`, INCLUDING THE TWO RETURNS. The first two
// runs measured six edges and no return chain at all, so the probe was silent
// about `delivery_return_items.do_item_id` and `purchase_return_items
// .grn_item_id` — two of the nine client-supplied bind points that docs/bugs
// /0672 site 15 is about. Silence printed exactly like a clean answer.
//
// NULLS ARE REPORTED, NOT SKIPPED. A count taken only over rows that already
// carry a link cannot see a link that was never written, and a "0 mismatches"
// from such a count is the false negative this class is best at producing. Every
// section prints its denominator and its NULL count next to its answer.
//
// PRIVACY: this repository and its Actions logs are PUBLIC. COUNTS ONLY — no
// document numbers, no item codes, no customer, no amount. A count tells you
// how big the problem is; naming the rows is a separate, private step.
//
// NOTHING IS WRITTEN. SELECTs only. No DDL, no transaction, no temp table.
//
//   DATABASE_URL   required
//
// RE-RUN: idempotent and side-effect free. Safe to run any number of times.
// ----------------------------------------------------------------------------
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(2);
}
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The six document types, their line table, and the header that carries the
   company. Domain knowledge, written out; the LINK COLUMNS below are
   discovered from information_schema so a column added tomorrow cannot be
   silently missed. */
/* `fk` is the LINE column and `pk` the HEADER column it matches. They are not
   always id -> id: a sales-order line carries `doc_no` and joins its header BY
   DOCUMENT NUMBER, which is why the first run of this probe (34137796488)
   answered `column h.id does not exist` for the one table that matters most and
   measured nothing for it. Written out per type rather than assumed. */
const DOC = {
  SO: { line: "mfg_sales_order_items", head: "mfg_sales_orders", fk: "doc_no", pk: "doc_no" },
  DO: { line: "delivery_order_items", head: "delivery_orders", fk: "delivery_order_id", pk: "id" },
  GR: { line: "grn_items", head: "grns", fk: "grn_id", pk: "id" },
  PO: { line: "purchase_order_items", head: "purchase_orders", fk: "purchase_order_id", pk: "id" },
  SI: { line: "sales_invoice_items", head: "sales_invoices", fk: "sales_invoice_id", pk: "id" },
  PI: { line: "purchase_invoice_items", head: "purchase_invoices", fk: "purchase_invoice_id", pk: "id" },
  /* THE TWO RETURN CHAINS WERE NEVER MEASURED. Run 34137796488 and its corrected
     re-run 34139187692 both reported six edges, and neither of them was a return.
     That was not a clean answer about returns — it was NO answer, and it printed
     identically to a clean one, which is exactly the false negative this file
     exists to refuse. Site 15 of docs/bugs/0672 names `purchase-returns.ts` and
     `delivery-returns.ts` as two of its nine client-supplied bind points, so the
     probe was silent about two of the very sites it was written to size.
     `delivery_return_items.do_item_id` and `purchase_return_items.grn_item_id`
     both carry `item_code` on both sides and are comparable like any other. */
  DR: { line: "delivery_return_items", head: "delivery_returns", fk: "delivery_return_id", pk: "id" },
  PR: { line: "purchase_return_items", head: "purchase_returns", fk: "purchase_return_id", pk: "id" },
};
const TYPES = Object.keys(DOC);

/* A column name that points at another document's LINE. Longest needle first so
   `purchase_order_item_id` is never read as `purchase_order_id`. Header links
   are deliberately absent: this file is about LINE identity. */
const LINE_HINT = [
  ["purchase_invoice_item_id", "PI"],
  ["purchase_order_item_id", "PO"],
  ["sales_invoice_item_id", "SI"],
  ["delivery_order_item_id", "DO"],
  ["do_item_id", "DO"],
  ["grn_item_id", "GR"],
  ["so_item_id", "SO"],
  ["po_item_id", "PO"],
  ["si_item_id", "SI"],
  ["pi_item_id", "PI"],
];

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* Item codes are compared the way a human would read them: trimmed, upper-cased,
   inner whitespace collapsed. Anything looser would hide a real mismatch;
   anything stricter reports formatting as a wrong product. */
const NORM = (expr) => `upper(regexp_replace(btrim(coalesce(${expr}, '')), '\\s+', ' ', 'g'))`;

/* THE COLOUR IS NOT `colourCode`. The first run of this probe compared
   `variants->>'colourCode'` and found 0 comparable pairs on every edge — which
   is an EMPTY answer, not a clean one, and would have read as "no colour is
   ever wrong". The importers write `colourId` (the fabric-colour row) and
   `colourLabel` (the text) — import-ac-outstanding-so.mjs:302. Both are read,
   id first, so a row carrying either is comparable, and the count of comparable
   pairs is printed so an empty answer can never pass as a clean one again. */
const COL = (a) => `upper(btrim(coalesce(${a}.variants->>'colourId', ${a}.variants->>'colourLabel', ${a}.variants->>'colourCode', '')))`;

/* THE MODEL, not the item code. Section 3 asks whether the rows sharing ONE
   AutoCount DtlKey are a sofa's compartments (expected: one book line becomes
   several ERP lines) or a genuine collision. The first version of that split
   asked "do they name DIFFERENT item codes" and answered 295 of 296 and 98 of
   98 — a worthless answer, because a sofa's compartments ALWAYS have different
   item codes: MODEL-1S, MODEL-2S, MODEL-CNR. The discriminator answered a
   different question from the one asked, the same mistake as the `colourCode`
   one a layer down, and docs/bugs/0672 records it as UNKNOWN rather than
   quietly repairing it.

   What actually separates the two cases is the MODEL — the code before the
   first dash. Compartments of one sofa share it; two unrelated products do not.
   A second and stronger discriminator is printed beside it: whether the rows
   sharing a key sit on MORE THAN ONE DOCUMENT. A sofa's compartments are all
   lines of the same order, so a key spanning two documents is wrong whatever
   the model says, and that test does not depend on the naming convention
   holding. */
const MODEL = (expr) => `split_part(${NORM(expr)}, '-', 1)`;

async function columnsOf(tables) {
  const rows = await sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ANY(${tables})`;
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Set());
    map.get(r.table_name).add(r.column_name);
  }
  return map;
}

async function main() {
  const lineTables = TYPES.map((t) => DOC[t].line);
  const headTables = TYPES.map((t) => DOC[t].head);
  const cols = await columnsOf([...lineTables, ...headTables]);

  const missingTables = [...lineTables, ...headTables].filter((t) => !cols.has(t));
  if (missingTables.length) log(`TABLES NOT PRESENT (skipped): ${missingTables.join(", ")}`);

  /* Discover the edges. */
  const edges = [];
  const unusable = [];
  for (const t of TYPES) {
    const child = DOC[t];
    const have = cols.get(child.line);
    if (!have) continue;
    for (const [needle, parentType] of LINE_HINT) {
      if (!have.has(needle)) continue;
      if (parentType === t) continue; // a self-reference is not a cross-document link
      const parent = DOC[parentType];
      if (!cols.has(parent.line)) continue;
      const bothHaveItem = have.has("item_code") && cols.get(parent.line).has("item_code");
      const edge = { t, parentType, table: child.line, column: needle, parentTable: parent.line, headTable: child.head, headFk: child.fk, headPk: child.pk };
      if (bothHaveItem) edges.push(edge);
      else unusable.push(`${child.line}.${needle} -> ${parent.line} (one side has no item_code)`);
    }
  }

  log("=== 1. ITEM DISAGREEMENT — the link is filled, the parent exists,");
  log("       and the two rows name a DIFFERENT PRODUCT ===");
  log("");
  const edgeResults = [];
  for (const e of edges) {
    let row;
    try {
      const rows = await sql.unsafe(`
        SELECT COUNT(*)::int                                                    AS total,
               COUNT(c.${e.column})::int                                        AS filled,
               COUNT(*) FILTER (WHERE c.${e.column} IS NULL)::int               AS nulls,
               COUNT(*) FILTER (WHERE c.${e.column} IS NOT NULL AND p.id IS NULL)::int AS dangling,
               COUNT(*) FILTER (WHERE p.id IS NOT NULL
                                 AND ${NORM("c.item_code")} <> ${NORM("p.item_code")})::int AS mismatch
          FROM scm.${e.table} c
          LEFT JOIN scm.${e.parentTable} p ON p.id = c.${e.column}`);
      row = rows[0];
    } catch (err) {
      log(`   ${e.t}->${e.parentType}  ${e.table}.${e.column}  — NOT COUNTABLE: ${String(err.message).slice(0, 100)}`);
      continue;
    }
    edgeResults.push({ ...e, ...row });
    const verdict = row.mismatch > 0 ? `MISMATCH ${row.mismatch}` : "clean";
    log(`   ${e.t}->${e.parentType}  ${e.table}.${e.column}`);
    log(`        ${row.filled} linked of ${row.total} rows (${row.nulls} carry no link) · dangling ${row.dangling} · ${verdict}`);
  }
  if (unusable.length) {
    log("");
    log("   NOT COMPARABLE BY ITEM CODE (reported, not dropped):");
    for (const u of unusable) log(`      ${u}`);
  }

  log("");
  log("=== 2. THE SWAP SIGNATURE — inside ONE document, are the children's item");
  log("       codes a PERMUTATION of their parents'? That is positional pairing ===");
  log("");
  for (const e of edgeResults) {
    if (!e.mismatch) {
      log(`   ${e.t}->${e.parentType}  ${e.table}.${e.column}  — no mismatch, nothing to shape`);
      continue;
    }
    try {
      const rows = await sql.unsafe(`
        WITH pairs AS (
          SELECT c.${e.headFk}                AS doc,
                 ${NORM("c.item_code")}       AS child_code,
                 ${NORM("p.item_code")}       AS parent_code
            FROM scm.${e.table} c
            JOIN scm.${e.parentTable} p ON p.id = c.${e.column}
        ),
        docs AS (
          SELECT doc,
                 COUNT(*) FILTER (WHERE child_code <> parent_code)::int AS wrong,
                 array_agg(child_code  ORDER BY child_code)  AS child_multiset,
                 array_agg(parent_code ORDER BY parent_code) AS parent_multiset
            FROM pairs GROUP BY doc
        )
        SELECT COUNT(*) FILTER (WHERE wrong > 0)::int                                      AS docs_with_wrong,
               COUNT(*) FILTER (WHERE wrong > 0 AND child_multiset = parent_multiset)::int AS docs_perfect_permutation,
               COALESCE(SUM(wrong) FILTER (WHERE wrong > 0 AND child_multiset = parent_multiset), 0)::int AS rows_in_permutation
          FROM docs`);
      const r = rows[0];
      log(`   ${e.t}->${e.parentType}  ${e.table}.${e.column}`);
      log(`        ${r.docs_with_wrong} documents carry a wrong pairing;`);
      log(`        ${r.docs_perfect_permutation} of them are a PERFECT PERMUTATION (${r.rows_in_permutation} rows) — positional pairing;`);
      log(`        ${r.docs_with_wrong - r.docs_perfect_permutation} are not a permutation — the parent is a product the document does not even order.`);
    } catch (err) {
      log(`   ${e.t}->${e.parentType}  ${e.table}.${e.column}  — SHAPE NOT COUNTABLE: ${String(err.message).slice(0, 100)}`);
    }
  }

  log("");
  log("=== 3. THE AUTOCOUNT LINE KEY IS NOT UNIQUE — 0273/0280 index");
  log("       linked_ac_dtlkey NON-uniquely, so a Map keyed by it keeps ONE row ===");
  log("");
  for (const t of TYPES) {
    const d = DOC[t];
    const have = cols.get(d.line);
    if (!have?.has("linked_ac_dtlkey")) {
      log(`   ${t}  ${d.line}  — no linked_ac_dtlkey column`);
      continue;
    }
    const headHasCompany = cols.get(d.head)?.has("company_id");
    try {
      const rows = await sql.unsafe(`
        WITH k AS (
          SELECT c.linked_ac_dtlkey AS dtlkey, ${NORM("c.item_code")} AS code,
                 ${MODEL("c.item_code")} AS model, c.${d.fk} AS doc${headHasCompany ? `, h.company_id` : ``}
            FROM scm.${d.line} c
            JOIN scm.${d.head} h ON h.${d.pk} = c.${d.fk}
           WHERE c.linked_ac_dtlkey IS NOT NULL
        ),
        dup AS (
          SELECT dtlkey,
                 COUNT(*)::int                   AS n,
                 COUNT(DISTINCT code)::int       AS codes,
                 COUNT(DISTINCT model)::int      AS models,
                 COUNT(DISTINCT doc)::int        AS docs
            FROM k GROUP BY dtlkey HAVING COUNT(*) > 1
        )
        SELECT (SELECT COUNT(*) FROM scm.${d.line})::int                       AS total,
               (SELECT COUNT(*) FROM k)::int                                   AS keyed,
               (SELECT COUNT(*) FROM dup)::int                                 AS dup_keys,
               (SELECT COALESCE(SUM(n), 0) FROM dup)::int                      AS dup_rows,
               (SELECT COUNT(*) FROM dup WHERE codes > 1)::int                 AS dup_keys_diff_code,
               (SELECT COUNT(*) FROM dup WHERE models = 1)::int                AS dup_keys_one_model,
               (SELECT COUNT(*) FROM dup WHERE models > 1)::int                AS dup_keys_many_models,
               (SELECT COALESCE(SUM(n), 0) FROM dup WHERE models > 1)::int     AS dup_rows_many_models,
               (SELECT COUNT(*) FROM dup WHERE docs > 1)::int                  AS dup_keys_many_docs,
               (SELECT COALESCE(SUM(n), 0) FROM dup WHERE docs > 1)::int       AS dup_rows_many_docs,
               (SELECT COALESCE(MAX(n), 0) FROM dup)::int                      AS dup_max_group
               ${headHasCompany ? `,
               (SELECT COUNT(*) FROM (SELECT dtlkey FROM k GROUP BY dtlkey HAVING COUNT(DISTINCT company_id) > 1) z)::int AS cross_company_keys` : ``}`);
      const r = rows[0];
      log(`   ${t}  ${d.line}`);
      log(`        ${r.keyed} of ${r.total} rows carry an AutoCount DtlKey`);
      log(`        ${r.dup_keys} DtlKeys are carried by more than one row (${r.dup_rows} rows, largest group ${r.dup_max_group})`);
      log(`        ... ${r.dup_keys_diff_code} of those carry rows naming different ITEM CODES — which decides NOTHING, see below`);
      log(`        SAME MODEL (code before the first dash agrees): ${r.dup_keys_one_model} keys — one book line expanded into a sofa's compartments, BY DESIGN`);
      log(`        DIFFERENT MODELS: ${r.dup_keys_many_models} keys (${r.dup_rows_many_models} rows) — a genuine collision; every Map keyed by DtlKey is a coin flip on these`);
      log(`        SPANNING MORE THAN ONE DOCUMENT: ${r.dup_keys_many_docs} keys (${r.dup_rows_many_docs} rows) — a sofa's compartments are all on ONE document, so any of these is wrong regardless of model`);
      if (headHasCompany) log(`        ${r.cross_company_keys} DtlKeys appear under MORE THAN ONE company — each company has its own book, so any of these is wrong`);
      else log(`        (company not counted: ${d.head} has no company_id)`);
    } catch (err) {
      log(`   ${t}  ${d.line}  — NOT COUNTABLE: ${String(err.message).slice(0, 100)}`);
    }
  }

  log("");
  log("=== 4. THE SOFA COLOUR — the same permutation test on the colour in `variants` ===");
  log("");
  for (const e of edgeResults) {
    const childHasVariants = cols.get(e.table)?.has("variants");
    const parentHasVariants = cols.get(e.parentTable)?.has("variants");
    if (!childHasVariants || !parentHasVariants) {
      log(`   ${e.t}->${e.parentType}  ${e.table}.${e.column}  — one side has no variants column`);
      continue;
    }
    try {
      const rows = await sql.unsafe(`
        WITH pairs AS (
          SELECT c.${e.headFk} AS doc,
                 ${COL("c")} AS child_col,
                 ${COL("p")} AS parent_col
            FROM scm.${e.table} c
            JOIN scm.${e.parentTable} p ON p.id = c.${e.column}
           WHERE ${COL("c")} <> '' AND ${COL("p")} <> ''
        ),
        docs AS (
          SELECT doc,
                 COUNT(*)::int AS pairs,
                 COUNT(*) FILTER (WHERE child_col <> parent_col)::int AS wrong,
                 array_agg(child_col  ORDER BY child_col)  AS child_multiset,
                 array_agg(parent_col ORDER BY parent_col) AS parent_multiset
            FROM pairs GROUP BY doc
        )
        SELECT COALESCE(SUM(pairs), 0)::int                                                AS comparable_pairs,
               COALESCE(SUM(wrong), 0)::int                                                AS wrong_rows,
               COUNT(*) FILTER (WHERE wrong > 0)::int                                      AS docs_with_wrong,
               COUNT(*) FILTER (WHERE wrong > 0 AND child_multiset = parent_multiset)::int AS docs_perfect_permutation
          FROM docs`);
      const r = rows[0];
      log(`   ${e.t}->${e.parentType}  ${e.table}.${e.column}`);
      log(`        ${r.comparable_pairs} pairs where BOTH sides carry a colour code`);
      log(`        ${r.wrong_rows} rows disagree, across ${r.docs_with_wrong} documents`);
      log(`        ${r.docs_perfect_permutation} of those documents are a PERFECT COLOUR PERMUTATION — an exact swap`);
    } catch (err) {
      log(`   ${e.t}->${e.parentType}  ${e.table}.${e.column}  — COLOUR NOT COUNTABLE: ${String(err.message).slice(0, 100)}`);
    }
  }

  log("");
  log("WHAT THIS DOES NOT ANSWER. It compares OUR two sides only. A link that is");
  log("missing entirely (the NULL column above) is a COVERAGE question and this");
  log("file cannot see whether the missing one would have been right. And a pair");
  log("that agrees with itself can still BOTH disagree with AutoCount — that needs");
  log("the book, which is check-ac-erp-reconcile's job, not this one's.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
