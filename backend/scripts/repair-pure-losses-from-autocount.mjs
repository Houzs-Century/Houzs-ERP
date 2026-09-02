#!/usr/bin/env node
/* Copy back the values the importers lost. Every one is a straight read of the
 * AutoCount line this row IS, found by its own DtlKey - no inference, no
 * sibling match, no aggregate.
 *
 * Owner: 以 AutoCount 为准，最准.
 *
 * THE FOUR LOSSES, each traced to the line of code that caused it:
 *
 *   delivery date   `import-ac-outstanding-po.mjs` reads `l.DelivDate` in three
 *                   places; the export column is `DeliveryDate`. The read
 *                   silently yields undefined. This is the owner's own
 *                   screenshot question - "delivery date 全部没带来?" - and the
 *                   SECOND time this key rename has cost data.
 *   received qty    `import-ac-so-linked-pos.mjs:167` wrote the export's
 *                   `GrQty`, which `export-received-pos-live.py` computes as
 *                   SUM over (DocNo, ItemCode). On a document holding two lines
 *                   of one code, every line got the document's total. AutoCount
 *                   never permits an over-receipt; we manufactured it. The
 *                   truth is `PODTL.TransferedQty`, per line.
 *   quantity        `Math.round(num(l.Qty)) || 1`. Zero is falsy in JavaScript,
 *                   so a deliberate zero-quantity line was ordered once.
 *
 * WHY THIS ONLY WORKS NOW. Each repair has to find THIS line in AutoCount, and
 * `linked_ac_dtlkey` covered 280 of 873 purchase-order lines until
 * backfill-po-ac-dtlkey.mjs derived 281 more from AutoCount's own FromSODtlKey.
 * A line with no key is REPORTED, never repaired by a guess.
 *
 * It writes only where the ERP disagrees with AutoCount, and it never writes a
 * value AutoCount does not state. Money is untouched: quantity changes are
 * reported with their line, not silently repriced.
 *
 *   DATABASE_URL   required
 *   APPLY=1        write. Dry-run otherwise.
 *
 * RE-RUN: convergent against ONE snapshot — a second run over the same file
 * writes nothing new. But the snapshot's values DO move in the book between
 * days (TransferedQty rises as goods arrive), so a fresh-enough snapshot is a
 * precondition, enforced below (docs/bugs/0560).
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
const day = (v) => (v == null ? null : String(v).slice(0, 10));

async function main() {
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-line-truth.json.gz"))).toString("utf8"));
  /* The snapshot's VALUES move in the book every day — TransferedQty rises as
     goods arrive. On 2026-08-28 this file's mtime was that day (a checkout)
     while its exportedAt was 2026-08-11, and the dry-run proposed resetting
     five correctly-imported received quantities to a 17-day-old zero
     (docs/bugs/0560). A repair copying "AutoCount's own value" is only faithful
     while the copy is fresh; the file's generator is not in the tree, so a
     stale file cannot be quietly refreshed either. */
  const ageDays = (Date.now() - new Date(snap.exportedAt).getTime()) / 86400000;
  if (!(ageDays <= 2)) {
    log(`REFUSED: ac-line-truth.json.gz was exported ${snap.exportedAt} (${ageDays.toFixed(1)} days ago).`);
    log(`Its values (received qty, delivery dates) move in the book daily; repairing from a stale copy overwrites correct data with old data. Re-export the snapshot first.`);
    await sql.end();
    process.exit(2);
  }
  const acPo = new Map(snap.po.map((r) => [String(r.k), r]));
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; AutoCount snapshot ${snap.exportedAt}, ${snap.po.length} PO lines`);

  const po = await sql`SELECT i.id, p.po_number doc, i.item_code code, i.linked_ac_dtlkey k,
                              i.delivery_date::text dd, i.qty, i.received_qty
      FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = 1`;

  const dates = [], recv = [], qty = [];
  let unkeyed = 0, unmatched = 0;
  for (const r of po) {
    if (!r.k) { unkeyed++; continue; }
    const a = acPo.get(String(r.k));
    if (!a) { unmatched++; continue; }
    if (!r.dd && a.deliveryDate) dates.push({ ...r, to: a.deliveryDate });
    const acQty = Math.round(a.qty), acRecv = Math.round(a.transferedQty);
    if (Number(r.qty) !== acQty) qty.push({ ...r, to: acQty });
    if (Number(r.received_qty ?? 0) !== acRecv) recv.push({ ...r, to: acRecv });
  }

  log("");
  log(`purchase-order lines ${po.length}; no AutoCount key ${unkeyed}; key not in the snapshot ${unmatched}`);
  log(`  delivery date to COPY BACK   ${dates.length}`);
  log(`  received qty to CORRECT      ${recv.length}   (AutoCount's own TransferedQty, per line)`);
  log(`  quantity to CORRECT          ${qty.length}`);
  for (const d of dates.slice(0, 8)) log(`   date ${d.doc} ${String(d.code).padEnd(20)} -> ${d.to}`);
  for (const d of recv.slice(0, 12)) log(`   recv ${d.doc} ${String(d.code).padEnd(20)} ${d.received_qty} -> ${d.to}`);
  for (const d of qty) log(`   qty  ${d.doc} ${String(d.code).padEnd(20)} ${d.qty} -> ${d.to}`);

  if (!APPLY) { log("\nDRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  let nd = 0, nr = 0, nq = 0;
  await sql.begin(async (tx) => {
    for (const d of dates) {
      const u = await tx`UPDATE scm.purchase_order_items SET delivery_date = ${d.to}::date
                          WHERE id = ${d.id} AND delivery_date IS NULL RETURNING id`;
      nd += u.length;
    }
    for (const d of recv) {
      const u = await tx`UPDATE scm.purchase_order_items SET received_qty = ${d.to}
                          WHERE id = ${d.id} RETURNING id`;
      nr += u.length;
    }
    for (const d of qty) {
      const u = await tx`UPDATE scm.purchase_order_items SET qty = ${d.to}
                          WHERE id = ${d.id} RETURNING id`;
      nq += u.length;
    }
    /* AutoCount never permits an over-receipt, so after copying its own numbers
       there must be none here either. This is the defect that started the whole
       fidelity check; if it survives the repair, the repair is wrong. */
    const over = await tx`SELECT COUNT(*)::int c FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
       WHERE p.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL
         AND COALESCE(i.received_qty,0) > i.qty`;
    log(`over-receipt check on keyed lines after the repair: ${over[0].c}`);
  });
  log(`APPLIED - delivery dates ${nd}, received quantities ${nr}, quantities ${nq}.`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
