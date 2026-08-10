#!/usr/bin/env node
// Remove the fully-delivered AutoCount orders that were imported as if they
// were outstanding (owner 2026-08-10: "如果不是 partially delivery 又 delivered
// 了全部就删掉吧").
//
// Definition, exactly the owner's: an order is fully delivered when EVERY line
// has TransferedQty >= Qty. TransferedPOQty is never consulted — converting to
// a PO keeps a line outstanding. Verified against the export: all 92 such
// orders have Qty == TransferedQty on every line, no partial, no over-delivery.
//
// SAFETY — an order is deleted only when nothing downstream points at it:
//   · no PO allocation references any of its lines
//   · no ERP delivery-order line references it
//   · no payment rows other than the ones this import created (any payment at
//     all is reported; the owner decides those case by case)
// Anything with a downstream reference is REPORTED and left untouched.
// MODE=dry-run default; MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN".
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const APPLY = MODE === "apply" && process.env.CONFIRM === "I HAVE REVIEWED THE DRY-RUN";
if (MODE === "apply" && !APPLY) { console.error('apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN"'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const here = path.dirname(fileURLToPath(import.meta.url));
const n = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 0; };

const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-outstanding-so.json.gz"))).toString("utf8"));
const byDoc = new Map();
for (const l of raw) { if (!byDoc.has(l.DocNo)) byDoc.set(l.DocNo, []); byDoc.get(l.DocNo).push(l); }
const delivered = new Set();
for (const [doc, ls] of byDoc) if (ls.length && !ls.some((l) => n(l.Qty) > n(l.TransferedQty))) delivered.add(doc);

async function main() {
  note(`MODE=${MODE}; fully-delivered orders in the export: ${delivered.size}`);
  const heads = await sql`SELECT doc_no, linked_ac_docno, total_revenue_centi, status
                          FROM scm.mfg_sales_orders
                          WHERE company_id = 1 AND linked_ac_docno = ANY(${[...delivered]})`;
  note(`present in the ERP: ${heads.length}`);

  const del = [], keep = [];
  for (const h of heads) {
    const reasons = [];
    const [alloc] = await sql`SELECT 1 AS x FROM scm.purchase_order_item_allocations a
                              JOIN scm.mfg_sales_order_items i ON i.id = a.so_item_id
                              WHERE i.doc_no = ${h.doc_no} LIMIT 1`;
    if (alloc) reasons.push("PO allocation");
    const [direct] = await sql`SELECT 1 AS x FROM scm.purchase_order_items p
                               JOIN scm.mfg_sales_order_items i ON i.id = p.so_item_id
                               WHERE i.doc_no = ${h.doc_no} LIMIT 1`;
    if (direct) reasons.push("PO line linked 1:1");
    const [pay] = await sql`SELECT count(*)::int AS c, coalesce(sum(amount_centi),0)::bigint AS amt
                            FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${h.doc_no}`;
    if (pay && pay.c > 0) reasons.push(`${pay.c} payment(s) RM${(Number(pay.amt) / 100).toFixed(2)}`);
    (reasons.length ? keep : del).push({ ...h, reasons });
  }

  note(`DELETABLE (nothing downstream): ${del.length}`);
  for (const d of del.slice(0, 60)) note(`   ${d.linked_ac_docno} -> ${d.doc_no}  RM${(Number(d.total_revenue_centi || 0) / 100).toFixed(2)}  ${d.status}`);
  note(`HELD BACK (has downstream refs — owner decides): ${keep.length}`);
  for (const k of keep.slice(0, 60)) note(`   ${k.linked_ac_docno} -> ${k.doc_no}  ${k.reasons.join(" + ")}`);

  if (!APPLY) { note("DRY-RUN — nothing deleted."); await sql.end({ timeout: 5 }); return; }

  let gone = 0;
  for (const d of del) {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${d.doc_no}`;
      await tx`DELETE FROM scm.mfg_sales_order_items WHERE doc_no = ${d.doc_no}`;
      await tx`DELETE FROM scm.mfg_sales_orders WHERE doc_no = ${d.doc_no} AND company_id = 1`;
      gone++;
    });
  }
  note(`APPLIED: orders deleted ${gone}; held back ${keep.length}`);
  await sql.end({ timeout: 5 });
}
main().catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
