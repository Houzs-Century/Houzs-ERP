#!/usr/bin/env node
// READ-ONLY. Everything the three book-model corrections need decided, measured
// on the live database rather than reasoned about.
//
// WHY. The dry run of apply-sofa-compartment-corrections.mjs raised two things a
// model change does that a piece change does not, and neither is visible in the
// corrections file:
//
//   1. THE PAIRING LOSES ITS ANCHOR. `pairRowsToPieces` pairs a row to a target
//      piece by its FULL code. While the model is unchanged every row matches
//      its own compartment exactly and keeps its identity. Change the model and
//      NO code matches, so rows are dealt out in document order instead - and on
//      HC-PO-009550 the document order is 2A(RHF), CNR, 1A(LHF), which would
//      move each compartment onto a different ROW. A sofa is HARD-BOUND: the
//      purchase-order row carries `so_item_id`, the dedication bound-mode
//      readiness reads. Moving compartments across rows without moving the
//      dedications silently mis-pairs them.
//
//   2. THE BUILD MAY NOT BE FINDABLE. HC-SO-012629 and HC-PO-009712 were both
//      reported "no line matches" against the desc2Match in the file, so that
//      entry cannot reach its rows at all today.
//
// It also answers the question the escalation doc left open: the compartment
// SKUs for the TARGET model must exist for every piece, not only the `-1S` the
// coverage probe measured.
//
// Writes nothing, opens no transaction, exits 0 for every legitimate answer.
// RE-RUN: identical output; it is a SELECT-only probe.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The three the owner ruled on, 2026-09-08: the book wins. `book` is the model
   AutoCount's own line carries, via autocount-erp-mapping-1561.csv. */
const CASES = [
  { who: "Tee", so: "HC-SO-010882", poAc: "PO-009550", was: "9058", book: "8030", pieces: ["1A(LHF)", "CNR", "2A(RHF)"] },
  { who: "Sulaiman", so: "HC-SO-011660", poAc: "PO-009017", was: "8030", book: "9058", pieces: ["1B(LHF)", "CNR", "2A(RHF)"] },
  { who: "KONG KIT YING", so: "HC-SO-012629", poAc: "PO-009712", was: "8030", book: "5535", pieces: ["1A(LHF)", "CNR", "2A(RHF)"] },
];

async function main() {
  log(`READ-ONLY probe, company ${CO}`);

  const wanted = [...new Set(CASES.flatMap((c) => c.pieces.map((p) => `${c.book}-${p}`.toUpperCase())))];
  const have = await sql`SELECT upper(code) code, name FROM scm.mfg_products
                          WHERE company_id = ${CO} AND upper(code) = ANY(${wanted})`;
  const haveSet = new Map(have.map((r) => [r.code, r.name]));
  log("");
  log("-- do the TARGET compartment SKUs exist? --");
  for (const w of wanted) log(`  ${haveSet.has(w) ? "yes" : "NO "}  ${w}${haveSet.has(w) ? `   ${haveSet.get(w)}` : ""}`);
  const missing = wanted.filter((w) => !haveSet.has(w));

  for (const c of CASES) {
    log("");
    log(`== ${c.who}  ${c.so}  (book ${c.book}, ERP holds ${c.was}) ==`);

    const soRows = await sql`SELECT i.id, i.line_no, i.item_code, i.qty, i.unit_price_sen, i.total_sen,
                                    i.description, i.description2, i.variants, i.linked_ac_dtlkey
                               FROM scm.mfg_sales_order_items i
                               JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                              WHERE h.company_id = ${CO} AND i.doc_no = ${c.so} AND i.item_group = 'sofa'
                              ORDER BY i.line_no`;
    log(`  sales order: ${soRows.length} sofa line(s)`);
    for (const r of soRows) {
      log(`    line ${r.line_no}  ${r.item_code}  qty ${r.qty}  unit ${r.unit_price_sen}  total ${r.total_sen}  acKey ${r.linked_ac_dtlkey ?? "-"}`);
      log(`        desc2 ${JSON.stringify(r.description2)}`);
    }

    /* Resolve the purchase order the way the applier does: by number, or by the
       AutoCount document it links to - linked_ac_docno survives a renumber. */
    const pos = await sql`SELECT id, po_number, linked_ac_docno FROM scm.purchase_orders
                           WHERE company_id = ${CO} AND (po_number = ${"HC-" + c.poAc} OR linked_ac_docno = ${c.poAc})`;
    log(`  purchase order ${c.poAc}: ${pos.length} match(es) ${pos.map((p) => `${p.po_number} (ac ${p.linked_ac_docno ?? "-"})`).join(", ")}`);
    for (const po of pos) {
      const poRows = await sql`SELECT i.id, i.item_code, i.qty, i.unit_price_sen, i.line_total_sen,
                                      i.so_item_id, i.received_qty, i.description2, i.warehouse_id
                                 FROM scm.purchase_order_items i
                                WHERE i.purchase_order_id = ${po.id} AND i.item_group = 'sofa'
                                ORDER BY i.id`;
      const soById = new Map(soRows.map((r) => [r.id, r]));
      log(`    ${po.po_number}: ${poRows.length} sofa line(s), in id order`);
      for (const r of poRows) {
        const ded = r.so_item_id ? soById.get(r.so_item_id) : null;
        const pair = !r.so_item_id ? "NOT DEDICATED"
          : !ded ? `dedicated to an SO line NOT on ${c.so}`
          : ded.item_code === r.item_code ? `dedicated to SO line ${ded.line_no} (${ded.item_code}) SAME code`
          : `dedicated to SO line ${ded.line_no} (${ded.item_code}) DIFFERENT code`;
        log(`      ${r.item_code}  qty ${r.qty}  recv ${r.received_qty}  unit ${r.unit_price_sen}  total ${r.line_total_sen}  ${pair}`);
        log(`          desc2 ${JSON.stringify(r.description2)}`);
      }
      /* The shuffle the applier would perform TODAY, printed rather than
         predicted: pair by full code first, then hand out leftovers in order. */
      const want = c.pieces.map((p) => `${c.book}-${p}`.toUpperCase());
      const pool = poRows.map((r) => r.item_code);
      const taken = new Set();
      const shuffle = want.map((w) => {
        const i = pool.findIndex((code, ix) => !taken.has(ix) && String(code).toUpperCase() === w);
        if (i >= 0) { taken.add(i); return { w, from: pool[i], exact: true }; }
        return { w, from: null, exact: false };
      });
      let next = 0;
      for (const s of shuffle) {
        if (s.from) continue;
        while (next < pool.length && taken.has(next)) next++;
        if (next < pool.length) { s.from = pool[next]; taken.add(next); }
      }
      const moved = shuffle.filter((s) => s.from && String(s.from).split("-").slice(1).join("-").toUpperCase() !== s.w.split("-").slice(1).join("-").toUpperCase());
      log(`      pairing the applier would do: ${shuffle.map((s) => `${s.from ?? "(insert)"} -> ${s.w}`).join(" | ")}`);
      log(`      compartments that would MOVE ROW: ${moved.length}${moved.length ? " <- this breaks the dedication" : ""}`);
    }
  }

  log("");
  log(missing.length
    ? `VERDICT: ${missing.length} target compartment SKU(s) do not exist: ${missing.join(", ")}`
    : `VERDICT: all ${wanted.length} target compartment SKUs exist.`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
