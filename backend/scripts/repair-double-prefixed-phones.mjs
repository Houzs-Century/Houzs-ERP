/* Repair customer phones that carry a DOUBLED Malaysian country code.

   THE SHAPE. The slip-scan draft builder prepended "+60" to a phone that
   postProcessSlip had already normalised to E.164, so a number was stored as
   "+6060142703095" (double 60) or, from the trunk-0 variant, "+600142703095".
   Fixed forward in scan-so.ts; this repairs what is already stored.

   WHAT IT TOUCHES. Only scm.customers rows whose phone digits start with "6060"
   or "600" — the two bug signatures. A correct "+60 1x..." number never starts
   with those, and a foreign number (+65/+62/...) never does either, so they are
   left untouched. The corrected value is +60 + the national-significant part
   (outer 60 dropped, a second 60 dropped for the 6060 case, trunk 0 dropped for
   the 600 case). If the result is not a plausible Malaysian national length
   (9-10 digits) the row is SKIPPED, never guessed.

   MODE=plan (default) lists every row's phone before -> after and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", updates one row at a
   time (guarded on the id + the exact old value), prints id<TAB>old<TAB>new for
   every change (the REVERSAL source), then re-reads on a fresh connection and
   asserts no customer phone still carries the doubled prefix.

   REVERSAL: restore each printed row with its old value:
     UPDATE scm.customers SET phone = '<old>' WHERE id = '<id>';

   Env: DATABASE_URL (required); COMPANY (optional, default = all); LIST_LIMIT
   (rows to print in plan, default 200).

   RE-RUN: idempotent — a fixed number no longer starts with 6060/600, so a
   second run finds nothing. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const ONLY_COMPANY = process.env.COMPANY ? Number(process.env.COMPANY) : null;
const LIST_LIMIT = Number(process.env.LIST_LIMIT) > 0 ? Number(process.env.LIST_LIMIT) : 200;

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/** The corrected E.164, or null when this phone is not a double-prefix bug or the
 *  result is not a plausible Malaysian national number (9-10 digits). */
export function fixDoubledMyPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (!(d.startsWith('6060') || d.startsWith('600'))) return null;
  let national = d.slice(2);          // drop the outer country code
  national = national.replace(/^60/, ''); // drop a second country code (6060 case)
  national = national.replace(/^0+/, ''); // drop trunk zero(s) (600 case)
  if (national.length < 9 || national.length > 10) return null;
  return '+60' + national;
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  let rows;
  if (ONLY_COMPANY != null) {
    rows = await sql`SELECT id, company_id, name, phone FROM scm.customers
                     WHERE phone IS NOT NULL AND phone <> '' AND company_id = ${ONLY_COMPANY}`;
  } else {
    rows = await sql`SELECT id, company_id, name, phone FROM scm.customers
                     WHERE phone IS NOT NULL AND phone <> ''`;
  }

  const changes = [];
  for (const r of rows) {
    const fixed = fixDoubledMyPhone(r.phone);
    if (fixed && fixed !== r.phone) changes.push({ id: r.id, name: r.name, old: r.phone, next: fixed });
  }

  note(`customers with a phone: ${rows.length}; double-prefixed to repair: ${changes.length}`);
  changes.slice(0, LIST_LIMIT).forEach((c) => note(`  ${c.old}  ->  ${c.next}   (${c.name ?? ''})`));
  if (changes.length > LIST_LIMIT) note(`  ... ${changes.length - LIST_LIMIT} more.`);

  if (!APPLY) {
    note(`DRY-RUN total: ${changes.length} customer phone(s) would be repaired. Nothing written.`);
    await sql.end();
    return;
  }

  for (const c of changes) {
    await sql`UPDATE scm.customers SET phone = ${c.next}, updated_at = now()
              WHERE id = ${c.id} AND phone = ${c.old}`;
  }
  note(`APPLIED ${changes.length} phone repairs.`);
  note('REVERSAL source (id<TAB>old<TAB>new):');
  changes.forEach((c) => note(`  ${c.id}\t${c.old}\t${c.next}`));

  await sql.end();
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const after = await check`SELECT phone FROM scm.customers WHERE phone IS NOT NULL AND phone <> ''`;
  let remaining = 0;
  for (const r of after) if (fixDoubledMyPhone(r.phone)) remaining++;
  await check.end();
  if (remaining > 0) { bad(`INVARIANT FAILED: ${remaining} fixable double-prefixed phone(s) still stored.`); process.exit(1); }
  note('Invariant holds on a fresh connection: no fixable double-prefixed phone remains.');
}

main().catch((e) => { bad(e instanceof Error ? e.message : String(e)); process.exit(1); });
