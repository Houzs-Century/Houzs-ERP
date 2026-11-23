#!/usr/bin/env node
/* L1 Personal reads only its own mailbox (owner 2026-11-23, PR 5966): a department
   mailbox is opened at L1 only by an admin's tick. Older data ticked every person's
   OWN department mailbox for them (sales@ for Sales staff, operation@ for Operation),
   so after the rule change 69 of 81 L1 people could still read it. This removes those
   grants, and only those:

     - the mailbox is a department mailbox (no owner, linked to a department), and
     - the person is in that department (primary or extra), and
     - the person is at L1 (mail_user_scope 'department' / 'personal', or no row), and
     - the person is not in the Management department (they read everything anyway).

   Grants to ANOTHER department's mailbox (Hana in HR reading Operation), to a
   colleague's own mailbox, and every L2 / L3 person's grants are left alone.

   MODE=plan (default) lists every grant it would remove and writes nothing.
   MODE=apply needs CONFIRM="REMOVE L1 OWN DEPARTMENT MAILBOX GRANTS"; it deletes the
   listed grants in one transaction, logs each in mail_access_changes ("stopped sharing
   <address>"), prints a RESTORE line per row (the original row as JSON), and then
   re-reads on a FRESH connection: none of the matched shape may remain, and every
   other grant must still be there.

   KEY=VALUE: COMPANY=<id> (default 1, Houzs Century).

   RE-RUN: inert. A second run finds no grant of the matched shape and writes nothing. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'REMOVE L1 OWN DEPARTMENT MAILBOX GRANTS';
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
if (!Number.isInteger(CO) || CO <= 0) { bad(`COMPANY must be a positive id, got ${process.env.COMPANY}`); process.exit(2); }

/** The grants this script removes. $1 = company id. */
const MATCH = `
  SELECT acc.id, acc.address_id, acc.user_id, acc.created_at, acc.created_by, acc.company_id,
         e.address, u.name AS user_name, COALESCE(s.level, 'department') AS level
    FROM email_address_access acc
    JOIN email_addresses e ON e.id = acc.address_id
    JOIN users u ON u.id = acc.user_id
    LEFT JOIN mail_user_scope s ON s.user_id = acc.user_id
   WHERE acc.company_id = $1
     AND e.assigned_user_id IS NULL
     AND e.department_id IS NOT NULL
     AND (e.department_id = u.department_id
          OR EXISTS (SELECT 1 FROM user_departments ud WHERE ud.user_id = u.id AND ud.department_id = e.department_id))
     AND COALESCE(s.level, 'department') IN ('department', 'personal')
     AND NOT EXISTS (
       SELECT 1 FROM departments d
        WHERE lower(trim(d.name)) = 'management'
          AND (d.id = u.department_id OR d.id IN (SELECT department_id FROM user_departments WHERE user_id = u.id)))
   ORDER BY e.address, u.name`;

const countAll = async (client) => (await client.unsafe(`SELECT COUNT(*)::int AS n FROM email_address_access WHERE company_id = $1`, [CO]))[0].n;

const sql = postgres(DSN, { ssl: process.env.PGSSLMODE === 'disable' ? false : 'require', prepare: false, max: 1 });
let code = 0;
try {
  const rows = await sql.unsafe(MATCH, [CO]);
  const before = await countAll(sql);
  note(`company ${CO}: ${rows.length} L1 grant(s) to the person's own department mailbox, of ${before} grant(s) in all`);
  const byBox = new Map();
  for (const r of rows) byBox.set(r.address, (byBox.get(r.address) ?? 0) + 1);
  for (const [box, n] of byBox) console.log(`  ${box}: ${n} person(s)`);
  for (const r of rows) console.log(`  - ${r.user_name} (user ${r.user_id}, ${r.level}) -> ${r.address}`);

  if (!APPLY) {
    note('PLAN only: nothing written. Re-run with MODE=apply and the CONFIRM phrase to remove them.');
  } else if (rows.length === 0) {
    note('Nothing to remove.');
  } else {
    await sql.begin(async (tx) => {
      for (const r of rows) {
        await tx.unsafe(`DELETE FROM email_address_access WHERE id = $1 AND company_id = $2`, [r.id, CO]);
        await tx.unsafe(
          `INSERT INTO mail_access_changes (id, company_id, by_user_id, user_id, change) VALUES ($1, $2, NULL, $3, $4)`,
          [crypto.randomUUID(), CO, r.user_id, `stopped sharing ${r.address} (L1 reads its own mailbox only)`],
        );
      }
    });
    for (const r of rows) {
      const original = { id: r.id, address_id: r.address_id, user_id: r.user_id, created_at: r.created_at, created_by: r.created_by, company_id: r.company_id };
      console.log(`RESTORE: ${JSON.stringify(original)}`);
    }

    // Fresh connection: the matched shape is gone, and nothing else moved.
    const check = postgres(DSN, { ssl: process.env.PGSSLMODE === 'disable' ? false : 'require', prepare: false, max: 1 });
    try {
      const left = await check.unsafe(MATCH, [CO]);
      const after = await countAll(check);
      const gone = await check.unsafe(`SELECT COUNT(*)::int AS n FROM email_address_access WHERE id = ANY($1::text[])`, [rows.map((r) => r.id)]);
      // The values: each removed (person, mailbox) pair now has exactly its "stopped sharing" log line,
      // and that person's remaining grants no longer name the mailbox.
      const logged = await check.unsafe(
        `SELECT user_id, change FROM mail_access_changes WHERE company_id = $1 AND user_id = ANY($2::int[]) AND change LIKE 'stopped sharing % (L1 reads its own mailbox only)'`,
        [CO, [...new Set(rows.map((r) => r.user_id))]],
      );
      const have = new Set(logged.map((l) => `${l.user_id}|${l.change}`));
      const missing = rows.filter((r) => !have.has(`${r.user_id}|stopped sharing ${r.address} (L1 reads its own mailbox only)`));
      if (missing.length) { bad(`${missing.length} removal(s) have no matching log line, e.g. user ${missing[0].user_id} ${missing[0].address}`); code = 1; }
      const still = await check.unsafe(
        `SELECT acc.user_id, e.address FROM email_address_access acc JOIN email_addresses e ON e.id = acc.address_id
          WHERE acc.company_id = $1 AND acc.user_id = ANY($2::int[])`,
        [CO, [...new Set(rows.map((r) => r.user_id))]],
      );
      const pairs = new Set(still.map((s) => `${s.user_id}|${String(s.address).toLowerCase()}`));
      const reopened = rows.filter((r) => pairs.has(`${r.user_id}|${String(r.address).toLowerCase()}`));
      if (reopened.length) { bad(`${reopened.length} person(s) still hold the removed mailbox, e.g. user ${reopened[0].user_id} ${reopened[0].address}`); code = 1; }
      if (left.length !== 0) { bad(`${left.length} grant(s) of the matched shape remain`); code = 1; }
      if (gone[0].n !== 0) { bad(`${gone[0].n} removed grant id(s) still present`); code = 1; }
      if (after !== before - rows.length) { bad(`grant count is ${after}, expected ${before - rows.length}: something else changed`); code = 1; }
      if (code === 0) note(`verified on a fresh connection: ${rows.length} removed, ${after} other grant(s) untouched, none of the matched shape left`);
    } finally {
      await check.end();
    }
  }
} catch (e) {
  bad(e instanceof Error ? e.message : String(e));
  code = 1;
} finally {
  await sql.end();
}
process.exit(code);
