#!/usr/bin/env node
// Read-only: WHICH sales orders does `linked_ac_docno IS NOT NULL` actually
// name? The measurement behind docs/bugs/0703.
//
// THE COLUMN CARRIES TWO POPULATIONS and the migrated-SO lock wants one:
//
//   1. CARRIED OVER by the 2026-08 cutover import. `import-ac-outstanding-so.mjs`
//      builds `docNo: "HC-" + acDoc` (:338), so `doc_no` differs from
//      `linked_ac_docno` by exactly a prefix ending in `-`.
//   2. PUSHED TO AutoCount by our own write-back. `autocount-outbox.ts:1902`
//      stamps the same column on a document the ERP created, with the number
//      the ERP sent — so `doc_no` and `linked_ac_docno` are EQUAL.
//
// This prints the split, and the third bucket — NEITHER equal nor prefixed — is
// the whole question. A write-back where AutoCount assigned its OWN, different
// number lands there, and a shape rule would silently call it a cutover
// document. If that bucket is empty the shape is exact; if it is not, every one
// of its rows is named here rather than counted.
//
// IT ALSO MEASURES THE SECOND SIGNAL, so the choice is not made from reading:
// `scm.autocount_outbox` op='create_so' is the ERP saying "I created this and
// sent it". Rows are never deleted from that table (0277's COMMENT; the
// 2026-09-08 archive migration added a COLUMN precisely so nothing is), so it
// is durable. The cross-tab at the end is the refutation test: if the shape
// verdict and the outbox verdict disagree on any document, the shape rule is
// not exact and this script names the documents rather than the count.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer, including "nothing yet" — a red job would read as "the
// check broke". Only an unreachable database exits non-zero.
//
// RE-RUN: safe, and expected — it is a snapshot, so re-read it at the moment
// you quote it.
//
// Usage:
//   node scripts/check-so-migrated-shape.mjs
//   COMPANY_ID=2 node scripts/check-so-migrated-shape.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";
/* THE RULE, from its one home - the same module the middleware decides with.
   The first version of this script expressed the shape a second time, in SQL.
   That was a copy, and a copy of a rule inside the very check that is supposed
   to police the rule is the hardest place for a drift to be noticed. The
   independent signal here is the OUTBOX, below, not a second parse. */
import { soNumberShape, soIsMigratedShape } from "../src/scm/lib/so-is-migrated.ts";

const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) {
  console.error(`COMPANY_ID must be a positive integer; got ${JSON.stringify(process.env.COMPANY_ID)}`);
  process.exit(1);
}
/* The two documents docs/bugs/0703 names, pinned here so the run that decides
   the fix prints them by name instead of leaving the reader to trust a count.
   Overridable, because the second one is only an EXAMPLE of a cutover order. */
const PIN = (process.env.PINNED || "HC-SO-2609-001,HC-SO-013361")
  .split(",").map((s) => s.trim()).filter(Boolean);

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

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARNING: ${m}`);
const myt = (d) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour12: false }) : "-");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`check-so-migrated-shape — company ${COMPANY_ID}, read-only`);
  log("");

  /* ONE read of the header pairs, classified in JS by the shared rule. */
  const headers = await sql`
    SELECT doc_no, status, linked_ac_docno, created_at
      FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY_ID}
     ORDER BY created_at`;
  const shaped = headers.map((r) => ({ ...r, shape: soNumberShape(r.doc_no, r.linked_ac_docno) }));
  const linked = shaped.filter((r) => r.shape !== "no-book-number");
  const migrated = shaped.filter((r) => soIsMigratedShape(r.doc_no, r.linked_ac_docno));

  log(`SALES ORDERS (company ${COMPANY_ID}): ${headers.length}`);
  log(`  linked_ac_docno IS NOT NULL — the OLD predicate's "migrated": ${linked.length}`);
  log(`  linked_ac_docno IS NULL     — the OLD predicate's "new":      ${headers.length - linked.length}`);
  log(`  came FROM AutoCount — what the guard decides today:           ${migrated.length}`);
  log(`  the ERP's own — new orders, written back or not:              ${headers.length - migrated.length}`);
  log("");

  /* THE THREE BUCKETS. The third is the answer to whether the shape rule is
     safe, so it is measured before anything is concluded from the first two. */
  const of = (k) => linked.filter((r) => r.shape === k);
  log("SHAPE OF linked_ac_docno AGAINST doc_no");
  for (const k of ["equal", "prefixed", "neither"]) {
    const rows = of(k);
    const what = k === "equal" ? "the ERP's own number went to the book -> WRITE-BACK"
      : k === "prefixed" ? "doc_no is a prefix + the book number -> CUTOVER IMPORT"
      : "NEITHER — the shape rule cannot classify these";
    log(`  ${k.padEnd(9)} ${String(rows.length).padStart(6)}   ${what}`);
    if (rows.length) {
      log(`  ${" ".repeat(9)}        created ${myt(rows[0].created_at)} .. ${myt(rows[rows.length - 1].created_at)} MYT`);
    }
  }
  log("");

  /* WHICH prefixes, and how many of each. A rule that assumed `HC-` would be
     wrong the day a company is added; this is the check that the assumption is
     not silently load-bearing. */
  const prefixes = new Map();
  for (const r of of("prefixed")) {
    const erp = String(r.doc_no).trim();
    const pre = erp.slice(0, erp.length - String(r.linked_ac_docno).trim().length);
    prefixes.set(pre, (prefixes.get(pre) ?? 0) + 1);
  }
  log(`PREFIXES IN USE (${prefixes.size}):`);
  for (const [pre, n] of [...prefixes].sort((a, b) => b[1] - a[1])) log(`  ${JSON.stringify(pre)}  ${n}`);
  log("");

  /* Did the ERP itself create each document and send it? The outbox is
     append-only, so this is a durable fact and not a snapshot of a queue — and
     it is INDEPENDENT of the numbers, which is what makes it worth comparing. */
  const created = new Set(
    (await sql`SELECT DISTINCT lower(btrim(doc_no)) AS d FROM scm.autocount_outbox
                WHERE doc_type = 'SO' AND op = 'create_so'`).map((r) => r.d),
  );
  const erpCreated = (r) => created.has(String(r.doc_no).trim().toLowerCase());

  /* THE THIRD BUCKET, NAMED. A count here would be the thing this script
     exists to refuse: these are the documents the shape rule cannot place. */
  const neither = of("neither");
  if (neither.length === 0) {
    log("THIRD BUCKET IS EMPTY — every linked order is either equal or prefixed.");
    log("  The shape rule classifies the whole corpus with nothing left over.");
  } else {
    warn(`THIRD BUCKET: ${neither.length} document(s) the shape rule cannot classify:`);
    for (const r of neither.slice(0, 200)) {
      warn(`  ${r.doc_no}  book=${JSON.stringify(r.linked_ac_docno)}  ${r.status}`
        + `  created ${myt(r.created_at)} MYT  erp_created_outbox=${erpCreated(r)}`);
    }
    warn("  They LOCK, deliberately — see so-is-migrated.ts. Read every one of them.");
  }
  log("");

  /* THE CROSS-TAB — the refutation test. The shape and the outbox are two
     INDEPENDENT answers to "did the ERP originate this document". Where they
     disagree, at most one is right and neither may be trusted without an
     explanation for the disagreement. */
  const cross = new Map();
  for (const r of linked) {
    const k = `${r.shape}|${erpCreated(r)}`;
    cross.set(k, (cross.get(k) ?? 0) + 1);
  }
  log("CROSS-TAB  shape  x  has an outbox create_so row (the ERP created and sent it)");
  for (const [k, n] of [...cross].sort()) {
    const [shape, erp] = k.split("|");
    log(`  ${shape.padEnd(9)} erp_created=${erp.padEnd(5)} ${String(n).padStart(6)}`);
  }

  const disagree = linked.filter((r) => (r.shape === "equal") !== erpCreated(r));
  log("");
  if (disagree.length === 0) {
    log("THE TWO SIGNALS AGREE on every linked order: shape='equal' exactly where an");
    log("  outbox create_so row exists. Either can be used to name the cutover population.");
  } else {
    warn(`THE TWO SIGNALS DISAGREE on ${disagree.length} document(s):`);
    for (const r of disagree.slice(0, 100)) {
      warn(`  ${r.doc_no}  book=${JSON.stringify(r.linked_ac_docno)}  shape=${r.shape}`
        + `  erp_created_outbox=${erpCreated(r)}  created ${myt(r.created_at)} MYT`);
    }
    warn("  Read each one before trusting either signal. A document the ERP created but");
    warn("  whose number AutoCount changed is the case that makes the shape rule unsafe.");
  }
  log("");

  const pendingSend = shaped.filter((r) => r.shape === "no-book-number" && erpCreated(r));
  log(`ERP-created, outbox row exists, NOT yet stamped: ${pendingSend.length}`);
  log("  (before docs/bugs/0703 these were the orders that shut the moment the write-back");
  log("   succeeded; they stay open now, which is what this check re-proves)");
  log("");

  /* THE PINNED DOCUMENTS — the two the fix has to get right, by name. */
  log("PINNED DOCUMENTS");
  const pins = await sql`
    SELECT so.doc_no, so.linked_ac_docno, so.status, so.created_at, so.company_id
      FROM scm.mfg_sales_orders so
     WHERE so.doc_no = ANY(${PIN})`;
  for (const d of PIN) {
    const r = pins.find((x) => x.doc_no === d);
    if (!r) { warn(`  ${d}  NOT FOUND`); continue; }
    log(`  ${r.doc_no}  company=${r.company_id}  book=${JSON.stringify(r.linked_ac_docno)}`);
    log(`      shape=${soNumberShape(r.doc_no, r.linked_ac_docno)}`
      + `  MIGRATED=${soIsMigratedShape(r.doc_no, r.linked_ac_docno)}`
      + `  erp_created_outbox=${erpCreated(r)}  ${r.status}  created ${myt(r.created_at)} MYT`);
  }
  log("");

  const pinOutbox = await sql`
    SELECT o.doc_no, o.op, o.status, o.ac_doc_no, o.created_at
      FROM scm.autocount_outbox o
     WHERE o.doc_no = ANY(${PIN})
     ORDER BY o.doc_no, o.created_at`;
  log(`OUTBOX ROWS FOR THE PINNED DOCUMENTS (${pinOutbox.length}):`);
  for (const r of pinOutbox) {
    log(`  ${r.doc_no}  ${r.op}  ${r.status}  ac_doc_no=${JSON.stringify(r.ac_doc_no)}  ${myt(r.created_at)} MYT`);
  }

  log("");
  log("read-only: this script never writes.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
