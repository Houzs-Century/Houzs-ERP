#!/usr/bin/env node
// repair-do-delivery-dates-to-autocount — a migrated / converted delivery order
// was showing the SALES ORDER's customer date (what the customer originally
// asked) as its delivery date, instead of the DELIVERY ORDER's own date, which
// is AutoCount's. Owner 2026-09-11 「全部要跟 autocount」: HC-DO-011559 showed
// 05/09 while AutoCount (and the DO's own DocDate) said 19/09.
//
// This sets an AutoCount-linked DO's `expected_delivery_at` and
// `customer_delivery_date` to its own `do_date` (= AutoCount's DocDate), for
// every DO where they currently differ. The customer's original ask is NOT lost
// — it still lives on the sales order (scm.mfg_sales_orders.customer_delivery_date).
//
// SCOPE: `linked_ac_docno IS NOT NULL` — only documents that exist in AutoCount,
// so `do_date` is genuinely the account book's date. 2990 documents carry no
// linked_ac_docno and are untouched.
//
// The ongoing conversion (delivery-orders-mfg.ts) and the migrated backfill
// (scripts/lib/customer-block.mjs DO_SALES_CARRY) are fixed at source in the
// same PR, so this repair is a one-time catch-up, not a recurring patch.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="DO-DATES-FOLLOW-AUTOCOUNT".
// RE-RUN: idempotent — only rows still differing are updated; a second run finds
// none (the fresh-connection shape check below asserts zero remain).
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "DO-DATES-FOLLOW-AUTOCOUNT";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const die = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

const iso = (v) => (v == null ? "(none)" : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));

const WHERE = "linked_ac_docno IS NOT NULL AND do_date IS NOT NULL AND "
  + "(expected_delivery_at IS DISTINCT FROM do_date OR customer_delivery_date IS DISTINCT FROM do_date)";

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM scm.delivery_orders WHERE ${WHERE}`);
  log(`AutoCount-linked delivery orders whose delivery dates DON'T match their own DO date: ${n}`);

  const byCo = await sql.unsafe(`SELECT company_id, count(*)::int AS n FROM scm.delivery_orders WHERE ${WHERE} GROUP BY company_id ORDER BY company_id`);
  for (const r of byCo) log(`   company ${r.company_id}: ${r.n}`);

  const samples = await sql.unsafe(
    `SELECT do_number, do_date, expected_delivery_at, customer_delivery_date, linked_ac_docno
       FROM scm.delivery_orders WHERE ${WHERE} ORDER BY do_date DESC LIMIT 12`);
  log("--- samples (what they are now -> what they become) ---");
  for (const r of samples) {
    log(`   ${r.do_number} (book ${r.linked_ac_docno}): expected ${iso(r.expected_delivery_at)}, customer ${iso(r.customer_delivery_date)}  ->  both ${iso(r.do_date)}`);
  }

  if (MODE !== "apply") {
    log(`PLAN: nothing written. ${n} document(s) would change. Re-run MODE=apply CONFIRM=${CONFIRM_PHRASE} to apply.`);
    await sql.end();
    return;
  }
  if (CONFIRM !== CONFIRM_PHRASE) { await sql.end(); die(`apply needs CONFIRM=${CONFIRM_PHRASE}`); }

  const updated = await sql.unsafe(
    `UPDATE scm.delivery_orders
        SET expected_delivery_at = do_date, customer_delivery_date = do_date
      WHERE ${WHERE}
      RETURNING id`);
  log(`APPLIED: ${updated.length} delivery order(s) set to their own DO date.`);
  await sql.end();

  /* SHAPE CHECK on a FRESH connection — assert ZERO still differ. A trigger that
     re-wrote customer_delivery_date, or a partial update, would surface here as a
     non-zero remainder rather than a satisfied row count. */
  const sql2 = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const [{ n: remain }] = await sql2.unsafe(`SELECT count(*)::int AS n FROM scm.delivery_orders WHERE ${WHERE}`);
  await sql2.end();
  if (remain !== 0) die(`verify FAILED: ${remain} document(s) still differ after the update. Something reverted the write (a trigger?).`);
  log("VERIFIED on a fresh connection: 0 AutoCount-linked delivery orders still differ from their DO date.");
}
main().catch((e) => { console.error(e); process.exit(1); });
