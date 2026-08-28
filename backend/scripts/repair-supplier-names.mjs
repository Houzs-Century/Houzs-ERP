#!/usr/bin/env node
/* Correct a supplier row whose NAME does not match the AutoCount creditor its
   CODE points at. Data-driven, one row per correction, refusing anything that
   does not match the expectation exactly — a rename is cheap, renaming the
   wrong row is not.

   The one correction shipped with this script (owner ruling 2026-08-28,
   "应该不一样啊" — the two creditors are different companies):
     company 1, code 400-R001: the book's creditor is RED SOFA PLT; the ERP row
     was seeded 2026-08-05 with the NAME of a different creditor (RENNESS
     BEDDING — the book codes that company 400-R002, now seeded correctly).
     The 20 RDS bindings and any 400-R001 POs hang on the row's ID, so the
     rename re-labels them correctly and moves nothing. docs/bugs/0557 carries
     the full trace.

   MODE=plan (default) reports; MODE=apply needs
   CONFIRM="RENAME SUPPLIER ROWS". RE-RUN: convergent — a row already carrying
   the corrected name no longer matches expect_name and reports as done.
   Verification re-reads on a FRESH connection and asserts the SHAPE: the code
   resolves to exactly one row and that row carries the corrected name. */
import postgres from "postgres";

const FIXES = [
  { company_id: 1, code: "400-R001", expect_name_like: "RENNESS BEDDING%", set_name: "RED SOFA PLT" },
];

const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = "RENAME SUPPLIER ROWS";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
if (APPLY && process.env.CONFIRM !== CONFIRM) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM}"`); process.exit(2);
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  note(`mode=${APPLY ? "APPLY" : "PLAN (read-only)"}`);
  const todo = [];
  for (const f of FIXES) {
    const rows = await sql`SELECT id, code, name FROM scm.suppliers
      WHERE company_id = ${f.company_id} AND code = ${f.code}`;
    if (rows.length !== 1) { note(`SKIP ${f.code}: expected exactly one row, found ${rows.length}`); continue; }
    const r = rows[0];
    if (r.name === f.set_name) { note(`DONE already ${f.code}: name is "${r.name}"`); continue; }
    const likeRe = new RegExp("^" + f.expect_name_like.replace(/%/g, ".*") + "$", "i");
    if (!likeRe.test(r.name || "")) {
      note(`REFUSE ${f.code}: name "${r.name}" does not match expected "${f.expect_name_like}" — the world moved, re-check before renaming`);
      continue;
    }
    note(`${f.code}: "${r.name}" -> "${f.set_name}" (id ${r.id})`);
    todo.push({ ...f, id: r.id, old: r.name });
  }
  if (!APPLY) { note(`PLAN complete — ${todo.length} rename(s) would be applied.`); }
  else {
    for (const t of todo) {
      await sql`UPDATE scm.suppliers SET name = ${t.set_name}, updated_at = now()
        WHERE id = ${t.id} AND company_id = ${t.company_id} AND name = ${t.old}`;
    }
    // fresh-connection SHAPE verification
    await sql.end({ timeout: 5 });
    const check = postgres(url, { ssl: "require", prepare: false, max: 1 });
    let bad = 0;
    for (const f of FIXES) {
      const rows = await check`SELECT name FROM scm.suppliers WHERE company_id = ${f.company_id} AND code = ${f.code}`;
      const ok = rows.length === 1 && rows[0].name === f.set_name;
      note(`verify ${f.code}: ${rows.length} row(s), name "${rows[0]?.name}" — ${ok ? "OK" : "WRONG"}`);
      if (!ok) bad++;
    }
    await check.end({ timeout: 5 });
    if (bad) { console.error(`VERIFICATION FAILED on ${bad} row(s)`); process.exit(1); }
    note("APPLIED and verified on a fresh connection.");
    process.exit(0);
  }
} finally {
  try { await sql.end({ timeout: 5 }); } catch { /* closed above on apply */ }
}
