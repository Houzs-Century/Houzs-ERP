#!/usr/bin/env node
/* Repair the SO-amendment line NAME that a code-swap left stale.

   THE BUG (docs/bugs/0781). applySoAmendment's SPEC branch rewrote a line's
   item_code but left `description` (the product name) untouched, so a code-swap
   amendment (e.g. 9028-2A(LHF) -> 9028-2A(RHF)) named the line by the OLD
   product on every name-first surface — the amend editor's SoLineCard picker,
   the follow-up PO's material_name, and anything reading description. The
   forward fix (so-revision.ts) now re-resolves the name from the catalogue on
   apply; this repairs the rows already written before that shipped.

   SCOPE — deliberately narrow and reversible-by-nature:
     * Only lines that went through an APPLIED (SO_APPROVED) SPEC amendment that
       carried a new code. Not "every line whose name != catalogue" — that would
       sweep legitimately-different migrated names.
     * Only the `description` column, set to mfg_products.name for the line's
       CURRENT item_code, company-scoped. Never a price, qty, variant, status,
       date, or description2.
     * A code with no catalogue row is LEFT and reported — never blanked.

   RE-RUN: idempotent. A second run re-reads the same candidate set, finds every
   name already equal to the catalogue name, plans zero fixes and writes nothing.
   There is no accumulating state to double-apply — the target value is derived
   from the catalogue, not from the current row.

   Gate: MODE=plan by default (no writes). MODE=apply requires
   CONFIRM="REPAIR SO AMENDMENT NAMES". After writing, a FRESH connection
   re-reads each fixed line and asserts its description now equals the catalogue
   name (a row count is not a shape). Exit 0 for every legitimate answer; non-zero
   only for an unreachable DB, a bad CONFIRM, or a failed verify.

   Env: DATABASE_URL (the only credential). MODE=apply + CONFIRM to write. */
import postgres from 'postgres';
import { planNameRepairs, verifyNameRepairs } from './lib/so-amendment-name-repair.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'REPAIR SO AMENDMENT NAMES';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (no writes)'}`);

  // Candidate set: DISTINCT so lines that went through an APPLIED (SO_APPROVED)
  // SPEC amendment carrying a new code, with the line's CURRENT code + name and
  // the catalogue name for that current code.
  const rows = await sql`
    SELECT DISTINCT si.id           AS "lineId",
                    si.doc_no       AS "docNo",
                    si.item_code    AS "itemCode",
                    si.description  AS "description",
                    p.name          AS "catalogName"
    FROM scm.so_amendment_lines al
    JOIN scm.so_amendments a          ON a.id = al.amendment_id AND a.status = 'SO_APPROVED'
    JOIN scm.mfg_sales_order_items si ON si.id = al.sales_order_item_id
    LEFT JOIN scm.mfg_products p      ON p.code = si.item_code AND p.company_id = si.company_id
    WHERE al.change_type = 'SPEC' AND al.new_item_code IS NOT NULL
  `;
  note(`candidate lines (through an applied SPEC amendment): ${rows.length}`);

  const { toFix, skipped } = planNameRepairs(rows);
  note(`stale names to fix: ${toFix.length}   left alone: ${skipped.length}`);
  for (const f of toFix) note(`  ${f.docNo}  ${f.itemCode}  "${f.from ?? ''}" -> "${f.to}"`);

  if (toFix.length === 0) { note('nothing to repair.'); await sql.end(); return; }

  if (!APPLY) {
    note(`\nPLAN only. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write.`);
    await sql.end();
    return;
  }

  // APPLY — one UPDATE per line, `description` ONLY.
  let wrote = 0;
  for (const f of toFix) {
    const res = await sql`UPDATE scm.mfg_sales_order_items SET description = ${f.to} WHERE id = ${f.lineId}`;
    wrote += res.count;
  }
  note(`wrote ${wrote} row(s).`);
  await sql.end();

  // VERIFY on a FRESH connection, asserting the SHAPE (each line's description
  // now equals the catalogue name we wrote), not a row count.
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const afterByLineId = new Map();
    for (const f of toFix) {
      const [row] = await check`SELECT description FROM scm.mfg_sales_order_items WHERE id = ${f.lineId}`;
      afterByLineId.set(f.lineId, row ? row.description : null);
    }
    const failures = verifyNameRepairs(toFix, afterByLineId);
    if (failures.length) {
      bad(`verify FAILED for ${failures.length} line(s): ${failures.join(', ')}`);
      process.exitCode = 1;
    } else {
      note(`verify OK — all ${toFix.length} line(s) now carry the catalogue name.`);
    }
  } finally {
    await check.end();
  }
}

main().catch((e) => { bad(e?.message ?? String(e)); process.exit(1); });
