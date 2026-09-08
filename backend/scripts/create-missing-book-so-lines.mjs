#!/usr/bin/env node
/* Create the sales-order lines the ACCOUNT BOOK states and the ERP does not
 * hold.
 *
 * 「简单来说都要跟Autocount一样啊」 / 「包括每个 line 都是要一样的」 — the owner,
 * 2026-09-08. Every writer in this repo UPDATES lines; none of them creates one,
 * so a book line we simply do not have had no route to the ERP at all and sat in
 * the reconcile's "AutoCount line with no ERP line" column run after run.
 *
 * ── WHAT IT MAY CREATE, AND WHAT IT REFUSES ─────────────────────────────────
 * The allow-list is data/missing-book-so-lines.json: one entry per AutoCount
 * line, named by DocNo and DtlKey, with the reason it is allowed. NOTHING about
 * the line is written in that file. The item, the quantity, the money, the text
 * and the delivery date all come from the committed snapshot
 * data/ac-reconcile-truth.json.gz — the same snapshot the reconcile compares
 * against — so this is a copy of the book, never an invention. 「migration
 * copies, never computes」.
 *
 *   THE MONEY MAY NOT MOVE. The order's header total was imported from the
 *   book's own total, so creating a PRICED line would leave the lines and the
 *   header disagreeing and would move a document total that reads 0 differences
 *   today. A book line whose unit price or subtotal is not zero is REFUSED and
 *   named. That refusal is why this is an allow-list and not a sweep.
 *
 *   A ROW THAT NAMES NOTHING IS NOT CREATED. 「删掉啊 没写的也删掉」 (owner,
 *   2026-09-08) — a book row with no item code, no description, no build text
 *   and no money is nothing, and nothing does not become a line.
 *
 *   THE PRODUCT MUST ALREADY EXIST. The AutoCount code is resolved through
 *   data/autocount-erp-mapping-1561.csv, the sheet the importer itself used, and
 *   then looked up in scm.mfg_products. A code the catalogue does not hold is a
 *   refusal — this script does not mint SKUs.
 *
 *   STOCK IS NOT TOUCHED, AND THAT IS ASSERTED. 「库存先不看」. A sales-order
 *   line is demand, not stock: it writes no inventory movement and none is
 *   implied. The run counts scm.inventory_movements naming the document before
 *   and after and REFUSES if the number moves.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────────
 * One row in scm.mfg_sales_order_items, shaped exactly as
 * import-ac-outstanding-so.mjs shapes a line of that item group, plus
 * scm.mfg_sales_orders.line_count brought up to the number of lines the
 * document now holds — the header's own count is a fact about the lines and a
 * stale one reads as a missing line all over again.
 *
 * `linked_ac_dtlkey` IS THE LINE'S IDENTITY and is stamped from the book, not
 * left null: a keyless line is invisible to the reconcile and takes the whole
 * document's line identity away from the next operator edit
 * (src/scm/lib/autocount-line-keys.ts:155).
 *
 * MODE=plan by default (any value but `apply` plans). MODE=apply additionally
 * needs CONFIRM="I HAVE REVIEWED THE PLAN". Each line is its own transaction,
 * and the run ends by re-reading every touched document on a FRESH connection
 * and asserting the SHAPE — the line's item, quantity, money and key, the
 * document's total unchanged, and the movement count unchanged. Not a row
 * count: a row count is what passed while the shape was wrong (docs/bugs, the
 * jsonb double-encoding repair).
 *
 * RE-RUN: inert. A document already carrying a line with that DtlKey is
 * reported as `already present` and nothing is inserted, so a second run
 * creates no duplicate and writes nothing at all.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = String(process.env.MODE || "plan").trim().toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE PLAN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM="${CONFIRM_PHRASE}". Nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const ONLY = (process.env.DOC || "").trim();

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
/* Two LITERAL clients, deliberately not one factory. The writer's own session
   is the worst witness that its write landed, so the verification below opens
   its own — and writing `postgres(` at both sites is what makes that visible to
   a reader and to check-release-discipline.mjs alike. */
const PG = { ssl: "require", prepare: false, max: 1 };
const sql = postgres(DST, PG);

/* AutoCount's category -> our item_group. The SAME table
   import-ac-outstanding-so.mjs uses (`CATG`, :72), because a second hand-copy of
   a mapping is the drift this repo keeps paying for. */
const CATG = {
  MATTRESS: "mattress", BEDFRAME: "bedframe", ACC: "accessory", ACCESSORY: "accessory",
  BEDLINES: "accessory", DIFFUSER: "others", CARPET: "others", DINING: "others",
  OTHER: "others", SERVICE: "service", TRANS: "service", SOFA: "sofa",
};
const uomOf = (g) => (g === "bedframe" ? "SET" : "UNIT");
const sen = (v) => Math.round(Number(v || 0) * 100);

const book = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-reconcile-truth.json.gz"))));
const LF = book.line_fields, HF = book.header_fields;
const lineObj = (r) => Object.fromEntries(LF.map((k, i) => [k, r[i]]));
const headObj = (r) => Object.fromEntries(HF.map((k, i) => [k, r[i]]));
const SO_DESC2 = new Map(book.types.SO.desc2);

const list = JSON.parse(fs.readFileSync(path.join(here, "data", "missing-book-so-lines.json"), "utf8"));
const mapping = readMappingCsv(fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8"));

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"} company=${CO}${ONLY ? ` DOC=${ONLY}` : ""}`);
  log(`AutoCount snapshot exported_at=${book.exported_at}`);
  log(`allow-list: ${list.entries.length} line(s)`);

  let nMade = 0, nAlready = 0, nRefused = 0;
  const verify = [];

  for (const e of list.entries) {
    if (ONLY && e.doc !== ONLY) continue;
    const acDoc = e.doc.replace(/^HC-/, "");
    const key = String(e.dtlKey).trim();
    const refuse = (why) => { log(`  ${e.doc} dtl ${key}: REFUSED — ${why}`); nRefused++; };

    const bl = book.types.SO.lines.filter((r) => r[0] === acDoc).map(lineObj).find((l) => String(l.dtlKey) === key);
    if (!bl) { refuse(`the snapshot holds no line ${key} on ${acDoc}`); continue; }
    const d2 = SO_DESC2.get(key) ?? null;
    const [bh] = book.types.SO.headers.filter((r) => r[0] === acDoc).map(headObj);

    /* 「删掉啊 没写的也删掉」 — a row that names nothing is nothing. */
    const namesSomething = String(bl.itemKey || "").trim() !== "" || String(d2 || "").trim() !== "";
    if (!namesSomething) { refuse("the book row states no item code and no text — the owner's ruling says that is nothing, not a line"); continue; }

    /* THE MONEY MAY NOT MOVE. */
    const up = sen(bl.unitPrice), sub = sen(bl.subTotal);
    if (up !== 0 || sub !== 0) {
      refuse(`the book line carries money (unit ${up}, subtotal ${sub}) and the header total was imported from the book, so creating it would move a document total that reads 0 differences today`);
      continue;
    }

    const m = mapping.get(normCode(bl.itemKey));
    if (!m || !m.erp) { refuse(`the mapping sheet does not resolve ${JSON.stringify(bl.itemKey)} to an ERP code`); continue; }
    const [prod] = await sql`SELECT code, name FROM scm.mfg_products
                              WHERE company_id = ${CO} AND upper(code) = ${String(m.erp).trim().toUpperCase()} LIMIT 1`;
    if (!prod) { refuse(`${JSON.stringify(bl.itemKey)} maps to ${JSON.stringify(m.erp)}, which the catalogue does not hold`); continue; }

    const [hdr] = await sql`SELECT doc_no, total_sen, line_count FROM scm.mfg_sales_orders
                             WHERE company_id = ${CO} AND doc_no = ${e.doc}`;
    if (!hdr) { refuse(`${e.doc} is not in the ERP`); continue; }

    const rows = await sql`SELECT id, line_no, item_code, qty, linked_ac_dtlkey, uom, location, warehouse_id, line_delivery_date
                             FROM scm.mfg_sales_order_items
                            WHERE company_id = ${CO} AND doc_no = ${e.doc} ORDER BY line_no`;
    if (rows.some((r) => String(r.linked_ac_dtlkey ?? "").trim() === key)) {
      log(`  ${e.doc} dtl ${key}: already present — nothing to do`);
      nAlready++;
      continue;
    }
    if (!rows.length) { refuse(`${e.doc} holds no lines at all — a document with nothing on it is not a missing-line case`); continue; }

    const grp = CATG[String(m.cat || "").trim().toUpperCase()] || "others";
    const qty = Math.round(Number(bl.qty || 0));
    if (!(qty > 0)) { refuse(`the book line states quantity ${JSON.stringify(bl.qty)}`); continue; }

    /* `uom`, `location`, `warehouse_id` and the delivery date are COPIED from a
       sibling line of the same document. They are properties of the ORDER, the
       lead already holds them, and a line that lands with warehouse_id NULL can
       never match stock — it stays PENDING for ever and reads as "the system did
       not capture it" (the 2026-08-11 round produced seven of those). */
    const src = rows[0];
    const lineNo = Math.max(...rows.map((r) => Number(r.line_no) || 0)) + 1;
    const movesBefore = (await sql`SELECT COUNT(*)::int n FROM scm.inventory_movements
                                    WHERE company_id = ${CO} AND source_doc_no = ${e.doc}`)[0].n;

    log(`  ${e.doc} dtl ${key}: ADD line ${lineNo}  ${grp}  ${JSON.stringify(prod.code)} x${qty} @ RM 0.00`);
    log(`      description2 = ${JSON.stringify(d2)}`);
    log(`      book says the document holds ${bh?.lineCount ?? "?"} line(s); the ERP holds ${rows.length} and will hold ${rows.length + 1}`);
    log(`      header total stays ${hdr.total_sen} (the line carries no money); inventory movements naming it: ${movesBefore}`);
    log(`      why: ${e.why}`);

    verify.push({
      doc: e.doc, key, code: prod.code, qty, grp, d2,
      total: Number(hdr.total_sen), moves: movesBefore, lines: rows.length + 1,
    });

    if (!APPLY) continue;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO scm.mfg_sales_order_items
        (doc_no, line_no, item_group, item_code, description, description2, uom, location, warehouse_id,
         qty, unit_price_sen, total_sen, balance_sen, company_id, remark, line_delivery_date, linked_ac_dtlkey)
        VALUES (${e.doc}, ${lineNo}, ${grp}, ${prod.code}, ${prod.name ?? prod.code}, ${d2},
                ${src.uom ?? uomOf(grp)}, ${src.location ?? null}, ${src.warehouse_id ?? null},
                ${qty}, 0, 0, 0, ${CO},
                ${"created from AutoCount " + acDoc + " line " + key + " (2026-09-08)"},
                ${src.line_delivery_date ?? null}, ${Number(key)})`;
      /* The header's own count is a fact about the lines. A stale one reads as
         a missing line all over again, which is the report this run is closing. */
      await tx`UPDATE scm.mfg_sales_orders SET line_count = (
                 SELECT COUNT(*)::int FROM scm.mfg_sales_order_items
                  WHERE company_id = ${CO} AND doc_no = ${e.doc})
               WHERE company_id = ${CO} AND doc_no = ${e.doc}`;
    });
    nMade++;
  }

  log("");
  log(`lines created ${nMade} · already present ${nAlready} · refused ${nRefused}`);
  await sql.end();
  if (!APPLY) { log("\nPLAN — set MODE=apply to write."); return; }
  await verifyOnFreshConnection(verify);
}

/**
 * Re-read every touched document on a NEW connection and assert the SHAPE: the
 * line is there, carrying the book's item, quantity, key and text, at zero
 * money; the document's total did not move; and no inventory movement appeared.
 * A row count is not a shape.
 */
async function verifyOnFreshConnection(items) {
  if (!items.length) return;
  const v = postgres(DST, PG);
  log(`\nVERIFY — re-reading ${items.length} document(s) on a fresh connection`);
  let bad = 0;
  for (const it of items) {
    const [h] = await v`SELECT total_sen, line_count FROM scm.mfg_sales_orders
                         WHERE company_id = ${CO} AND doc_no = ${it.doc}`;
    const rows = await v`SELECT item_code, qty, unit_price_sen, total_sen, description2, item_group, linked_ac_dtlkey, warehouse_id
                           FROM scm.mfg_sales_order_items
                          WHERE company_id = ${CO} AND doc_no = ${it.doc} ORDER BY line_no`;
    const mine = rows.filter((r) => String(r.linked_ac_dtlkey ?? "").trim() === it.key);
    const moves = (await v`SELECT COUNT(*)::int n FROM scm.inventory_movements
                            WHERE company_id = ${CO} AND source_doc_no = ${it.doc}`)[0].n;
    const say = [];
    if (mine.length !== 1) say.push(`${mine.length} line(s) carry DtlKey ${it.key}, expected exactly 1`);
    else {
      const r = mine[0];
      if (String(r.item_code).toUpperCase() !== String(it.code).toUpperCase()) say.push(`item ${r.item_code}, expected ${it.code}`);
      if (Number(r.qty) !== it.qty) say.push(`qty ${r.qty}, expected ${it.qty}`);
      if (Number(r.unit_price_sen) !== 0 || Number(r.total_sen) !== 0) say.push(`money ${r.unit_price_sen}/${r.total_sen}, expected 0/0`);
      if (String(r.description2 ?? "") !== String(it.d2 ?? "")) say.push("description2 is not the book's text");
      if (String(r.item_group) !== it.grp) say.push(`group ${r.item_group}, expected ${it.grp}`);
      if (r.warehouse_id == null) say.push("warehouse_id is NULL — the line can never match stock");
    }
    if (Number(h?.total_sen) !== it.total) say.push(`document total ${h?.total_sen}, expected ${it.total} — MONEY MOVED`);
    if (Number(h?.line_count) !== it.lines) say.push(`header line_count ${h?.line_count}, expected ${it.lines}`);
    if (moves !== it.moves) say.push(`inventory movements ${moves}, expected ${it.moves} — STOCK MOVED`);
    if (!say.length) { log(`  OK  ${it.doc}  ${it.code} x${it.qty} @ 0  total ${h.total_sen}  lines ${h.line_count}  movements ${moves}`); continue; }
    bad++;
    for (const s of say) log(`  FAIL ${it.doc}: ${s}`);
  }
  await v.end();
  if (bad) { console.error(`VERIFY FAILED on ${bad} document(s)`); process.exit(1); }
  log(`VERIFY OK — ${items.length} document(s): the line, its key, its zero money, the document total and the movement count`);
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
