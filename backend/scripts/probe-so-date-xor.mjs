#!/usr/bin/env node
/* Read-only: how many live orders already break the both-dates-or-neither rule.

   THE RULE (owner, restated 2026-08-13): "processing date 和 delivery date 必须
   同时有或者同时没有". A Processing Date is the go-to-production signal and a
   Delivery Date is what it is promised against; one without the other is a
   half-stated schedule.

   WHERE IT IS ENFORCED, AND WHERE IT IS NOT.
     client  frontend/src/vendor/scm/lib/so-form-validate.ts:94
               if ((i.requireDatesTogether ?? true) && hasP !== hasD) → refuse
             Both directions. Desktop New/Edit and mobile (mobile relaxes it
             for a DRAFT, which strips both dates).
     server  backend/src/scm/shared/so-save-problems.ts, inside
               if (facts.procDate && facts.completeness) { ... }
               if (!facts.delivDate) → 'A delivery date is required ...'
             ONE direction only. A Delivery Date with NO Processing Date raises
             nothing, so any path that does not go through the form — a direct
             API call, an import script, a future surface — can write one.

   Before closing that half, count what is already there: a server rule that
   fires on save would block the next edit of every pre-existing offender,
   including edits that do not touch a date. That is the grandfather carve-out
   the past-date rules already use (origProcDate / origDelivDate), and this
   probe says how many rows would need it.

   Writes nothing. */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const CO = Number(process.env.COMPANY || 1);

async function main() {
  const [tot] = await sql`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE company_id = ${CO}`;
  note(`sales orders (company ${CO}): ${tot.n}`);

  /* The UI's "Processing Date" is internal_expected_dd (PR #140 renamed it);
     the legacy processing_date column was dropped in migration 0189. */
  const [sum] = await sql`
    SELECT
      count(*) FILTER (WHERE internal_expected_dd IS NOT NULL AND customer_delivery_date IS NOT NULL)::int AS both,
      count(*) FILTER (WHERE internal_expected_dd IS NULL     AND customer_delivery_date IS NULL)::int     AS neither,
      count(*) FILTER (WHERE internal_expected_dd IS NULL     AND customer_delivery_date IS NOT NULL)::int AS deliv_only,
      count(*) FILTER (WHERE internal_expected_dd IS NOT NULL AND customer_delivery_date IS NULL)::int     AS proc_only
    FROM scm.mfg_sales_orders WHERE company_id = ${CO}`;

  note(`\n=== both-or-neither ===`);
  note(`  both dates set:        ${sum.both}`);
  note(`  neither set:           ${sum.neither}`);
  note(`  DELIVERY only (no P):  ${sum.deliv_only}   <- the half the server does not refuse`);
  note(`  PROCESSING only (no D):${sum.proc_only}   <- the server already refuses this on save`);

  const offenders = Number(sum.deliv_only) + Number(sum.proc_only);
  note(`\n  rows that a save-time rule would newly block: ${offenders}`);
  note(`  (each would need the grandfather carve-out the past-date rules use,`);
  note(`   or an edit that does not touch a date would start failing)`);

  /* WHO wrote them. There is no `source` column on the header, so provenance
     is read off status + the created_at bracket: old imported history and
     something a live surface is still producing need different answers
     (backfill vs close the hole first). */
  const bySrc = await sql`
    SELECT coalesce(status::text, '(null)') AS status,
           count(*)::int AS n,
           to_char(min(created_at), 'YYYY-MM-DD') AS first_seen,
           to_char(max(created_at), 'YYYY-MM-DD') AS last_seen
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO}
       AND internal_expected_dd IS NULL AND customer_delivery_date IS NOT NULL
     GROUP BY 1 ORDER BY n DESC`;
  note(`\n=== DELIVERY-only rows, by status ===`);
  if (!bySrc.length) note(`  none`);
  for (const r of bySrc) {
    note(`  ${String(r.status).padEnd(14)} ${String(r.n).padStart(5)}   ${r.first_seen} .. ${r.last_seen}`);
  }

  /* Is anything STILL producing them? A rule that only grandfathers old rows is
     enough when the hole is closed; if a live surface is writing them this
     week, the hole has to close first or the backlog just regrows. */
  const [recent] = await sql`
    SELECT count(*)::int AS n FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND internal_expected_dd IS NULL
       AND customer_delivery_date IS NOT NULL
       AND created_at > now() - interval '30 days'`;
  note(`\n  created in the last 30 days: ${recent.n}${Number(recent.n) ? "  <- still being produced" : "  (historical only)"}`);

  const eg = await sql`
    SELECT doc_no, status, to_char(customer_delivery_date, 'YYYY-MM-DD') AS deliv,
           to_char(created_at, 'YYYY-MM-DD') AS created,
           to_char(proceeded_at, 'YYYY-MM-DD') AS proceeded
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND internal_expected_dd IS NULL
       AND customer_delivery_date IS NOT NULL
     ORDER BY created_at DESC LIMIT 15`;
  note(`\n=== newest 15 ===`);
  for (const r of eg) {
    note(`  ${String(r.doc_no).padEnd(18)} ${String(r.status ?? "-").padEnd(14)} deliv=${r.deliv}  created=${r.created}  proceeded_at=${r.proceeded ?? "-"}`);
  }

  /* ── WHERE DID THE PROCESSING DATE GO? ───────────────────────────────────
     'both dates set: 0' is not a rounding artefact — if it holds, NOT ONE
     order in this company carries a Processing Date, and internal_expected_dd
     is the ONLY thing soProcessingLocked reads ('const proc =
     header.internal_expected_dd ?? null; if (!proc) return false'). Nothing
     would be spec-gated and nothing would be edit-locked.

     There is a candidate explanation in the import: backfill-so-dates.mjs
     maps AutoCount's UDF_PDate (the header processing date) onto
     `proceeded_at`, NOT onto internal_expected_dd. If proceeded_at is
     populated on the same rows whose internal_expected_dd is null, the dates
     are not missing — they are in the column the ERP does not read. */
  const [where] = await sql`
    SELECT
      count(*) FILTER (WHERE internal_expected_dd IS NOT NULL)::int AS has_ied,
      count(*) FILTER (WHERE proceeded_at IS NOT NULL)::int AS has_proceeded,
      count(*) FILTER (WHERE internal_expected_dd IS NULL AND proceeded_at IS NOT NULL)::int AS proceeded_but_no_ied,
      count(*) FILTER (WHERE internal_expected_dd IS NULL AND proceeded_at IS NOT NULL
                         AND customer_delivery_date IS NOT NULL)::int AS proceeded_deliv_no_ied
    FROM scm.mfg_sales_orders WHERE company_id = ${CO}`;
  note(`\n=== where the processing date actually is ===`);
  note(`  internal_expected_dd set (the ERP's Processing Date): ${where.has_ied}`);
  note(`  proceeded_at set:                                     ${where.has_proceeded}`);
  note(`  proceeded_at set but internal_expected_dd NULL:        ${where.proceeded_but_no_ied}`);
  note(`     ... of those, also carrying a delivery date:        ${where.proceeded_deliv_no_ied}`);
  if (Number(where.has_ied) === 0) {
    note(`  → NO order carries a Processing Date. soProcessingLocked reads only`);
    note(`    internal_expected_dd, so no order is edit-locked and no order is`);
    note(`    spec-gated, whatever proceeded_at says.`);
  }

  await sql.end({ timeout: 5 });
}
main().catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
