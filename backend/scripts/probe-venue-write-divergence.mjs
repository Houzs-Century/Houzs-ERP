#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. "The repair wrote one name and the row came back holding another —
// what actually happened?"
//
// THE OBSERVATION, run 33424502242 (repair-blanked-venue, APPLY, company 2):
//   APPLIED — 5 order(s) got their venue name back.
//   VERIFY: name matches the order's own venue id on 0
//      UNEXPECTED 2990-SO-2606-008: venue="2990s PJ" should be "PJ Showroom"
//
// The UPDATE was `SET venue = v.name FROM scm.venues v WHERE v.id = h.venue_id`
// and the verify re-joined the SAME key on a fresh connection. Those two cannot
// disagree unless something between them changed the row — so something did, and
// naming it is the whole job here. Note the row is NOT damaged: "2990s PJ" is
// the name the audit log shows this order carrying before the blanking, so the
// outcome may well be right for a reason the script does not know about. That is
// exactly why this asks rather than re-runs.
//
// WHAT IT PRINTS. Four things, in the order they narrow the answer:
//   1. TRIGGERS on scm.mfg_sales_orders — a BEFORE UPDATE that derives `venue`
//      would rewrite the value inside the same statement, which is the leading
//      hypothesis and the cheapest to refute.
//   2. Whether `scm.mfg_sales_orders.venue_id` REFERENCES scm.venues at all, or
//      some other table. A foreign key pointing elsewhere means the script has
//      been joining a table that merely shares a uuid space.
//   3. For each of the five documents: venue, venue_id, venue_source, and the
//      name held by BOTH candidate masters for that id.
//   4. Whether the two names are two rows of one table or one row seen twice.
//
// PRIVACY: venue names and document numbers only — no customer, no address, no
// amount. This repository and its Actions logs are public.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction.
//
//   DATABASE_URL   required
//   COMPANY        default 2
//
// RE-RUN: idempotent and side-effect free.
// ----------------------------------------------------------------------------
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const COMPANY = Number(process.env.COMPANY ?? 2);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const DOCS = ['2990-SO-2606-008', '2990-SO-2607-010', '2990-SO-2608-024',
  '2990-SO-2608-070', '2990-SO-2608-079'];

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  log(`company=${COMPANY}`);

  const trg = await sql`
    SELECT t.tgname, p.proname AS fn, t.tgenabled,
           pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'scm' AND c.relname = 'mfg_sales_orders' AND NOT t.tgisinternal`;
  log('');
  log(`1. TRIGGERS on scm.mfg_sales_orders: ${trg.length}`);
  for (const t of trg) {
    log(`   ${t.tgname}  ->  ${t.fn}()  enabled=${t.tgenabled}`);
    /* The definition, because "there is a trigger" is not an answer — WHEN it
       fires and on WHICH columns is. */
    log(`      ${String(t.def).replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  if (!trg.length) log('   none — a trigger is NOT the explanation.');

  const fks = await sql`
    SELECT con.conname, ref.relname AS references_table
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class ref ON ref.oid = con.confrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
     WHERE n.nspname = 'scm' AND c.relname = 'mfg_sales_orders'
       AND con.contype = 'f' AND a.attname = 'venue_id'`;
  log('');
  log(`2. venue_id foreign keys: ${fks.length}`);
  for (const f of fks) log(`   ${f.conname} -> ${f.references_table}`);
  if (!fks.length) log('   NONE — venue_id is unconstrained, so nothing guarantees which master it names.');

  /* Both candidate masters, side by side, for the SAME id. If one answers and
     the other does not, that alone settles which table the column means. */
  const rows = await sql`
    SELECT h.doc_no, h.venue, h.venue_id::text AS venue_id, h.venue_source, h.updated_at,
           (SELECT v.name FROM scm.venues v WHERE v.id = h.venue_id) AS in_scm_venues,
           (SELECT pv.name FROM public.project_venues pv WHERE pv.id = h.venue_id) AS in_project_venues
      FROM scm.mfg_sales_orders h
     WHERE h.doc_no = ANY(${DOCS}) AND h.company_id = ${COMPANY}
     ORDER BY h.doc_no`;
  log('');
  log(`3. THE FIVE DOCUMENTS (${rows.length} found)`);
  for (const r of rows) {
    log(`   ${r.doc_no}`);
    log(`      venue        = "${r.venue ?? ''}"   venue_source=${r.venue_source ?? '-'}`);
    log(`      venue_id     = ${r.venue_id ?? '-'}`);
    log(`      scm.venues            says "${r.in_scm_venues ?? '(no row)'}"`);
    log(`      public.project_venues says "${r.in_project_venues ?? '(no row)'}"`);
    log(`      last written ${r.updated_at}`);
  }

  /* Are "2990s PJ" and "PJ Showroom" two masters, or one row renamed? */
  const named = await sql`
    SELECT 'scm.venues' AS src, id::text, name, company_id
      FROM scm.venues WHERE name ILIKE '%PJ%'
     UNION ALL
    SELECT 'project_venues', id::text, name, company_id
      FROM public.project_venues WHERE name ILIKE '%PJ%'
     ORDER BY 3`;
  log('');
  log(`4. EVERY "PJ" venue in both masters: ${named.length}`);
  for (const v of named) log(`   ${v.src.padEnd(15)} company ${v.company_id ?? '-'}  "${v.name}"  ${v.id}`);

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
