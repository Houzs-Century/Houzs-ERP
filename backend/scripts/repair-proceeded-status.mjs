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
//   COMPANY        a company id, or `all` for EVERY company (default all)
//   MODE           plan (default) | apply
//   CONFIRM        on apply, must be exactly: PROCEEDED MEANS IN PRODUCTION
//
// ALL COMPANIES BY DEFAULT, and that default is the point. Owner 2026-09-01,
// after company 2 was found with IN PRODUCTION = 0 and 44 dated CONFIRMED
// orders — a full week after the identical repair ran on company 1:
//   「这是全套系统 而不是 单一organisation」
// A per-company switch means somebody has to REMEMBER the other companies, and
// on 2026-08-31 nobody did. The company list is read from the data, so a company
// added tomorrow is swept without anyone editing this file.
//
// RE-RUN: convergent. A second run finds nothing — the rows it moved are no
// longer CONFIRMED, and it never touches a status other than CONFIRMED.
// ----------------------------------------------------------------------------
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const COMPANY_RAW = String(process.env.COMPANY ?? 'all').trim().toLowerCase();
const ALL_COMPANIES = COMPANY_RAW === 'all' || COMPANY_RAW === '';
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
  log(`mode=${APPLY ? 'APPLY' : 'PLAN'} scope=${ALL_COMPANIES ? 'ALL COMPANIES' : `company ${COMPANY_RAW}`}`);

  /* The list comes from the DATA, never from a constant here — a company added
     later must be swept without anyone remembering to edit this file. */
  const companies = ALL_COMPANIES
    ? (await sql`SELECT DISTINCT company_id AS id FROM scm.mfg_sales_orders
                  WHERE company_id IS NOT NULL ORDER BY 1`).map((r) => Number(r.id))
    : [Number(COMPANY_RAW)];
  log(`companies in scope: ${companies.join(', ')}`);

  const movedAll = [];
  for (const CO of companies) {
    const [before] = await sql`
      SELECT COUNT(*)::int AS confirmed,
             COUNT(*) FILTER (WHERE processing_date IS NOT NULL)::int AS to_move
        FROM scm.mfg_sales_orders
       WHERE company_id = ${CO} AND upper(status::text) = 'CONFIRMED'`;
    const [ahead] = await sql`
      SELECT COUNT(*)::int AS n FROM scm.mfg_sales_orders
       WHERE company_id = ${CO}
         AND upper(status::text) NOT IN ('CONFIRMED', 'DRAFT', 'CANCELLED')
         AND processing_date IS NULL`;
    const [gated] = await sql`
      SELECT COUNT(DISTINCT h.doc_no)::int AS n
        FROM scm.mfg_sales_orders h
       WHERE h.company_id = ${CO} AND upper(h.status::text) = 'CONFIRMED'
         AND h.processing_date IS NOT NULL
         AND (COALESCE(btrim(h.debtor_name), '') = ''
           OR COALESCE(btrim(h.address1), '') = ''
           OR COALESCE(btrim(h.postcode), '') = ''
           OR h.customer_delivery_date IS NULL)`;
    log('');
    log(`COMPANY ${CO} — CONFIRMED: ${before.confirmed}; of those carrying a Processing Date: ${before.to_move}`);
    log(`   FYI (not touched): ${ahead.n} past CONFIRMED with NO Processing Date — the reverse disagreement.`);
    log(`   of the movable, ${gated.n} would FAIL today's customer/address/delivery-date gate if done`
      + ' interactively. They proceeded in AutoCount before the import, so this repair does not re-gate them.');

    if (!APPLY || before.to_move === 0) continue;
    const moved = await sql`
      UPDATE scm.mfg_sales_orders
         SET status = 'IN_PRODUCTION', updated_at = now()
       WHERE company_id = ${CO}
         AND upper(status::text) = 'CONFIRMED'
         AND processing_date IS NOT NULL
     RETURNING doc_no, company_id`;
    log(`   APPLIED — ${moved.length} order(s) moved CONFIRMED -> IN_PRODUCTION.`);
    movedAll.push(...moved);
  }

  if (!APPLY) {
    log('');
    log(`PLAN ONLY — MODE=apply CONFIRM="${CONFIRM_PHRASE}" writes.`);
    await sql.end();
    return;
  }
  if (!movedAll.length) { log('nothing to do.'); await sql.end(); return; }

  /* VERIFY on a FRESH connection, asserting the VALUES, across EVERY company
     touched — a per-company verify would have been just as forgettable as the
     per-company repair. */
  const v = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  const docs = movedAll.map((m) => m.doc_no);
  const after = await v`
    SELECT doc_no, company_id, status::text AS status, (processing_date IS NOT NULL) AS has_date
      FROM scm.mfg_sales_orders WHERE doc_no = ANY(${docs})`;
  const wrongStatus = after.filter((r) => String(r.status).toUpperCase() !== 'IN_PRODUCTION');
  const lostDate = after.filter((r) => r.has_date !== true);
  log('');
  log(`VERIFY (fresh connection, values not counts): ${after.length} of ${docs.length} rows re-read;`
    + ` status is IN_PRODUCTION on ${after.length - wrongStatus.length};`
    + ` the Processing Date is still present on ${after.length - lostDate.length}`);
  for (const r of [...wrongStatus, ...lostDate].slice(0, 5)) {
    log(`   UNEXPECTED ${r.doc_no} (company ${r.company_id}): status='${r.status}' hasProcessingDate=${r.has_date}`);
  }
  const left = await v`
    SELECT company_id, COUNT(*)::int AS n FROM scm.mfg_sales_orders
     WHERE upper(status::text) = 'CONFIRMED' AND processing_date IS NOT NULL
     GROUP BY 1 ORDER BY 1`;
  log(`   CONFIRMED orders still carrying a Processing Date, EVERY company: `
    + (left.length ? left.map((r) => `company ${r.company_id}: ${r.n}`).join(', ') : 'none'));
  if (wrongStatus.length || lostDate.length || after.length !== docs.length || left.length) {
    log('VERIFY FAILED — investigate before re-running.');
  }
  await v.end();
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
