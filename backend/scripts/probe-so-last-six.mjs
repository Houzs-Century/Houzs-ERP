#!/usr/bin/env node
/* probe-so-last-six — what the ERP actually holds for the last six sales-order
 * differences and the transposed goods receipt.
 *
 * READ-ONLY. Every statement is a SELECT; there is no APPLY flag and no write
 * path. It exists because each of the seven documents has a DIFFERENT cause,
 * and a sweep across mixed causes is how a correct row gets overwritten with a
 * wrong one. Nothing here decides anything: it prints the measured state so the
 * repair for each can be planned against a fact instead of a summary.
 *
 * THE BOOK SIDE IS NOT READ HERE. It is the committed snapshot
 * data/ac-reconcile-truth.json.gz, which this file reads from disk — the live
 * book is reachable only over ZeroTier from the office and a hosted runner has
 * no route to it. What is printed side by side is therefore "the ERP now" and
 * "the snapshot the reconcile compared against", which is exactly the pair the
 * repair has to reconcile.
 *
 * WHY LINE KEYS AND NOT POSITIONS. docs/bugs/0690 is the named class: two
 * similar rows paired by POSITION get swapped, and the swap is invisible
 * because both names look plausible afterwards. Every pairing below is printed
 * with `linked_ac_dtlkey` beside it so the reader can check identity rather
 * than order.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const SOS = ["HC-SO-011099", "HC-SO-005082", "HC-SO-011221", "HC-SO-007293", "HC-SO-012128", "HC-SO-013496"];
const POS = ["HC-PO-009882"];
const GRS = ["HC-GR-005334"];

const p = (m) => console.log(m);
const j = (v) => JSON.stringify(v);
const head = (t) => { p(""); p(`═══════════ ${t} ═══════════`); };

/** Which of these columns the live table really has — the schema has moved. */
async function cols(table) {
  const [schema, name] = table.split(".");
  const rs = await sql`SELECT column_name FROM information_schema.columns
                        WHERE table_schema = ${schema} AND table_name = ${name}`;
  return new Set(rs.map((r) => r.column_name));
}

const book = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-reconcile-truth.json.gz"))));
const LF = book.line_fields, HF = book.header_fields;
const lineObj = (r) => Object.fromEntries(LF.map((k, i) => [k, r[i]]));
const headObj = (r) => Object.fromEntries(HF.map((k, i) => [k, r[i]]));
const desc2Of = (type) => new Map(book.types[type].desc2);

function bookLines(type, docNo) {
  const d2 = desc2Of(type);
  return book.types[type].lines.filter((r) => r[0] === docNo).map(lineObj)
    .map((l) => ({ ...l, desc2: d2.get(l.dtlKey) ?? null }));
}

async function main() {
  p(`probe-so-last-six — company ${CO}`);
  p(`AutoCount snapshot exported_at=${book.exported_at} (${book.source})`);

  /* ── the option catalogue, for HC-SO-013496 ─────────────────────────────── */
  head("THE LIVE SOFA OPTION CATALOGUE (scm.special_addons)");
  const addonCols = await cols("scm.special_addons");
  const addons = await sql`SELECT * FROM scm.special_addons WHERE company_id = ${CO}`;
  const sofaAddons = addons.filter((a) => (a.categories || []).some((c) => /sofa/i.test(String(c))));
  p(`${addons.length} addon row(s) for company ${CO}; ${sofaAddons.length} carry a SOFA category`);
  p(`columns: ${[...addonCols].sort().join(", ")}`);
  /* The PRICE decides which route HC-SO-013496's specials repair may take. A
     FREE option can simply be ticked in variants.specials; a PRICED one cannot
     be stamped there without repricing the document, and the owner's ruling 甲
     of 2026-09-03 is what covers that case — money-neutrally, in its own key.
     (That key is deliberately NOT NAMED anywhere in this file. A guard test in
     backend/tests keeps its spelling out of every file that is not a display
     surface or the backfill, and it scans for the literal string — so writing
     it here, even inside a comment, fails that guard. This probe is neither a
     display surface nor a writer, so it has no business spelling it.) The price
     is therefore printed for every sofa option rather than guessed at. */
  const priceCols = ["selling_price_sen", "cost_price_sen", "price_sen", "unit_price_sen", "amount_sen"]
    .filter((c) => addonCols.has(c));
  p("");
  p("  every SOFA addon whose code or label mentions a backrest, a back cushion or 8030:");
  for (const a of sofaAddons) {
    const t = `${a.code} ${a.label ?? ""}`.toLowerCase();
    if (!/back|8030|cushion|nylon|nilon/.test(t)) continue;
    p(`    code=${j(a.code)}  label=${j(a.label ?? null)}  ${priceCols.map((c) => `${c}=${a[c]}`).join(" ")}  active=${j(a.active ?? null)}  categories=${j(a.categories)}`);
  }
  p("");
  p("  is CHANGE8030BACKREST a live option code at all, in ANY category?");
  const spelt = addons.filter((a) => /change\s*8030|8030\s*back/i.test(`${a.code} ${a.label ?? ""}`));
  p(`    ${spelt.length} row(s): ${spelt.map((a) => j(a.code)).join(", ") || "(none)"}`);

  /* ── the sales orders ───────────────────────────────────────────────────── */
  const soiCols = await cols("scm.mfg_sales_order_items");
  const sohCols = await cols("scm.mfg_sales_orders");
  p("");
  p(`scm.mfg_sales_order_items columns: ${[...soiCols].sort().join(", ")}`);
  p(`scm.mfg_sales_orders columns: ${[...sohCols].sort().join(", ")}`);

  for (const doc of SOS) {
    head(doc);
    const [h] = await sql`SELECT * FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${doc}`;
    if (!h) { p("  NOT IN THE ERP"); continue; }
    const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
    p(`  header: ${j(pick(h, ["doc_no", "status", "doc_date", "currency", "subtotal_sen", "total_sen", "paid_sen", "balance_sen", "linked_ac_docno", "processing_date", "migrated_no_stock", "cancelled_at"]))}`);

    const rows = await sql`SELECT * FROM scm.mfg_sales_order_items
                            WHERE company_id = ${CO} AND doc_no = ${doc} ORDER BY line_no`;
    p(`  ${rows.length} ERP line(s):`);
    for (const r of rows) {
      p(`    line ${r.line_no}  id=${r.id}`);
      p(`      group=${j(r.item_group)} code=${j(r.item_code)} qty=${r.qty} unit=${r.unit_price_sen} total=${r.total_sen} balance=${r.balance_sen}`);
      p(`      dtlkey=${j(r.linked_ac_dtlkey ?? null)} warehouse=${j(r.warehouse_id ?? null)} uom=${j(r.uom ?? null)} location=${j(r.location ?? null)}`);
      p(`      description=${j(r.description)}`);
      p(`      description2=${j(r.description2)}`);
      p(`      variants=${j(r.variants)}`);
      if ("custom_specials" in r) p(`      custom_specials=${j(r.custom_specials)}`);
      const [{ n: nPo }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_order_items WHERE so_item_id = ${r.id}`;
      const [{ n: nDo }] = await sql`SELECT COUNT(*)::int n FROM scm.delivery_order_items WHERE so_item_id = ${r.id}`;
      p(`      downstream: ${nPo} PO line(s), ${nDo} DO line(s)`);
      if (nPo) {
        const ps = await sql`SELECT i.id, i.item_code, i.linked_ac_dtlkey, p.po_number, i.received_qty
                               FROM scm.purchase_order_items i
                               JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
                              WHERE i.so_item_id = ${r.id}`;
        for (const x of ps) p(`        PO ${x.po_number} line ${x.id} ${j(x.item_code)} dtlkey=${j(x.linked_ac_dtlkey ?? null)} received=${x.received_qty}`);
      }
    }
    const ac = doc.replace(/^HC-/, "");
    const bl = bookLines("SO", ac);
    p(`  ${bl.length} BOOK line(s) (snapshot):`);
    for (const l of bl) p(`    dtl ${l.dtlKey} seq ${l.seq} item=${j(l.itemKey)} qty=${l.qty} unit=${l.unitPrice} sub=${l.subTotal} desc2=${j(l.desc2)}`);
    const [bh] = book.types.SO.headers.filter((r) => r[0] === ac).map(headObj);
    p(`  BOOK header: ${j(bh ?? null)}`);
    const mv = await sql`SELECT COUNT(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${doc}`;
    p(`  inventory movements naming this document: ${mv[0].n}`);
  }

  /* ── the purchase order behind HC-SO-011099 ─────────────────────────────── */
  for (const doc of POS) {
    head(doc);
    const ac = doc.replace(/^HC-/, "");
    const [h] = await sql`SELECT * FROM scm.purchase_orders
                           WHERE company_id = ${CO} AND (po_number = ${doc} OR linked_ac_docno = ${ac}) LIMIT 1`;
    if (!h) { p("  NOT IN THE ERP by number or AutoCount link"); continue; }
    p(`  header: po_number=${j(h.po_number)} status=${j(h.status)} linked_ac_docno=${j(h.linked_ac_docno ?? null)}`);
    const rows = await sql`SELECT * FROM scm.purchase_order_items WHERE purchase_order_id = ${h.id} ORDER BY id`;
    p(`  ${rows.length} ERP line(s):`);
    for (const r of rows) {
      p(`    id=${r.id} group=${j(r.item_group)} code=${j(r.item_code)} qty=${r.qty} unit=${r.unit_price_sen} total=${r.line_total_sen} received=${r.received_qty}`);
      p(`      dtlkey=${j(r.linked_ac_dtlkey ?? null)} so_item_id=${j(r.so_item_id ?? null)} warehouse=${j(r.warehouse_id ?? null)}`);
      p(`      description2=${j(r.description2)}`);
      p(`      variants=${j(r.variants)}`);
      const [{ n }] = await sql`SELECT COUNT(*)::int n FROM scm.grn_items WHERE purchase_order_item_id = ${r.id}`;
      p(`      GRN lines hanging off it: ${n}`);
    }
    const bl = bookLines("PO", ac);
    p(`  ${bl.length} BOOK line(s):`);
    for (const l of bl) p(`    dtl ${l.dtlKey} item=${j(l.itemKey)} qty=${l.qty} unit=${l.unitPrice} desc2=${j(l.desc2)}`);
  }

  /* ── the transposed goods receipt ───────────────────────────────────────── */
  const grCols = await cols("scm.grn_items");
  head("scm.grn_items columns");
  p([...grCols].sort().join(", "));

  for (const doc of GRS) {
    head(doc);
    const ac = doc.replace(/^HC-/, "");
    /* An AutoCount receipt can span several purchase orders, and the ERP holds
       one goods receipt per purchase order — so the ERP number may carry a
       `-PO-nnnnnn` suffix. Match the PREFIX, never an exact string. */
    const grns = await sql`SELECT g.* FROM scm.grns g
                            JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
                           WHERE p.company_id = ${CO} AND g.grn_number LIKE ${doc + "%"}
                           ORDER BY g.grn_number`;
    p(`  ${grns.length} ERP goods receipt(s) whose number starts ${doc}`);
    for (const g of grns) {
      const [po] = await sql`SELECT po_number FROM scm.purchase_orders WHERE id = ${g.purchase_order_id}`;
      p(`  ── ${g.grn_number}  po=${j(po?.po_number)} migrated_no_stock=${j(g.migrated_no_stock ?? null)} status=${j(g.status)} total=${g.total_sen}`);
      const items = await sql`SELECT * FROM scm.grn_items WHERE grn_id = ${g.id} ORDER BY id`;
      for (const r of items) {
        p(`     id=${r.id} code=${j(r.item_code)} name=${j(r.material_name)} qty_recv=${r.qty_received} unit=${r.unit_price_sen}`);
        p(`       dtlkey=${j(r.linked_ac_dtlkey ?? null)} po_item=${j(r.purchase_order_item_id ?? null)}`);
        p(`       description2=${j(r.description2)}`);
        if (r.purchase_order_item_id) {
          const [pi] = await sql`SELECT i.id, i.item_code, i.linked_ac_dtlkey, i.description2, p.po_number
                                   FROM scm.purchase_order_items i
                                   JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
                                  WHERE i.id = ${r.purchase_order_item_id}`;
          if (pi) {
            p(`       its PO line: ${pi.po_number} ${j(pi.item_code)} dtlkey=${j(pi.linked_ac_dtlkey ?? null)}`);
            p(`         PO description2=${j(pi.description2)}`);
          }
        }
      }
      const mv = await sql`SELECT COUNT(*)::int n FROM scm.inventory_movements
                            WHERE company_id = ${CO} AND source_doc_no = ${g.grn_number}`;
      p(`     inventory movements naming ${g.grn_number}: ${mv[0].n}`);
    }
    const bl = bookLines("GR", ac);
    p(`  ${bl.length} BOOK line(s):`);
    for (const l of bl) p(`    dtl ${l.dtlKey} seq ${l.seq} item=${j(l.itemKey)} qty=${l.qty} unit=${l.unitPrice} fromPO=${j(l.fromDocNo)} desc2=${j(l.desc2)}`);
  }

  /* ── are the piece SKUs a repair would need actually minted? ────────────── */
  head("PIECE SKUs A REPAIR WOULD NEED");
  const wanted = ["9028-2S", "9028-1A(LHF)", "9028-1A(RHF)", "9028-2A(LHF)", "9028-L(RHF)",
    "2379-1S", "2379-2S", "2379-3S", "9058-1S", "5530-2S"];
  for (const w of wanted) {
    const [hit] = await sql`SELECT code, name FROM scm.mfg_products
                             WHERE company_id = ${CO} AND upper(code) = ${w.toUpperCase()} LIMIT 1`;
    p(`  ${w}: ${hit ? `MINTED as ${j(hit.code)} (${j(hit.name)})` : "NOT MINTED"}`);
  }
  /* HC-SO-012128's missing book line names a pillow; a line cannot be created
     for a product the catalogue does not hold. */
  /* scm.mfg_products has no item_group column — measured, run 34243496074,
     which died here on `column "item_group" does not exist` AFTER printing
     everything above it. Read what the table has instead of what a sibling
     table has. */
  const prodCols = await cols("scm.mfg_products");
  p(`  scm.mfg_products columns: ${[...prodCols].sort().join(", ")}`);
  const pillows = await sql`SELECT code, name FROM scm.mfg_products
                             WHERE company_id = ${CO} AND upper(code) LIKE '%PILLOW%' ORDER BY code`;
  p(`  pillow products in the catalogue: ${pillows.length}`);
  for (const x of pillows.slice(0, 30)) p(`    ${j(x.code)} ${j(x.name)}`);

  await sql.end();
  p("");
  p("probe complete — nothing was written.");
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
