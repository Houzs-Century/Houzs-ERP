#!/usr/bin/env node
/* Every migrated sales-order line carries the UNIT PRICE of the AutoCount line
 * it is - found by its own DtlKey - EXCEPT where the book states no price.
 *
 * Owner: 不是跟着 AutoCount 吗?  and 空白不覆盖. Both rules, and they point in
 * different directions on different lines, which is the whole design here:
 *
 *   book states a price, ours differs   -> COPY. The book is the truth.
 *   book states 0.00, ours has a price  -> LEAVE. A blank never overwrites a
 *                                          value, and the book holding 0.00
 *                                          means it holds no price to copy.
 *
 * WHY THIS EXISTS, and it is not a nicety. `repair-so-qty-from-autocount`
 * (run 34134351163) re-summed each touched order's `local_total_sen` from its
 * lines, which is what that column is defined as. On `HC-SO-004188` that made
 * the order WORSE: the book says 1 x RM 7,988.00 and the ERP line said 2 x
 * RM 3,344.00, so copying the quantity alone left 1 x RM 3,344.00 - further
 * from the book (RM 7,988.00) than the RM 6,688.00 it started at. Quantity and
 * price are one fact about a line and repairing half of it is not half a
 * repair. Ledger: docs/bugs/0670.
 *
 * NEVER COMPUTED. The price written is the book's `UnitPrice` for that DtlKey,
 * read from the reconcile snapshot. Nothing here derives a price from a total,
 * from a sibling line, or from a discount.
 *
 * THE CURRENCY GUARD. A non-MYR document's amounts are NOT comparable to the
 * ERP's, and reading one as a difference is exactly what took RM 13,068.55 off
 * a live purchase order (docs/bugs/0665, 0666). Every such document is SKIPPED
 * and named. The book holds all 13,378 sales orders in MYR today, so this guard
 * is expected to skip nothing - it exists so that stops being an assumption.
 *
 *   DATABASE_URL   required
 *   APPLY=1        write. Dry-run otherwise.
 *   CONFIRM        must equal "I HAVE REVIEWED THE DRY-RUN" to write.
 *
 * RE-RUN: convergent. The book's DtlKey is the source and the truth does not
 * move, so a second run finds nothing to write and says so.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 needs CONFIRM="${CONFIRM_PHRASE}". Read the dry-run first: it names every line whose price moves and the money each one moves.`);
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;

const BUCKET = {
  mattress: "mattress_sofa_sen", sofa: "mattress_sofa_sen", bedframe: "bedframe_sen",
  accessory: "accessories_sen", service: "service_sen", others: "others_sen",
};

async function main() {
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-reconcile-truth.json.gz"))).toString("utf8"));
  const li = Object.fromEntries(snap.line_fields.map((f, i) => [f, i]));
  const hi = Object.fromEntries(snap.header_fields.map((f, i) => [f, i]));

  /* Which sales orders are NOT in MYR. Their amounts are stated in another
     currency and comparing them to the ERP's is the 0665/0666 defect. */
  const foreign = new Set();
  for (const h of snap.types.SO.headers) {
    const c = String(h[hi.currency] ?? "").trim();
    if (c && c !== "MYR") foreign.add(String(h[hi.docNo]));
  }
  const book = new Map();
  for (const r of snap.types.SO.lines) {
    book.set(String(r[li.dtlKey]), {
      docNo: String(r[li.docNo]),
      priceSen: Math.round(Number(r[li.unitPrice]) * 100),
    });
  }
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; AutoCount snapshot ${snap.exported_at}`);
  log(`book: ${book.size} SO lines; ${foreign.size} sales order(s) are NOT in MYR and are skipped wholesale`);

  const rows = await sql`
    SELECT i.id, i.doc_no, i.line_no, i.item_code, i.item_group,
           i.qty::numeric AS qty, i.unit_price_sen::bigint AS up, i.linked_ac_dtlkey AS k
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL`;

  const write = [], held = [], skippedForeign = [];
  for (const r of rows) {
    const b = book.get(String(r.k));
    if (!b) continue;
    const cur = Number(r.up);
    if (b.priceSen === cur) continue;
    if (foreign.has(b.docNo)) { skippedForeign.push({ ...r, cur, book: b.priceSen, ac: b.docNo }); continue; }
    /* 空白不覆盖. The book holding 0.00 is the book holding no price. */
    if (b.priceSen === 0) { held.push({ ...r, cur, book: 0 }); continue; }
    write.push({ ...r, cur, book: b.priceSen });
  }

  log("");
  log(`migrated SO lines compared: ${rows.length}`);
  log(`unit price differs from the book: ${write.length + held.length + skippedForeign.length}`);
  log("");
  log(`WRITE - the book states a price and ours differs: ${write.length}`);
  for (const w of write.sort((a, b) => a.doc_no.localeCompare(b.doc_no))) {
    const delta = (w.book - w.cur) * Number(w.qty);
    log(`   ${w.doc_no} line ${w.line_no} key=${w.k} ${String(w.item_code).slice(0, 26).padEnd(26)} ` +
        `${rm(w.cur)} -> ${rm(w.book)}  x qty ${Number(w.qty)}  money ${delta > 0 ? "+" : ""}${rm(delta)}`);
  }
  log("");
  log(`HELD by 空白不覆盖 - the book states 0.00 and the ERP holds a real price. NOT written: ${held.length}`);
  for (const h of held) {
    log(`   ${h.doc_no} line ${h.line_no} key=${h.k} ${h.item_code}  ERP keeps ${rm(h.cur)}; the book states no price`);
  }
  if (skippedForeign.length) {
    log("");
    log(`SKIPPED, not in MYR - amounts are not comparable: ${skippedForeign.length}`);
    for (const f of skippedForeign) log(`   ${f.doc_no} key=${f.k} (AutoCount ${f.ac})`);
  }

  const byDoc = new Map();
  for (const w of write) {
    const d = byDoc.get(w.doc_no) ?? { delta: 0, lines: 0 };
    d.delta += (w.book - w.cur) * Number(w.qty); d.lines += 1; byDoc.set(w.doc_no, d);
  }
  log("");
  log(`order headers whose total MOVES: ${byDoc.size}`);
  for (const [d, v] of byDoc) log(`   ${d}  ${v.delta > 0 ? "+" : ""}${rm(v.delta)} over ${v.lines} line(s)`);
  log(`net movement: ${rm([...byDoc.values()].reduce((t, v) => t + v.delta, 0))}`);

  if (!APPLY) { log(""); log("DRY-RUN - set APPLY=1 to write."); await sql.end(); return; }
  if (write.length === 0) { log(""); log("nothing to write."); await sql.end(); return; }

  let nLines = 0, nHeads = 0;
  await sql.begin(async (tx) => {
    for (const w of write) {
      const total = Math.round(w.book * Number(w.qty));
      const u = await tx`UPDATE scm.mfg_sales_order_items
                            SET unit_price_sen = ${w.book}, total_sen = ${total}, balance_sen = ${total}
                          WHERE id = ${w.id} RETURNING id`;
      nLines += u.length;
    }
    for (const d of byDoc.keys()) {
      const lines = await tx`SELECT item_group, total_sen::bigint t FROM scm.mfg_sales_order_items WHERE doc_no = ${d}`;
      const b = { mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, service_sen: 0, others_sen: 0 };
      let total = 0;
      for (const l of lines) {
        total += Number(l.t);
        b[BUCKET[String(l.item_group)] ?? "others_sen"] += Number(l.t);
      }
      const u = await tx`UPDATE scm.mfg_sales_orders SET local_total_sen = ${total},
              mattress_sofa_sen = ${b.mattress_sofa_sen}, bedframe_sen = ${b.bedframe_sen},
              accessories_sen = ${b.accessories_sen}, service_sen = ${b.service_sen},
              others_sen = ${b.others_sen}
            WHERE doc_no = ${d} RETURNING doc_no`;
      nHeads += u.length;
    }
  });
  log("");
  log(`APPLIED - ${nLines} line(s) now carry the book's unit price; ${nHeads} order total(s) re-summed.`);

  /* A SECOND connection, asserting the SHAPE rather than counting rows. */
  const fresh = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const back = await fresh`
    SELECT i.linked_ac_dtlkey k, i.unit_price_sen AS up, i.qty AS q, i.total_sen AS total
      FROM scm.mfg_sales_order_items i WHERE i.id = ANY(${write.map((w) => w.id)})`;
  const bad = [];
  for (const r of back) {
    const up = Number(r.up), q = Number(r.q), total = Number(r.total);
    const want = book.get(String(r.k)).priceSen;
    if (typeof up !== "number" || !Number.isFinite(up) || up !== want) {
      bad.push(`${r.k}: unit_price_sen is ${JSON.stringify(r.up)}, book says ${want}`); continue;
    }
    if (total !== Math.round(up * q)) bad.push(`${r.k}: total_sen ${total} is not ${up} x ${q}`);
  }
  log(`read-back on a fresh connection: ${back.length}/${write.length} row(s) returned; ${back.length - bad.length} carry the book's price AND a line total that is qty x unit price`);
  for (const b of bad) log(`   WRONG SHAPE ${b}`);
  await fresh.end();

  log("");
  log("order totals after the write:");
  for (const d of byDoc.keys()) {
    const [h] = await sql`SELECT local_total_sen::bigint t, paid_sen::bigint p, balance_sen::bigint b
                            FROM scm.mfg_sales_orders WHERE doc_no = ${d}`;
    const consistent = Number(h.t) === Number(h.p) + Number(h.b);
    log(`   ${d}  total ${rm(h.t)}   paid ${rm(h.p)} + balance ${rm(h.b)} ${consistent ? "= total" : `= ${rm(Number(h.p) + Number(h.b))}  <-- does not equal the total; the owner's call`}`);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
