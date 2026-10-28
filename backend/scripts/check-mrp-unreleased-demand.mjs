#!/usr/bin/env node
// READ-ONLY. "Why does MRP list orders with an EMPTY Processing Date?"
//
// THE QUESTION (owner, 2026-08-31, from the Stock Status Report): several rows
// show "—" under PROCESSING DATE. MRP carries that column for DISPLAY only —
// its demand set is every non-cancelled line on a live sales order, and it never
// filters on the release signal (`routes/mrp.ts`, the DemandRow comment). So an
// order nobody has released for purchasing still appears, and the page's
// "Proceed PO" button can raise a purchase order against it.
//
// Whether that is right is the owner's call, and the call needs a NUMBER: how
// much of the plan is un-released, and how much of THAT is stale migrated
// history rather than real forward demand.
//
// COUNTS ONLY — no document numbers, no customers, no amounts. This repository's
// Actions logs are public.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction.
//
//   DATABASE_URL   required
//   COMPANY_ID     default 1
//
// RE-RUN: idempotent and side-effect free.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

/* The statuses MRP treats as DONE and drops from demand — kept in step with
   SO_TERMINAL_STATES / SO_DONE_SQL in the route. */
const DONE = ['CANCELLED', 'COMPLETED', 'CLOSED', 'DELIVERED', 'FULLY_DELIVERED'];

async function main() {
  log(`company ${CO} — MRP demand lines by release state`);

  const [t] = await sql`
    SELECT COUNT(*)::int                                                        AS lines,
           COUNT(*) FILTER (WHERE h.processing_date IS NULL)::int                AS unreleased,
           COUNT(DISTINCT h.doc_no) FILTER (WHERE h.processing_date IS NULL)::int AS unreleased_docs,
           COUNT(*) FILTER (WHERE h.processing_date IS NULL
                              AND COALESCE(i.line_delivery_date, h.amended_delivery_date,
                                           h.customer_delivery_date) < CURRENT_DATE)::int AS unreleased_past_due,
           COUNT(*) FILTER (WHERE h.processing_date IS NULL
                              AND COALESCE(i.line_delivery_date, h.amended_delivery_date,
                                           h.customer_delivery_date) IS NULL)::int        AS unreleased_no_date,
           COUNT(*) FILTER (WHERE h.processing_date IS NULL AND h.linked_ac_docno IS NOT NULL)::int AS unreleased_migrated
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.cancelled = false
       AND upper(h.status::text) <> ALL(${DONE})`;

  log(`live demand lines: ${t.lines}`);
  log(`  of which NO Processing Date (never released for purchasing): ${t.unreleased}`
    + `  (${t.lines ? Math.round((t.unreleased / t.lines) * 1000) / 10 : 0}%), on ${t.unreleased_docs} order(s)`);
  log(`     · already PAST their delivery date: ${t.unreleased_past_due}`);
  log(`     · carrying no delivery date at all: ${t.unreleased_no_date}`);
  log(`     · came from AutoCount (migrated):   ${t.unreleased_migrated}`);
  log('');

  const byYear = await sql`
    SELECT to_char(h.so_date, 'YYYY') AS yr, COUNT(*)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.cancelled = false
       AND upper(h.status::text) <> ALL(${DONE})
       AND h.processing_date IS NULL
     GROUP BY 1 ORDER BY 1`;
  log('un-released lines by the YEAR the order was written:');
  for (const r of byYear) log(`  ${r.yr ?? '(no so_date)'}: ${r.n}`);
  log('');
  log('READ IT THIS WAY: a line that is past due or years old is stale history the');
  log('cutover carried over, not demand to buy for. A recent one with a future date');
  log('is real demand that simply has not been released yet.');

  /* "确定这些那么久了还没送货嘛?" (owner, 2026-08-31, looking at a 2024 order still
     sitting in the plan). The import only took what AutoCount itself still
     counted as OUTSTANDING, so the book agrees they are undelivered — but that
     is the book's opinion, and the question is whether OUR side shows any
     delivery against them at all. Counts only. */
  const [old] = await sql`
    SELECT COUNT(*)::int AS lines,
           COUNT(DISTINCT h.doc_no)::int AS docs,
           COUNT(*) FILTER (WHERE d.line_id IS NOT NULL)::int AS with_some_delivery,
           COUNT(*) FILTER (WHERE h.linked_ac_docno IS NOT NULL)::int AS migrated
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      LEFT JOIN LATERAL (
        SELECT di.so_item_id AS line_id FROM scm.delivery_order_items di
         WHERE di.so_item_id = i.id LIMIT 1
      ) d ON true
     WHERE h.company_id = ${CO} AND i.cancelled = false
       AND upper(h.status::text) <> ALL(${DONE})
       AND h.so_date < CURRENT_DATE - INTERVAL '12 months'`;
  log('');
  log(`ORDERS OLDER THAN 12 MONTHS still counted as live demand: ${old.lines} line(s) on ${old.docs} order(s)`);
  log(`  came from AutoCount:                       ${old.migrated}`);
  log(`  have ANY delivery order line against them: ${old.with_some_delivery}`);
  log(`  have NONE at all:                          ${old.lines - old.with_some_delivery}`);
  log('  (the import only took what AutoCount itself still counted as outstanding,');
  log('   so "never delivered" is the ACCOUNT BOOK position, carried over as-is.)');

  const oldest = await sql`
    SELECT to_char(h.so_date, 'YYYY-MM') AS mon, COUNT(*)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.cancelled = false
       AND upper(h.status::text) <> ALL(${DONE})
       AND h.so_date < CURRENT_DATE - INTERVAL '12 months'
     GROUP BY 1 ORDER BY 1 LIMIT 18`;
  log('  by the month the order was written:');
  for (const r of oldest) log(`    ${r.mon}: ${r.n}`);

  /* "可是那么久了的单确定没有 DO？没有出货？" (owner, 2026-08-31, pressing on the
     answer above — rightly, because the count above asks a DIFFERENT question.
     It counts DO lines that carry the LINK back to the sales line, and unlinked
     DO lines exist in this system, so "no linked delivery" is not "never
     shipped".)
     
     THE BOOK ITSELF IS THE EVIDENCE. ac-fidelity-so-lines.json.gz holds one row
     per AutoCount SO line — DocNo, DtlKey, Qty and TransferedQty, which is
     AutoCount's own record of how much of that line has gone out. Our rows carry
     linked_ac_dtlkey, so the two join exactly, with no name matching and no
     guessing. Counts only. */
  const here = path.dirname(fileURLToPath(import.meta.url));
  const snapPath = path.join(here, 'data', 'ac-fidelity-so-lines.json.gz');
  const manPath = path.join(here, 'data', 'ac-fidelity-manifest.json');
  const snapRaw = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString('utf8'));
  const snapRows = Array.isArray(snapRaw) ? snapRaw : Object.values(snapRaw);
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  const byKey = new Map(snapRows.map((r) => [String(r.DtlKey), r]));
  log('');
  log(`WHAT AUTOCOUNT ITSELF SAYS (snapshot exported ${man.exported_at}, ${snapRows.length} book lines)`);

  const oldLines = await sql`
    SELECT i.linked_ac_dtlkey AS k, COALESCE(i.qty, 0)::numeric AS qty
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.cancelled = false
       AND upper(h.status::text) <> ALL(${DONE})
       AND h.so_date < CURRENT_DATE - INTERVAL '12 months'`;

  let noKey = 0, notInBook = 0, full = 0, part = 0, zero = 0;
  for (const r of oldLines) {
    if (r.k == null) { noKey += 1; continue; }
    const b = byKey.get(String(r.k));
    if (!b) { notInBook += 1; continue; }
    const q = Number(b.Qty ?? 0);
    const t = Number(b.TransferedQty ?? 0);
    if (t <= 0) zero += 1;
    else if (t >= q) full += 1;
    else part += 1;
  }
  log(`  old ERP lines examined: ${oldLines.length}`);
  log(`    the book says FULLY delivered  (TransferedQty >= Qty): ${full}`);
  log(`    the book says PARTLY delivered (0 < Transfered < Qty): ${part}`);
  log(`    the book says NOTHING went out (TransferedQty = 0):    ${zero}`);
  log(`    our line carries no AutoCount key:                     ${noKey}`);
  log(`    keyed, but that line is not in the snapshot:           ${notInBook}`);
  log('  NOTE: the snapshot is a point in time. A line the book has shipped SINCE');
  log('  that export reads as not-shipped here, so FULL/PART are floors, not ceilings.');

  /* "那么久的 PO 还没 GR？你确定真的全部 convert 成功？" (owner, 2026-08-31). Same
     question on the purchase side, and the same answer shape: ask the BOOK.
     ac-fidelity-po-lines.json.gz carries TransferedQty per PO line — AutoCount's
     own record of how much of that line has been received. */
  const poSnap = JSON.parse(zlib.gunzipSync(
    fs.readFileSync(path.join(here, 'data', 'ac-fidelity-po-lines.json.gz'))).toString('utf8'));
  const poRows = Array.isArray(poSnap) ? poSnap : Object.values(poSnap);
  const poByKey = new Map(poRows.map((r) => [String(r.DtlKey), r]));
  log('');
  log(`PURCHASE SIDE — old open PO lines vs what the book says (${poRows.length} book lines)`);

  const oldPo = await sql`
    SELECT i.linked_ac_dtlkey AS k,
           COALESCE(i.qty, 0)::numeric AS qty, COALESCE(i.received_qty, 0)::numeric AS got
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO}
       AND upper(p.status::text) NOT IN ('CANCELLED', 'CLOSED', 'COMPLETED')
       AND COALESCE(i.received_qty, 0) < COALESCE(i.qty, 0)
       AND p.po_date < CURRENT_DATE - INTERVAL '12 months'`;

  let pNoKey = 0, pNotInBook = 0, pFull = 0, pPart = 0, pZero = 0;
  for (const r of oldPo) {
    if (r.k == null) { pNoKey += 1; continue; }
    const b = poByKey.get(String(r.k));
    if (!b) { pNotInBook += 1; continue; }
    const q = Number(b.Qty ?? 0);
    const t = Number(b.TransferedQty ?? 0);
    if (t <= 0) pZero += 1;
    else if (t >= q) pFull += 1;
    else pPart += 1;
  }
  /* CONTROL. A zero above must not be allowed to read as "the purchase side is
     clean" when it could equally mean the predicates matched nothing. These two
     say how many rows each filter step can see at all. */
  const [ctl] = await sql`
    SELECT COUNT(*)::int AS all_open_lines,
           COUNT(*) FILTER (WHERE p.po_date < CURRENT_DATE - INTERVAL '12 months')::int AS old_lines,
           MIN(p.po_date)::text AS oldest_po_date
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO}
       AND upper(p.status::text) NOT IN ('CANCELLED', 'CLOSED', 'COMPLETED')
       AND COALESCE(i.received_qty, 0) < COALESCE(i.qty, 0)`;
  log(`  CONTROL — open, not-fully-received PO lines at ANY age: ${ctl.all_open_lines}`
    + `; of those older than 12 months: ${ctl.old_lines}; oldest purchase order date on file: ${ctl.oldest_po_date ?? 'n/a'}`);
  log(`  PO lines older than 12 months and still not fully received here: ${oldPo.length}`);
  log(`    the book says FULLY received  (TransferedQty >= Qty): ${pFull}   <-- if > 0, WE are behind the book`);
  log(`    the book says PARTLY received (0 < Transfered < Qty): ${pPart}`);
  log(`    the book says NOTHING came in (TransferedQty = 0):    ${pZero}`);
  log(`    our line carries no AutoCount key:                    ${pNoKey}`);
  log(`    keyed, but that line is not in the snapshot:          ${pNotInBook}`);

  /* "有 processing date 的就是都在 in production 啊，就是他们 proceed 了" (owner,
     2026-08-31, looking at IN PRODUCTION = 0 on the list). His rule is already
     pinned in this repo's own code — 「只要有 Processing Date, 就代表他 Proceed
     了」 — but the STATUS is a separate column that only a transition writes, and
     the import never performed one. So the two disagree on the imported book. */
  const byStatus = await sql`
    SELECT upper(h.status::text) AS status,
           COUNT(*)::int AS orders,
           COUNT(*) FILTER (WHERE h.processing_date IS NOT NULL)::int AS with_processing_date
      FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${CO}
     GROUP BY 1 ORDER BY 2 DESC`;
  log('');
  log('ORDERS BY STATUS, and how many of each carry a Processing Date:');
  for (const r of byStatus) {
    log(`  ${String(r.status).padEnd(16)} ${String(r.orders).padStart(6)} orders, `
      + `${String(r.with_processing_date).padStart(6)} with a Processing Date`);
  }
  const conf = byStatus.find((r) => r.status === 'CONFIRMED');
  if (conf) {
    log(`  ^ ${conf.with_processing_date} order(s) are CONFIRMED and carry a Processing Date. Under the`);
    log('    owner rule the code already pins, those have proceeded and belong in IN PRODUCTION.');
  }

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
