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

  /* The UI's "Processing Date" is scm.mfg_sales_orders.processing_date — one
     column since 0189, one name since 0284. */
  const [sum] = await sql`
    SELECT
      count(*) FILTER (WHERE processing_date IS NOT NULL AND customer_delivery_date IS NOT NULL)::int AS both,
      count(*) FILTER (WHERE processing_date IS NULL     AND customer_delivery_date IS NULL)::int     AS neither,
      count(*) FILTER (WHERE processing_date IS NULL     AND customer_delivery_date IS NOT NULL)::int AS deliv_only,
      count(*) FILTER (WHERE processing_date IS NOT NULL AND customer_delivery_date IS NULL)::int     AS proc_only
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
           min(created_at)::date AS first_seen,
           max(created_at)::date AS last_seen
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO}
       AND processing_date IS NULL AND customer_delivery_date IS NOT NULL
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
     WHERE company_id = ${CO} AND processing_date IS NULL
       AND customer_delivery_date IS NOT NULL
       AND created_at > now() - interval '30 days'`;
  note(`\n  created in the last 30 days: ${recent.n}${Number(recent.n) ? "  <- still being produced" : "  (historical only)"}`);

  const eg = await sql`
    SELECT doc_no, status, customer_delivery_date, created_at::date AS created
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND processing_date IS NULL
       AND customer_delivery_date IS NOT NULL
     ORDER BY created_at DESC LIMIT 15`;
  note(`\n=== newest 15 ===`);
  for (const r of eg) {
    note(`  ${String(r.doc_no).padEnd(18)} ${String(r.status ?? "-").padEnd(12)} deliv=${r.customer_delivery_date}  created=${r.created}`);
  }

  await sql.end({ timeout: 5 });
}
main().catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
