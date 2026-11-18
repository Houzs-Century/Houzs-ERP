#!/usr/bin/env node
/* Renumber 13 Houzs Century crew from their placeholder EMP-### to their real
   HRIS employee numbers.

   WHY. Driver + warehouse crew were first added to Employee Master from their
   ERP accounts, so they got auto-assigned EMP-001..EMP-013. The HRIS spreadsheet
   import (#5779) then enriched them in place but, by design, never changed an
   Emp No. The 4 crew who had no ERP account came in through that same import
   under their real HRIS numbers (HCFW####), so the book now mixes two schemes.
   This one-off aligns the 13 placeholders onto their HRIS numbers so every crew
   member reads the same way.

   HOW IT IS KEYED. Each rename is tied to the person's linked ERP account
   (user_id) — the stable identity that made these the right rows — and is
   applied only when the row still carries the EXPECTED old EMP-### and the
   target number is free. A row whose number is not what we expect, or whose
   target is already taken, is REFUSED and printed, never guessed. No names, IC
   or passport numbers are in this file or its output: the repo (and the Actions
   log) is public, so only internal codes (user_id, emp_no) are handled here.

   MODE=plan (default) prints every intended rename and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", renames one row at a
   time, and verifies on a FRESH connection that each account now carries its
   HRIS number and no old EMP-### remains.

   RE-RUN: inert. Each rename requires the OLD EMP-### to still be on the row, so
   once applied a second run finds every account already on its HRIS number,
   renames nothing, and refuses any row whose number is unexpected. */
import postgres from 'postgres';

/* user_id -> {from: placeholder now on the row, to: real HRIS number}.
   Internal codes only; captured read-only on 2026-11-18. */
const RENAMES = [
  { userId: 51, from: 'EMP-001', to: 'HC0009' },
  { userId: 54, from: 'EMP-002', to: 'HCFW0003' },
  { userId: 135, from: 'EMP-003', to: 'HCFW0009' },
  { userId: 50, from: 'EMP-004', to: 'HC0006' },
  { userId: 55, from: 'EMP-005', to: 'HCFW0002' },
  { userId: 57, from: 'EMP-006', to: 'HCFW0006' },
  { userId: 52, from: 'EMP-007', to: 'HC0014' },
  { userId: 62, from: 'EMP-008', to: 'HC0008' },
  { userId: 56, from: 'EMP-009', to: 'HCFW0001' },
  { userId: 143, from: 'EMP-010', to: 'HC0017' },
  { userId: 60, from: 'EMP-011', to: 'HCFW0004' },
  { userId: 59, from: 'EMP-012', to: 'HCFW0007' },
  { userId: 49, from: 'EMP-013', to: 'HC0011' },
];

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);

  const userIds = RENAMES.map((r) => r.userId);
  const targets = RENAMES.map((r) => r.to);

  // The rows we mean to touch, by their linked account.
  const current = await sql`
    SELECT id::int AS id, user_id::int AS user_id, emp_no
      FROM hr_employees
     WHERE company_id = ${CO} AND user_id = ANY(${userIds})`;
  const byUser = new Map(current.map((r) => [r.user_id, r]));

  // Who, if anyone, already holds a target number — so a rename never collides.
  const holders = await sql`
    SELECT id::int AS id, emp_no
      FROM hr_employees
     WHERE company_id = ${CO} AND emp_no = ANY(${targets})`;
  const targetHolder = new Map(holders.map((r) => [r.emp_no, r.id]));

  const doIt = [];
  const skip = [];
  const refuse = [];
  for (const r of RENAMES) {
    const row = byUser.get(r.userId);
    if (!row) { refuse.push(`user ${r.userId} -> ${r.to}: no employee for this account in company ${CO}`); continue; }
    if (row.emp_no === r.to) { skip.push(`user ${r.userId}: already ${r.to}`); continue; }
    if (row.emp_no !== r.from) { refuse.push(`user ${r.userId} -> ${r.to}: row is ${row.emp_no}, expected ${r.from} — not renaming`); continue; }
    const holder = targetHolder.get(r.to);
    if (holder !== undefined && holder !== row.id) { refuse.push(`user ${r.userId}: target ${r.to} is already used by employee ${holder}`); continue; }
    doIt.push({ id: row.id, userId: r.userId, from: r.from, to: r.to });
  }

  note(`\n=== PLAN: ${doIt.length} rename(s), ${skip.length} already done, ${refuse.length} refused ===`);
  for (const d of doIt) note(`  user ${d.userId}: ${d.from} -> ${d.to}`);
  for (const s of skip) note(`  ${s}`);
  for (const x of refuse) bad(`  ${x}`);

  if (refuse.length) { bad(`\n${refuse.length} row(s) refused — fix or re-check before applying.`); }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    if (refuse.length) process.exit(1);
    return;
  }

  note(`\n=== RENAMING ${doIt.length} ROW(S) ===`);
  let wrote = 0;
  for (const d of doIt) {
    // Guard on the OLD number so a row that changed under us is left alone.
    const back = await sql`
      UPDATE hr_employees SET emp_no = ${d.to}, updated_at = now()
       WHERE company_id = ${CO} AND id = ${d.id} AND emp_no = ${d.from}
      RETURNING id::int AS id`;
    wrote += back.length;
    note(`  ${back.length ? 'OK  ' : 'SKIP'} user ${d.userId}: ${d.from} -> ${d.to}`);
  }
  note(`  written: ${wrote} of ${doIt.length}`);

  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const after = await check`
      SELECT id::int AS id, user_id::int AS user_id, emp_no
        FROM hr_employees
       WHERE company_id = ${CO} AND user_id = ANY(${userIds})`;
    const nowByUser = new Map(after.map((r) => [r.user_id, r.emp_no]));
    let onTarget = 0;
    let wrong = 0;
    for (const r of RENAMES) {
      const got = nowByUser.get(r.userId);
      if (got === r.to) { onTarget++; continue; }
      wrong++;
      bad(`  user ${r.userId}: expected ${r.to}, reads ${got ?? '(missing)'}`);
    }
    const stale = after.filter((r) => /^EMP-\d+$/.test(r.emp_no)).length;
    note(`  on HRIS number: ${onTarget} of ${RENAMES.length}; still on an EMP-### placeholder: ${stale}; mismatched: ${wrong}`);
    if (wrong || stale) { bad(`\nverification failed`); process.exitCode = 1; }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
