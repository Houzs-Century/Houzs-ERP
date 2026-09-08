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

const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) {
  console.error(`COMPANY_ID must be a positive integer; got ${JSON.stringify(process.env.COMPANY_ID)}`);
  process.exit(1);
}
/* The documents docs/bugs/0703 names, pinned here so the run that decides the
   fix prints them by name instead of leaving the reader to trust a count.

   IT USED TO PIN HC-SO-2609-001 TOO, and that document no longer exists: it was
   DELETED from the ERP on 2026-09-08 at the owner's instruction — a test order,
   《把SO2609-001 删掉 这是测试单来的》. Leaving it pinned would print
   "NOT FOUND" as a ::warning:: on every future run, which reads as an anomaly
   rather than as a document somebody removed on purpose.

   It is NOT replaced by another live write-back example, because on the day it
   was deleted there was no second one: the 'equal' bucket held exactly 1 of
   2,883 (run 34214516108, measured again by 34220096163). That bucket is
   printed above and is the honest, self-updating answer — when the ERP next
   creates and sends an order, 'equal' becomes 1 again on its own and this pin
   does not have to be edited for the probe to tell the truth.

   The SHAPE rule is still pinned by name on BOTH documents, in
   backend/tests/soIsMigratedShape.test.ts — a pure function needs no live row.

   Ledger: docs/bugs/0715-deleting-a-sales-order-trusted-a-hand-written-child-list-nob.md

   Overridable: the remaining one is only an EXAMPLE of a cutover order. */
const PIN = (process.env.PINNED || "HC-SO-013361")
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

/* The shape verdict, in SQL, matching frontend/src/lib/autocountRegister.ts
   exactly: trimmed and case-folded, and a prefix must END AT A SEPARATOR so
   that `SO-013361` cannot "match" its own suffix. Written once here and reused
   by every query below, so the buckets cannot disagree with each other. */
const SHAPE = () => sql`
  CASE
    WHEN lower(btrim(so.linked_ac_docno)) = lower(btrim(so.doc_no)) THEN 'equal'
    WHEN length(btrim(so.doc_no)) > length(btrim(so.linked_ac_docno))
     AND right(lower(btrim(so.doc_no)), length(btrim(so.linked_ac_docno)) + 1)
         = '-' || lower(btrim(so.linked_ac_docno)) THEN 'prefixed'
    ELSE 'neither'
  END`;

/* Did the ERP itself create this document and send it? The outbox is
   append-only, so this is a durable fact and not a snapshot of a queue. */
const HAS_CREATE = () => sql`
  EXISTS (SELECT 1 FROM scm.autocount_outbox o
           WHERE o.doc_type = 'SO' AND o.op = 'create_so'
             AND lower(btrim(o.doc_no)) = lower(btrim(so.doc_no)))`;

async function main() {
  log(`check-so-migrated-shape — company ${COMPANY_ID}, read-only`);
  log("");

  const [totals] = await sql`
    SELECT count(*)::int AS all_so,
           count(*) FILTER (WHERE so.linked_ac_docno IS NOT NULL)::int AS linked,
           count(*) FILTER (WHERE so.linked_ac_docno IS NULL)::int     AS unlinked
      FROM scm.mfg_sales_orders so
     WHERE so.company_id = ${COMPANY_ID}`;
  log(`SALES ORDERS (company ${COMPANY_ID}): ${totals.all_so}`);
  log(`  linked_ac_docno IS NOT NULL — what the lock calls "migrated" today: ${totals.linked}`);
  log(`  linked_ac_docno IS NULL     — what it calls "new" today:            ${totals.unlinked}`);
  log("");

  /* THE THREE BUCKETS. The third is the answer to whether the shape rule is
     safe, so it is measured before anything is concluded from the first two. */
  const buckets = await sql`
    SELECT ${SHAPE()} AS shape,
           count(*)::int AS n,
           min(so.created_at) AS oldest,
           max(so.created_at) AS newest
      FROM scm.mfg_sales_orders so
     WHERE so.company_id = ${COMPANY_ID} AND so.linked_ac_docno IS NOT NULL
     GROUP BY 1 ORDER BY 1`;
  const byShape = new Map(buckets.map((b) => [b.shape, b]));
  const n = (k) => byShape.get(k)?.n ?? 0;

  log("SHAPE OF linked_ac_docno AGAINST doc_no");
  for (const k of ["equal", "prefixed", "neither"]) {
    const b = byShape.get(k);
    const what = k === "equal" ? "the ERP's own number went to the book -> WRITE-BACK"
      : k === "prefixed" ? "doc_no is a prefix + the book number -> CUTOVER IMPORT"
      : "NEITHER — the shape rule cannot classify these";
    log(`  ${k.padEnd(9)} ${String(b?.n ?? 0).padStart(6)}   ${what}`);
    if (b) log(`  ${" ".repeat(9)}        created ${myt(b.oldest)} .. ${myt(b.newest)} MYT`);
  }
  log("");

  /* WHICH prefixes, and how many of each. A rule that assumed `HC-` would be
     wrong the day a company is added; this is the check that the assumption is
     not silently load-bearing. */
  const prefixes = await sql`
    SELECT left(btrim(so.doc_no), length(btrim(so.doc_no)) - length(btrim(so.linked_ac_docno))) AS prefix,
           count(*)::int AS n
      FROM scm.mfg_sales_orders so
     WHERE so.company_id = ${COMPANY_ID} AND so.linked_ac_docno IS NOT NULL
       AND ${SHAPE()} = 'prefixed'
     GROUP BY 1 ORDER BY 2 DESC`;
  log(`PREFIXES IN USE (${prefixes.length}):`);
  for (const p of prefixes) log(`  ${JSON.stringify(p.prefix)}  ${p.n}`);
  log("");

  /* THE THIRD BUCKET, NAMED. A count here would be the thing this script
     exists to refuse: these are the documents a shape rule would misfile. */
  const neither = await sql`
    SELECT so.doc_no, so.linked_ac_docno, so.status, so.created_at, ${HAS_CREATE()} AS erp_created
      FROM scm.mfg_sales_orders so
     WHERE so.company_id = ${COMPANY_ID} AND so.linked_ac_docno IS NOT NULL
       AND ${SHAPE()} = 'neither'
     ORDER BY so.created_at DESC
     LIMIT 200`;
  if (neither.length === 0) {
    log("THIRD BUCKET IS EMPTY — every linked order is either equal or prefixed.");
    log("  The shape rule classifies the whole corpus with nothing left over.");
  } else {
    warn(`THIRD BUCKET: ${n("neither")} document(s) the shape rule cannot classify (showing ${neither.length}):`);
    for (const r of neither) {
      warn(`  ${r.doc_no}  book=${JSON.stringify(r.linked_ac_docno)}  ${r.status}`
        + `  created ${myt(r.created_at)} MYT  erp_created_outbox=${r.erp_created}`);
    }
  }
  log("");

  /* THE CROSS-TAB — the refutation test. The shape rule and the outbox are two
     independent answers to "did the ERP originate this document". Where they
     disagree, at most one of them is right and neither may be shipped without
     an explanation for the disagreement. */
  const cross = await sql`
    SELECT ${SHAPE()} AS shape, ${HAS_CREATE()} AS erp_created, count(*)::int AS n
      FROM scm.mfg_sales_orders so
     WHERE so.company_id = ${COMPANY_ID} AND so.linked_ac_docno IS NOT NULL
     GROUP BY 1, 2 ORDER BY 1, 2`;
  log("CROSS-TAB  shape  x  has an outbox create_so row (the ERP created and sent it)");
  for (const r of cross) {
    log(`  ${String(r.shape).padEnd(9)} erp_created=${String(r.erp_created).padEnd(5)} ${String(r.n).padStart(6)}`);
  }

  const disagree = await sql`
    SELECT so.doc_no, so.linked_ac_docno, so.created_at, ${SHAPE()} AS shape, ${HAS_CREATE()} AS erp_created
      FROM scm.mfg_sales_orders so
     WHERE so.company_id = ${COMPANY_ID} AND so.linked_ac_docno IS NOT NULL
       AND ((${SHAPE()} = 'equal') <> ${HAS_CREATE()})
     ORDER BY so.created_at DESC
     LIMIT 100`;
  log("");
  if (disagree.length === 0) {
    log("THE TWO SIGNALS AGREE on every linked order: shape='equal' exactly where an");
    log("  outbox create_so row exists. Either can be used to name the cutover population.");
  } else {
    warn(`THE TWO SIGNALS DISAGREE on ${disagree.length} document(s) (capped at 100):`);
    for (const r of disagree) {
      warn(`  ${r.doc_no}  book=${JSON.stringify(r.linked_ac_docno)}  shape=${r.shape}`
        + `  erp_created_outbox=${r.erp_created}  created ${myt(r.created_at)} MYT`);
    }
    warn("  Read each one before choosing a signal. A document the ERP created but whose");
    warn("  number AutoCount changed is the case that makes the shape rule unsafe.");
  }
  log("");

  /* ERP-ORIGINATED AND NOT YET IN THE BOOK — the population that is open today
     only because the write-back has not run yet. It is the same documents the
     lock is about to shut, seen one step earlier. */
  const [pending] = await sql`
    SELECT count(*)::int AS n
      FROM scm.mfg_sales_orders so
     WHERE so.company_id = ${COMPANY_ID} AND so.linked_ac_docno IS NULL AND ${HAS_CREATE()}`;
  log(`ERP-created, outbox row exists, NOT yet stamped: ${pending.n}`);
  log("  (these are open today and would shut the moment the write-back succeeds)");
  log("");

  /* THE PINNED DOCUMENTS — the two the fix has to get right, by name. */
  log("PINNED DOCUMENTS");
  const pins = await sql`
    SELECT so.doc_no, so.linked_ac_docno, so.status, so.created_at, so.company_id,
           ${SHAPE()} AS shape, ${HAS_CREATE()} AS erp_created
      FROM scm.mfg_sales_orders so
     WHERE so.doc_no = ANY(${PIN})`;
  for (const d of PIN) {
    const r = pins.find((p) => p.doc_no === d);
    if (!r) { warn(`  ${d}  NOT FOUND`); continue; }
    log(`  ${r.doc_no}  company=${r.company_id}  book=${JSON.stringify(r.linked_ac_docno)}`);
    log(`      shape=${r.shape}  erp_created_outbox=${r.erp_created}  ${r.status}  created ${myt(r.created_at)} MYT`);
  }
  log("");

  /* The outbox rows for the pinned documents, so a disagreement on one of them
     can be read rather than guessed at. */
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
