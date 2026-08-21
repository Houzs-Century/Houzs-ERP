#!/usr/bin/env node
/* Read-only: which document numbers do NOT carry their company's prefix?
 *
 * THE QUESTION, in the owner's words (2026-08-21): the Sales Order list's
 * "PO No." cell showed TWO chips for what he believed was one purchase order —
 * `PO-2606-011` beside `2990-PO-2606-011`. His pushback was the right one:
 * *"不可能我们系统全部 PO 都有 2990 的，去哪里找个没有的 PO"*. This settles it
 * with a count instead of an argument.
 *
 * WHY THE CELL CAN SHOW BOTH. `frontend/src/lib/soPoChips.ts` builds two arms
 * and de-dupes the second against the first by EXACT STRING —
 * `raised.filter((n) => !source.includes(n))`. Two spellings of one purchase
 * order are two different strings, so both are chipped:
 *   solid  `source_po_union`   — traced from the inventory ledger
 *   muted  `converted_po_nos`  — `purchase_orders.po_number` off the line link
 *
 * WHAT THIS DOES *NOT* ASSUME, and the correction that produced it. The
 * `repair-2990-doc-refs` A2 dry run (run 32488798039, 2026-08-21) reported
 * "53 batches, 0 to repair, 53 skipped — already resolves as stored", and that
 * was read as "the ledger is fine, so the un-prefixed number is not from
 * there". THAT INFERENCE IS WRONG and this header exists to stop the next
 * reader repeating it: A2 only renames a batch whose stored value does NOT
 * resolve while its prefixed form DOES. If an UN-PREFIXED purchase order row
 * genuinely exists, an un-prefixed batch naming it resolves perfectly well and
 * is correctly skipped. So that run is NEUTRAL on this question, not evidence
 * against it. Measure the document numbers themselves.
 *
 * SCOPE. Every doc-number column the 2990 importer prefixes (its DOCNO_COL
 * map), for every company, split by whether the value carries the prefix its
 * company mints under. Company 1 (Houzs Century) mints BARE numbers by design,
 * so a company-1 row without a `2990-` prefix is correct and is reported as
 * such — the finding is a company-2 row that lacks one.
 *
 * Writes nothing. One SELECT per table. Exit 0 for every legitimate answer —
 * the output IS the answer.
 *
 * RE-RUN: safe and idempotent; it is a SELECT. */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The importer's own DOCNO_COL map (scripts/migrate-2990-into-houzs.mjs), which
   is the list of numbers that were prefixed on the way in. Keeping the same
   membership means a table added there and not here shows up as a gap rather
   than as silence. */
const DOC_TABLES = [
  ["mfg_sales_orders",   "doc_no"],
  ["purchase_orders",    "po_number"],
  ["delivery_orders",    "do_number"],
  ["sales_invoices",     "invoice_number"],
  ["grns",               "grn_number"],
  ["purchase_invoices",  "invoice_number"],
  ["delivery_returns",   "dr_number"],
  ["purchase_returns",   "pr_number"],
];

/* Company 2 is the only tenant whose numbers carry a document prefix — the
   import stamped `2990-` and the post-flip minter continues it. Company 1 mints
   bare. Read from the companies master rather than hard-coded so a third
   company does not silently fall into the wrong arm. */
const PREFIX_BY_COMPANY = new Map([[2, "2990-"]]);

async function main() {
  note("=== check-doc-no-prefix (read-only) ===");

  const companies = await sql`
    SELECT id, code, name FROM scm.companies ORDER BY id`.catch(() => []);
  if (companies.length) {
    note(`companies: ${companies.map((c) => `${c.id}=${c.code ?? c.name}`).join(", ")}`);
  }

  let totalOffenders = 0;

  for (const [table, col] of DOC_TABLES) {
    let rows;
    try {
      rows = await sql`
        SELECT company_id, ${sql(col)} AS doc_no
          FROM ${sql("scm")}.${sql(table)}
         WHERE ${sql(col)} IS NOT NULL`;
    } catch (e) {
      /* A table or column that does not exist is a FINDING (the importer map and
         the schema disagree), not a crash — say so and carry on. */
      note(`  ${table}.${col}: could not read — ${e.message}`);
      continue;
    }

    const byCompany = new Map();
    for (const r of rows) {
      const cid = Number(r.company_id ?? 0);
      let b = byCompany.get(cid);
      if (!b) { b = { total: 0, missing: [], unexpected: 0 }; byCompany.set(cid, b); }
      b.total += 1;
      const want = PREFIX_BY_COMPANY.get(cid);
      const val = String(r.doc_no);
      if (want) {
        if (!val.startsWith(want)) b.missing.push(val);
      } else if (/^2990-/.test(val)) {
        /* A bare-minting company holding a 2990- number is the mirror image of
           the same fault and is worth naming rather than passing over. */
        b.unexpected += 1;
      }
    }

    const parts = [];
    for (const [cid, b] of [...byCompany.entries()].sort((a, x) => a[0] - x[0])) {
      const want = PREFIX_BY_COMPANY.get(cid);
      if (want) {
        totalOffenders += b.missing.length;
        parts.push(`company ${cid}: ${b.total} rows, ${b.missing.length} WITHOUT "${want}"`);
      } else {
        parts.push(`company ${cid}: ${b.total} rows, bare by design${b.unexpected ? `, ${b.unexpected} carrying 2990-` : ""}`);
      }
    }
    note(`\n${table}.${col}  —  ${parts.join(" | ")}`);

    for (const [cid, b] of byCompany.entries()) {
      if (!PREFIX_BY_COMPANY.get(cid) || b.missing.length === 0) continue;
      const shown = b.missing.slice(0, 20);
      for (const v of shown) note(`    [no prefix] ${v}`);
      if (b.missing.length > shown.length) {
        note(`    ... and ${b.missing.length - shown.length} more`);
      }
    }
  }

  note(`\n=== VERDICT ===`);
  note(totalOffenders === 0
    ? "  ZERO document numbers are missing their company prefix. The two chips on the"
      + " Sales Order list are NOT two spellings of one document — look at the two arms"
      + " of soPoChips.ts instead (source_po_union vs converted_po_nos)."
    : `  ${totalOffenders} document number(s) lack their company prefix. Each one shows`
      + ` twice in any cell that de-dupes by exact string — soPoChips.ts is one such cell.`);

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
