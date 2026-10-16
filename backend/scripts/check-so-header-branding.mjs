// Read-only: which sales-order HEADERS hold a branding the BUG-115 rule would
// not stamp today (PR #4594).
//
// Before #4594 the header was stamped once at create from the first main line
// and never re-derived, and a category word (BEDFRAME) could win over a real
// brand — HC-SO-2609-336 is headed BEDFRAME and sells one Dunlopillo mattress.
// New and edited orders are now right; this lists the OLD rows still wrong.
//
// The rule is the app's own (lib/so-header-branding-drift.mjs imports
// pickHeaderBranding from derive-line-branding.ts), with restampHeaderBranding's
// skips: a migrated order (linked_ac_docno set) and an order with a live DO / SI
// are counted separately, never listed as repairable.
//
// One READ ONLY transaction per company, no writes. Exits 0 for every real
// answer, including "nothing to repair"; only an unreachable database or a
// query error exits non-zero. Optional COMPANY=HOUZS|2990 limits the run.
// Repair: repair-so-header-branding.mjs.
import postgres from "postgres";
import { pairCounts, readHeaderBrandingDrift } from "./lib/so-header-branding-drift.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }
const ONLY = String(process.env.COMPANY ?? "").trim().toUpperCase();

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m) => console.log(m);
const shown = (v) => (v == null ? "(null)" : JSON.stringify(v));

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
try {
  const companies = await sql`SELECT id, code FROM companies ORDER BY id`;
  let total = 0;
  for (const co of companies) {
    if (ONLY && String(co.code).toUpperCase() !== ONLY) continue;
    const r = await sql.begin("read only", (tx) => readHeaderBrandingDrift(tx, co));
    total += r.affected.length;
    notice(`${r.code} (company_id=${r.cid}): ${r.affected.length} repairable; skipped ${r.skippedMigrated.length} migrated (linked_ac_docno), ${r.skippedDownstream.length} with a live DO/SI`);
    const ownDoc = r.skippedMigrated.filter((h) => h.linked_ac_docno === h.doc_no).length;
    out(`  of the migrated skips, ${ownDoc} carry their own doc_no as linked_ac_docno (ERP-created, pushed to AutoCount)`);
    for (const [k, n] of pairCounts(r.affected)) out(`  PAIR\t${k}\tx${n}`);
    for (const [k, n] of pairCounts(r.skippedMigrated)) out(`  SKIP-MIGRATED-PAIR\t${k}\tx${n}`);
    for (const [k, n] of pairCounts(r.skippedDownstream)) out(`  SKIP-DOWNSTREAM-PAIR\t${k}\tx${n}`);
    const repend = r.affected.filter((h) => h.repend).length;
    out(`  fair_match would go back to PENDING on ${repend}`);
    for (const h of r.affected) {
      out(`  ROW\t${h.doc_no}\tstored=${shown(h.branding)}\tderived=${shown(h.derived)}\tstatus=${h.status}\tso_date=${h.so_date ?? "(null)"}${h.repend ? "\tfair->PENDING" : ""}`);
    }
  }
  notice(`TOTAL repairable: ${total}`);
} finally {
  await sql.end({ timeout: 5 });
}
