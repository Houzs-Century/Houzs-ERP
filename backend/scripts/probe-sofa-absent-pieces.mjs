#!/usr/bin/env node
/* READ-ONLY. For a build the chain audit called PIECE ABSENT, put every piece
 * of evidence about it on ONE screen, so the question "is the sales order right
 * or is the purchase order right?" can be answered from the BOOK's own text and
 * the slip PHOTO rather than by asking the owner one document at a time.
 *
 * WHY THIS EXISTS. check-sofa-chain-alignment.mjs splits a SO -> PO piece
 * mismatch by cause. UNDER-LINKED is a missing dedication and needs no drawing.
 * PIECE ABSENT means the lacked piece is not on that purchase order at all —
 * and its own header records the blind spot this script closes:
 *
 *     "the check looks only at the purchase orders the build's linked lines
 *      came from, so a piece could be sitting on a DIFFERENT purchase order."
 *
 * So a piece is NEVER called absent here until it has been looked for across
 * EVERY company-1 purchase order. Section C is that wider search, and it is the
 * whole reason this is a separate script and not another log line.
 *
 * WHAT IT PRINTS, per sales order:
 *   A  the sales-order build   — every line, its code, seat, colour, quantity,
 *      whether it is cancelled, its AutoCount DtlKey, its Desc2, and HOW MANY
 *      slip photos the line carries (the photo is the drawing).
 *   B  the purchase order(s) its lines are dedicated to — every line, dedicated
 *      or not, so an under-linked piece is visible as such.
 *   C  THE WIDE SEARCH. For each piece the purchase order lacks: every
 *      purchase-order line on company 1 carrying that item code, with its
 *      document, its dedication and whether that document quotes the same
 *      AutoCount sales order. A piece found here is NOT absent — it is on
 *      another document, and that is a different repair.
 *   D  the DECODE. parse-sofa.mjs — the same decoder both importers use — run
 *      over the sales-order line's own Desc2, so the book's text can be
 *      compared with what the two documents ended up holding. Printed as a
 *      MULTISET comparison, because line order is not the physical layout.
 *
 * IT DECIDES NOTHING AND WRITES NOTHING. No UPDATE, no INSERT, no DDL, no
 * transaction. Where the decoder is not confident it says so; this migration
 * copies and decodes, it never guesses (docs/bugs, "migration copies, never
 * computes").
 *
 *   DATABASE_URL   required
 *   COMPANY        default 1
 *   DOCS           comma-separated sales orders; defaults to the 10 the
 *                  2026-09-07 audit (run 34134017406) left as PIECE ABSENT
 *                  after the 9 wrong-bed dedications are excluded
 *
 * RE-RUN: idempotent and side-effect free.
 */
import postgres from "postgres";

import { buildFabricColourIndex } from "./lib/fabric-colour-match.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { pieceCodes } from "./lib/redecode-sofa-plan.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);

/* The PIECE ABSENT set of run 34134017406, minus the nine bedframe builds whose
   cause is already traced to a wrong dedication (docs/bugs/0671-*). Those are
   somebody else's repair and re-reading their drawings would answer a question
   that is not open. */
const DEFAULT_DOCS = [
  "HC-SO-011008", "HC-SO-011099", "HC-SO-012277", "HC-SO-012949", "HC-SO-013000",
  "HC-SO-013312", "HC-SO-013320", "HC-SO-013328", "HC-SO-013384", "HC-SO-013385",
];
const DOCS = (process.env.DOCS || "").trim()
  ? process.env.DOCS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_DOCS;

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const K = (s) => String(s ?? "").trim().toUpperCase();
const modelOf = (code) => {
  const c = K(code);
  const d = c.indexOf("-");
  const base = d < 0 ? c : c.slice(0, d);
  return SOFA_MODEL_ALIAS[base] || base;
};
const compOf = (code) => {
  const c = K(code);
  const d = c.indexOf("-");
  return d < 0 ? "" : c.slice(d + 1);
};
const vget = (v, k) => {
  const x = (v || {})[k];
  return x === undefined || x === null || String(x).trim() === "" ? null : String(x).trim();
};
/* EVERY axis, not a chosen four. Whether two same-code lines are truly
   interchangeable is decided by the axes nobody remembered to print. */
const axes = (v) => Object.keys(v || {}).sort()
  .map((k) => (vget(v, k) ? `${k}=${vget(v, k)}` : null)).filter(Boolean).join(" ") || "(no axes)";

/** Parent has X the child lacks / child has Y the parent never had. Multiset. */
function multisetDiff(a0, b0) {
  const a = a0.map(K).sort(); const b = b0.map(K).sort();
  if (a.join("|") === b.join("|")) return null;
  const pb = [...b]; const pa = [...a];
  const lacks = []; for (const x of a) { const i = pb.indexOf(x); if (i < 0) lacks.push(x); else pb.splice(i, 1); }
  const extra = []; for (const x of b) { const i = pa.indexOf(x); if (i < 0) extra.push(x); else pa.splice(i, 1); }
  return { lacks, extra };
}

async function main() {
  log(`READ-ONLY sofa/bedframe PIECE-ABSENT evidence - company ${CO}, ${DOCS.length} sales order(s)`);
  log("Nothing is written. Section C searches EVERY company-1 purchase order before a piece is called absent.");

  /* One pull of the whole company-1 purchase-order side. The wide search needs
     it, and pulling it once beats a query per missing piece. */
  const allPo = await sql`
    SELECT i.id::text AS id, p.po_number AS doc, p.linked_ac_docno AS ac, UPPER(COALESCE(p.status::text,'')) AS status,
           i.item_code AS code, i.item_group AS grp, i.qty, i.received_qty, i.so_item_id::text AS so_item_id,
           i.description2 AS d2, i.variants, i.linked_ac_dtlkey::text AS dtl,
           COALESCE(array_length(i.photo_urls, 1), 0) AS pics
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group IN ('sofa','bedframe')`;

  const soOfPoItem = new Map();
  const dedicated = allPo.filter((r) => r.so_item_id);
  if (dedicated.length) {
    const rows = await sql`
      SELECT i.id::text AS id, i.doc_no AS doc, i.item_code AS code
        FROM scm.mfg_sales_order_items i
       WHERE i.id::text = ANY(${dedicated.map((r) => r.so_item_id)})`;
    for (const r of rows) soOfPoItem.set(r.id, r);
  }

  const products = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const knownCode = new Set(products.map((p) => K(p.code)));
  /* The SAME predicate import-ac-outstanding-so.mjs hands the decoder. Without
     it a colour-first Desc2 reads its own fabric code as an unknown STRUCTURE
     token and the whole build decodes to nothing - which would make this probe
     report a false "cannot read". */
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };
  log(`masters: ${products.length} product codes, ${fcRows.length} fabric colours`);

  const summary = [];

  for (const doc of DOCS) {
    log("");
    log(`################ ${doc}`);
    const hdr = await sql`SELECT doc_no, UPPER(COALESCE(status::text,'')) AS status, linked_ac_docno AS ac,
                                 proceeded_at, debtor_name
                            FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${doc}`;
    if (!hdr.length) { log(`  no such sales order on company ${CO}`); summary.push({ doc, verdict: "NO SUCH DOCUMENT" }); continue; }
    const h = hdr[0];
    log(`  status ${h.status} · AutoCount ${h.ac ?? "(none)"} · proceeded ${h.proceeded_at ?? "(not proceeded)"} · ${h.debtor_name ?? ""}`);

    const soRows = await sql`
      SELECT i.id::text AS id, i.line_no, i.item_code AS code, i.item_group AS grp, i.qty, i.cancelled,
             i.description2 AS d2, i.variants, i.linked_ac_dtlkey::text AS dtl, i.remark,
             COALESCE(array_length(i.photo_urls, 1), 0) AS pics, i.photo_urls
        FROM scm.mfg_sales_order_items i
       WHERE i.company_id = ${CO} AND i.doc_no = ${doc}
       ORDER BY i.line_no`;

    log("");
    log("  --- A. the SALES ORDER build");
    for (const r of soRows) {
      log(`    ${String(r.line_no).padStart(3)}  ${String(r.code).padEnd(24)} qty ${r.qty}${r.cancelled ? "  CANCELLED" : ""}  ${axes(r.variants)}  dtl=${r.dtl ?? "-"}  photos=${r.pics}`);
      if (r.d2) log(`         Desc2: ${String(r.d2).replace(/\n/g, " | ")}`);
      for (const u of r.photo_urls ?? []) log(`         PHOTO ${u}`);
    }

    /* The build under test: the sofa/bedframe lines of this document, keyed the
       way the chain audit keys them (document + model + Desc2). */
    const live = soRows.filter((r) => !r.cancelled && (r.grp === "sofa" || r.grp === "bedframe"));
    if (!live.length) { log("  no live sofa/bedframe line here"); summary.push({ doc, verdict: "NO SOFA LINE" }); continue; }
    const grp = live[0].grp;
    const model = modelOf(live[0].code);
    const pieceOf = (code) => (grp === "sofa" ? compOf(code) : K(code));

    const linkedPo = allPo.filter((r) => r.so_item_id && live.some((s) => s.id === r.so_item_id));
    const poDocs = [...new Set(linkedPo.map((r) => r.doc))];
    log("");
    log(`  --- B. the PURCHASE ORDER(S) its lines are dedicated to: ${poDocs.join(", ") || "(none)"}`);
    const onThosePo = allPo.filter((r) => poDocs.includes(r.doc));
    for (const r of onThosePo) {
      const t = r.so_item_id ? soOfPoItem.get(r.so_item_id) : null;
      log(`    ${r.doc}  ${String(r.code).padEnd(24)} qty ${r.qty} recv ${r.received_qty}  ${axes(r.variants)}  dtl=${r.dtl ?? "-"}  photos=${r.pics}  -> ${t ? `${t.doc} ${t.code}` : "(NOT DEDICATED)"}`);
      if (r.d2) log(`         Desc2: ${String(r.d2).replace(/\n/g, " | ")}`);
    }

    const soPieces = live.map((r) => pieceOf(r.code));
    const poPieces = onThosePo.filter((r) => poDocs.includes(r.doc) && r.so_item_id && live.some((s) => s.id === r.so_item_id)).map((r) => pieceOf(r.code));
    const d = multisetDiff(soPieces, poPieces);
    log("");
    log(`    SO pieces: ${soPieces.join("+")}`);
    log(`    PO pieces (dedicated to this build): ${poPieces.join("+") || "(none)"}`);
    log(`    PO lacks: ${d ? (d.lacks.join(", ") || "(none)") : "(nothing - the two agree)"}`);

    log("");
    log("  --- C. THE WIDE SEARCH - is the lacked piece on ANY other purchase order?");
    const found = [];
    const stillAbsent = [];
    for (const want of d ? d.lacks : []) {
      const wantCode = grp === "sofa" ? `${model}-${want}` : want;
      const hits = allPo.filter((r) => pieceOf(r.code) === want || K(r.code) === K(wantCode));
      const onOurs = hits.filter((r) => poDocs.includes(r.doc));
      const elsewhere = hits.filter((r) => !poDocs.includes(r.doc));
      log(`    piece ${want}  (code ${wantCode}): ${hits.length} purchase-order line(s) on company ${CO} carry it`);
      for (const r of onOurs) {
        const t = r.so_item_id ? soOfPoItem.get(r.so_item_id) : null;
        log(`        SAME PO   ${r.doc}  qty ${r.qty}  -> ${t ? `${t.doc} ${t.code}` : "(NOT DEDICATED)"}`);
      }
      for (const r of elsewhere.slice(0, 8)) {
        const t = r.so_item_id ? soOfPoItem.get(r.so_item_id) : null;
        log(`        OTHER PO  ${r.doc} (AutoCount ${r.ac ?? "-"}) qty ${r.qty}  -> ${t ? `${t.doc} ${t.code}` : "(NOT DEDICATED)"}${t && t.doc === doc ? "   <-- DEDICATED TO THIS VERY SALES ORDER" : ""}`);
      }
      if (elsewhere.length > 8) log(`        ... and ${elsewhere.length - 8} more elsewhere`);
      const here = elsewhere.some((r) => { const t = r.so_item_id ? soOfPoItem.get(r.so_item_id) : null; return t && t.doc === doc; });
      if (here) { found.push(want); log(`        VERDICT: NOT absent - a purchase line for this piece is dedicated to THIS sales order on a different purchase order.`); }
      else if (onOurs.some((r) => !r.so_item_id)) { found.push(want); log(`        VERDICT: NOT absent - it is on the same purchase order, undedicated.`); }
      else { stillAbsent.push(want); log(`        VERDICT: no purchase line for this piece is dedicated to this sales order anywhere on company ${CO}.`); }
    }
    if (!d) log("    (nothing lacked)");

    log("");
    log("  --- D. THE DECODE - parse-sofa.mjs over the book's own Desc2");
    const seen = new Set();
    for (const r of live) {
      const key = `${modelOf(r.code)}|${K(r.d2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (grp !== "sofa") { log(`    ${r.code}: bedframe - the compartment grammar does not apply, the whole code is the piece`); continue; }
      const ps = parseSofa(r.d2, modelOf(r.code), false, { knownColour });
      const codes = pieceCodes(modelOf(r.code), ps.pieces);
      const unknown = codes.filter((c) => !knownCode.has(K(c)));
      log(`    from line ${r.line_no} Desc2: pieces [${ps.pieces.join(", ") || "(none)"}]  confidence ${ps.conf}`);
      if (ps.why?.length) log(`         why: ${ps.why.join("; ")}`);
      if (ps.size) log(`         seat size: ${ps.size}`);
      if (ps.color) log(`         colour: ${ps.color}`);
      if (ps.specials?.length) log(`         specials: ${ps.specials.join(" | ")}`);
      if (unknown.length) log(`         codes the product master does NOT have: ${unknown.join(", ")}`);
      const vsSo = multisetDiff(ps.pieces.map((p) => K(p)), soPieces);
      const vsPo = multisetDiff(ps.pieces.map((p) => K(p)), poPieces);
      log(`         decode vs SALES ORDER:    ${vsSo ? `SO lacks ${vsSo.lacks.join(", ") || "(none)"} / SO has extra ${vsSo.extra.join(", ") || "(none)"}` : "IDENTICAL"}`);
      log(`         decode vs PURCHASE ORDER: ${vsPo ? `PO lacks ${vsPo.lacks.join(", ") || "(none)"} / PO has extra ${vsPo.extra.join(", ") || "(none)"}` : "IDENTICAL"}`);
    }

    summary.push({
      doc, grp, model,
      lacked: d ? d.lacks : [],
      foundElsewhere: found,
      stillAbsent,
      photos: soRows.reduce((a, r) => a + Number(r.pics || 0), 0),
    });
  }

  log("");
  log("================ SUMMARY");
  for (const s of summary) {
    if (s.verdict) { log(`  ${s.doc}: ${s.verdict}`); continue; }
    log(`  ${s.doc}  ${s.grp} ${s.model}  lacked ${s.lacked.length} [${s.lacked.join(", ")}]`
      + `  found elsewhere ${s.foundElsewhere.length}  STILL ABSENT ${s.stillAbsent.length} [${s.stillAbsent.join(", ")}]`
      + `  slip photos on the sales order: ${s.photos}`);
  }
  const absent = summary.filter((s) => !s.verdict && s.stillAbsent.length);
  log(`  ${absent.length} of ${summary.length} sales order(s) still have at least one piece no purchase order anywhere carries for them.`);
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
