#!/usr/bin/env node
// ----------------------------------------------------------------------------
// repair-proceeded-status — an order that carries a Processing Date has
// PROCEEDED, so its status should say so.
//
// THE OWNER'S RULE, and it is already pinned in this repo's own code
// (routes/mfg-sales-orders.ts, the IN_PRODUCTION transition):
//   「只要有 Processing Date, 就代表他 Proceed 了。」
// And again on 2026-08-31, looking at IN PRODUCTION = 0 on the Sales Order list:
//   「有 processing date 的就是都在 in production 啊，就是他们 proceed 了，就代表
//    进入生产，然后才 ready to ship 和 delivered。」
//
// WHAT WENT WRONG. The status is a separate column that only a TRANSITION
// writes, and the AutoCount import never performed one: it wrote the dates and
// wrote `CONFIRMED`, independently. Measured on production 2026-08-31 (company
// 1): 2,599 CONFIRMED orders, of which **364 carry a Processing Date**, and
// IN PRODUCTION is empty. The data contradicts the system's own stated rule.
//
// WHAT IT WRITES: `status` only, CONFIRMED -> IN_PRODUCTION, and only where a
// Processing Date is present. Nothing else — no date, no line, no money, no
// stock, and no AutoCount document (AutoCount has no such status; this column is
// ours).
//
// WHAT IT REFUSES TO TOUCH, deliberately:
//   · any status that is not CONFIRMED. READY_TO_SHIP and beyond are FURTHER
//     along, and pulling one back would be a demotion, not a repair.
//   · an order with no Processing Date. That is the un-released set, and it is a
//     separate decision (2,238 orders on the same measurement) that belongs to
//     the owner, not to this script.
//   · a cancelled order, whatever else it carries.
//
// THE GATES THE ROUTE WOULD RUN ARE NOT RE-RUN HERE, and that is worth saying
// out loud rather than hiding: the interactive transition also checks variant
// completeness, the colour-KIV rule and customer/address completeness. This is a
// repair of a status that DISAGREES WITH A DATE THE ORDER ALREADY CARRIES — the
// proceed already happened, in AutoCount, before the import; re-gating it would
// refuse orders on today's rules for a decision taken months ago. The count of
// orders that WOULD fail those gates is reported in the plan so the number is
// visible either way.
//
//   DATABASE_URL   required
//   COMPANY        company id (default 1)
//   MODE           plan (default) | apply
//   CONFIRM        on apply, must be exactly: PROCEEDED MEANS IN PRODUCTION
//
// RE-RUN: convergent. A second run finds nothing — the rows it moved are no
// longer CONFIRMED, and it never touches a status other than CONFIRMED.
// ----------------------------------------------------------------------------
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const COMPANY = Number(process.env.COMPANY ?? 1);
const MODE = (process.env.MODE ?? 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'PROCEEDED MEANS IN PRODUCTION';
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && (process.env.CONFIRM ?? '').trim() !== CONFIRM_PHRASE) {
  console.error(`REFUSED: apply needs CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  log(`mode=${APPLY ? 'APPLY' : 'PLAN'} company=${COMPANY}`);

  const [before] = await sql`
    SELECT COUNT(*)::int AS confirmed,
           COUNT(*) FILTER (WHERE processing_date IS NOT NULL)::int AS to_move
      FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY} AND upper(status::text) = 'CONFIRMED'`;
  log(`CONFIRMED orders: ${before.confirmed}; of those carrying a Processing Date: ${before.to_move}`);

  /* The OTHER disagreement, reported and never touched: an order further along
     than production that never got a release date at all. */
  const [ahead] = await sql`
    SELECT COUNT(*)::int AS n FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY}
       AND upper(status::text) NOT IN ('CONFIRMED', 'DRAFT', 'CANCELLED')
       AND processing_date IS NULL`;
  log(`FYI (not touched): ${ahead.n} order(s) are past CONFIRMED with NO Processing Date — the reverse`
    + ' disagreement, and a separate decision.');

  /* What the interactive transition would ALSO check. Reported so the number is
     visible rather than quietly bypassed. */
  const [gated] = await sql`
    SELECT COUNT(DISTINCT h.doc_no)::int AS n
      FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${COMPANY} AND upper(h.status::text) = 'CONFIRMED'
       AND h.processing_date IS NOT NULL
       AND (COALESCE(btrim(h.debtor_name), '') = ''
         OR COALESCE(btrim(h.address1), '') = ''
         OR COALESCE(btrim(h.postcode), '') = ''
         OR h.customer_delivery_date IS NULL)`;
  log(`of those, ${gated.n} would FAIL today's customer/address/delivery-date completeness gate if the`
    + ' transition were performed interactively. They proceeded in AutoCount before the import, so this'
    + ' repair does not re-gate them — the number is here so nobody has to guess it.');

  if (!APPLY) {
    log('');
    log(`PLAN ONLY — MODE=apply CONFIRM="${CONFIRM_PHRASE}" writes.`);
    await sql.end();
    return;
  }
  if (before.to_move === 0) { log('nothing to do.'); await sql.end(); return; }

  const moved = await sql`
    UPDATE scm.mfg_sales_orders
       SET status = 'IN_PRODUCTION', updated_at = now()
     WHERE company_id = ${COMPANY}
       AND upper(status::text) = 'CONFIRMED'
       AND processing_date IS NOT NULL
   RETURNING doc_no`;
  log(`APPLIED — ${moved.length} order(s) moved CONFIRMED -> IN_PRODUCTION.`);

  /* VERIFY on a FRESH connection, asserting the SHAPE rather than a count: no
     CONFIRMED order may still carry a Processing Date, and every row we moved
     must hold BOTH the new status and the date that justified the move. */
  const v = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  /* THE VALUES, not a count. Re-read the very rows this run moved and assert
     what they now ARE — the status text and that the date that justified the
     move is still there. A count would have reported success while writing the
     wrong value into every one of them, which is exactly how the jsonb
     double-encoding repair passed its own check. */
  const docs = moved.map((m) => m.doc_no);
  const after = await v`
    SELECT doc_no, status::text AS status, (processing_date IS NOT NULL) AS has_date
      FROM scm.mfg_sales_orders WHERE doc_no = ANY(${docs}) AND company_id = ${COMPANY}`;
  const wrongStatus = after.filter((r) => String(r.status).toUpperCase() !== 'IN_PRODUCTION');
  const lostDate = after.filter((r) => r.has_date !== true);
  log(`VERIFY (fresh connection, values not counts): ${after.length} of ${docs.length} rows re-read;`
    + ` status is IN_PRODUCTION on ${after.length - wrongStatus.length};`
    + ` the Processing Date is still present on ${after.length - lostDate.length}`);
  for (const r of [...wrongStatus, ...lostDate].slice(0, 5)) {
    log(`   UNEXPECTED ${r.doc_no}: status='${r.status}' hasProcessingDate=${r.has_date}`);
  }
  const [chk] = await v`
    SELECT COUNT(*) FILTER (WHERE upper(status::text) = 'CONFIRMED'
                              AND processing_date IS NOT NULL)::int AS left_behind
      FROM scm.mfg_sales_orders WHERE company_id = ${COMPANY}`;
  log(`   and CONFIRMED orders still carrying a Processing Date: ${chk.left_behind}`);
  if (wrongStatus.length || lostDate.length || after.length !== docs.length || chk.left_behind !== 0) {
    log('VERIFY FAILED — investigate before re-running.');
  }
  await v.end();
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
