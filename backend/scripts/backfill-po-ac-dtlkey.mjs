#!/usr/bin/env node
/* Give a purchase-order line its AutoCount line key, derived from AutoCount's
 * own link rather than from a (document, ItemCode) join.
 *
 * WHY THIS IS THE UNLOCK. Every "copy the value AutoCount already holds" repair
 * still owed - the 101 lost delivery dates, the over-received quantities, the
 * quantity AutoCount records as 0 - has to find THIS line in AutoCount first.
 * Only 280 of 873 purchase-order lines carry `linked_ac_dtlkey`, which is why a
 * delivery-date repair keyed on it reaches 20 of 119. The rest cannot be
 * repaired faithfully until they can be identified faithfully.
 *
 * THE DERIVATION, and why it is a copy and not a guess:
 *
 *     our PO line -> so_item_id -> that SO line's linked_ac_dtlkey
 *                 -> the AutoCount PODTL row whose FromSODtlKey IS that key
 *                 -> that row's DtlKey
 *
 * `FromSODtlKey` is the one line-to-line link AutoCount populates, so this
 * follows AutoCount's own pointer backwards. It never joins on ItemCode to
 * CHOOSE a row - it uses the item code only to REFUSE one, which is the
 * opposite direction and cannot invent a match.
 *
 * Three refusals: the derived key is not unique, the key already belongs to
 * another line here, or AutoCount's row carries a different item code than the
 * supplier code we recorded.
 *
 * A key only: no value written, no money, no stock. Measured before writing:
 * 281 recoverable, 0 ambiguous.
 *
 *   DATABASE_URL   required
 *   APPLY=1        write. Dry-run otherwise.
 *
 * RE-RUN: inert. The UPDATE itself re-asserts linked_ac_dtlkey IS NULL, so a stamped line is never restamped.
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
const norm = (s) => String(s ?? "").trim().toUpperCase();

async function main() {
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-po-fromsodtlkey.json.gz"))).toString("utf8"));
  const byFrom = new Map();
  for (const r of snap.rows) {
    const k = String(r.FromSODtlKey);
    if (!byFrom.has(k)) byFrom.set(k, []);
    byFrom.get(k).push(r);
  }
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; AutoCount snapshot ${snap.exportedAt}, ${snap.rows.length} PO lines carry a FromSODtlKey`);

  const po = await sql`SELECT i.id, p.po_number doc, i.material_code code, i.supplier_sku,
                              i.linked_ac_dtlkey k, i.so_item_id
      FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = 1`;
  const so = new Map((await sql`SELECT i.id, i.linked_ac_dtlkey k FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL`).map((r) => [r.id, String(r.k)]));
  const taken = new Set(po.filter((r) => r.k).map((r) => String(r.k)));

  const plan = [];
  let ambiguous = 0, alreadyTaken = 0, codeMismatch = 0, docMismatch = 0, noPath = 0;
  for (const r of po) {
    if (r.k) continue;
    const sk = r.so_item_id ? so.get(r.so_item_id) : null;
    if (!sk) { noPath++; continue; }
    const cand = byFrom.get(sk) || [];
    if (cand.length !== 1) { if (cand.length) ambiguous++; else noPath++; continue; }
    const ac = cand[0];
    if (taken.has(String(ac.DtlKey))) { alreadyTaken++; continue; }
    /* The item code REFUSES a match, it never chooses one. Our supplier_sku is
       the AutoCount code we recorded at import; where we have it and it
       disagrees, the derivation is not trustworthy for this line. */
    if (r.supplier_sku && norm(r.supplier_sku) !== norm(ac.ItemCode)) { codeMismatch++; continue; }
    /* Independent confirmation that costs nothing: the AutoCount row this
       derivation lands on must belong to the SAME purchase order. Our numbering
       is AutoCount's own number with an HC- prefix, so the two must agree, and
       they are reached by completely different routes - ours through the
       dedication link, this through the document number. */
    if (norm(ac.DocNo) !== norm(r.doc).replace(/^HC-/, "")) { docMismatch++; continue; }
    taken.add(String(ac.DtlKey));
    plan.push({ id: r.id, doc: r.doc, code: r.code, key: ac.DtlKey, acDoc: ac.DocNo, acCode: ac.ItemCode });
  }

  log("");
  log(`purchase-order lines            ${po.length}`);
  log(`  already keyed                 ${po.filter((r) => r.k).length}`);
  log(`  KEY RECOVERED                 ${plan.length}`);
  log(`  no path (no dedication / key) ${noPath}`);
  log(`  refused, ambiguous            ${ambiguous}`);
  log(`  refused, key already used     ${alreadyTaken}`);
  log(`  refused, item code disagrees  ${codeMismatch}`);
  log(`  refused, WRONG DOCUMENT       ${docMismatch}`);
  for (const p of plan.slice(0, 10)) log(`   ${p.doc} ${String(p.code).padEnd(22)} -> DtlKey ${p.key} (AC ${p.acDoc} ${p.acCode})`);
  if (plan.length > 10) log(`   ... and ${plan.length - 10} more`);

  if (!APPLY) { log("\nDRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const u = await tx`UPDATE scm.purchase_order_items SET linked_ac_dtlkey = ${p.key}
                          WHERE id = ${p.id} AND linked_ac_dtlkey IS NULL RETURNING id`;
      n += u.length;
    }
    /* A key must identify ONE line. A duplicate would make every later repair
       write the same AutoCount value onto two different rows. */
    const dup = await tx`SELECT COUNT(*)::int c FROM (
        SELECT i.linked_ac_dtlkey FROM scm.purchase_order_items i
          JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
         WHERE p.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL
         GROUP BY i.linked_ac_dtlkey HAVING COUNT(*) > 1) d`;
    if (dup[0].c) throw new Error(`REFUSED: ${dup[0].c} AutoCount keys would identify more than one line. Rolled back.`);
    log(`uniqueness check: 0 duplicate AutoCount keys`);
  });
  log(`APPLIED - keyed ${n}. A key only: no value, no money, no stock.`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
