// Read-only: how often does a document say "done" while the stock, the PO or
// the bank behind it did not change? Facts first, before anyone guesses at the
// root cause. Per company, over the last DAYS days:
//
//   1. POSTED / CLOSED GRNs whose goods lines have no stock IN, or a different qty
//   2. DOs in a stock-out status (DO_STOCK_OUT_STATES) whose goods lines have no
//      stock OUT, or a different qty (service lines excluded)
//   3. CANCELLED DOs whose OUT was never reversed (or reversed twice)
//   4. PO lines whose received_qty disagrees with their counted GRN lines
//   5. Receipt rebanks (acc/receipt-rebank.ts) reversed with no new entry
//   6. Stock buckets (item, warehouse, variant) where open FIFO lots disagree
//      with net movements — the CODY-(K) class. Current state, not windowed.
//   7. Double-submits: same header and lines created within 10 s, for credit
//      notes, supplier bills, deposit invoices and money-in documents
//
// Classes 1-2 also print the Malaysia hour the failed documents were created,
// beside all documents by hour, to show whether failures cluster at peak load.
//
// PUBLIC LOG: the repository's Actions logs are public. This script prints
// document numbers, item codes, quantities and counts only — never an amount,
// a cost, a customer name or a phone number. The duplicate check compares
// amounts and names inside SQL through md5() so they never reach this process.
//
//   node backend/scripts/check-half-done-documents.mjs
//   Actions -> "Run a backend script on production": script
//   check-half-done-documents.mjs, mode plan, optional env DAYS=180;LIMIT=30
//
// SELECTs only, in one READ ONLY transaction; every query names company_id.
// Exits 0 for every real answer (zero findings is an answer). Only a missing
// DATABASE_URL, an unreachable database or a query error exits non-zero; one
// class failing does not stop the others (each runs in its own savepoint).
import "./lib/public-log-guard.mjs";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import { DO_STOCK_OUT_STATES } from "./lib/do-shipped-states.mjs";
import {
  DEFAULT_DAYS, DEFAULT_LIMIT, DUPLICATE_WINDOW_SECONDS, intEnv,
  compareDocItems, cancelledResidue, comparePoReceived, strandedRebanks,
  lotBucketDiffs, duplicateClusters, summarise, hourProfile,
} from "./lib/half-done-documents.mjs";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const DAYS = intEnv(process.env.DAYS, DEFAULT_DAYS, 3650);
const LIMIT = intEnv(process.env.LIMIT, DEFAULT_LIMIT, 500);

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const iso = (t) => (t ? new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") : "-");
let failures = 0;

function report(label, rows, fmt) {
  const s = summarise(rows, LIMIT);
  notice(`${label}: ${s.count} finding(s) on ${s.documents} document(s); oldest ${s.oldest}, newest ${s.newest}`);
  for (const r of s.examples) console.log(`  ${fmt(r)}`);
  if (s.count > s.examples.length) console.log(`  ... ${s.count - s.examples.length} more`);
}

function printHours(label, failed, all) {
  if (failed.length === 0) return;
  console.log(`  ${label} by created hour (Malaysia time): hour | failed docs | all docs | failed %`);
  for (const h of hourProfile(failed, all)) {
    if (h.all === 0 && h.failed === 0) continue;
    console.log(`    ${String(h.hour).padStart(2, "0")}:00 | ${h.failed} | ${h.all} | ${h.pct}%`);
  }
}

const docItemLine = (r) =>
  `${r.docNo} | ${iso(r.createdAt)} | ${r.itemCode} | lines=${r.expected} | movements=${r.actual} | ${r.kind}`;

async function cls1(sql, co, cutoff) {
  const docs = await sql`
    SELECT id AS "docId", grn_number AS "docNo", created_at AS "createdAt"
      FROM scm.grns
     WHERE company_id = ${co} AND status IN ('POSTED', 'CLOSED')
       AND COALESCE(migrated_no_stock, false) = false AND created_at >= ${cutoff}`;
  const lines = await sql`
    SELECT gi.grn_id AS "docId", gi.item_code AS "itemCode", gi.item_group AS "itemGroup", gi.qty_accepted AS qty
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
     WHERE g.company_id = ${co} AND g.status IN ('POSTED', 'CLOSED')
       AND COALESCE(g.migrated_no_stock, false) = false AND g.created_at >= ${cutoff}`;
  const movs = await sql`
    SELECT m.source_doc_id AS "docId", m.item_code AS "itemCode",
           SUM(CASE WHEN m.movement_type = 'IN' THEN m.qty WHEN m.movement_type = 'OUT' THEN -m.qty ELSE 0 END)::int AS net
      FROM scm.inventory_movements m JOIN scm.grns g ON g.id = m.source_doc_id
     WHERE m.company_id = ${co} AND g.company_id = ${co} AND m.source_doc_type = 'GRN'
       AND g.status IN ('POSTED', 'CLOSED') AND COALESCE(g.migrated_no_stock, false) = false
       AND g.created_at >= ${cutoff}
     GROUP BY 1, 2`;
  const bad = compareDocItems(docs, lines, movs);
  console.log(`  posted GRNs in window: ${docs.length}`);
  report(`[1] company ${co} GRN posted, stock IN missing or wrong`, bad, docItemLine);
  printHours("GRN", bad, docs);
}

/* Net OUT of a DO: its OUT rows minus its own IN corrections (resync returns)
   minus the ADJUSTMENT a cancel writes (source_doc_type 'ADJUSTMENT',
   source_doc_id = the DO, fn_reverse_do_out). */
const doNetSql = (sql, co, statusFilter, cutoff) => sql`
  SELECT m.source_doc_id AS "docId", m.item_code AS "itemCode",
         SUM(CASE WHEN m.source_doc_type = 'DO' AND m.movement_type = 'OUT' THEN m.qty
                  WHEN m.source_doc_type = 'DO' AND m.movement_type = 'IN' THEN -m.qty
                  WHEN m.source_doc_type = 'ADJUSTMENT' AND m.movement_type = 'ADJUSTMENT' THEN -m.qty
                  ELSE 0 END)::int AS net
    FROM scm.inventory_movements m JOIN scm.delivery_orders d ON d.id = m.source_doc_id
   WHERE m.company_id = ${co} AND d.company_id = ${co}
     AND m.source_doc_type IN ('DO', 'ADJUSTMENT')
     AND d.status::text IN ${sql(statusFilter)}
     AND COALESCE(d.migrated_no_stock, false) = false AND d.created_at >= ${cutoff}
   GROUP BY 1, 2`;

async function cls2(sql, co, cutoff) {
  const docs = await sql`
    SELECT id AS "docId", do_number AS "docNo", created_at AS "createdAt"
      FROM scm.delivery_orders
     WHERE company_id = ${co} AND status::text IN ${sql(DO_STOCK_OUT_STATES)}
       AND COALESCE(migrated_no_stock, false) = false AND created_at >= ${cutoff}`;
  const lines = await sql`
    SELECT i.delivery_order_id AS "docId", i.item_code AS "itemCode", i.item_group AS "itemGroup", i.qty
      FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
     WHERE d.company_id = ${co} AND d.status::text IN ${sql(DO_STOCK_OUT_STATES)}
       AND COALESCE(d.migrated_no_stock, false) = false AND d.created_at >= ${cutoff}`;
  const movs = await doNetSql(sql, co, DO_STOCK_OUT_STATES, cutoff);
  const bad = compareDocItems(docs, lines, movs);
  console.log(`  stock-out DOs in window (${DO_STOCK_OUT_STATES.join("/")}): ${docs.length}`);
  report(`[2] company ${co} DO shipped, stock OUT missing or wrong`, bad, docItemLine);
  printHours("DO", bad, docs);
}

async function cls3(sql, co, cutoff) {
  const docs = await sql`
    SELECT id AS "docId", do_number AS "docNo", created_at AS "createdAt"
      FROM scm.delivery_orders
     WHERE company_id = ${co} AND status::text = 'CANCELLED'
       AND COALESCE(migrated_no_stock, false) = false AND created_at >= ${cutoff}`;
  const movs = await doNetSql(sql, co, ["CANCELLED"], cutoff);
  const bad = cancelledResidue(docs, movs);
  console.log(`  cancelled DOs in window: ${docs.length}`);
  report(`[3] company ${co} DO cancelled, OUT not reversed`, bad,
    (r) => `${r.docNo} | ${iso(r.createdAt)} | ${r.itemCode} | net still out=${r.actual} | ${r.kind}`);
}

async function cls4(sql, co, cutoff) {
  const poLines = await sql`
    SELECT pi.id AS "poItemId", po.po_number AS "docNo", pi.line_no AS "lineNo", pi.item_code AS "itemCode",
           pi.received_qty AS "receivedQty", pi.created_at AS "createdAt"
      FROM scm.purchase_order_items pi JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
     WHERE po.company_id = ${co}
       AND (pi.created_at >= ${cutoff} OR EXISTS (
             SELECT 1 FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
              WHERE g.company_id = ${co} AND gi.purchase_order_item_id = pi.id AND gi.created_at >= ${cutoff}))`;
  const grnLines = await sql`
    SELECT gi.purchase_order_item_id AS "poItemId", g.status::text AS status,
           gi.qty_accepted, gi.returned_qty, gi.returned_closed_qty
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
      JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
     WHERE g.company_id = ${co} AND po.company_id = ${co}
       AND (pi.created_at >= ${cutoff} OR EXISTS (
             SELECT 1 FROM scm.grn_items gx JOIN scm.grns gg ON gg.id = gx.grn_id
              WHERE gg.company_id = ${co} AND gx.purchase_order_item_id = pi.id AND gx.created_at >= ${cutoff}))`;
  const bad = comparePoReceived(poLines, grnLines);
  console.log(`  PO lines in window: ${poLines.length}`);
  report(`[4] company ${co} PO received_qty disagrees with GRN lines`, bad,
    (r) => `${r.docNo} line ${r.lineNo ?? "-"} | ${iso(r.createdAt)} | ${r.itemCode} | received_qty=${r.actual} | GRN lines=${r.expected} | ${r.kind}`);
}

async function cls5(sql, co, cutoff) {
  /* reverseJournal writes the contra with source_type <SRC>_REVERSAL, the
     payment id as source_doc_no and the narration receipt-rebank.ts builds
     ("... moved from <bank> to <bank>"). */
  const rows = await sql`
    SELECT r.je_no AS "jeNo", r.source_type AS "sourceType", r.source_doc_no AS "paymentId", r.created_at AS "createdAt",
           CASE WHEN r.source_type = 'SOPAY_REVERSAL'
                THEN EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments p WHERE p.company_id = ${co} AND p.id::text = r.source_doc_no)
                ELSE EXISTS (SELECT 1 FROM scm.sales_invoice_payments p WHERE p.company_id = ${co} AND p.id::text = r.source_doc_no)
           END AS "paymentExists",
           (SELECT COUNT(*) FROM scm.journal_entries l
             WHERE l.company_id = ${co} AND l.source_doc_no = r.source_doc_no
               AND l.source_type = replace(r.source_type, '_REVERSAL', '')
               AND l.posted = true AND COALESCE(l.reversed, false) = false)::int AS "liveEntries"
      FROM scm.journal_entries r
     WHERE r.company_id = ${co} AND r.source_type IN ('SOPAY_REVERSAL', 'SIPAY_REVERSAL')
       AND r.narration LIKE '% moved from % to %' AND r.created_at >= ${cutoff}`;
  const bad = strandedRebanks(rows);
  console.log(`  rebank reversals in window: ${rows.length}`);
  report(`[5] company ${co} rebank reversed, no new entry`, bad,
    (r) => `${r.jeNo} | ${iso(r.createdAt)} | ${r.sourceType} | payment ${String(r.paymentId).slice(0, 8)} | live entries=${r.liveEntries}`);
}

async function cls6(sql, co) {
  /* Signs mirror the scm.inventory_balances view. Not windowed: on-hand is a
     state, and the CODY-(K) mismatch can come from a movement of any age. */
  const rows = await sql`
    WITH mv AS (
      SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk,
             SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int AS net,
             MAX(created_at) AS last_at
        FROM scm.inventory_movements WHERE company_id = ${co} GROUP BY 1, 2, 3),
    lt AS (
      SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk, SUM(qty_remaining)::int AS open
        FROM scm.inventory_lots WHERE company_id = ${co} GROUP BY 1, 2, 3)
    SELECT COALESCE(mv.item_code, lt.item_code) AS "itemCode",
           COALESCE(w.code, w.name, LEFT(COALESCE(mv.warehouse_id, lt.warehouse_id)::text, 8)) AS warehouse,
           COALESCE(mv.vk, lt.vk) AS "variantKey",
           COALESCE(mv.net, 0) AS "movementNet", COALESCE(lt.open, 0) AS "lotOpen", mv.last_at AS "lastAt"
      FROM mv FULL JOIN lt ON lt.item_code = mv.item_code AND lt.warehouse_id = mv.warehouse_id AND lt.vk = mv.vk
      LEFT JOIN scm.warehouses w ON w.id = COALESCE(mv.warehouse_id, lt.warehouse_id) AND w.company_id = ${co}
     WHERE COALESCE(mv.net, 0) <> COALESCE(lt.open, 0)`;
  const bad = lotBucketDiffs(rows);
  report(`[6] company ${co} open FIFO lots disagree with net movements`, bad,
    (r) => `${r.docNo} | last movement ${iso(r.lastAt)} | movements=${r.movementNet} | lots=${r.lotOpen} | ${r.kind}`);
}

/* Each source returns docNo, status, createdAt and an md5 fingerprint of the
   header and the lines. Amounts and names go INTO the md5 inside Postgres and
   never come out. */
const dupSources = (co, cutoff) => [
  ["credit notes", (sql) => sql`
    SELECT n.note_number AS "docNo", n.status::text AS status, n.created_at AS "createdAt",
           md5(concat_ws('|', n.kind, n.party_type, n.party_code, n.party_name, n.supplier_id, n.so_doc_no, n.sales_invoice_id,
                 n.purchase_invoice_id, n.source_doc_no, n.note_date, n.total_sen, n.debtor_id,
                 (SELECT string_agg(concat_ws('~', l.description, l.account_code, l.amount_sen, l.qty), '^' ORDER BY l.line_no, l.description)
                    FROM scm.acc_credit_note_lines l WHERE l.note_id = n.id AND l.company_id = ${co}))) AS fingerprint
      FROM scm.acc_credit_notes n WHERE n.company_id = ${co} AND n.created_at >= ${cutoff}`],
  ["supplier bills (PI)", (sql) => sql`
    SELECT p.invoice_number AS "docNo", p.status::text AS status, p.created_at AS "createdAt",
           md5(concat_ws('|', p.supplier_id, p.supplier_invoice_ref, p.purchase_order_id, p.grn_id, p.invoice_date, p.total_sen,
                 (SELECT string_agg(concat_ws('~', i.item_code, i.grn_item_id, i.qty, i.unit_price_sen), '^' ORDER BY i.item_code, i.qty, i.grn_item_id)
                    FROM scm.purchase_invoice_items i WHERE i.purchase_invoice_id = p.id))) AS fingerprint
      FROM scm.purchase_invoices p WHERE p.company_id = ${co} AND p.created_at >= ${cutoff}`],
  ["supplier bills (AP)", (sql) => sql`
    SELECT a.invoice_number AS "docNo", a.status::text AS status, a.created_at AS "createdAt",
           md5(concat_ws('|', a.doc_kind, a.supplier_id, a.supplier_invoice_ref, a.invoice_date, a.total_sen,
                 (SELECT string_agg(concat_ws('~', l.description, l.debit_account_code, l.amount_sen), '^' ORDER BY l.line_no, l.description)
                    FROM scm.ap_invoice_lines l WHERE l.invoice_id = a.id AND l.company_id = ${co}))) AS fingerprint
      FROM scm.ap_invoices a WHERE a.company_id = ${co} AND a.created_at >= ${cutoff}`],
  ["deposit invoices", (sql) => sql`
    SELECT d.di_number AS "docNo", d.status::text AS status, d.created_at AS "createdAt",
           md5(concat_ws('|', d.payment_source, d.so_doc_no, d.party_code, d.invoice_date, d.amount_sen, d.method)) AS fingerprint
      FROM scm.acc_deposit_invoices d WHERE d.company_id = ${co} AND d.created_at >= ${cutoff}`],
  ["general receipts", (sql) => sql`
    SELECT r.receipt_number AS "docNo", r.status::text AS status, r.created_at AS "createdAt",
           md5(concat_ws('|', r.payer_name, r.receipt_date, r.bank_account_code, r.total_sen,
                 (SELECT string_agg(concat_ws('~', l.description, l.credit_account_code, l.amount_sen), '^' ORDER BY l.line_no, l.description)
                    FROM scm.acc_receipt_lines l WHERE l.receipt_id = r.id AND l.company_id = ${co}))) AS fingerprint
      FROM scm.acc_receipts r WHERE r.company_id = ${co} AND r.created_at >= ${cutoff}`],
  ["other debtor receipts", (sql) => sql`
    SELECT r.receipt_number AS "docNo", r.status::text AS status, r.created_at AS "createdAt",
           md5(concat_ws('|', r.debtor_id, r.receipt_date, r.bank_account_code, r.total_sen,
                 (SELECT string_agg(concat_ws('~', a.bill_id, a.amount_sen), '^' ORDER BY a.bill_id, a.amount_sen)
                    FROM scm.acc_debtor_receipt_allocations a WHERE a.receipt_id = r.id AND a.company_id = ${co}))) AS fingerprint
      FROM scm.acc_debtor_receipts r WHERE r.company_id = ${co} AND r.created_at >= ${cutoff}`],
  ["sales order payments", (sql) => sql`
    SELECT p.so_doc_no || ' pay ' || LEFT(p.id::text, 8) AS "docNo", p.method AS status, p.created_at AS "createdAt",
           md5(concat_ws('|', p.so_doc_no, p.paid_at, p.method, p.merchant_provider, p.approval_code, p.amount_sen,
                 p.converted_from_so_doc_no, p.converted_to_so_doc_no)) AS fingerprint
      FROM scm.mfg_sales_order_payments p
     WHERE p.company_id = ${co} AND p.created_at >= ${cutoff} AND p.mirror_of_payment_id IS NULL`],
  ["sales invoice payments", (sql) => sql`
    SELECT COALESCE(s.invoice_number, 'SI') || ' pay ' || LEFT(p.id::text, 8) AS "docNo", p.method AS status, p.created_at AS "createdAt",
           md5(concat_ws('|', p.sales_invoice_id, p.paid_at, p.method, p.merchant_provider, p.approval_code, p.amount_sen)) AS fingerprint
      FROM scm.sales_invoice_payments p
      LEFT JOIN scm.sales_invoices s ON s.id = p.sales_invoice_id AND s.company_id = ${co}
     WHERE p.company_id = ${co} AND p.created_at >= ${cutoff}`],
];

async function cls7(sql, co, cutoff) {
  for (const [label, query] of dupSources(co, cutoff)) {
    await sql.savepoint(async (sp) => {
      const docs = await query(sp);
      const clusters = duplicateClusters(docs, DUPLICATE_WINDOW_SECONDS);
      console.log(`  ${label} in window: ${docs.length}`);
      report(`[7] company ${co} ${label}: same header+lines within ${DUPLICATE_WINDOW_SECONDS}s`, clusters,
        (c) => `${iso(c.createdAt)} | ${c.docs.map((d) => `${d.docNo} (${d.status})`).join(" + ")} | span ${c.spanSeconds}s`);
    }).catch((e) => { failures += 1; console.error(`  [7] ${label} query failed: ${e.message}`); });
  }
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  await pg.begin("read only", async (sql) => {
    const [{ cutoff }] = await sql`SELECT now() - make_interval(days => ${DAYS}) AS cutoff`;
    /* Companies that own documents — no master-table name to get wrong. */
    const cos = (await sql`
      SELECT company_id FROM scm.grns WHERE company_id IS NOT NULL GROUP BY 1
      UNION SELECT company_id FROM scm.delivery_orders WHERE company_id IS NOT NULL GROUP BY 1
      ORDER BY 1`).map((r) => Number(r.company_id));
    notice(`half-done documents: window ${DAYS} days (since ${iso(cutoff)}), companies ${cos.join(", ")}, up to ${LIMIT} examples per class`);
    for (const co of cos) {
      console.log(`\n================ company ${co} ================`);
      const classes = [
        ["1", (sp) => cls1(sp, co, cutoff)], ["2", (sp) => cls2(sp, co, cutoff)], ["3", (sp) => cls3(sp, co, cutoff)],
        ["4", (sp) => cls4(sp, co, cutoff)], ["5", (sp) => cls5(sp, co, cutoff)], ["6", (sp) => cls6(sp, co)],
      ];
      for (const [n, run] of classes) {
        console.log(`\n-- class ${n} --`);
        await sql.savepoint(run).catch((e) => { failures += 1; console.error(`  [${n}] company ${co} query failed: ${e.message}`); });
      }
      console.log(`\n-- class 7 --`);
      await cls7(sql, co, cutoff);
    }
  });
} finally {
  await pg.end({ timeout: 5 });
}
if (failures > 0) {
  console.error(`${failures} query(ies) failed; the classes above that printed a count are still valid.`);
  process.exit(1);
}
