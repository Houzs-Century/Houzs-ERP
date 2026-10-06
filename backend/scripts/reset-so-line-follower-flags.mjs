#!/usr/bin/env node
/* Clear line_delivery_date_overridden on Sales Order lines that only FOLLOW the
   header: flag true, line date equal to the order's header Delivery Date.

   WHY. Owner 2026-10-06 (Weisiang): on a header Delivery Date change a line the
   user hand-set keeps its date, every other line follows. apply_so_header_cas
   now keeps every line whose flag is true (20261006T1300). Until the same PR,
   the item routes flagged any line a caller sent a date for (the phone editor
   sends every line's date) and an approved delivery-date amendment flagged every
   line, so many lines carry true while sitting on the header date. Left alone,
   those would stay behind on the next header change.

   SAFE. A flagged line on the header date reads the same date either way
   (effective-delivery.ts), so no visible date moves. A line truly hand-set to
   the header's own date cannot be told apart and becomes a follower — it was on
   the header date anyway. Which lines: lib/so-line-follower-flags.mjs.

   MODE=plan (default) prints how many lines and orders, writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", clears the flag in one
   statement, and re-reads every touched line on a FRESH connection: flag false,
   date unchanged, still equal to the header date.

   COMPANY_ID is required (1 = Houzs Century). Plan also prints the count across
   every company so another company's run is not missed.

   RE-RUN: inert. Keyed on flag = true, which the reset turns false. */
import postgres from 'postgres';
import { planFollowerFlags, resetFollowerFlags, verifyFollowerFlags } from './lib/so-line-follower-flags.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID);
if (!Number.isInteger(CO) || CO <= 0) { console.error('need COMPANY_ID (e.g. COMPANY_ID=1)'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);
  const plan = await planFollowerFlags(sql, CO);
  note(`  lines flagged hand-set while on the header date: ${plan.lines} on ${plan.orders} order(s)`);
  const perCo = await sql`
    SELECT i.company_id, count(*)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
     WHERE i.line_delivery_date_overridden IS TRUE AND i.line_delivery_date IS NOT NULL
       AND i.line_delivery_date = NULLIF(left(h.customer_delivery_date::text, 10), '')::date
     GROUP BY i.company_id ORDER BY i.company_id`;
  for (const r of perCo) note(`  (all companies) company ${r.company_id}: ${r.n} line(s)`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (plan.lines === 0) { note('Nothing to reset.'); await sql.end({ timeout: 5 }); return; }

  const touched = await resetFollowerFlags(sql, CO);
  note(`  written: ${touched.length} line(s) on ${new Set(touched.map((t) => t.doc_no)).size} order(s)`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const wrong = await verifyFollowerFlags(check, CO, touched);
    for (const w of wrong.slice(0, 50)) bad(`  ${w}`);
    const left = await planFollowerFlags(check, CO);
    note(`  lines in the wrong shape: ${wrong.length} of ${touched.length}; still flagged on the header date: ${left.lines}`);
    if (wrong.length > 0) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
