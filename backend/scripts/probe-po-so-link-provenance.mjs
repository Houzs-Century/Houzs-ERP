#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. WHY A PURCHASE-ORDER LINE CARRIES NO SALES-ORDER LINK.
//
// The 36-cell matrix (probe-doc-link-matrix.mjs) reported PO->SO at 1005/1301
// lines, and 77% was left standing as "unverified whether the rest are
// legitimate stock-buys". That number is measured against the WRONG artifact.
//
// Mig 0235 says so in its own words: a PO line serving several customers has NO
// correct single-valued `so_item_id`, so the answer moved to
// scm.purchase_order_item_allocations, where the allocations "SUPERSEDE the
// line's own so_item_id wherever both exist" and `so_item_id IS NULL on an
// allocation = for stock". Counting the column alone therefore reports a
// consolidated line as unlinked and a deliberate stock buy as a gap.
//
// This classifies every line with no `so_item_id` into WHY, so the residue is
// the only thing anyone has to look at:
//
//   ALLOCATED-TO-SO   allocations exist and name at least one customer line
//                     -> LINKED. The matrix could not see it.
//   ALLOCATED-STOCK   allocations exist and every one is so_item_id NULL
//                     -> a deliberate stock buy, stated explicitly.
//   STOCK-BUY         no allocations, and the PO is not a customer-driven one
//                     -> the ordinary replenishment case.
//   UNATTRIBUTED      none of the above. THIS is the residue worth reading.
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Counts and reason
// codes only — no document numbers, no customer, no supplier, no amount.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction.
//
//   DATABASE_URL   required
//
// RE-RUN: idempotent and side-effect free. Safe to run any number of times.
// ----------------------------------------------------------------------------
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 10 });

/* PRE-FLIGHT (docs/bugs/0599): a probe that cannot execute its own read must
   say so and stop, never print a clean-looking zero. */
const need = ["purchase_order_items", "purchase_order_item_allocations", "purchase_orders"];
const present = (await sql`
  SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'scm' AND table_name = ANY(${need})`).map((r) => r.table_name);
const missing = need.filter((t) => !present.includes(t));
if (missing.length) {
  console.error(`PRE-FLIGHT FAILED — scm tables absent: ${missing.join(", ")}`);
  await sql.end(); process.exit(3);
}

try {
  const rows = await sql`
    WITH line AS (
      SELECT poi.id, poi.company_id, poi.so_item_id,
             (SELECT count(*) FROM scm.purchase_order_item_allocations a
               WHERE a.purchase_order_item_id = poi.id)                        AS alloc_n,
             (SELECT count(*) FROM scm.purchase_order_item_allocations a
               WHERE a.purchase_order_item_id = poi.id
                 AND a.so_item_id IS NOT NULL)                                 AS alloc_so_n,
             (SELECT count(*) FROM scm.purchase_order_items sib
               WHERE sib.purchase_order_id = poi.purchase_order_id
                 AND sib.so_item_id IS NOT NULL)                               AS doc_so_lines
        FROM scm.purchase_order_items poi
    )
    SELECT company_id,
           CASE
             WHEN so_item_id IS NOT NULL              THEN 'DIRECT-SO-LINK'
             WHEN alloc_so_n > 0                      THEN 'ALLOCATED-TO-SO'
             WHEN alloc_n   > 0                       THEN 'ALLOCATED-STOCK'
             WHEN doc_so_lines = 0                    THEN 'STOCK-BUY'
             ELSE                                          'UNATTRIBUTED'
           END AS reason,
           count(*)::int AS n
      FROM line
     GROUP BY 1, 2
     ORDER BY 1, 3 DESC`;

  const total = rows.reduce((a, r) => a + r.n, 0);
  const by = (k) => rows.filter((r) => r.reason === k).reduce((a, r) => a + r.n, 0);
  const linked = by("DIRECT-SO-LINK") + by("ALLOCATED-TO-SO");
  const stock  = by("ALLOCATED-STOCK") + by("STOCK-BUY");

  log(`PO LINES: ${total}`);
  log("");
  log("  BY REASON (whole system, both companies)");
  for (const k of ["DIRECT-SO-LINK", "ALLOCATED-TO-SO", "ALLOCATED-STOCK", "STOCK-BUY", "UNATTRIBUTED"]) {
    log(`    ${k.padEnd(16)} ${String(by(k)).padStart(6)}`);
  }
  log("");
  log(`  ANSWERED: ${linked + stock} of ${total} — ${linked} serve a customer line, ${stock} are stock`);
  log(`  RESIDUE:  ${by("UNATTRIBUTED")} line(s) on a PO that DOES carry customer lines but this one does not`);
  log("");
  log("  PER COMPANY");
  for (const c of [...new Set(rows.map((r) => r.company_id))].sort()) {
    const cr = rows.filter((r) => r.company_id === c);
    log(`    company ${c}: ` + cr.map((r) => `${r.reason}=${r.n}`).join("  "));
  }
  log("");
  log("  so_item_id ALONE would have reported: " + by("DIRECT-SO-LINK") + "/" + total +
      ` (${((by("DIRECT-SO-LINK") / total) * 100).toFixed(1)}%) — mig 0235 is why that undercounts.`);
} finally {
  await sql.end();
}
