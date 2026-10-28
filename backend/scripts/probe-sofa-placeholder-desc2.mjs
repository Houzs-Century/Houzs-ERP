#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. Why is a sofa line still sitting on a bare `-1S` placeholder?
//
// `check-sofa-bedframe-completeness.mjs` counts them — 126 sales-order lines on
// 122 documents with ALL_SO=1 (prod, company 1, run 33653494144) — and stops at
// the count, because it has no reason to print the text. So the number has never
// had a CAUSE attached to it, and "126 lines need a human with the photograph"
// and "126 lines the decoder could read if it knew one more spelling" are the
// same number until somebody looks.
//
// This looks. For every line the importer fell back on (`remark` carries
// `SOFA UNPARSED` and the code's compartment is the bare `1S`), it re-runs the
// REAL decoder — `lib/parse-sofa.mjs`, with the live `scm.fabric_colours` index
// wired in as `knownColour` exactly as `import-ac-outstanding-so.mjs:177` does —
// over the Desc2 the row holds TODAY, and buckets the outcome:
//
//   A  the text carries no build at all (colour / size / instructions only)
//      -> only the photograph can answer this. Not a decoder defect.
//   B  the decoder REJECTED a token and named it
//      -> a spelling. Every distinct token is listed with its count, which is
//         the actionable list: one grammar arm each.
//   C  the split guard fired (the structure looked spread across segments)
//   D  the grammar held it as genuinely ambiguous (an arm mid-row, "2L" beside
//      other pieces) -> a judgement, photo-verify
//   E  it DECODES, but a piece SKU is not minted in scm.mfg_products
//      -> a catalogue gap, not a decoder defect
//   F  it DECODES CLEANLY TODAY -> the decoder has already learned this since the
//      row was written; it needs a re-run, not a fix
//
// And, independently: does the OTHER side of the pair carry the build? A sofa
// SO line and the PO raised from it describe one build, and the two Desc2 are
// typed separately — so a line blank on one side can be readable on the other.
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Document numbers,
// models and the Desc2 build text only — that text is a build spec plus a fabric
// code, the same shape `check-sofa-bedframe-completeness.mjs` already prints. No
// customer, no address, no amount.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction, and deliberately no
// APPLY input.
//
//   DATABASE_URL   required
//   COMPANY        default 1
//   ALL_SO         "1" (default) = every sales order, not only the proceeded ones
//   SHOW           how many example lines to print per side (default 200)
//
// RE-RUN: idempotent and side-effect free.
// ----------------------------------------------------------------------------
import postgres from "postgres";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex } from "./lib/fabric-colour-match.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("DATABASE_URL required"); process.exit(2); }
/* An input a workflow does not pass arrives as "", not as undefined, so every
   default below has to be `||` and never `??` (PR #2896 paid for this one). */
const CO = Number(process.env.COMPANY || 1);
const ALL_SO = (process.env.ALL_SO || "1") === "1";
const SHOW = Number(process.env.SHOW || 200);
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const PDATE = soProcessingDateFragment(sql);

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const modelOf = (code) => {
  const c = norm(code);
  const dash = c.indexOf("-");
  const base = dash < 0 ? c : c.slice(0, dash);
  return SOFA_MODEL_ALIAS[base] || base;
};
const compartmentOf = (code) => {
  const c = norm(code);
  const dash = c.indexOf("-");
  return dash < 0 ? "" : c.slice(dash + 1);
};
/* One line per record, so a run is greppable. The floor separates instructions
   with newlines and that matters to a reader, so keep them visible as \n. */
const oneLine = (s) => String(s ?? "").replace(/\r/g, "").replace(/\n/g, "\\n").replace(/[ \t]+/g, " ").trim();

/* The importer's own placeholder test, restated: it wrote `SOFA UNPARSED` into
   the remark AND opened the line on `{model}-1S`. Both halves are required —
   a genuine one-seater is also `-1S` and is not a placeholder. This is the same
   predicate check-sofa-bedframe-completeness.mjs uses to reach 126. */
const isPlaceholder = (r) => /SOFA UNPARSED/.test(r.remark || "") && /^1S$/i.test(compartmentOf(r.code));

function classify(ps, allExist) {
  const why = ps.why.filter((w) => !/^note "/.test(w));
  const tok = why.map((w) => /^token "(.*)"$/.exec(w)).find(Boolean);
  if (ps.pieces.length && ps.conf !== "low") {
    return allExist
      ? { bucket: "F decodes cleanly TODAY — the decoder has already learned it", token: null }
      : { bucket: "E decodes, but a piece SKU is not minted", token: null };
  }
  if (tok) return { bucket: "B a token the decoder rejected", token: tok[1] };
  if (why.some((w) => /structure split across segments/.test(w))) return { bucket: "C the split guard fired", token: null };
  if (why.some((w) => /empty Desc2/.test(w))) return { bucket: "A1 Desc2 is empty", token: null };
  if (why.some((w) => /\u770B\u56FE|\u6B67\u4E49/.test(w))) return { bucket: "D the grammar held it as ambiguous", token: null };
  if (why.some((w) => /no structure tokens/.test(w))) return { bucket: "A2 the text carries no build at all", token: null };
  return { bucket: "A3 nothing decoded and no reason recorded", token: null };
}

async function main() {
  log(`READ-ONLY sofa "-1S" placeholder Desc2 probe — company ${CO}, ALL_SO=${ALL_SO ? 1 : 0}`);

  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => norm(p.code)));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const reclOf = (m) => RECL.some((s) => codeSet.has(norm(m + s)));

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  // exactly the predicate import-ac-outstanding-so.mjs:177 hands the decoder
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };
  log(`masters: ${codeSet.size} product codes, ${fcRows.length} fabric colours`);

  const soRows = await sql`
    SELECT i.id::text AS id, h.doc_no AS doc, i.item_code AS code, i.description2 AS d2,
           i.remark, i.cancelled
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group = 'sofa'
       AND (${ALL_SO} OR h.${PDATE} IS NOT NULL)
     ORDER BY h.doc_no, i.line_no`;

  const poRows = await sql`
    SELECT i.id::text AS id, p.po_number AS doc, i.item_code AS code, i.description2 AS d2,
           i.notes AS remark, p.status AS po_status, i.so_item_id::text AS so_item_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group = 'sofa'
     ORDER BY p.po_number`;

  /* The other side of the pair, keyed both ways, so "is the build written on the
     document I am NOT looking at?" is one lookup. */
  const poBySoItem = new Map();
  for (const r of poRows) if (r.so_item_id) {
    if (!poBySoItem.has(r.so_item_id)) poBySoItem.set(r.so_item_id, []);
    poBySoItem.get(r.so_item_id).push(r);
  }
  const soById = new Map(soRows.map((r) => [r.id, r]));

  for (const [side, rows] of [["SALES ORDER", soRows], ["PURCHASE ORDER", poRows]]) {
    const ph = rows.filter(isPlaceholder);
    log("");
    log(`${side}: ${rows.length} sofa line(s); ${ph.length} still on a bare "-1S" placeholder, on ${new Set(ph.map((r) => r.doc)).size} document(s)`);
    if (!ph.length) continue;
    if (side === "SALES ORDER") log(`   of those placeholders, ${ph.filter((r) => r.cancelled).length} are on a CANCELLED line`);
    else log(`   of those placeholders, ${ph.filter((r) => r.po_status === "CANCELLED").length} are on a CANCELLED PO`);

    const buckets = new Map();
    const tokens = new Map();
    const texts = new Map();
    let siblingReadable = 0;
    const siblingDocs = [];
    for (const r of ph) {
      const model = modelOf(r.code);
      const ps = parseSofa(r.d2, model, reclOf(model), { knownColour });
      const codes = ps.pieces.map((c) => `${model}-${c}`);
      const allExist = codes.length > 0 && codes.every((c) => codeSet.has(norm(c)));
      const { bucket, token } = classify(ps, allExist);
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push({ r, ps, model });
      if (token) {
        if (!tokens.has(token)) tokens.set(token, []);
        tokens.get(token).push(r.doc);
      }
      texts.set(oneLine(r.d2), (texts.get(oneLine(r.d2)) || 0) + 1);

      const others = side === "SALES ORDER"
        ? (poBySoItem.get(r.id) || [])
        : (r.so_item_id && soById.has(r.so_item_id) ? [soById.get(r.so_item_id)] : []);
      for (const o of others) {
        const om = modelOf(o.code);
        const op = parseSofa(o.d2, om, reclOf(om), { knownColour });
        if (op.pieces.length && op.conf !== "low") { siblingReadable++; siblingDocs.push(`${r.doc}<-${o.doc}`); break; }
      }
    }

    log("");
    log(`  WHY — ${ph.length} placeholder line(s), bucketed by what the decoder does with the text the row holds NOW:`);
    for (const [b, v] of [...buckets.entries()].sort((a, b2) => b2[1].length - a[1].length))
      log(`     ${String(v.length).padStart(4)}  ${b}`);
    log(`  distinct Desc2 strings behind them: ${texts.size}`);
    log(`  the OTHER side of the pair carries a readable build for ${siblingReadable} of them${siblingReadable ? `: ${siblingDocs.slice(0, 20).join(", ")}${siblingDocs.length > 20 ? `, +${siblingDocs.length - 20} more` : ""}` : ""}`);

    if (tokens.size) {
      log("");
      log("  THE ACTIONABLE LIST — every token the decoder rejected, most common first:");
      for (const [t, docs] of [...tokens.entries()].sort((a, b2) => b2[1].length - a[1].length))
        log(`     ${String(docs.length).padStart(4)}  "${t}"   e.g. ${[...new Set(docs)].slice(0, 4).join(", ")}`);
    }

    log("");
    log("  THE TEXT — every placeholder line, its bucket and the Desc2 verbatim:");
    let n = 0;
    for (const [b, v] of [...buckets.entries()].sort((a, b2) => b2[1].length - a[1].length)) {
      if (n >= SHOW) break;
      log(`  --- ${b} (${v.length}) ---`);
      for (const { r, ps, model } of v) {
        if (n++ >= SHOW) { log(`  ... +${ph.length - SHOW} more line(s) not printed (raise SHOW)`); break; }
        const why = ps.why.filter((w) => !/^note "/.test(w)).join("; ");
        log(`     ${r.doc}  [${model}]  ${JSON.stringify(oneLine(r.d2))}`);
        log(`         decoder: ${ps.pieces.length ? ps.pieces.join("+") : "(nothing)"}${why ? `   |   ${why}` : ""}`);
      }
    }
  }

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
