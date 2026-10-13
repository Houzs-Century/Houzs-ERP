/* Repair stored phones that carry a DOUBLED Malaysian country code.

   THE SHAPE. "+60" glued onto a number that already carried it: "+6060142703095"
   (double 60) or, from the trunk-0 variant, "+600142703095". Two writers did it:
   the slip-scan draft builder before #4282, and the +60 phone picker when a full
   number ("60 19-268 9927" / "019-268 9927") was pasted behind it. Both are
   fixed forward (normalizePhone now collapses the doubled prefix, BUG-114); this
   repairs what is already stored.

   WHAT IT TOUCHES. The #4282 run repaired scm.customers only, so every Sales
   Order written from those customers before the fix kept "+6060..." on its own
   header, and that header is what the HC Delivery sheet prints (BUG-114:
   HC-SO-2609-096 "6060192689927"). This run covers the customer master plus
   the document headers listed in TARGETS. Only values whose digits start with
   "6060" or "600" — the two bug signatures — are read. A correct "+60 1x..."
   number never starts with those, and a foreign number (+65/+62/...) never does
   either. The corrected value is collapseDoubledMalaysianPrefix(), the same rule
   the API now applies on every write (scripts/lib/phone-normalise.mjs, pinned
   to src/scm/shared/phone.ts by phoneNormaliseMirror.test.ts). If the result is
   not a plausible Malaysian national length (8-10 digits) the row is SKIPPED,
   never guessed.

   A repaired Sales Order also gets updated_at = now(): the delivery sheet pulls
   orders by last-modified, so without it the sheet would keep printing the old
   number. The Venture Portal trigger does not watch phone or updated_at, and
   nothing here enqueues an AutoCount push.

   MODE=plan (default) lists every value before -> after and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", updates one row at a
   time (guarded on the row id + the exact old value), prints
   table.column<TAB>id<TAB>old<TAB>new for every change (the REVERSAL source),
   then re-reads on a fresh connection and asserts no target still carries the
   doubled prefix.

   REVERSAL: restore each printed row with its old value:
     UPDATE scm.<table> SET <column> = '<old>' WHERE <pk> = '<id>';

   Env: DATABASE_URL (required); COMPANY (optional, default = all); LIST_LIMIT
   (rows to print per column in plan, default 200).

   RE-RUN: idempotent — a fixed number no longer starts with 6060/600, so a
   second run finds nothing. */
import postgres from 'postgres';
import { collapseDoubledMalaysianPrefix } from './lib/phone-normalise.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const ONLY_COMPANY = process.env.COMPANY ? Number(process.env.COMPANY) : null;
const LIST_LIMIT = Number(process.env.LIST_LIMIT) > 0 ? Number(process.env.LIST_LIMIT) : 200;

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARN ${m}`);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

// Named explicitly: a repair changes exactly the set a human approved. Each is
// existence-checked and skipped with a warning when the database lacks it.
const TARGETS = [
  { table: 'customers', column: 'phone' },
  { table: 'mfg_sales_orders', column: 'phone', touch: true },
  { table: 'mfg_sales_orders', column: 'emergency_contact_phone', touch: true },
  { table: 'delivery_orders', column: 'phone' },
  { table: 'delivery_orders', column: 'emergency_contact_phone' },
  { table: 'sales_invoices', column: 'phone' },
  { table: 'sales_invoices', column: 'emergency_contact_phone' },
  { table: 'delivery_returns', column: 'phone' },
  { table: 'delivery_returns', column: 'emergency_contact_phone' },
  { table: 'consignment_sales_orders', column: 'phone' },
  { table: 'consignment_sales_orders', column: 'emergency_contact_phone' },
  { table: 'consignment_delivery_orders', column: 'phone' },
  { table: 'consignment_delivery_orders', column: 'emergency_contact_phone' },
  { table: 'consignment_delivery_returns', column: 'phone' },
  { table: 'consignment_delivery_returns', column: 'emergency_contact_phone' },
];

/** The corrected E.164, or null when this phone is not a double-prefix bug or the
 *  result is not a plausible Malaysian national number. */
export function fixDoubledMyPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (!(d.startsWith('6060') || d.startsWith('600'))) return null;
  const fixed = collapseDoubledMalaysianPrefix(d);
  return fixed === d ? null : '+' + fixed;
}

async function columnInfo(db, table, column) {
  const cols = await db`SELECT column_name FROM information_schema.columns
                         WHERE table_schema = 'scm' AND table_name = ${table}`;
  const names = new Set(cols.map((c) => c.column_name));
  if (!names.has(column)) return null;
  const pk = await db`
    SELECT a.attname AS col
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     WHERE i.indisprimary AND n.nspname = 'scm' AND c.relname = ${table}`;
  if (pk.length !== 1) return { pk: null };
  return { pk: pk[0].col, hasCompany: names.has('company_id'), hasUpdatedAt: names.has('updated_at') };
}

async function suspectRows(db, t, info) {
  const tbl = db(`scm.${t.table}`);
  const col = db(t.column);
  const company = ONLY_COMPANY != null && info.hasCompany ? db`AND company_id = ${ONLY_COMPANY}` : db``;
  return db`
    SELECT ${db(info.pk)}::text AS id, ${col} AS phone
      FROM ${tbl}
     WHERE regexp_replace(coalesce(${col}, ''), '\\D', '', 'g') ~ '^60(60|0)'
       ${company}`;
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  const plan = [];
  let total = 0;
  for (const t of TARGETS) {
    const info = await columnInfo(sql, t.table, t.column);
    if (!info) { warn(`SKIPPED scm.${t.table}.${t.column}: no such column.`); continue; }
    if (!info.pk) { warn(`SKIPPED scm.${t.table}.${t.column}: no single-column primary key.`); continue; }
    const rows = await suspectRows(sql, t, info);
    const changes = [];
    let unfixable = 0;
    for (const r of rows) {
      const next = fixDoubledMyPhone(r.phone);
      if (next && next !== r.phone) changes.push({ id: r.id, old: r.phone, next });
      else unfixable++;
    }
    note(`scm.${t.table}.${t.column}: ${changes.length} to repair, ${unfixable} doubled-looking but not a plausible MY number (left alone).`);
    changes.slice(0, LIST_LIMIT).forEach((c) => note(`  ${c.id}  ${c.old}  ->  ${c.next}`));
    if (changes.length > LIST_LIMIT) note(`  ... ${changes.length - LIST_LIMIT} more.`);
    plan.push({ t, info, changes });
    total += changes.length;
  }

  if (!APPLY) {
    note(`DRY-RUN total: ${total} phone value(s) would be repaired. Nothing written.`);
    await sql.end();
    return;
  }

  // A corrected customer phone can collide with an EXISTING customer that already
  // holds the right number under the same name (customers_name_phone_unique), i.e.
  // the bad-phone row is a DUPLICATE. We do not merge/delete here (that is the
  // owner's call); we skip the collision and report it.
  const done = [], collisions = [];
  for (const { t, info, changes } of plan) {
    const tbl = sql(`scm.${t.table}`);
    for (const c of changes) {
      try {
        const set = t.touch && info.hasUpdatedAt
          ? sql`${sql(t.column)} = ${c.next}, updated_at = now()`
          : sql`${sql(t.column)} = ${c.next}`;
        await sql`UPDATE ${tbl} SET ${set} WHERE ${sql(info.pk)}::text = ${c.id} AND ${sql(t.column)} = ${c.old}`;
        done.push({ ...c, where: `${t.table}.${t.column}`, pk: info.pk });
      } catch (e) {
        if (/unique/i.test(e instanceof Error ? e.message : String(e))) { collisions.push({ ...c, where: `${t.table}.${t.column}` }); continue; }
        throw e;
      }
    }
  }
  note(`APPLIED ${done.length} phone repairs; ${collisions.length} skipped as duplicates (a row with that name+number already exists).`);
  note('REVERSAL source (table.column<TAB>pk=id<TAB>old<TAB>new):');
  done.forEach((c) => note(`  ${c.where}\t${c.pk}=${c.id}\t${c.old}\t${c.next}`));
  if (collisions.length > 0) {
    note('DUPLICATES to dedup (table.column / id / bad-phone -> would-be):');
    collisions.forEach((c) => note(`  DUP ${c.where}\t${c.id}\t${c.old} -> ${c.next}`));
  }

  await sql.end();
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let remaining = 0;
  for (const { t, info } of plan) {
    for (const r of await suspectRows(check, t, info)) if (fixDoubledMyPhone(r.phone)) remaining++;
  }
  await check.end();
  // The only fixable rows left standing must be the ones we deliberately skipped
  // as duplicates; anything beyond that is a real failure.
  if (remaining > collisions.length) { bad(`INVARIANT FAILED: ${remaining} fixable double-prefixed phone(s) still stored (only ${collisions.length} expected as duplicates).`); process.exit(1); }
  note(`Invariant holds on a fresh connection: ${remaining} fixable phone(s) remain, all of them the reported duplicates.`);
}

main().catch((e) => { bad(e instanceof Error ? e.message : String(e)); process.exit(1); });
