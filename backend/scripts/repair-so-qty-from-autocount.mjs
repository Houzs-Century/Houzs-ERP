#!/usr/bin/env node
/* Every migrated sales-order line carries the QUANTITY of the AutoCount line it
 * is - found by its own DtlKey.
 *
 * Owner, 2026-09-07: 不是跟着 AutoCount 吗?  The migration rule is COPY THE BOOK.
 * "Changing a quantity is changing the business" was never his instruction, and
 * a quantity that disagrees with the book is the reason the document totals
 * disagree with the book: 我们的 invoice 等等，全部应该都要跟这 line item 去对比
 * 一样的啊.  Lines first, totals follow.
 *
 * THE DEFECT THIS REPAIRS, traced to its line rather than guessed.
 * `import-ac-outstanding-so.mjs:249` reads
 *
 *     const qty = Math.round(num(l.Qty)) || 1;
 *
 * and `0 || 1` is `1` in JavaScript.  Every AutoCount line the book records at
 * Qty 0 was therefore imported as ONE.  Read against the live book on
 * 2026-09-07, all seven of those lines are zero-priced annotations - DISPOSE
 * REQUEST, TRANSPORTATION CHARGES, a bare "LEG: FOLLOW DISPLAY" note - so the
 * ERP is claiming a unit of goods the book does not order.  The `|| 1` fallback
 * is fixed at the same time so a re-import cannot put it back.
 *
 * WHAT IS NEVER WRITTEN SILENTLY.  A line that has already MOVED - delivered on
 * a live delivery order, or holding an allocated batch - cannot be quietly
 * reduced: the stock came out against the old number.  Where the book's
 * quantity is >= what has already moved the book wins and is written.  Where it
 * is LESS, the line is NAMED with its delivered quantity and left alone; that is
 * a real conflict and the owner rules on it.  It is never folded into a refusal
 * count.
 *
 * MONEY.  `total_sen` / `balance_sen` on the line are `unit_price_sen * qty` -
 * the same derivation the importer used - and the header's `local_total_sen`
 * and its five bucket columns are re-summed from the lines, which is what that
 * column is DEFINED as.  The header's `paid_sen` and `balance_sen` are NOT
 * touched: what the customer paid is a fact about the business, not an
 * arithmetic consequence, so where a corrected total leaves them inconsistent
 * this reports the order and the owner rules on it.
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
  console.error(`APPLY=1 needs CONFIRM="${CONFIRM_PHRASE}". Read the dry-run first: it names every line whose quantity moves, the money each one moves, and the conflicts it refuses to write.`);
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;

/* The header's five bucket columns, by the item_group the line carries. The
   importer folded sofa into the mattress bucket; keep that, or every migrated
   order's buckets move for a reason that has nothing to do with quantity. */
const BUCKET = {
  mattress: "mattress_sofa_sen", sofa: "mattress_sofa_sen", bedframe: "bedframe_sen",
  accessory: "accessories_sen", service: "service_sen", others: "others_sen",
};

async function main() {
  const snapPath = path.join(here, "data", "ac-reconcile-truth.json.gz");
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString("utf8"));
  const li = Object.fromEntries(snap.line_fields.map((f, i) => [f, i]));
  const bookQty = new Map();
  for (const r of snap.types.SO.lines) bookQty.set(String(r[li.dtlKey]), Number(r[li.qty]));
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; AutoCount snapshot ${snap.exported_at}; SO lines in book ${bookQty.size}`);

  /* Every migrated SO line, with what has already MOVED against it: delivered
     quantity on live delivery orders, and whether the allocator has claimed a
     batch. Both are read in SQL so the decision below is made on the database's
     own answer, not on a second round trip that could disagree with it. */
  const rows = await sql`
    SELECT i.id, i.doc_no, i.line_no, i.item_code, i.item_group,
           i.qty::numeric AS qty, i.unit_price_sen::bigint AS up,
           i.total_sen::bigint AS total, i.linked_ac_dtlkey AS k,
           i.allocated_batch_no AS batch,
           COALESCE((SELECT SUM(di.qty) FROM scm.delivery_order_items di
                       JOIN scm.delivery_orders d2 ON d2.id = di.delivery_order_id
                      WHERE di.so_item_id = i.id
                        AND upper(COALESCE(d2.status::text, '')) NOT IN ('CANCELLED','DRAFT')), 0)::numeric AS delivered
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL`;

  const write = [], conflict = [], unknown = [];
  for (const r of rows) {
    const book = bookQty.get(String(r.k));
    if (book === undefined) { unknown.push(r); continue; }
    const cur = Number(r.qty);
    if (Math.round(book) === Math.round(cur)) continue;
    const moved = Number(r.delivered);
    const row = { ...r, cur, book: Math.round(book), moved, batch: r.batch };
    /* The book's number wins unless it is BELOW what already left the building. */
    if (row.book >= moved) write.push(row); else conflict.push(row);
  }

  log("");
  log(`migrated SO lines compared: ${rows.length}${unknown.length ? `; ${unknown.length} carry a DtlKey the book no longer has (left alone)` : ""}`);
  log(`quantity differs from the book: ${write.length + conflict.length}`);
  log("");
  log(`WRITE - the book's quantity, nothing already moved stands in the way: ${write.length}`);
  for (const w of write.sort((a, b) => a.doc_no.localeCompare(b.doc_no))) {
    const delta = (w.book - w.cur) * Number(w.up);
    log(`   ${w.doc_no} line ${w.line_no} key=${w.k} ${String(w.item_code).slice(0, 28).padEnd(28)} ${w.cur} -> ${w.book}` +
        `  unit ${rm(w.up)}  money ${delta === 0 ? "unchanged" : (delta > 0 ? "+" : "") + rm(delta)}` +
        `${w.moved > 0 ? `  [delivered ${w.moved}]` : ""}${w.batch ? `  [batch ${w.batch}]` : ""}`);
  }
  log("");
  log(`NAMED CONFLICT - the book says LESS than has already been delivered. NOT written; the owner rules on each: ${conflict.length}`);
  for (const c of conflict) {
    log(`   ${c.doc_no} line ${c.line_no} key=${c.k} ${c.item_code}  ERP ${c.cur} -> book ${c.book}, but ${c.moved} already DELIVERED${c.batch ? `, batch ${c.batch} allocated` : ""}`);
  }

  /* Which order headers move, and by how much. Printed before any write so the
     money is on the record whether or not APPLY is set. */
  const byDoc = new Map();
  for (const w of write) {
    const d = byDoc.get(w.doc_no) ?? { docNo: w.doc_no, delta: 0, lines: 0 };
    d.delta += (w.book - w.cur) * Number(w.up); d.lines += 1; byDoc.set(w.doc_no, d);
  }
  const moving = [...byDoc.values()].filter((d) => d.delta !== 0);
  log("");
  log(`order headers whose total MOVES: ${moving.length} of ${byDoc.size} touched`);
  for (const m of moving) log(`   ${m.docNo}  ${m.delta > 0 ? "+" : ""}${rm(m.delta)} over ${m.lines} line(s)`);
  log(`net movement across every touched order: ${rm(moving.reduce((t, m) => t + m.delta, 0))}`);

  if (!APPLY) { log(""); log("DRY-RUN - set APPLY=1 to write."); await sql.end(); return; }
  if (write.length === 0) { log(""); log("nothing to write."); await sql.end(); return; }

  const before = new Map();
  for (const d of byDoc.keys()) {
    const [h] = await sql`SELECT local_total_sen::bigint t, paid_sen::bigint p, balance_sen::bigint b
                            FROM scm.mfg_sales_orders WHERE doc_no = ${d}`;
    before.set(d, h);
  }

  let nLines = 0, nHeads = 0;
  await sql.begin(async (tx) => {
    for (const w of write) {
      const total = Math.round(Number(w.up) * w.book);
      const u = await tx`UPDATE scm.mfg_sales_order_items
                            SET qty = ${w.book}, total_sen = ${total}, balance_sen = ${total}
                          WHERE id = ${w.id} RETURNING id`;
      nLines += u.length;
    }
    /* Re-sum each touched header from its OWN lines rather than from the deltas
       above: the header must equal what the table now holds, not what this run
       believes it wrote. */
    for (const d of byDoc.keys()) {
      const lines = await tx`SELECT item_group, total_sen::bigint t FROM scm.mfg_sales_order_items WHERE doc_no = ${d}`;
      const b = { mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, service_sen: 0, others_sen: 0 };
      let total = 0;
      for (const l of lines) {
        total += Number(l.t);
        const col = BUCKET[String(l.item_group)] ?? "others_sen";
        b[col] += Number(l.t);
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
  log(`APPLIED - ${nLines} line(s) now carry the book's quantity; ${nHeads} order total(s) re-summed.`);

  /* Read back on a SECOND connection. The session that wrote is the worst
     witness that the write landed, and a row count is not a shape: this asserts
     what each value now IS - qty is a finite number equal to the book's, and
     the line money is still qty * unit_price. */
  const fresh = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const back = await fresh`
    SELECT i.linked_ac_dtlkey k, i.qty AS q, i.unit_price_sen AS up, i.total_sen AS total
      FROM scm.mfg_sales_order_items i WHERE i.id = ANY(${write.map((w) => w.id)})`;
  const bad = [];
  for (const r of back) {
    const q = Number(r.q), up = Number(r.up), total = Number(r.total);
    const want = bookQty.get(String(r.k));
    if (typeof q !== "number" || !Number.isFinite(q) || Math.round(q) !== Math.round(want)) {
      bad.push(`${r.k}: qty is ${JSON.stringify(r.q)}, book says ${want}`); continue;
    }
    if (total !== Math.round(up * q)) bad.push(`${r.k}: total_sen ${total} is not ${up} x ${q}`);
  }
  log(`read-back on a fresh connection: ${back.length}/${write.length} row(s) returned; ${back.length - bad.length} carry the book's quantity AND a line total that is qty x unit price`);
  for (const b of bad) log(`   WRONG SHAPE ${b}`);
  if (bad.length) { log(`${bad.length} row(s) did NOT land as intended - do not report this run as clean.`); }
  await fresh.end();

  log("");
  log("order totals, and whether paid + balance still add up (the owner's call where they do not):");
  for (const d of byDoc.keys()) {
    const [h] = await sql`SELECT local_total_sen::bigint t, paid_sen::bigint p, balance_sen::bigint b
                            FROM scm.mfg_sales_orders WHERE doc_no = ${d}`;
    const was = before.get(d);
    const consistent = Number(h.t) === Number(h.p) + Number(h.b);
    log(`   ${d}  total ${rm(was.t)} -> ${rm(h.t)}   paid ${rm(h.p)} + balance ${rm(h.b)} ${consistent ? "= total" : `= ${rm(Number(h.p) + Number(h.b))}  <-- NO LONGER EQUALS THE TOTAL`}`);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
