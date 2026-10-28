#!/usr/bin/env node
/* Every line's Desc2 must be the Desc2 of the AutoCount line it IS - found by
 * its own DtlKey, not by (document, ItemCode).
 *
 * Owner: 以 AutoCount 为准，最准.
 *
 * WHAT THIS FIXES. `HC-PO-009722` holds two `CODY-(Q)` lines. Ours read
 * `M'GP:10"` where AutoCount's line of that key reads `14"`, and vice versa -
 * the two texts are SWAPPED. Nothing is missing and nothing is wrong as a set;
 * each value simply sits on the wrong sibling. That is the same collision that
 * produced every wrong-value incident in this migration, and it is why four
 * documents still read as SO-vs-PO "conflicts" after their dedication links
 * were repaired: the LINK is now right and the TEXT is still crossed.
 *
 * Desc2 is the source every variant is derived from, so a crossed Desc2 keeps
 * re-deriving crossed variants. Fix the text first; the variant sweeps then
 * have something true to read.
 *
 * A line with no `linked_ac_dtlkey` is skipped, never repaired by a guess.
 * Where AutoCount's Desc2 is blank the ERP keeps what it has - this copies a
 * value, it does not erase one.
 *
 *   DATABASE_URL   required
 *   APPLY=1        write. Dry-run otherwise.
 *
 * RE-RUN: convergent. AutoCount's DtlKey is the source and the truth does not move, so a second run writes the same text.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const t = (s) => String(s ?? "").trim();

async function main() {
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-line-desc2.json.gz"))).toString("utf8"));
  const acPo = new Map(snap.po.map((r) => [String(r.k), r.d2]));
  const acSo = new Map(snap.so.map((r) => [String(r.k), r.d2]));
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; AutoCount snapshot ${snap.exportedAt}`);

  const po = await sql`SELECT i.id, p.po_number doc, i.item_code code, i.linked_ac_dtlkey k, i.description2 d2
      FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL`;
  const so = await sql`SELECT i.id, i.doc_no doc, i.item_code code, i.linked_ac_dtlkey k, i.description2 d2
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL`;

  const plan = [];
  for (const [rows, ac, table] of [[po, acPo, "purchase_order_items"], [so, acSo, "mfg_sales_order_items"]]) {
    for (const r of rows) {
      const truth = ac.get(String(r.k));
      if (!truth) continue;                 // AutoCount says nothing; keep ours
      if (t(r.d2) === t(truth)) continue;
      plan.push({ table, ...r, truth });
    }
  }
  log("");
  log(`lines compared  PO ${po.length}  SO ${so.length}`);
  log(`Desc2 that DIFFERS from its own AutoCount line: ${plan.length}`);
  for (const p of plan.slice(0, 20)) {
    log(`  ${p.doc} ${String(p.code).padEnd(20)} key=${p.k}`);
    log(`     ours: ${JSON.stringify(t(p.d2).slice(0, 90))}`);
    log(`     AC  : ${JSON.stringify(t(p.truth).slice(0, 90))}`);
  }
  if (plan.length > 20) log(`  ... and ${plan.length - 20} more`);

  if (!APPLY) { log("\nDRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const u = p.table === "purchase_order_items"
        ? await tx`UPDATE scm.purchase_order_items SET description2 = ${p.truth} WHERE id = ${p.id} RETURNING id`
        : await tx`UPDATE scm.mfg_sales_order_items SET description2 = ${p.truth} WHERE id = ${p.id} RETURNING id`;
      n += u.length;
    }
  });
  log(`APPLIED - ${n} line(s) now carry the Desc2 of the AutoCount line they are.`);
  log("Re-run the variant sweeps afterwards: they derive from this text.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
