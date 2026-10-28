#!/usr/bin/env node
/* One-off repair — the owner's income split, his calls verbatim (2026-09-04):
   other income 我想挂在 700-0000 可以吗 / 530，592都挂other income / 别乱分类.

   WHAT IT DOES. The ENUMERATED other-income roots below (the owner's list —
   deliberately not a code-range guess, 别乱分类) get parent_code =
   '700-0000' in every company they exist in. Sub-trees ride along (570-x
   and 599-0010's children move with their roots). Everything NOT listed —
   the trading-revenue series 500/501/502/509/510/520 — is untouched: "not
   under 700-0000" IS the owner's definition of 正常生意 income.

   THE SERVER'S REPARENT GUARDS, REPLICATED (same as
   reparent-900-expenses.mjs):
     · target exists ACTIVE in every company a moved row lives in — a
       company missing it gets it INSTANTIATED from the master definition,
       an inactive one re-activated; no definition anywhere aborts;
     · same type — every listed row and the target must be INCOME;
     · 父户不记账 asserted on 700-0000 (zero GL lines);
     · no cycles — the listed rows are roots, and a listed row already
       under 700-0000 is skipped (idempotence), while one under ANY OTHER
       parent refuses: that shape was not what the owner reviewed.

   MODE=plan (default) writes NOTHING — it lists what would move, per
   company. MODE=apply needs the CONFIRM sentence.

   RE-RUN: a second apply is a no-op — the instantiate is ON CONFLICT DO
   NOTHING, the re-activate sets TRUE to TRUE, and the re-parent's WHERE
   takes only parentless listed rows, of which zero remain. plan can be run
   any number of times. */

import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM = process.env.CONFIRM ?? "";
if (APPLY && CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error("apply needs CONFIRM='I HAVE REVIEWED THE DRY-RUN' — run plan first and read it.");
  process.exit(2);
}

const TARGET = "700-0000";
/* The owner's enumeration. 530 and 592 are his explicit calls; the rest is
   the reviewed list he corrected. Children (570-0010..9999, 599-0006/0012)
   are NOT listed — they follow their roots. */
const CODES = [
  "530-0000", "540-0000", "550-0000", "560-0000", "570-0000", "580-0000",
  "590-0000", "591-0000", "592-0000", "598-0000",
  "599-0000", "599-0001", "599-0002", "599-0003", "599-0004", "599-0005",
  "599-0007", "599-0010",
];

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

try {
  const rows = await sql`
    SELECT company_id, account_code, account_name, account_type, COALESCE(parent_code, '') AS parent_code
    FROM scm.accounts
    WHERE account_code = ANY(${CODES})
    ORDER BY company_id, account_code`;

  const offType = rows.filter((r) => r.account_type !== "INCOME");
  if (offType.length > 0) {
    console.error("REFUSING — listed rows that are not INCOME (same-type rule):");
    for (const r of offType) console.error(`  co${r.company_id} ${r.account_code} ${r.account_type}`);
    process.exit(1);
  }
  const elsewhere = rows.filter((r) => r.parent_code !== "" && r.parent_code !== TARGET);
  if (elsewhere.length > 0) {
    console.error("REFUSING — listed rows already under a DIFFERENT parent (not the shape the owner reviewed):");
    for (const r of elsewhere) console.error(`  co${r.company_id} ${r.account_code} under ${r.parent_code}`);
    process.exit(1);
  }

  const toMove = rows.filter((r) => r.parent_code === "");
  const companies = [...new Set(toMove.map((r) => r.company_id))];
  const target = await sql`
    SELECT company_id, account_name, account_type, is_active, acc_money
    FROM scm.accounts WHERE account_code = ${TARGET}`;
  const master = target[0];
  if (!master) { console.error(`REFUSING — ${TARGET} exists in no company; nothing to instantiate from.`); process.exit(1); }
  for (const t of target) {
    if (t.account_type !== "INCOME") { console.error(`REFUSING — ${TARGET} is ${t.account_type} in company ${t.company_id}`); process.exit(1); }
  }
  const missingIn = companies.filter((co) => !target.some((r) => r.company_id === co));
  const inactiveIn = target.filter((r) => companies.includes(r.company_id) && !r.is_active).map((r) => r.company_id);
  if (missingIn.length > 0) console.log(`${TARGET} would be INSTANTIATED (from company ${master.company_id}'s definition) in: company ${missingIn.join(", company ")}`);
  if (inactiveIn.length > 0) console.log(`${TARGET} would be re-ACTIVATED in: company ${inactiveIn.join(", company ")}`);
  const [{ n: postings }] = await sql`
    SELECT count(*)::int AS n FROM scm.journal_entry_lines WHERE account_code = ${TARGET}`;
  if (postings > 0) { console.error(`REFUSING — ${TARGET} carries ${postings} GL line(s); 父户不记账.`); process.exit(1); }

  const byCo = new Map();
  for (const r of toMove) byCo.set(r.company_id, (byCo.get(r.company_id) ?? 0) + 1);
  const already = rows.length - toMove.length;
  console.log(`${toMove.length} row(s) would move under ${TARGET} (${already} already there):`);
  for (const [co, n] of byCo) console.log(`  company ${co}: ${n}`);
  const codes = [...new Set(toMove.map((r) => r.account_code))].sort();
  console.log(`distinct codes (${codes.length}): ${codes.join(", ")}`);
  const listedMissing = CODES.filter((c) => !rows.some((r) => r.account_code === c));
  if (listedMissing.length > 0) console.log(`listed but present in NO company (skipped): ${listedMissing.join(", ")}`);

  if (!APPLY) {
    console.log("MODE=plan — nothing written. Run apply with the CONFIRM sentence.");
    process.exit(0);
  }

  for (const co of missingIn) {
    await sql`
      INSERT INTO scm.accounts (company_id, account_code, account_name, account_type, parent_code, is_active, acc_money)
      VALUES (${co}, ${TARGET}, ${master.account_name}, ${master.account_type}, NULL, TRUE, ${master.acc_money ?? false})
      ON CONFLICT (company_id, account_code) DO NOTHING`;
    console.log(`instantiated ${TARGET} in company ${co}.`);
  }
  for (const co of inactiveIn) {
    await sql`
      UPDATE scm.accounts SET is_active = TRUE
      WHERE company_id = ${co} AND account_code = ${TARGET}`;
    console.log(`re-activated ${TARGET} in company ${co}.`);
  }

  const updated = await sql`
    UPDATE scm.accounts
    SET parent_code = ${TARGET}
    WHERE account_code = ANY(${CODES})
      AND parent_code IS NULL
      AND account_type = 'INCOME'
    RETURNING company_id`;
  console.log(`APPLIED — ${updated.length} row(s) re-parented under ${TARGET}.`);

  /* FRESH-CONNECTION verification, asserting the SHAPE — not a row count. */
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const stray = await fresh`
      SELECT company_id, account_code, COALESCE(parent_code, '(root)') AS parent_code
      FROM scm.accounts
      WHERE account_code = ANY(${CODES})
        AND (parent_code IS DISTINCT FROM ${TARGET})`;
    const under = await fresh`
      SELECT company_id, count(*)::int AS n
      FROM scm.accounts
      WHERE parent_code = ${TARGET}
      GROUP BY company_id ORDER BY company_id`;
    for (const r of under) console.log(`fresh verify: company ${r.company_id} now has ${r.n} account(s) under ${TARGET}`);
    const holes = await fresh`
      SELECT DISTINCT k.company_id
      FROM scm.accounts k
      WHERE k.parent_code = ${TARGET}
        AND NOT EXISTS (
          SELECT 1 FROM scm.accounts t
          WHERE t.company_id = k.company_id AND t.account_code = ${TARGET} AND t.is_active
        )`;
    if (holes.length > 0) {
      console.error(`FRESH VERIFY FAILED — children hang under ${TARGET} in company(ies) ${holes.map((r) => r.company_id).join(', ')} but the header row is missing or inactive there.`);
      process.exit(1);
    }
    if (stray.length > 0) {
      console.error(`FRESH VERIFY FAILED — ${stray.length} listed row(s) not under ${TARGET}:`);
      for (const r of stray) console.error(`  co${r.company_id} ${r.account_code} parent=${r.parent_code}`);
      process.exit(1);
    }
    console.log(`fresh verify: every listed code hangs under ${TARGET} — the owner's split holds.`);
  } finally {
    await fresh.end({ timeout: 5 });
  }
} finally {
  await sql.end({ timeout: 5 });
}
