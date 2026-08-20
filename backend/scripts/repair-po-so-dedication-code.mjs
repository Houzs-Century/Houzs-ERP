#!/usr/bin/env node
/* A purchase-order line dedicated to a sales-order line carrying a DIFFERENT
 * item code is mis-paired. The two lines are supposed to describe one physical
 * build, so a code mismatch is not a data difference - it is the wrong link.
 *
 * This session created four of them: the sofa splitter copied `so_item_id`
 * verbatim onto every piece it inserted, so two or three new purchase-order
 * pieces all pointed at the ONE original sales-order line. SO-to-PO
 * disagreements went 14 -> 18 and sofa builds 45/45 -> 45/42.
 *
 * The repair is deterministic and needs no judgement: point the line at the
 * sales-order line on the SAME document whose code matches. A line with no
 * unique match is REPORTED and left alone - never re-pointed at a guess.
 *
 * This is a link repair. It writes no value, moves no money and touches no
 * stock. DRY-RUN by default; APPLY=1 writes.
 *
 * RE-RUN: convergent. Re-derives the same so_item_id from the same AutoCount dedication text.
 */
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const MISPAIRED = (db) => db`
  SELECT i.id po_id, p.po_number po_doc, i.item_code po_code,
         s.doc_no so_doc, s.item_code so_code
    FROM scm.purchase_order_items i
    JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
   WHERE p.company_id = 1 AND i.item_group IN ('sofa','bedframe')
     AND upper(btrim(i.item_code)) <> upper(btrim(s.item_code))`;

async function main() {
  const rows = await MISPAIRED(sql);
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; mis-paired lines: ${rows.length}`);

  const plan = [];
  for (const r of rows) {
    const cand = await sql`SELECT id, item_code FROM scm.mfg_sales_order_items
       WHERE doc_no = ${r.so_doc} AND upper(btrim(item_code)) = upper(btrim(${r.po_code}))`;
    if (cand.length !== 1) {
      log(`REPORTED ${r.po_doc} ${r.po_code}: ${cand.length} candidates on ${r.so_doc} - left alone`);
      continue;
    }
    plan.push({ ...r, newSoId: cand[0].id });
    log(`  ${r.po_doc} ${String(r.po_code).padEnd(16)} ${r.so_doc}: ${r.so_code} -> ${cand[0].item_code}`);
  }
  log(`re-point ${plan.length} of ${rows.length}`);

  if (!APPLY) { log("\nDRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const r = await tx`UPDATE scm.purchase_order_items SET so_item_id = ${p.newSoId}
                          WHERE id = ${p.po_id} RETURNING id`;
      n += r.length;
    }
    /* Re-count inside the transaction rather than trusting the loop: the answer
       that matters is what the database now holds, not what the writer thinks
       it wrote. */
    const left = await MISPAIRED(tx);
    log(`after the repair, mis-paired lines remaining: ${left.length}`);
  });
  log(`APPLIED - re-pointed ${n}. No value written, no money moved, no stock touched.`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
