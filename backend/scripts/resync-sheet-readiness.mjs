#!/usr/bin/env node
/* Re-send provably-stale READY_TO_SHIP orders to the "HC Delivery Updated" sheet
   by nudging their updated_at, so the next 15-min so-since pull rewrites their
   Remarks 2 column to READY / READY (PARTIAL).

   WHY THIS EXISTS. PR #4094 fixed toSheetRecord (src/lib/delivery-sheet-feed.ts):
   the sheet's Remarks 2 now follows the LIVE line readiness, so a fully-allocated
   order shows READY even though its header remark2 is a frozen AutoCount import
   word (BEDFRAME / ACC/BEDFRAME / MATTRESS). But the 15-min pull is INCREMENTAL --
   it only re-sends an order whose GREATEST(updated_at, last payment, last DO) has
   moved past the sheet's checkpoint. Deploying the fix did not touch updated_at,
   so orders already on the sheet and untouched since keep their stale word. This
   one-off nudges updated_at = now() on those orders so the next pull re-sends them.

   SCOPE. company COMPANY_ID (default 1), status READY_TO_SHIP, remark2 non-blank
   and NOT starting with READY (i.e. a product-group word). A READY_TO_SHIP order
   has its main lines ready by definition, so the deployed feed computes READY or
   READY (PARTIAL) for every one of these -- none flips the wrong way.

   IT DOES NOT CHANGE remark2. The DB header stays the AutoCount snapshot on
   purpose; the sheet value is computed by the feed at pull time. Only updated_at
   moves -- no money, no stock, and the sheet's manual columns (col A delivery
   status, the date column) are written by staff, never by the pull. AutoCount
   write-back is untouched: nothing it mirrors changes and a raw updated_at bump
   enqueues nothing.

   MODE=plan (default) lists the orders and the label each will show, writes
   nothing. MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", bumps
   updated_at in one statement, then verifies on a FRESH connection that every
   touched row's updated_at advanced.

   RE-RUN: safe. The DB remark2 is intentionally left unchanged, so the same
   orders match again; a re-run simply re-nudges them (another harmless re-send). */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* The provably-stale set. `so.` prefix and $1 = company, so the same predicate
   drives the plan read, the apply write, and the fresh-connection verify -- the
   write can never touch a row the plan did not list. */
const TARGET = `so.company_id = $1
  AND so.status::text = 'READY_TO_SHIP'
  AND so.remark2 IS NOT NULL AND btrim(so.remark2) <> '' AND so.remark2 !~* '^READY'`;

/* The label the deployed feed will show. READY_TO_SHIP means the ship gate
   passed, so main is ready (or there is no main line, ready on sight). */
function preview(r) {
  const m = +r.main_lines, mr = +r.main_ready, a = +r.acc_lines, ar = +r.acc_ready;
  if (m > 0 && mr === m) return ar === a ? 'READY' : 'READY (PARTIAL)';
  if (m === 0) return 'READY';
  return 'UNCHANGED (main not all ready -- review this row)';
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);

  const rows = await sql.unsafe(`
    SELECT so.doc_no, so.linked_ac_docno, so.remark2,
           COUNT(li.cat) FILTER (WHERE li.cat IN ('BEDFRAME','SOFA','MATTRESS')) AS main_lines,
           COUNT(li.cat) FILTER (WHERE li.cat IN ('BEDFRAME','SOFA','MATTRESS') AND li.stock_status = 'READY') AS main_ready,
           COUNT(li.cat) FILTER (WHERE li.cat = 'ACCESSORY') AS acc_lines,
           COUNT(li.cat) FILTER (WHERE li.cat = 'ACCESSORY' AND li.stock_status = 'READY') AS acc_ready
      FROM scm.mfg_sales_orders so
      LEFT JOIN LATERAL (
        SELECT it.stock_status,
               CASE
                 WHEN upper(coalesce(it.item_group,'')) LIKE '%BEDFRAME%' THEN 'BEDFRAME'
                 WHEN upper(coalesce(it.item_group,'')) LIKE '%SOFA%'     THEN 'SOFA'
                 WHEN upper(coalesce(it.item_group,'')) LIKE '%MATTRESS%' THEN 'MATTRESS'
                 WHEN upper(coalesce(it.item_group,'')) LIKE '%ACCESSOR%' THEN 'ACCESSORY'
                 ELSE 'OTHERS'
               END AS cat
          FROM scm.mfg_sales_order_items it
         WHERE it.doc_no = so.doc_no AND coalesce(it.cancelled, false) = false
      ) li ON true
     WHERE ${TARGET}
     GROUP BY so.doc_no, so.linked_ac_docno, so.remark2
     ORDER BY so.doc_no`, [CO]);

  note(`\n=== ${rows.length} READY_TO_SHIP order(s) whose sheet Remarks 2 is a stale product word ===`);
  for (const r of rows) {
    const key = r.linked_ac_docno || r.doc_no;
    note(`  ${String(key).padEnd(14)} sheet now: ${String(r.remark2).padEnd(16)} -> will show: ${String(preview(r)).padEnd(16)} (main ${r.main_ready}/${r.main_lines}, acc ${r.acc_ready}/${r.acc_lines})`);
  }
  const oddball = rows.filter((r) => preview(r).startsWith('UNCHANGED'));
  if (oddball.length) bad(`  ${oddball.length} row(s) are READY_TO_SHIP but their main lines are not all READY -- they will NOT flip; review before apply.`);
  note(`\n  total to nudge: ${rows.length}`);

  if (!rows.length) { note(`\nNothing to resync.`); await sql.end({ timeout: 5 }); return; }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== NUDGING updated_at ON ${rows.length} ROW(S) (one statement) ===`);
  const nudged = await sql.unsafe(
    `UPDATE scm.mfg_sales_orders so SET updated_at = now() WHERE ${TARGET} RETURNING so.doc_no`, [CO]);
  note(`  updated_at bumped on ${nudged.length} row(s)`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const [{ n }] = await check.unsafe(
      `SELECT COUNT(*)::int AS n FROM scm.mfg_sales_orders so
        WHERE ${TARGET} AND so.updated_at > now() - interval '10 minutes'`, [CO]);
    note(`  ${n} of the ${rows.length} target row(s) now carry a fresh updated_at (< 10 min old)`);
    if (n < nudged.length) bad(`  expected at least ${nudged.length} freshly-updated rows, saw ${n}`);
    note(`\n  The sheet itself changes on the NEXT so-since pull (<= 15 min), which re-sends these rows through the fixed feed. remark2 in the DB is unchanged by design.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
