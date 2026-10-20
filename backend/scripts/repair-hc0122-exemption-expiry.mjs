// Freeze the Sales Exemption Expiry Date on every processed order that never
// got one (HC-0122 / 2990-0010).
//
// Syu, 2026-10-20: "I do need the sales exemption delivery date to do not
// change once the salesperson have entered the delivery date when process the
// bill ... the sales exemption date is the one I will refer to when I need to
// make charge to customer." BUG-51 (2026-10-05) freezes the column from the
// first delivery date, but only for orders created or edited after it shipped;
// older orders (HC-SO-008230, 2990-SO-2608-040 / -053) still carry NULL, so the
// list falls back to the CURRENT delivery date and a reschedule moves it. Syu
// has no record of the original dates, so the best value left is the one each
// order shows today.
//
// WHAT THIS DOES: one column, sales_exemption_expiry, on orders that are not
// DRAFT / CANCELLED and whose column is still NULL. It freezes to the AutoCount
// book's expiry when the order is linked and the book has one, else to the
// current customer_delivery_date. One SO history row per order says why.
// Version, updated_at, status, delivery date, lines and AutoCount are untouched.
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        required on apply: HC0122-FREEZE-EXEMPTION-EXPIRY
//   COMPANY_IDS    default 1,2 (Houzs Century, 2990's Home)
//
// RE-RUN: idempotent. A frozen order is no longer NULL, so it is skipped.
import postgres from 'postgres';
import { readFreezeTargets, freezeExemptionExpiry } from './lib/hc0122-exemption-expiry-sql.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(2); }
const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'HC0122-FREEZE-EXEMPTION-EXPIRY';
const COMPANY_IDS = (process.env.COMPANY_IDS ?? '1,2').split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
const BATCH = 500;
const SAMPLES = ['HC-SO-008230', '2990-SO-2608-040', '2990-SO-2608-053'];
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${CONFIRM_PHRASE}`);
  process.exit(2);
}

function summarise(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `company ${r.company_id} / ${r.source}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...by].sort()) log(`  ${k}: ${n}`);
  for (const doc of SAMPLES) {
    const r = rows.find((x) => x.doc_no === doc);
    log(`  ${doc}: ${r ? `${r.status} delivery=${r.customer_delivery_date ?? '(none)'} -> freeze ${r.freeze_to} (${r.source})` : 'not a target'}`);
  }
}

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  log(`mode=${MODE} companies=${COMPANY_IDS.join(',')}`);

  const targets = await readFreezeTargets(sql, COMPANY_IDS);
  log(`orders to freeze: ${targets.length}`);
  summarise(targets);

  if (targets.length === 0) {
    log('NOTHING TO DO — every processed order already has its date frozen.');
    await sql.end();
    return;
  }
  if (!APPLY) {
    log('');
    log(`PLAN ONLY — set MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.`);
    await sql.end();
    return;
  }

  const note = 'HC-0122: Sales Exemption Expiry Date frozen. The order was processed before BUG-51 '
    + '(2026-10-05) kept the original delivery date, so it is frozen to the date it showed on 2026-10-20. '
    + 'Requested by Syu.';
  let written = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const done = await sql.begin((tx) => freezeExemptionExpiry(tx, targets.slice(i, i + BATCH), note));
    written += done.length;
    log(`  batch ${i / BATCH + 1}: ${done.length} written`);
  }
  log(`rows written: ${written} of ${targets.length}`);
  await sql.end();

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const left = await readFreezeTargets(check, COMPANY_IDS);
  await check.end();
  log(`VERIFY (fresh connection): orders still unfrozen = ${left.length}`);
  if (left.length > 0) {
    log('VERIFY FAILED — some orders are still NULL; re-run plan and investigate.');
    process.exit(1);
  }
  log('OK — every processed order has a frozen Sales Exemption Expiry Date.');
}

await main();
