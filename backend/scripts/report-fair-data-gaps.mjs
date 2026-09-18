#!/usr/bin/env node
/* READ-ONLY. The three data gaps that stop an order linking to its fair.
 *
 * Owner rule: never ask him to run a query — build the check. Actions ->
 * "Fair data gaps (read-only)" -> Run workflow; the answer is the run log.
 *
 * WRITES NOTHING, on any path. SELECTs only, no DDL, no transaction. Exits 0 for
 * every legitimate answer including "all three are clear" — a red job reads as
 * "the check broke", and the answer is the output. Non-zero is reserved for an
 * unreachable database.
 *
 * ── WHAT IT LOOKS FOR, AND WHY EACH ONE BREAKS THE LINK ────────────────────
 *
 * 1. ORGANIZER SPELLINGS. The fair picker's rows are "place — organizer", so two
 *    spellings of one organizer are two rows on screen and two different fairs
 *    to a report. Measured 2026-09-13: `MALL MGMT` and `MALL MGT` both exist,
 *    and GURNEY PARAGON in June therefore looked like two organizers at one
 *    venue on one day when it was one.
 *
 *    The automatic fold catches case, spacing and punctuation only. It does NOT
 *    catch that pair, and no safe rule would: `MGT`/`MGMT` is an abbreviation,
 *    and a rule loose enough to fold it would fold organizers that really are
 *    different. So section 1 prints the WHOLE roster (~15 rows) for a person to
 *    read. This limit is not theoretical — on the first real dispatch the fold
 *    reported `KAI HAO (KL CHEN)` / `KAI HAO (KL, CHEN)` and stayed silent about
 *    MALL MGT.
 *
 * 2. MAIN PRODUCTS WITH NO BRAND. The brand is what decides WHICH booth at a
 *    picked event an order belongs to, and it is read off the SKU. A main
 *    product (sofa / bedframe / mattress) with a blank brand leaves the order
 *    AMBIGUOUS at a multi-brand fair. 104 such SKUs on 2026-09-13 — including
 *    the two sofas on HC-SO-2609-065, which is why that order's brand is blank.
 *
 * 3. DUPLICATE FAIRS. Two project rows identical on venue + organizer + brand +
 *    period are one booth entered twice. The resolver collapses them to the
 *    lowest id so an order still links, but the duplicate splits that fair's P&L
 *    and puts a repeated row in the picker. Measured by this script's first
 *    clean run (2026-09-13): 66 groups across all years, 9 of them inside
 *    Jun-Dec 2026. The earlier "9" quoted in #3778 was the Jun-Dec window only
 *    and read as an all-time figure; this section has no date filter.
 *
 * THIS SCRIPT DOES NOT FIX ANY OF THEM, deliberately. Fixing #1 means choosing
 * which spelling is right, #2 means knowing what brand a product actually is,
 * and #3 means deciding which duplicate keeps the history hanging off it. All
 * three are the owner's calls, not a script's, and inventing the answers would
 * be manufacturing the evidence the report exists to gather.
 *
 * RE-RUN: safe and identical — it is a read. Nothing is cached or stamped.
 */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const CO = Number(process.env.COMPANY || 1);
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const line = (m) => console.log(m);

/** Compare key for an organizer name: case- and inner-space-insensitive, and
 *  punctuation-insensitive, so `MALL MGMT` / `Mall Mgmt.` fold together. This is
 *  a REPORTING key only — it never rewrites anything. */
function orgKey(v) {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

async function main() {
  line(`Fair data gaps — company ${CO}, ${new Date().toISOString().slice(0, 10)}`);
  line('');

  // ── 1. organizer spellings ────────────────────────────────────────────────
  const organizers = await sql`
    SELECT organizer, count(*)::int AS fairs
      FROM public.projects
     WHERE company_id = ${CO}
       AND coalesce(btrim(organizer), '') <> ''
     GROUP BY organizer
     ORDER BY organizer`;
  const byKey = new Map();
  for (const r of organizers) {
    const k = orgKey(r.organizer);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const dupOrgs = [...byKey.entries()].filter(([, rows]) => rows.length > 1);
  line(`1. ORGANIZER SPELLINGS — ${dupOrgs.length} organizer(s) written more than one way`);
  for (const [, rows] of dupOrgs) {
    line(`   ${rows.map((r) => `"${r.organizer}" (${r.fairs})`).join('  vs  ')}`);
  }
  if (dupOrgs.length === 0) line('   none by the fold key');
  /* The fold key above catches case, spacing and punctuation. It CANNOT catch an
     abbreviation — `MALL MGMT` and `MALL MGT` are one organizer to a human and
     two different keys to any rule, and a rule loose enough to fold them would
     also fold organizers that really are different. Measured on the first real
     dispatch (2026-09-13): the fold found `KAI HAO (KL CHEN)` / `KAI HAO (KL,
     CHEN)` and did NOT find the MALL MGT pair, which is exactly this limit.
     So the whole roster is printed — it is ~15 rows — and a person reads it.
     A list a human scans beats a cleverer rule nobody can audit. */
  line('   full roster, for the abbreviations no fold key can catch safely:');
  for (const r of organizers) line(`     ${String(r.fairs).padStart(4)}  ${r.organizer}`);
  line('');

  // ── 2. main products with no brand ────────────────────────────────────────
  /* MAIN = the categories deriveHeaderBrandingFromLines treats as the
     representative line. An accessory with no brand is harmless; a sofa with no
     brand is what leaves an order unattributable. */
  const noBrand = await sql`
    SELECT category, count(*)::int AS skus
      FROM scm.mfg_products
     WHERE company_id = ${CO}
       AND coalesce(btrim(branding), '') = ''
       AND (upper(category::text) LIKE '%SOFA%'
         OR upper(category::text) LIKE '%BEDFRAME%'
         OR upper(category::text) LIKE '%MATTRESS%')
     GROUP BY category
     ORDER BY skus DESC`;
  const totalNoBrand = noBrand.reduce((n, r) => n + r.skus, 0);
  line(`2. MAIN PRODUCTS WITH NO BRAND — ${totalNoBrand} SKU(s)`);
  for (const r of noBrand) line(`   ${r.category.padEnd(12)} ${r.skus}`);
  if (totalNoBrand === 0) line('   none');
  if (totalNoBrand > 0) {
    const sample = await sql`
      SELECT code, category
        FROM scm.mfg_products
       WHERE company_id = ${CO}
         AND coalesce(btrim(branding), '') = ''
         AND (upper(category::text) LIKE '%SOFA%'
           OR upper(category::text) LIKE '%BEDFRAME%'
           OR upper(category::text) LIKE '%MATTRESS%')
       ORDER BY category, code
       LIMIT 40`;
    line(`   first ${sample.length}:`);
    for (const r of sample) line(`     ${r.category.padEnd(10)} ${r.code}`);
  }
  line('');

  // ── 3. duplicate fairs ────────────────────────────────────────────────────
  const dupFairs = await sql`
    SELECT venue, organizer, brand, start_date, end_date,
           count(*)::int AS rows,
           string_agg(id::text, ',' ORDER BY id) AS ids
      FROM public.projects
     WHERE company_id = ${CO}
       AND lower(coalesce(status, '')) <> 'cancelled'
       AND coalesce(btrim(venue), '') <> ''
       AND start_date IS NOT NULL
     GROUP BY venue, organizer, brand, start_date, end_date
    HAVING count(*) > 1
     ORDER BY start_date DESC
     LIMIT 100`;
  line(`3. DUPLICATE FAIRS — ${dupFairs.length} group(s), one booth entered twice`);
  for (const r of dupFairs) {
    line(`   ids ${r.ids.padEnd(14)} ${r.start_date}  ${r.venue} — ${r.organizer ?? '(no organizer)'} [${r.brand ?? '(no brand)'}]`);
  }
  if (dupFairs.length === 0) line('   none');
  line('');

  note(
    `Fair data gaps: ${dupOrgs.length} organizer spelling(s), ` +
    `${totalNoBrand} main SKU(s) with no brand, ${dupFairs.length} duplicate fair group(s).`,
  );
}

main()
  .then(() => sql.end())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('fair-data-gaps FAILED:', e?.message ?? e);
    try { await sql.end(); } catch { /* already closed */ }
    /* Non-zero ONLY here: the database could not be reached or read. Every
       legitimate answer, including "all clear", exits 0 above. */
    process.exit(1);
  });
