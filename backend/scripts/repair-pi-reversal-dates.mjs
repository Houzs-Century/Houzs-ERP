#!/usr/bin/env node
/* Re-date the periodic backfill's RESHAPE contras onto their originals' dates.

   What happened (docs/bugs/0647): the item-3 backfill re-shaped 19 old-shape
   PI journals (Dr 330 / Cr AP) by reversing each and re-posting it under the
   periodic rule. The re-post took the INVOICE date; the contra took TODAY
   (reversePiAccounting's cancel default), so July and August kept their old
   Dr 330 / Cr AP uncancelled until September — stock and payables over-stated
   by 56,914.60 on every month-end balance sheet in between. The owner's rule:
   照理应该根据 PI 的日期 (2026-09-06, 做).

   WHICH rows, exactly — never "every reversal":
     • source_type PI_REVERSAL, whose original (orig.reversed_by_je = contra.id)
       is a PI journal dated EARLIER than the contra, AND
     • the same invoice carries a NEW, ACTIVE PI journal (the re-post) — that
       is the reshape signature. A CANCELLED invoice has no active journal and
       its contra rightly keeps the day it was voided.
   Nothing else about the contra moves: lines, amounts, numbers all stay.
   The JE number keeps its September series — it is an audit id, not a date.

   MODE=plan (default) reports; MODE=apply needs CONFIRM="REDATE PI REVERSALS".
   RE-RUN: convergent — a contra already on its original's date no longer
   matches and reports nothing. Verification re-reads on a FRESH connection
   and asserts the shape: zero reshape contras still off their original's date. */
import postgres from "postgres";

const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = "REDATE PI REVERSALS";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
if (APPLY && process.env.CONFIRM !== CONFIRM) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM}"`); process.exit(2);
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const RESHAPE_CONTRAS = (sql) => sql`
  SELECT contra.id, contra.je_no, contra.company_id, contra.entry_date AS contra_date,
         orig.je_no AS orig_je_no, orig.entry_date AS orig_date, orig.source_doc_no
  FROM scm.journal_entries contra
  JOIN scm.journal_entries orig ON orig.reversed_by_je = contra.id
  WHERE contra.source_type = 'PI_REVERSAL'
    AND orig.source_type = 'PI'
    AND contra.entry_date <> orig.entry_date
    AND EXISTS (
      SELECT 1 FROM scm.journal_entries fresh
      WHERE fresh.company_id = orig.company_id
        AND fresh.source_type = 'PI'
        AND fresh.source_doc_no = orig.source_doc_no
        AND fresh.reversed = false
        AND fresh.id <> orig.id
    )
  ORDER BY contra.company_id, orig.entry_date, orig.je_no`;

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  note(`mode=${APPLY ? "APPLY" : "PLAN (read-only)"}`);
  const todo = await RESHAPE_CONTRAS(sql);
  for (const r of todo) {
    note(`co${r.company_id} ${r.je_no}: ${fmt(r.contra_date)} -> ${fmt(r.orig_date)} (reverses ${r.orig_je_no}, ${r.source_doc_no})`);
  }
  if (!APPLY) { note(`PLAN complete — ${todo.length} contra(s) would be re-dated.`); }
  else {
    let moved = 0;
    for (const r of todo) {
      const res = await sql`UPDATE scm.journal_entries
        SET entry_date = ${r.orig_date}
        WHERE id = ${r.id} AND source_type = 'PI_REVERSAL' AND entry_date = ${r.contra_date}`;
      moved += res.count;
    }
    note(`updated ${moved} of ${todo.length}`);
    // fresh-connection SHAPE verification
    await sql.end({ timeout: 5 });
    const check = postgres(url, { ssl: "require", prepare: false, max: 1 });
    const left = await RESHAPE_CONTRAS(check);
    await check.end({ timeout: 5 });
    note(`verify: ${left.length} reshape contra(s) still off their original's date`);
    if (left.length > 0 || moved !== todo.length) { console.error("VERIFICATION FAILED"); process.exit(1); }
    note("APPLIED and verified on a fresh connection.");
    process.exit(0);
  }
} finally {
  try { await sql.end({ timeout: 5 }); } catch { /* closed above on apply */ }
}

function fmt(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}
