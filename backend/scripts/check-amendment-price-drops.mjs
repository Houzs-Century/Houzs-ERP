#!/usr/bin/env node
// Read-only: which Sales Order lines lost their price when an amendment was
// approved? The measurement behind DEV-70.
//
// HOW IT HAPPENED (HC-SO-013490/A1, HC-SO-013497/A1). The amendment editor
// sends every changed line's current price as new_unit_price_sen. Swapping a
// line's item code re-fills that price from the NEW SKU's sell price, which
// is 0 on many cutover SKUs, and the LINES-lane approval (the Purchaser,
// scm.amendment.approve_lines) makes the requested price payable
// (lib/so-revision.ts applySoAmendment). A set price that AutoCount kept on one
// line (RM 8,500 / RM 5,340) became RM 0 and the order turned over-collected.
//
// THE SOURCE OF TRUTH is the approval's own audit row: applySoAmendment records
// `line_<original code>_unit_price_sen` from -> to for every line whose price it
// wrote. The amendment's lines (so_amendment_lines.old_snapshot.itemCode) give
// the line id behind each key.
//
// Buckets:
//   TO_ZERO   price went from > 0 to 0 — the DEV-70 bug, fix the price.
//   MOVED     price moved to another non-zero figure — not necessarily wrong,
//             but nobody in Finance signed it; listed for a human to look at.
//
// For each line it prints how the price can be put back today:
//   EDIT       no live DO / SI carries the line — the normal SO editor.
//   AFTER_DO   a live DO carries it, no invoice / return — "Change price after
//              DO" (scm.so.edit_price_after_do).
//   INVOICED   a live Sales Invoice or Delivery Return — needs the invoice
//              decision first.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer, including "nothing found". Only an unreachable database
// exits non-zero.
//
// Usage:
//   node scripts/check-amendment-price-drops.mjs
//   COMPANY_ID=2 node scripts/check-amendment-price-drops.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) {
  console.error(`COMPANY_ID must be a positive integer; got ${JSON.stringify(process.env.COMPANY_ID)}`);
  process.exit(1);
}

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

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const myt = (d) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour12: false }) : "-");
const rm = (sen) => (sen == null ? "-" : `RM ${(Number(sen) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const PRICE_KEY = /^line_(.*)_unit_price_sen$/;

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`check-amendment-price-drops — company ${COMPANY_ID}, read-only`);
  log("");

  const approvals = await sql`
    SELECT a.so_doc_no, a.created_at, a.field_changes
      FROM scm.mfg_so_audit_log a
     WHERE a.company_id = ${COMPANY_ID}
       AND a.action = 'AMENDMENT_SO_APPROVED'
     ORDER BY a.created_at`;

  const hits = [];
  for (const row of approvals) {
    const changes = Array.isArray(row.field_changes) ? row.field_changes : [];
    const amendmentId = changes.find((c) => c.field === "amendment_id")?.to ?? null;
    const authority = changes.find((c) => c.field === "price_authority")?.to ?? null;
    for (const c of changes) {
      const m = PRICE_KEY.exec(String(c.field ?? ""));
      if (!m) continue;
      const from = Number(c.from ?? 0), to = Number(c.to ?? 0);
      if (from === to) continue;
      const codeChange = changes.find((x) => x.field === `line_${m[1]}_item_code`);
      hits.push({
        docNo: row.so_doc_no, at: row.created_at, amendmentId, authority, wasCode: m[1],
        nowCode: codeChange?.to ?? m[1], from, to, bucket: from > 0 && to === 0 ? "TO_ZERO" : "MOVED",
      });
    }
  }
  log(`Amendment approvals read: ${approvals.length}; line price changes found: ${hits.length}`);
  if (hits.length === 0) { log("Nothing to report."); return; }

  /* The line behind each key: the amendment's line whose old snapshot named that code. */
  const amendmentIds = [...new Set(hits.map((h) => h.amendmentId).filter(Boolean))];
  const amLines = amendmentIds.length === 0 ? [] : await sql`
    SELECT l.amendment_id, l.sales_order_item_id, l.old_snapshot->>'itemCode' AS old_code, am.amendment_no
      FROM scm.so_amendment_lines l
      JOIN scm.so_amendments am ON am.id = l.amendment_id
     WHERE l.amendment_id IN ${sql(amendmentIds)}`;
  for (const h of hits) {
    const l = amLines.find((x) => x.amendment_id === h.amendmentId && String(x.old_code ?? "") === h.wasCode);
    h.itemId = l?.sales_order_item_id ?? null;
    h.amendmentNo = amLines.find((x) => x.amendment_id === h.amendmentId)?.amendment_no ?? null;
  }

  const itemIds = [...new Set(hits.map((h) => h.itemId).filter(Boolean))];
  const docNos = [...new Set(hits.map((h) => h.docNo))];
  const [items, orders, doLines, siLines, sis, drs] = await Promise.all([
    itemIds.length ? sql`SELECT id, item_code, unit_price_sen, cancelled FROM scm.mfg_sales_order_items WHERE id IN ${sql(itemIds)}` : [],
    sql`SELECT doc_no, status, local_total_sen, linked_ac_docno FROM scm.mfg_sales_orders WHERE doc_no IN ${sql(docNos)}`,
    itemIds.length ? sql`
      SELECT di.so_item_id, d.id, d.do_number, d.status
        FROM scm.delivery_order_items di JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
       WHERE di.so_item_id IN ${sql(itemIds)} AND upper(coalesce(d.status::text, '')) <> 'CANCELLED'` : [],
    itemIds.length ? sql`
      SELECT si.so_item_id, s.invoice_number, s.status
        FROM scm.sales_invoice_items si JOIN scm.sales_invoices s ON s.id = si.sales_invoice_id
       WHERE si.so_item_id IN ${sql(itemIds)} AND upper(coalesce(s.status::text, '')) <> 'CANCELLED'` : [],
    sql`SELECT delivery_order_id, invoice_number, status FROM scm.sales_invoices
         WHERE so_doc_no IN ${sql(docNos)} AND upper(coalesce(status::text, '')) <> 'CANCELLED'`,
    sql`SELECT dr.delivery_order_id, dr.status FROM scm.delivery_returns dr
          JOIN scm.delivery_orders d ON d.id = dr.delivery_order_id
         WHERE d.so_doc_no IN ${sql(docNos)} AND upper(coalesce(dr.status::text, '')) <> 'CANCELLED'`,
  ]);

  for (const bucket of ["TO_ZERO", "MOVED"]) {
    const rows = hits.filter((h) => h.bucket === bucket);
    log("");
    log(bucket === "TO_ZERO"
      ? `TO_ZERO — price went to RM 0 on approval: ${rows.length} line(s) on ${new Set(rows.map((r) => r.docNo)).size} order(s)`
      : `MOVED — price changed to another figure on approval: ${rows.length} line(s)`);
    for (const h of rows) {
      const item = items.find((i) => i.id === h.itemId);
      const so = orders.find((o) => o.doc_no === h.docNo);
      const dos = doLines.filter((d) => d.so_item_id === h.itemId);
      const lineSis = siLines.filter((s) => s.so_item_id === h.itemId);
      const doSis = sis.filter((s) => dos.some((d) => d.id === s.delivery_order_id));
      const doDrs = drs.filter((r) => dos.some((d) => d.id === r.delivery_order_id));
      const invoices = [...new Set([...lineSis, ...doSis].map((s) => `${s.invoice_number} (${s.status})`))];
      const path = invoices.length || doDrs.length ? "INVOICED" : dos.length ? "AFTER_DO" : "EDIT";
      const nowPrice = item ? Number(item.unit_price_sen ?? 0) : null;
      const putBack = item && nowPrice === h.to ? "" : ` — price is ${rm(nowPrice)} now (changed since)`;
      log(`  ${h.docNo} ${h.amendmentNo ?? ""} approved ${myt(h.at)} MYT by ${h.authority ?? "?"}`);
      log(`    ${h.wasCode}${h.nowCode !== h.wasCode ? ` -> ${h.nowCode}` : ""}: ${rm(h.from)} -> ${rm(h.to)}${putBack}`);
      log(`    SO ${so?.status ?? "?"} total ${rm(so?.local_total_sen)}; DO ${dos.map((d) => d.do_number).join(", ") || "-"}; invoice ${invoices.join(", ") || "-"}${doDrs.length ? "; return on DO" : ""}; fix via ${path}${item ? "" : " (line not found)"}`);
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
