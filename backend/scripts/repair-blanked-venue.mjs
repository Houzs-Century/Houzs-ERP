#!/usr/bin/env node
// ----------------------------------------------------------------------------
// repair-blanked-venue — put back the venue name a save wiped, from the venue id
// that same save wrote.
//
// THE DEFECT (owner, 2026-09-01: 「为什么我的 Venue 又不见了？」). The Sales Order
// form's default-venue effect wrote `venue: ''` over a loaded venue whenever the
// venue master had not arrived yet — and it could not repair itself, because its
// own `if (form.venueId) return` guard makes it a one-shot. PROVEN on
// 2990-SO-2608-070 (audit log, 2026-08-31 07:50:31): `venue: "2990s PJ" -> ""`
// and `venueId: null -> "5cafa0a2…"`, one save, both fields.
//
// Every MIRRORED 2990 order starts in exactly the state that triggers it — the
// mirror forces `venue_id: null` and keeps the text — so each one lost its venue
// the first time somebody opened and saved it.
//
// WHAT THIS WRITES: `venue` ONLY, and only on rows that carry a venue_id whose
// master row has a name, and whose venue text is empty. It is a re-resolve of a
// value the order already points at — not a guess. `venue_source` is left
// exactly as it is: this repairs the NAME, it does not re-decide who chose it.
//
// WHAT IT REFUSES: a row with no venue_id (nothing to resolve from — that is the
// create path's deliberate NULL, and guessing there would put a wrong venue on
// an exhibition P&L), and a venue_id with no row in scm.venues.
//
//   DATABASE_URL   required
//   COMPANY        company id (default 2)
//   MODE           plan (default) | apply
//   CONFIRM        on apply, must be exactly: RESTORE THE VENUE NAME
//
// RE-RUN: convergent. A second run finds nothing — the rows it filled are no
// longer empty, and it never touches a row that already has a venue.
// ----------------------------------------------------------------------------
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const COMPANY = Number(process.env.COMPANY ?? 2);
const MODE = (process.env.MODE ?? 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'RESTORE THE VENUE NAME';
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && (process.env.CONFIRM ?? '').trim() !== CONFIRM_PHRASE) {
  console.error(`REFUSED: apply needs CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  log(`mode=${APPLY ? 'APPLY' : 'PLAN'} company=${COMPANY}`);

  const cands = await sql`
    SELECT h.doc_no, v.name AS venue_name
      FROM scm.mfg_sales_orders h
      JOIN scm.venues v ON v.id = h.venue_id
     WHERE h.company_id = ${COMPANY}
       AND COALESCE(btrim(h.venue), '') = ''
       AND h.venue_id IS NOT NULL
       AND COALESCE(btrim(v.name), '') <> ''
     ORDER BY h.doc_no`;

  const [orphan] = await sql`
    SELECT COUNT(*)::int AS n FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${COMPANY}
       AND COALESCE(btrim(h.venue), '') = ''
       AND h.venue_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM scm.venues v WHERE v.id = h.venue_id)`;
  const [noId] = await sql`
    SELECT COUNT(*)::int AS n FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${COMPANY}
       AND COALESCE(btrim(h.venue), '') = '' AND h.venue_id IS NULL`;

  log(`orders whose venue name can be restored from their own venue id: ${cands.length}`);
  const byVenue = new Map();
  for (const r of cands) byVenue.set(r.venue_name, (byVenue.get(r.venue_name) ?? 0) + 1);
  for (const [name, n] of [...byVenue.entries()].sort((a, b) => b[1] - a[1])) log(`   "${name}": ${n}`);
  log(`NOT touched — venue_id points at no venue row: ${orphan.n}`);
  log(`NOT touched — no venue id at all (the create path's deliberate NULL): ${noId.n}`);

  if (!APPLY) { log(''); log(`PLAN ONLY — MODE=apply CONFIRM="${CONFIRM_PHRASE}" writes.`); await sql.end(); return; }
  if (!cands.length) { log('nothing to do.'); await sql.end(); return; }

  const done = await sql`
    UPDATE scm.mfg_sales_orders h
       SET venue = v.name, updated_at = now()
      FROM scm.venues v
     WHERE v.id = h.venue_id
       AND h.company_id = ${COMPANY}
       AND COALESCE(btrim(h.venue), '') = ''
       AND COALESCE(btrim(v.name), '') <> ''
   RETURNING h.doc_no`;
  log(`APPLIED — ${done.length} order(s) got their venue name back.`);

  /* VERIFY on a FRESH connection, on the VALUES: every row this run touched must
     now read the name its own venue_id names. A count would say "12 of 12" while
     writing the wrong name into all twelve.

     THROUGH scm.canonicalize_venue(), and that is not a detail — the first APPLY
     (run 33424502242) reported VERIFY FAILED on five rows it had written
     CORRECTLY. Mig 0229 puts a BEFORE UPDATE OF venue trigger on this table that
     folds known aliases, so the write of "PJ Showroom" (the venues master's
     spelling) landed as "2990s PJ" (the canonical one) — the same showroom under
     the name the rest of the system uses. Comparing the stored value against the
     RAW master therefore cried failure on a success, which is the more dangerous
     direction: the next person re-runs a repair that already worked, or reverts
     it. Compare what the database would STORE, not what we handed it. */
  const v = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  const docs = done.map((d) => d.doc_no);
  const after = await v`
    SELECT h.doc_no, h.venue,
           scm.canonicalize_venue(ven.name) AS should_be,
           ven.name AS master_name
      FROM scm.mfg_sales_orders h
      JOIN scm.venues ven ON ven.id = h.venue_id
     WHERE h.doc_no = ANY(${docs}) AND h.company_id = ${COMPANY}`;
  /* Reported, never repaired here: a venues row whose own name is a known alias
     is a picker entry that keeps handing out the non-canonical spelling. Folding
     it belongs to backfill-canonicalize-venue.mjs, which has its own dry run —
     mig 0229 is explicit that it does no backfill of its own. */
  const aliasMasters = [...new Set(after
    .filter((r) => String(r.master_name ?? '').trim() !== String(r.should_be ?? '').trim())
    .map((r) => `"${r.master_name}" -> "${r.should_be}"`))];
  const wrong = after.filter((r) => String(r.venue ?? '').trim() !== String(r.should_be ?? '').trim());
  log(`VERIFY (fresh connection, values not counts): ${after.length} of ${docs.length} re-read; `
    + `name matches the order's own venue id on ${after.length - wrong.length}`);
  for (const r of wrong.slice(0, 5)) log(`   UNEXPECTED ${r.doc_no}: venue="${r.venue}" should be "${r.should_be}"`);
  if (aliasMasters.length) {
    log(`   FYI — ${aliasMasters.length} venue master row(s) carry a non-canonical name; the trigger folded`
      + ` it on write, so the ORDERS are right and the PICKER still is not: ${aliasMasters.join(', ')}`);
    log('   Fold them with backfill-canonicalize-venue.mjs (dry-run gated). Not done here.');
  }
  if (wrong.length || after.length !== docs.length) log('VERIFY FAILED — investigate before re-running.');
  await v.end();
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
