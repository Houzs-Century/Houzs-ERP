#!/usr/bin/env node
/* One-off repair — the owner's ask, verbatim (2026-09-04, tidying his chart):
   批量挂, 全部挂到 900-0000 下.

   WHAT IT DOES. Every ROOT-level 900-x EXPENSE account (the AutoCount
   expense series — 900-A001, 900-B001, … 900-W009 — which the xlsx carries
   flat, so the import faithfully left them parentless) gets
   parent_code = '900-0000', in every company it exists in. Sub-trees ride
   along untouched (only roots move); 900-0000 itself and non-EXPENSE rows
   are excluded by the WHERE.

   THE SERVER'S REPARENT GUARDS, REPLICATED — this script writes what N drag
   operations through chartUpdateHandler would have written:
     · target exists ACTIVE in every company a moved row lives in (checked,
       abort otherwise);
     · same type — the scope is account_type='EXPENSE' and the target is
       asserted EXPENSE;
     · 父户不记账 on the target — 900-0000 is ALREADY a header (it has
       children), which is exactly the server's already-header fast path;
       its zero-postings state is asserted anyway, belt and braces;
     · no cycles — every moved row is a ROOT, so none can be 900-0000's own
       ancestor.

   MODE=plan (default) writes NOTHING — it lists what would move, per
   company. MODE=apply needs the CONFIRM sentence, like every repair
   workflow here.

   RE-RUN: a second apply matches ZERO rows (everything already carries
   parent_code = 900-0000, and the WHERE takes only parentless rows) — pure
   idempotence; plan can be run any number of times. */

import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM = process.env.CONFIRM ?? "";
if (APPLY && CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error("apply needs CONFIRM='I HAVE REVIEWED THE DRY-RUN' — run plan first and read it.");
  process.exit(2);
}

const TARGET = "900-0000";
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

try {
  const scope = await sql`
    SELECT company_id, account_code, account_name, account_type
    FROM scm.accounts
    WHERE parent_code IS NULL
      AND account_code LIKE '900-%'
      AND account_code <> ${TARGET}
    ORDER BY company_id, account_code`;

  const offType = scope.filter((r) => r.account_type !== "EXPENSE");
  if (offType.length > 0) {
    console.error("REFUSING — 900-x roots that are not EXPENSE (would break the same-type rule):");
    for (const r of offType) console.error(`  co${r.company_id} ${r.account_code} ${r.account_type}`);
    process.exit(1);
  }

  const companies = [...new Set(scope.map((r) => r.company_id))];
  const target = await sql`
    SELECT company_id, account_type, is_active FROM scm.accounts WHERE account_code = ${TARGET}`;
  for (const co of companies) {
    const t = target.find((r) => r.company_id === co);
    if (!t) { console.error(`REFUSING — ${TARGET} missing in company ${co}`); process.exit(1); }
    if (!t.is_active) { console.error(`REFUSING — ${TARGET} inactive in company ${co}`); process.exit(1); }
    if (t.account_type !== "EXPENSE") { console.error(`REFUSING — ${TARGET} is ${t.account_type} in company ${co}`); process.exit(1); }
  }
  const [{ n: postings }] = await sql`
    SELECT count(*)::int AS n FROM scm.journal_entry_lines WHERE account_code = ${TARGET}`;
  if (postings > 0) { console.error(`REFUSING — ${TARGET} carries ${postings} GL line(s); 父户不记账.`); process.exit(1); }

  const byCo = new Map();
  for (const r of scope) byCo.set(r.company_id, (byCo.get(r.company_id) ?? 0) + 1);
  console.log(`${scope.length} row(s) would move under ${TARGET}:`);
  for (const [co, n] of byCo) console.log(`  company ${co}: ${n}`);
  const codes = [...new Set(scope.map((r) => r.account_code))].sort();
  console.log(`distinct codes (${codes.length}): ${codes.join(", ")}`);

  if (!APPLY) {
    console.log("MODE=plan — nothing written. Run apply with the CONFIRM sentence.");
    process.exit(0);
  }

  const updated = await sql`
    UPDATE scm.accounts
    SET parent_code = ${TARGET}
    WHERE parent_code IS NULL
      AND account_code LIKE '900-%'
      AND account_code <> ${TARGET}
      AND account_type = 'EXPENSE'
    RETURNING company_id`;
  console.log(`APPLIED — ${updated.length} row(s) re-parented under ${TARGET}.`);

  /* FRESH-CONNECTION verification, asserting the SHAPE the chart must now
     have — not a row count. A row that dodged the UPDATE (or a write that
     silently landed elsewhere) is what this catches. */
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const stray = await fresh`
      SELECT company_id, account_code, COALESCE(parent_code, '(root)') AS parent_code
      FROM scm.accounts
      WHERE account_code LIKE '900-%'
        AND account_code <> ${TARGET}
        AND account_type = 'EXPENSE'
        AND parent_code IS NULL`;
    const under = await fresh`
      SELECT company_id, count(*)::int AS n
      FROM scm.accounts
      WHERE parent_code = ${TARGET}
      GROUP BY company_id ORDER BY company_id`;
    for (const r of under) console.log(`fresh verify: company ${r.company_id} now has ${r.n} account(s) under ${TARGET}`);
    if (stray.length > 0) {
      console.error(`FRESH VERIFY FAILED — ${stray.length} 900-x EXPENSE root(s) still parentless:`);
      for (const r of stray) console.error(`  co${r.company_id} ${r.account_code} parent=${r.parent_code}`);
      process.exit(1);
    }
    console.log("fresh verify: 0 parentless 900-x EXPENSE roots remain — the family hangs whole.");
  } finally {
    await fresh.end({ timeout: 5 });
  }
} finally {
  await sql.end({ timeout: 5 });
}
