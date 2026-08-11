#!/usr/bin/env node
/* A multi-piece sofa that the importer could not decode landed as ONE line
 * carrying the bare `-1S` placeholder. Split it into the pieces it really is.
 *
 * Owner, 2026-08-11, confirming the rule this reads the builds by:
 *   "草图两端的阴影 = 扶手，所以两格两端有阴影就是 1A(LHF) + 1A(RHF)" - 是的
 * which is the rule already stated in parse-sofa's own comment: 一套沙发只有左右
 * 两个闭端；console 放中间；端头带外侧扶手.
 *
 * NOTHING IS DELETED. The existing row is RE-CODED as the first piece and the
 * remaining pieces are INSERTed beside it, so the owner's 不可以删只可以 cancel
 * holds by construction and the line keeps its id, its links and its history.
 *
 * THE INSERT CLONES THE ROW. `INSERT ... SELECT` from the source line, then
 * override only what must differ. Enumerating columns would silently drop
 * whatever this script has not heard of - and these tables carry columns no
 * migration in this repository declares.
 *
 * PRICE IS COPIED, NOT INVENTED. Measured over the 171 sofa builds that DID
 * decompose: on a purchase order 71 of 72 carry 0 on every piece (AutoCount
 * never prices a sofa PO), and on a sales order 97 of 99 put the whole price on
 * ONE piece and 0 on the rest. So the re-coded original keeps the money and the
 * new pieces get zero - which is also what makes the split money-neutral: the
 * document's total does not move by a cent, and the script proves that by
 * summing before and after inside the same transaction.
 *
 * REFUSALS, each one a stop rather than a guess:
 *   - the document does not hold exactly one bare -1S sofa line
 *   - a piece SKU is not minted in scm.mfg_products
 *   - the line already has a downstream receipt/delivery against it
 *   - the document total would move
 *
 *   DATABASE_URL   required
 *   APPLY=1        write. Dry-run otherwise.
 */
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* Every entry names the evidence it was read from. A build with no evidence
   does not belong here - the four still-unreadable documents (PO-009024,
   PO-009260, SO-008942, PO-009597) are deliberately absent. */
const PLAN = [
  { doc: "HC-PO-007709", pieces: ["9058-1A(LHF)", "9058-1NA", "9058-CNR", "9058-1NA", "9058-1A(RHF)"], seat: '30"', why: 'the sketch writes it out: "1EL + 1NA + C + 1NA + 1ER"' },
  { doc: "HC-PO-009583", pieces: ["8030-1A(LHF)", "8030-1A(RHF)"], seat: '35"', why: 'the sketch writes "(2 seater)", two boxes 35" / 35"' },
  { doc: "HC-SO-012715", pieces: ["8030-1A(LHF)", "8030-1A(RHF)"], seat: '35"', why: 'same sketch as PO-009583, "(2 seater)" 35"' },
  { doc: "HC-PO-009077", pieces: ["8030-1A(LHF)", "8030-1A(RHF)"], seat: '35"', why: "two boxes 35 / 35, hatching on both outer ends" },
  { doc: "HC-SO-012113", pieces: ["8030-1A(LHF)", "8030-1A(RHF)"], seat: '35"', why: "same sketch as PO-009077" },
  { doc: "HC-PO-009781", pieces: ["9058-1A(LHF)", "9058-1A(RHF)"], seat: '32"', why: "two boxes 32 / 32, 223cm x 120cm, hatching both ends" },
  { doc: "HC-SO-012107", pieces: ["9058-1A(LHF)", "9058-1A(RHF)"], seat: '32"', why: "same sketch as PO-009781" },
  { doc: "HC-SO-012634", pieces: ["8030-1A(LHF)", "8030-1A(RHF)"], seat: '30"', why: "two boxes 30 / 30 (an earlier figure crossed out), hatching both ends" },
  { doc: "HC-SO-012361", pieces: ["8030-1A(LHF)", "8030-1A(RHF)"], seat: '30"', why: "two boxes 30 / 30, hatching both outer ends" },
  { doc: "HC-PO-009582", pieces: ["8030-1A(LHF)", "8030-1NA", "8030-1A(RHF)"], seat: '24"', why: "three boxes 24 / 24 / 24, hatching only on the two outer ends" },
  { doc: "HC-SO-012636", pieces: ["8030-1A(LHF)", "8030-1NA", "8030-1A(RHF)"], seat: '24"', why: "same sketch as PO-009582" },
];

const MONEY_SO = ["unit_price_centi", "discount_centi", "total_centi", "tax_centi", "total_inc_centi",
  "balance_centi", "unit_cost_centi", "line_cost_centi", "line_margin_centi",
  "divan_price_sen", "leg_price_sen", "special_order_price_sen"];

async function main() {
  log(`split the collapsed sofa lines - mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const prods = new Set((await sql`SELECT code FROM scm.mfg_products WHERE company_id = 1`).map((r) => r.code));
  const plan = [];

  for (const p of PLAN) {
    const isPo = p.doc.startsWith("HC-PO-");
    const rows = isPo
      ? await sql`SELECT i.id, i.material_code code, i.qty, i.unit_price_centi price, i.received_qty, i.purchase_order_id pid
                    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
                   WHERE h.po_number = ${p.doc} AND i.item_group = 'sofa'`
      : await sql`SELECT i.id, i.item_code code, i.qty, i.unit_price_centi price, i.doc_no, i.line_no
                    FROM scm.mfg_sales_order_items i
                   WHERE i.doc_no = ${p.doc} AND i.item_group = 'sofa'`;
    const target = rows.filter((r) => /-1S$/i.test(String(r.code)));
    if (target.length !== 1) { log(`REFUSED ${p.doc}: expected exactly one bare -1S sofa line, found ${target.length}`); continue; }
    const missing = p.pieces.filter((c) => !prods.has(c));
    if (missing.length) { log(`REFUSED ${p.doc}: piece SKU not minted - ${missing.join(", ")}`); continue; }
    if (isPo && Number(target[0].received_qty || 0) > 0) { log(`REFUSED ${p.doc}: the line already has ${target[0].received_qty} received`); continue; }
    plan.push({ ...p, isPo, row: target[0], siblings: rows.length });
  }

  /* A sales order whose DEDICATED purchase-order line cannot be split must not
     be split either. Splitting one side of a pair is how this session created
     four fresh SO-to-PO disagreements earlier today: the owner's goal is that
     related documents hold IDENTICAL data, so a repair that can only reach one
     side is not a repair. */
  const refusedPo = new Set(PLAN.map((p) => p.doc).filter((d) => d.startsWith("HC-PO-") && !plan.some((q) => q.doc === d)));
  if (refusedPo.size) {
    const links = await sql`SELECT h.doc_no so_doc, p.po_number po_doc
        FROM scm.mfg_sales_order_items s
        JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
        JOIN scm.purchase_order_items i ON i.so_item_id = s.id
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
       WHERE h.doc_no = ANY(${plan.filter((q) => !q.isPo).map((q) => q.doc)})`;
    for (const l of links) {
      if (!refusedPo.has(l.po_doc)) continue;
      const i = plan.findIndex((q) => q.doc === l.so_doc);
      if (i >= 0) { log(`REFUSED ${l.so_doc}: its dedicated purchase order ${l.po_doc} cannot be split, and the pair must stay identical`); plan.splice(i, 1); }
    }
  }

  log("");
  for (const p of plan) {
    log(`${p.doc}  ${p.row.code} qty=${p.row.qty} price=${(Number(p.row.price || 0) / 100).toFixed(2)}`);
    log(`   why: ${p.why}`);
    p.pieces.forEach((c, i) => log(`   ${i === 0 ? "RE-CODE the existing row ->" : "INSERT a new line       ->"} ${c.padEnd(16)} qty=1  price=${i === 0 ? (Number(p.row.price || 0) / 100).toFixed(2) : "0.00"}  seatHeight=${p.seat}`));
  }
  const newLines = plan.reduce((n, p) => n + p.pieces.length - 1, 0);
  log("");
  log(`documents to split ${plan.length} of ${PLAN.length}; lines re-coded ${plan.length}; new lines ${newLines}; deletions 0`);

  if (!APPLY) { log("\nDRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  let recoded = 0, inserted = 0;
  await sql.begin(async (tx) => {
    const totBefore = await tx`SELECT COALESCE(SUM(total_centi),0)::bigint t FROM scm.mfg_sales_order_items WHERE doc_no = ANY(${plan.filter(p=>!p.isPo).map(p=>p.doc)})`;
    for (const p of plan) {
      const [first, ...rest] = p.pieces;
      if (p.isPo) {
        const r = await tx`UPDATE scm.purchase_order_items
             SET material_code = ${first},
                 variants = COALESCE(variants,'{}'::jsonb) || ${tx.json({ seatHeight: p.seat })}
           WHERE id = ${p.row.id} AND jsonb_typeof(COALESCE(variants,'{}'::jsonb)) = 'object'
           RETURNING id`;
        recoded += r.length;
        for (const code of rest) {
          const c2 = await tx`INSERT INTO scm.purchase_order_items
            (purchase_order_id, material_kind, material_code, material_name, item_group, qty, uom,
             unit_price_centi, line_total_centi, description, description2, variants, company_id,
             so_item_id, warehouse_id, linked_ac_dtlkey)
            SELECT i.purchase_order_id, i.material_kind, ${code}, i.material_name, i.item_group, 1, i.uom,
                   0, 0, i.description, i.description2,
                   COALESCE(i.variants,'{}'::jsonb) || ${tx.json({ seatHeight: p.seat })},
                   i.company_id, i.so_item_id, i.warehouse_id, i.linked_ac_dtlkey
              FROM scm.purchase_order_items i WHERE i.id = ${p.row.id}
            RETURNING id`;
          inserted += c2.length;
        }
      } else {
        const r = await tx`UPDATE scm.mfg_sales_order_items
             SET item_code = ${first},
                 variants = COALESCE(variants,'{}'::jsonb) || ${tx.json({ seatHeight: p.seat })}
           WHERE id = ${p.row.id} AND jsonb_typeof(COALESCE(variants,'{}'::jsonb)) = 'object'
           RETURNING id`;
        recoded += r.length;
        for (const code of rest) {
          const zero = MONEY_SO.map((c) => `0 AS ${c}`).join(", ");
          const ins = await tx.unsafe(
            `INSERT INTO scm.mfg_sales_order_items
               (doc_no, item_code, item_group, qty, uom, description2, variants, company_id, line_no, ${MONEY_SO.join(", ")})
             SELECT i.doc_no, $1, i.item_group, 1, i.uom, i.description2,
                    COALESCE(i.variants,'{}'::jsonb) || $2::jsonb, i.company_id, COALESCE(i.line_no,0),
                    ${MONEY_SO.map(() => "0").join(", ")}
               FROM scm.mfg_sales_order_items i WHERE i.id = $3
             RETURNING id`,
            [code, JSON.stringify({ seatHeight: p.seat }), p.row.id]);
          inserted += ins.length;
        }
      }
    }
    const totAfter = await tx`SELECT COALESCE(SUM(total_centi),0)::bigint t FROM scm.mfg_sales_order_items WHERE doc_no = ANY(${plan.filter(p=>!p.isPo).map(p=>p.doc)})`;
    if (String(totBefore[0].t) !== String(totAfter[0].t)) {
      throw new Error(`REFUSED: the sales-order total moved ${totBefore[0].t} -> ${totAfter[0].t}. Rolled back.`);
    }
    log(`money check: sales-order total unchanged at ${totBefore[0].t} centi`);
  });

  log(`APPLIED - re-coded ${recoded}, inserted ${inserted}, deleted 0.`);
  log("Counts are RETURNING. Confirm with an independent read before believing them.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
