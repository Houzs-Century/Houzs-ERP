#!/usr/bin/env node
// READ-ONLY: can a Sales Order that carries a CANCELLED line still ship, and do
// the supplier-orphan and PDF readers handle that line correctly?
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// Two studies ran on 2026-08-10/11 without seeing each other:
//
//   • restore-deleted-so-lines.mjs (PR #1937, run 31424084270) reinstated two
//     hard-deleted sofa lines as `cancelled = true` rows — the FIRST such rows
//     production has ever held.
//   • docs/autocount-line-retirement-plan.md argued that a cancelled row is
//     worse than a deleted one because ~85 readers filter `cancelled` but
//     several load-bearing ones do NOT, and named three that would bite a sofa
//     line specifically.
//
// The plan's gap 1 is the dangerous one: sofa-batch-guard.findIncompleteSofaSets
// defines "the whole sofa set" as every line of the SO with
// stock_status = 'READY' and applies NO cancelled filter. If a cancelled sofa
// module is READY it becomes a permanent phantom set member and EVERY delivery
// order for that Sales Order is refused 409 sofa_partial_set.
//
// So the verdict turns on one column the restore script never wrote:
// mfg_sales_order_items.stock_status on the restored rows. This script reads it,
// then REPLAYS each guard's own predicate against the live rows rather than
// reasoning about them.
//
// Sections:
//   A. the two documents — header + every line, with the fields each guard reads
//   B. sofa detection — replays detectSofa (mfg_products.category = 'SOFA' OR
//      item_group ILIKE '%SOFA%'), because that decides whether the guards
//      look at these lines at all
//   C. gap 1 — replays findIncompleteSofaSets' set definition and answers
//      SHIPPABLE yes/no per document
//   D. existing delivery orders on each document, and their link state
//   E. gap 2 — purchase_order_items.so_item_id pointing at any line of these
//      documents, plus the so_revisions snapshots that drive `removed`
//   F. gap 3 — what a PDF built from GET /:docNo would print and total, since
//      that endpoint applies no cancelled filter
//   G. blast radius — every cancelled line in production, not just these two
//
// SELECTs only. No writes, no DDL, no transaction. Exit 0 for every legitimate
// answer; the output IS the answer. Exit non-zero only if the DB is unreachable.
//   DATABASE_URL  required
//   SO_DOCS       comma-separated doc_no list (default the two restored docs)
import { readFileSync } from "node:fs";
import postgres from "postgres";

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
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const DOCS = (process.env.SO_DOCS || "HC-SO-012624,HC-SO-013167")
  .split(",").map((s) => s.trim()).filter(Boolean);
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const money = (c) => (Number(c ?? 0) / 100).toFixed(2);

async function main() {
  log(`=== cancelled-SO-line reader check (read-only) ===  SO_DOCS=${DOCS.join(", ")}`);

  // The column default matters as much as the current value: it is what every
  // future restore-style insert will land on.
  const [def] = await sql`
    SELECT column_default, is_nullable, data_type
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'mfg_sales_order_items'
       AND column_name = 'stock_status'`;
  log(`stock_status column: default=${def?.column_default ?? "(none)"} nullable=${def?.is_nullable} type=${def?.data_type}`);

  for (const doc of DOCS) {
    log("");
    log(`################ ${doc} ################`);

    const hdr = await sql`
      SELECT doc_no, company_id, debtor_name,
             UPPER(COALESCE(status::text, '')) AS status
        FROM scm.mfg_sales_orders WHERE doc_no = ${doc}`;
    if (hdr.length === 0) { log("  NOT FOUND."); continue; }
    const companyId = hdr[0].company_id;
    log(`  A. header: status=${hdr[0].status} customer=${hdr[0].debtor_name ?? "?"} company=${companyId}`);

    // ---- A. every line, with exactly the columns the guards read -------------
    const lines = await sql`
      SELECT id::text AS id, line_no, item_code, item_group, qty,
             cancelled,
             stock_status,
             stock_qty_ready,
             allocated_batch_no,
             warehouse_id::text AS warehouse_id,
             unit_price_centi, total_centi, balance_centi,
             LEFT(COALESCE(description, ''), 40) AS description
        FROM scm.mfg_sales_order_items
       WHERE doc_no = ${doc}
       ORDER BY line_no NULLS LAST, created_at`;
    log(`  A. lines (${lines.length}):`);
    for (const l of lines) {
      log(`     line_no=${l.line_no} ${l.item_code} group=${l.item_group} qty=${l.qty} ` +
          `cancelled=${l.cancelled} stock_status=${JSON.stringify(l.stock_status)} ` +
          `ready_qty=${l.stock_qty_ready} batch=${JSON.stringify(l.allocated_batch_no)} ` +
          `wh=${l.warehouse_id ?? "null"} unit=${money(l.unit_price_centi)} total=${money(l.total_centi)} id=${l.id.slice(0, 8)}`);
    }

    // ---- B. sofa detection, replaying detectSofa ----------------------------
    const codes = [...new Set(lines.map((l) => l.item_code).filter(Boolean))];
    const prods = codes.length
      ? await sql`SELECT code, category FROM scm.mfg_products
                   WHERE code = ANY(${codes}) AND company_id = ${companyId}`
      : [];
    const sofaCodes = new Set(prods.filter((p) => String(p.category ?? "").toUpperCase() === "SOFA").map((p) => p.code));
    const isSofa = (l) => sofaCodes.has(l.item_code) || String(l.item_group ?? "").toUpperCase().includes("SOFA");
    log(`  B. sofa detection: mfg_products category=SOFA for [${[...sofaCodes].join(", ") || "none"}]`);
    for (const l of lines) log(`     ${l.item_code} -> isSofa=${isSofa(l)} (category=${prods.find((p) => p.code === l.item_code)?.category ?? "n/a"}, item_group=${l.item_group})`);

    // ---- C. gap 1 — replay findIncompleteSofaSets ---------------------------
    // Its set = lines of this doc with stock_status = 'READY' that are sofa. A
    // cancelled line inside that set is a phantom member: it can never be put
    // on a DO (the DO picker reads live lines), so every DO leaves it behind
    // and is refused sofa_partial_set.
    const readySofa = lines.filter((l) => String(l.stock_status ?? "") === "READY" && isSofa(l));
    const phantom = readySofa.filter((l) => l.cancelled);
    log(`  C. GAP 1 (sofa_partial_set) — findIncompleteSofaSets set = stock_status='READY' AND sofa:`);
    log(`     set members: ${readySofa.length ? readySofa.map((l) => `${l.item_code}${l.cancelled ? " [CANCELLED]" : ""}`).join(", ") : "(none)"}`);
    if (phantom.length > 0) {
      log(`     >>> GAP 1 IS LIVE: ${phantom.map((l) => l.item_code).join(", ")} is a CANCELLED phantom set member.`);
      log(`     >>> SHIPPABLE: NO — every DO for ${doc} is refused 409 sofa_partial_set (missing ${phantom.map((l) => l.item_code).join(", ")}).`);
    } else {
      log(`     no cancelled row is inside the set, so findIncompleteSofaSets cannot name one as missing.`);
      log(`     >>> SHIPPABLE: YES as far as gap 1 is concerned.`);
    }

    // findSofaLinesWithoutCompleteBatch only ever sees SO lines a DO actually
    // carries, so report whether the LIVE lines could pass it today.
    const liveSofa = lines.filter((l) => !l.cancelled && isSofa(l));
    const noBatch = liveSofa.filter((l) => !l.allocated_batch_no || !l.warehouse_id);
    log(`  C2. findSofaLinesWithoutCompleteBatch on the LIVE sofa lines: ${liveSofa.length} live, ` +
        `${noBatch.length} would be offenders for missing batch/warehouse ` +
        `(${noBatch.map((l) => l.item_code).join(", ") || "none"}).`);

    // ---- D. delivery orders -------------------------------------------------
    const dos = await sql`
      SELECT id::text AS id, do_number, UPPER(COALESCE(status::text, '')) AS status, do_date::text AS do_date
        FROM scm.delivery_orders WHERE so_doc_no = ${doc} ORDER BY do_date NULLS LAST, do_number`;
    log(`  D. delivery orders on this SO: ${dos.length}`);
    for (const d of dos) {
      const dl = await sql`
        SELECT item_code, qty, so_item_id::text AS so_item_id
          FROM scm.delivery_order_items WHERE delivery_order_id = ${d.id}::uuid ORDER BY item_code`;
      log(`     ${d.do_number} status=${d.status} date=${d.do_date} lines=${dl.length}`);
      for (const x of dl) log(`        ${x.item_code} qty=${x.qty} so_item_id=${x.so_item_id ? x.so_item_id.slice(0, 8) : "NULL"}`);
    }

    // ---- E. gap 2 — supplier-side orphan reconciliation ---------------------
    const ids = lines.map((l) => l.id);
    const poLinks = ids.length
      ? await sql`SELECT pi.id::text AS id, pi.so_item_id::text AS so_item_id, pi.material_code,
                         po.po_number, UPPER(COALESCE(po.status::text, '')) AS po_status
                    FROM scm.purchase_order_items pi
                    LEFT JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
                   WHERE pi.so_item_id = ANY(${ids}::uuid[])`
      : [];
    log(`  E. GAP 2 (PO orphan reconciliation) — purchase_order_items pointing at a line of this SO: ${poLinks.length}`);
    const cancelledIds = new Set(lines.filter((l) => l.cancelled).map((l) => l.id));
    for (const p of poLinks) {
      const onCancelled = cancelledIds.has(p.so_item_id);
      log(`     PO ${p.po_number} (${p.po_status}) line ${p.id.slice(0, 8)} ${p.material_code} -> so_item ${p.so_item_id.slice(0, 8)}${onCancelled ? "  <<< POINTS AT A CANCELLED SO LINE" : ""}`);
    }
    const poOnCancelled = poLinks.filter((p) => cancelledIds.has(p.so_item_id));
    log(`     ${poOnCancelled.length === 0
      ? "no live PO line is bound to a cancelled SO line, so there is nothing for the orphan pass to miss."
      : ">>> GAP 2 IS LIVE: a supplier PO line is bound to a cancelled SO line and will never be classified REMOVED."}`);

    // The `removed = prev \ current` diff reads so_revisions.snapshot.lines[].id.
    // A restored row carries a NEW uuid, so it cannot appear in any earlier
    // snapshot — state that as evidence rather than assuming it.
    const revs = await sql`
      SELECT revision, created_at::text AS created_at,
             jsonb_array_length(COALESCE(snapshot->'lines', '[]'::jsonb)) AS snap_lines,
             COALESCE(snapshot->'poLinks', '{}'::jsonb)::text AS po_links
        FROM scm.so_revisions WHERE so_doc_no = ${doc} ORDER BY revision`;
    log(`     so_revisions snapshots for this SO: ${revs.length}`);
    for (const r of revs) {
      const snapIds = await sql`
        SELECT COALESCE(jsonb_agg(e->>'id'), '[]'::jsonb)::text AS ids
          FROM scm.so_revisions r, jsonb_array_elements(COALESCE(r.snapshot->'lines', '[]'::jsonb)) e
         WHERE r.so_doc_no = ${doc} AND r.revision = ${r.revision}`;
      const inSnap = ids.filter((i) => String(snapIds[0]?.ids ?? "").includes(i));
      log(`        rev ${r.revision} @${r.created_at} lines=${r.snap_lines} poLinks=${r.po_links} ` +
          `— current line ids present in it: ${inSnap.length ? inSnap.map((i) => i.slice(0, 8)).join(", ") : "none"}`);
    }

    // ---- F. gap 3 — the customer-facing PDF ---------------------------------
    // GET /mfg-sales-orders/:docNo applies no cancelled filter, so this is
    // literally the row list handed to generateSalesOrderPdf by the mobile
    // detail and by the desktop LIST bulk print.
    const printed = lines;
    const printedTotal = printed.reduce((s, l) => s + Number(l.total_centi ?? 0), 0);
    const liveTotal = printed.filter((l) => !l.cancelled).reduce((s, l) => s + Number(l.total_centi ?? 0), 0);
    const cancelledPrinted = printed.filter((l) => l.cancelled);
    log(`  F. GAP 3 (PDF) — GET /:docNo returns ${printed.length} rows, of which ${cancelledPrinted.length} cancelled.`);
    log(`     a PDF built from that payload prints ${printed.length} line rows and totals RM ${money(printedTotal)}; ` +
        `the correct figure over live lines only is RM ${money(liveTotal)}.`);
    if (cancelledPrinted.length > 0) {
      log(`     >>> GAP 3 IS LIVE: ${cancelledPrinted.map((l) => `${l.item_code} qty ${l.qty} @ RM ${money(l.total_centi)}`).join("; ")} ` +
          `appears on the customer document (mobile detail print + desktop list bulk print). ` +
          `Money moved by it: RM ${money(printedTotal - liveTotal)}.`);
    } else {
      log(`     no cancelled row would be printed.`);
    }
  }

  // ---- G. blast radius ------------------------------------------------------
  log("");
  log("=== G. every cancelled sales-order line in production ===");
  const all = await sql`
    SELECT doc_no, line_no, item_code, item_group, qty, stock_status, total_centi, company_id
      FROM scm.mfg_sales_order_items WHERE cancelled ORDER BY doc_no, line_no`;
  log(`  ${all.length} row(s) with cancelled = true:`);
  for (const r of all) {
    log(`    ${r.doc_no} line ${r.line_no} ${r.item_code} group=${r.item_group} qty=${r.qty} ` +
        `stock_status=${JSON.stringify(r.stock_status)} total=${money(r.total_centi)} company=${r.company_id}`);
  }
  const readyCancelled = all.filter((r) => String(r.stock_status ?? "") === "READY");
  log(`  of those, ${readyCancelled.length} carry stock_status='READY' — the shape that makes gap 1 bite.`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
