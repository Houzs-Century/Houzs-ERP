#!/usr/bin/env node
// Close the company-1 sales orders whose GOODS are all delivered and which stay
// open only on a charge line (transport / storage / dispose / repair / misc).
//
// THE OWNER'S WORDS, 2026-09-10: 「那些剩下 transportation、disposal 这些全部东西
// 都可以关掉，货已经送完了的就可以关掉了，因为 Service 我们都不会进 MRP 里面去计算的」
// and, on the list this script drives, 「那这个可以清掉」.
//
// WHAT THIS IS *NOT* FOR. It does not clean up MRP. He is right that a service
// line never reaches the MRP page — routes/mrp.ts skips `isServiceLine` BEFORE
// the category filter, so `?category=SERVICE` cannot surface one either. These
// orders were never distorting the plan. What they distort is the OPEN-ORDER
// list: work that finished a year ago still reads as outstanding.
//
// ONLY THE HEADER STATUS MOVES. No line is touched, no quantity, no money. That
// is deliberate: the document's CONTENT stays byte-identical to the account
// book, so the AutoCount tally cannot start reporting a difference we invented.
// And the AutoCount write-back is enqueued by the ROUTE layer, never by a
// database trigger (scm.mfg_sales_orders carries three triggers, none of them
// the outbox), so a direct write here reaches Postgres and stops there.
//
// WHICH STATUS. DELIVERED when the order actually shipped something, CLOSED when
// it never did — a charge-only order that was never fulfilled is finished, not
// delivered. Both are in SO_TERMINAL_STATES, so either one takes the order out
// of the open list.
//
// DINING FURNITURE IS NOT A CHARGE. `AN-*` / `CH-*` (ANNEX table top, dining
// leg, dining chair, CH round table) sit in item_group `others` and look exactly
// like a fee line to a naive filter — but they are real goods the customer has
// not received. Five orders were excluded by hand for this reason on the first
// pass; the predicate below encodes it so nobody has to remember.
//
// RE-RUN: idempotent. The UPDATE re-asserts the status the row had when it was
// planned, so a second run reports 0 to change. An order somebody has since
// moved is skipped by that same CAS rather than overwritten.
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        required on apply: CLOSE-FEE-ONLY-SO
//   COMPANY_ID     default 1
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(2); }
const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'CLOSE-FEE-ONLY-SO';
const CO = Number(process.env.COMPANY_ID ?? 1);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${CONFIRM_PHRASE}`);
  process.exit(2);
}

/* The statuses that already mean "no longer open". Mirrors
   shared/so-terminal-states.ts — a row already in one of these is not a
   candidate and must not be re-stamped. */
const TERMINAL = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'];

/** Orders whose real goods are all delivered, with what is still open on them. */
async function candidates(sql) {
  return sql`
    WITH live AS (
      SELECT i.doc_no, i.item_code, lower(COALESCE(i.item_group, '')) AS grp, i.qty,
             o.status::text AS status, o.debtor_name,
             COALESCE((SELECT SUM(d.qty) FROM scm.delivery_order_items d
                         JOIN scm.delivery_orders h ON h.id = d.delivery_order_id
                        WHERE d.so_item_id = i.id
                          AND COALESCE(h.status::text, '') <> 'CANCELLED'), 0)::int AS delivered
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
       WHERE i.company_id = ${CO} AND i.cancelled = false AND i.qty > 0
         AND o.status::text <> ALL(${TERMINAL})
    ), tagged AS (
      SELECT *, GREATEST(qty - delivered, 0) AS remaining,
             CASE WHEN grp IN ('mattress','accessory','bedframe','sofa') THEN 'goods'
                  WHEN item_code ~* '^(AN-|CH-)'                         THEN 'goods'
                  ELSE 'charge' END AS kind
        FROM live
    )
    SELECT t.doc_no,
           MAX(t.debtor_name)                                        AS customer,
           MAX(t.status)                                             AS from_status,
           SUM(t.delivered)::int                                     AS shipped,
           COALESCE(SUM(t.remaining) FILTER (WHERE t.kind='charge'), 0)::int AS charge_open,
           COALESCE(STRING_AGG(DISTINCT t.item_code, ' / ')
                    FILTER (WHERE t.remaining > 0 AND t.kind='charge'), '')  AS open_charges,
           CASE WHEN SUM(t.delivered) > 0 THEN 'DELIVERED' ELSE 'CLOSED' END AS to_status
      FROM tagged t
     GROUP BY t.doc_no
    HAVING COALESCE(SUM(t.remaining) FILTER (WHERE t.kind='goods'), 0) = 0
     ORDER BY t.doc_no`;
}

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  log(`mode=${MODE} company=${CO}`);

  const rows = await candidates(sql);
  log(`orders whose GOODS are all delivered and only a charge line is open: ${rows.length}`);
  const byTo = rows.reduce((a, r) => ({ ...a, [r.to_status]: (a[r.to_status] ?? 0) + 1 }), {});
  log(`  -> DELIVERED (something shipped): ${byTo.DELIVERED ?? 0}`);
  log(`  -> CLOSED    (nothing ever shipped): ${byTo.CLOSED ?? 0}`);
  log('');
  for (const r of rows) {
    log(`  ${r.doc_no}  ${r.from_status} -> ${r.to_status}  shipped=${r.shipped}  `
      + `still open: ${r.open_charges || '(nothing at all)'}`);
  }

  if (!APPLY) {
    log('');
    log(`PLAN ONLY — set MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.`);
    await sql.end();
    return;
  }

  /* CAS on the status the plan read: an order somebody moved between the plan
     and the write is SKIPPED, not overwritten. That is also what makes a second
     run inert — the row no longer matches its planned from_status. */
  let wrote = 0;
  const skipped = [];
  for (const r of rows) {
    const res = await sql`
      UPDATE scm.mfg_sales_orders
         SET status = ${r.to_status}::scm.so_status, updated_at = NOW()
       WHERE doc_no = ${r.doc_no} AND company_id = ${CO}
         AND status::text = ${r.from_status}
       RETURNING doc_no`;
    if (res.length === 1) {
      wrote += 1;
      await sql`
        INSERT INTO scm.mfg_so_audit_log (so_doc_no, action, actor_name_snapshot, source, note,
                                          field_changes, status_snapshot, company_id)
        VALUES (${r.doc_no}, 'UPDATE_STATUS', 'System (fee-only cleanup)', 'script',
                ${'goods all delivered; only a charge line open: ' + (r.open_charges || 'none')},
                ${sql.json([{ field: 'status', from: r.from_status, to: r.to_status }])},
                ${r.to_status}, ${CO})`;
    } else {
      skipped.push(r.doc_no);
    }
  }
  log('');
  log(`headers updated: ${wrote} of ${rows.length}`);
  if (skipped.length > 0) log(`  skipped (moved since the plan): ${skipped.join(', ')}`);
  await sql.end();

  /* VERIFY ON A FRESH CONNECTION, AND ASSERT THE SHAPE — not a row count. The
     count above already said "1 row updated" for every one of them; what that
     cannot tell us is whether the LINES survived untouched, which is the whole
     promise this script makes to the AutoCount tally. So re-read both. */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const docs = rows.map((r) => r.doc_no);
  const after = await check`
    SELECT o.doc_no, o.status::text AS status,
           (SELECT COUNT(*) FROM scm.mfg_sales_order_items i
             WHERE i.doc_no = o.doc_no AND i.cancelled = false)::int AS live_lines,
           (SELECT COALESCE(SUM(i.qty), 0) FROM scm.mfg_sales_order_items i
             WHERE i.doc_no = o.doc_no AND i.cancelled = false)::int AS total_qty
      FROM scm.mfg_sales_orders o
     WHERE o.doc_no = ANY(${docs}) AND o.company_id = ${CO}`;
  const want = new Map(rows.map((r) => [r.doc_no, r.to_status]));
  const wrongStatus = after.filter((a) => a.status !== want.get(a.doc_no)
    && !skipped.includes(a.doc_no));
  const noLines = after.filter((a) => a.live_lines === 0 || a.total_qty === 0);
  log('');
  log(`VERIFY (fresh connection): ${after.length} order(s) re-read`);
  log(`  status is what we intended: ${after.length - wrongStatus.length} of ${after.length}`);
  log(`  still carry their lines + quantities: ${after.length - noLines.length} of ${after.length}`);
  if (wrongStatus.length > 0) {
    log(`  MISMATCH: ${wrongStatus.map((a) => `${a.doc_no}=${a.status}`).join(', ')}`);
  }
  if (noLines.length > 0) {
    log(`  LINES OR QUANTITIES GONE: ${noLines.map((a) => a.doc_no).join(', ')} — investigate`);
  }
  await check.end();
  if (wrongStatus.length > 0 || noLines.length > 0) process.exit(1);
}

await main();
